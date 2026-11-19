import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/database";
import type { Principal } from "../../src/modules/auth/principal";
import { importCatalogueOnce, previewImport } from "../../src/modules/catalogue/import-service";
import { createCategory, getProductWithVariants } from "../../src/modules/catalogue/service";
import { BASE_URL, clearAuthState, count, createTestAuth, createVerifiedOwner } from "../support/auth";
import { errorCodeOf } from "../support/fixtures";
import { createTestDb } from "../support/test-database";
import { buildXlsx, sharedStringsSheet } from "../support/xlsx";

// Bulk catalogue import against PostgreSQL: the preview writes nothing; an import is all or nothing, once per key,
// through the normal catalogue services; it never publishes, confirms fabric or receives stock. Fictional data.

const state = vi.hoisted(() => ({ db: undefined as unknown, auth: undefined as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/modules/auth/server", () => ({ getAuth: () => state.auth }));
const previewRoute = await import("../../src/app/admin/import/preview/route");
const confirmRoute = await import("../../src/app/admin/import/confirm/route");
const templateRoute = await import("../../src/app/admin/import/template/route");

let db: Db;
let pool: Pool;
let owner: Principal;
let cookie: string;
let run = 0;

beforeAll(async () => {
  ({ db, pool } = await createTestDb(8));
  const auth = createTestAuth(db);
  Object.assign(state, { db, auth });
  await clearAuthState(pool);
  ({ principal: owner, cookie } = await createVerifiedOwner(auth, db, pool, "import-owner@example.test"));
});

afterAll(async () => {
  await pool?.end();
});

const HEADER = "product_slug,name_en,name_bn,description_bn,category_slug,fabric_en,fabric_bn,care_en,featured,sku,size,colour,price_bdt,chest_cm,length_cm";
/** A fictional catalogue file; every slug and SKU unique to this call. */
function file(lines: (tag: string) => string[]) {
  run += 1;
  const tag = `imp${Date.now().toString(36)}${run}`;
  return { tag, bytes: new TextEncoder().encode([HEADER, ...lines(tag)].join("\r\n")) };
}
const valid = (tag: string) => [
  `${tag}-romper,Fictional Romper,কাল্পনিক রম্পার,নরম কাল্পনিক কাপড়,,Fictional fabric,কাল্পনিক কাপড়,Fictional care,yes,${tag}-r1,0-3M,Ivory,850,24.5,38`,
  `${tag}-romper,,,,,,,,,${tag}-r2,3-6M,Ivory,920.50,26,41`,
  `${tag}-cap,Fictional Cap,,,,,,,,${tag}-c1,,,120,,`,
];
const snapshot = async () => ({
  products: await count(pool, "select count(*) from products"),
  variants: await count(pool, "select count(*) from variants"),
  balances: await count(pool, "select count(*) from inventory_balances"),
  movements: await count(pool, "select count(*) from stock_movements"),
  measurements: await count(pool, "select count(*) from product_measurements"),
  imports: await count(pool, "select count(*) from catalogue_imports"),
  idempotency: await count(pool, "select count(*) from idempotency_records"),
});

describe("preview", () => {
  it("shows what would be created and changes nothing", async () => {
    const { bytes } = file(valid);
    const before = await snapshot();
    const preview = await previewImport(db, owner, bytes);
    expect(preview).toMatchObject({ ok: true, format: "csv", issues: [], counts: { rows: 3, products: 2, variants: 3, rejectedRows: 0 } });
    expect(preview.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await snapshot()).toEqual(before);
  });

  it("reports existing slugs and SKUs and unknown categories by row, and gives no fingerprint", async () => {
    const first = file(valid);
    await importCatalogueOnce(db, owner, randomUUID(), { bytes: first.bytes, fingerprint: (await previewImport(db, owner, first.bytes)).fingerprint! });
    const again = await previewImport(db, owner, first.bytes);
    expect(again.ok).toBe(false);
    expect(again.fingerprint).toBeNull();
    expect(again.issues.map((i) => `${i.line}:${i.code}`)).toEqual(expect.arrayContaining(["2:slug_taken", "4:slug_taken", "2:sku_taken", "3:sku_taken", "4:sku_taken"]));
    const unknown = file((tag) => [`${tag}-x,Name,,,no-such-category-${tag},,,,,${tag}-x1,,,100,,`]);
    expect((await previewImport(db, owner, unknown.bytes)).issues.map((i) => i.code)).toEqual(["unknown_category"]);
  });
});

describe("import", () => {
  it("creates draft products, SKUs with zero stock, content and measurements, unconfirmed fabric, and one audit row", async () => {
    const category = await createCategory(db, { slug: `imp-cat-${Date.now().toString(36)}`, nameEn: "Fictional sets" });
    const { tag, bytes } = file((t) => valid(t).map((line, i) => (i === 0 ? line.replace(",,Fictional fabric", `,${category.slug},Fictional fabric`) : line)));
    const preview = await previewImport(db, owner, bytes);
    const before = await snapshot();
    const { value, replayed } = await importCatalogueOnce(db, owner, randomUUID(), { bytes, fingerprint: preview.fingerprint! });
    expect(replayed).toBe(false);
    expect(value).toMatchObject({ format: "csv", productsCreated: 2, variantsCreated: 3 });
    const after = await snapshot();
    expect(after).toEqual({ ...before, products: before.products + 2, variants: before.variants + 3, balances: before.balances + 3, measurements: before.measurements + 4, imports: before.imports + 1, idempotency: before.idempotency + 1 });
    const romper = await getProductWithVariants(db, value.products.find((p) => p.slug === `${tag}-romper`)!.id);
    expect(romper).toMatchObject({
      status: "draft",
      nameBn: "কাল্পনিক রম্পার",
      descriptionBn: "নরম কাল্পনিক কাপড়",
      fabricEn: "Fictional fabric",
      fabricConfirmedAt: null,
      featured: true,
      categoryId: category.id,
    });
    expect(romper.variants.map((v) => [v.sku, v.size, v.pricePaisa, v.status])).toEqual([[`${tag}-R1`.toUpperCase(), "0-3M", 85_000, "active"], [`${tag}-R2`.toUpperCase(), "3-6M", 92_050, "active"]]);
    expect(await count(pool, "select count(*) from inventory_balances b join variants v on v.id = b.variant_id where v.product_id = $1 and b.on_hand = 0 and b.reserved = 0", [romper.id])).toBe(2);
    expect(romper.measurements).toHaveLength(4);
    await expect(pool.query("update catalogue_imports set products_created = 9")).rejects.toThrow(/append-only/);
  });

  it("a repeated import with the same key returns the first result and creates nothing more", async () => {
    const { bytes } = file(valid);
    const preview = await previewImport(db, owner, bytes);
    const key = randomUUID();
    const first = await importCatalogueOnce(db, owner, key, { bytes, fingerprint: preview.fingerprint! });
    const before = await snapshot();
    const again = await importCatalogueOnce(db, owner, key, { bytes, fingerprint: preview.fingerprint! });
    expect([again.replayed, again.value.id]).toEqual([true, first.value.id]);
    expect(await snapshot()).toEqual(before);
    const other = file(valid);
    expect(await errorCodeOf(importCatalogueOnce(db, owner, key, { bytes: other.bytes, fingerprint: (await previewImport(db, owner, other.bytes)).fingerprint! }))).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("is all or nothing: a later failure, a stale fingerprint or a changed category leaves zero new rows", async () => {
    const category = await createCategory(db, { slug: `imp-cat2-${Date.now().toString(36)}`, nameEn: "Fictional caps" });
    const { tag, bytes } = file((t) => [...valid(t), `${t}-hat,Fictional Hat,,,${category.slug},,,,,${t}-h1,,,90,,`]);
    const preview = await previewImport(db, owner, bytes);
    const before = await snapshot();
    // Someone takes the last product's SKU after the preview: the whole import is refused, nothing is left behind.
    await pool.query("insert into products (slug, name_en) values ($1, 'Taken elsewhere')", [`${tag}-other`]);
    const taker = (await pool.query<{ id: string }>("select id from products where slug = $1", [`${tag}-other`])).rows[0].id;
    await pool.query("insert into variants (product_id, sku, price_paisa) values ($1, $2, 100)", [taker, `${tag}-H1`.toUpperCase()]);
    expect(await errorCodeOf(importCatalogueOnce(db, owner, randomUUID(), { bytes, fingerprint: preview.fingerprint! }))).toBe("VERSION_CONFLICT");
    const delta = await snapshot();
    expect(delta).toEqual({ ...before, products: before.products + 1, variants: before.variants + 1 });

    const second = file((t) => [`${t}-hat,Fictional Hat,,,${category.slug},,,,,${t}-h1,,,90,,`]);
    const fresh = await previewImport(db, owner, second.bytes);
    await pool.query("update product_categories set name_en = 'Renamed caps', version = version + 1 where id = $1", [category.id]);
    expect(await errorCodeOf(importCatalogueOnce(db, owner, randomUUID(), { bytes: second.bytes, fingerprint: fresh.fingerprint! }))).toBe("VERSION_CONFLICT");
    await pool.query("delete from product_categories where id = $1", [category.id]);
    expect(await errorCodeOf(importCatalogueOnce(db, owner, randomUUID(), { bytes: second.bytes, fingerprint: fresh.fingerprint! }))).toBe("VERSION_CONFLICT");
    expect(await errorCodeOf(importCatalogueOnce(db, owner, randomUUID(), { bytes: second.bytes, fingerprint: "0".repeat(64) }))).toBe("VERSION_CONFLICT");
    expect(await snapshot()).toEqual(delta);
  });

  it("rolls back a multi-product import when a database insert fails halfway", async () => {
    const { bytes } = file(valid);
    const preview = await previewImport(db, owner, bytes);
    const before = await snapshot();
    await pool.query("create function test_fail_measurement() returns trigger language plpgsql as $$ begin raise exception 'injected test failure'; end $$");
    try {
      await pool.query("create trigger test_fail_measurement before insert on product_measurements for each row execute function test_fail_measurement()");
      await expect(importCatalogueOnce(db, owner, randomUUID(), { bytes, fingerprint: preview.fingerprint! })).rejects.toThrow();
    } finally {
      await pool.query("drop function test_fail_measurement() cascade");
    }
    expect(await snapshot()).toEqual(before);
  });

  it("two imports racing for the same slug: exactly one creates it, the other creates nothing", async () => {
    const shared = file(valid);
    const a = shared.bytes;
    const b = new TextEncoder().encode(`${new TextDecoder().decode(a)}\r\n`); // a different file with the same rows
    const [pa, pb] = [await previewImport(db, owner, a), await previewImport(db, owner, b)];
    const before = await snapshot();
    const results = await Promise.allSettled([
      importCatalogueOnce(db, owner, randomUUID(), { bytes: a, fingerprint: pa.fingerprint! }),
      importCatalogueOnce(db, owner, randomUUID(), { bytes: b, fingerprint: pb.fingerprint! }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(["SLUG_TAKEN", "SKU_TAKEN", "VERSION_CONFLICT"]).toContain((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code);
    const after = await snapshot();
    expect([after.products - before.products, after.variants - before.variants, after.imports - before.imports]).toEqual([2, 3, 1]);
  });

  it("imports 300 rows (150 products) from an XLSX file with shared strings, in one transaction", async () => {
    run += 1;
    const tag = `impx${Date.now().toString(36)}${run}`;
    const rows = [["product_slug", "name_en", "name_bn", "sku", "size", "price_bdt", "chest_cm"]];
    for (let i = 0; i < 150; i += 1) {
      rows.push([`${tag}-p${i}`, `Fictional Product ${i}`, `কাল্পনিক পণ্য ${i}`, `${tag}-p${i}-a`, "0-3M", "500", "24"]);
      rows.push([`${tag}-p${i}`, "", "", `${tag}-p${i}-b`, "3-6M", "550.25", "26"]);
    }
    const { sheet, shared } = sharedStringsSheet(rows);
    const bytes = await buildXlsx({ sheet, shared });
    const preview = await previewImport(db, owner, bytes);
    expect(preview).toMatchObject({ ok: true, format: "xlsx", counts: { rows: 300, products: 150, variants: 300 } });
    const { value } = await importCatalogueOnce(db, owner, randomUUID(), { bytes, fingerprint: preview.fingerprint! });
    expect([value.productsCreated, value.variantsCreated, value.format]).toEqual([150, 300, "xlsx"]);
    expect(await count(pool, "select count(*) from products where slug like $1 and status = 'draft'", [`${tag}-%`])).toBe(150);
    expect(await count(pool, "select count(*) from stock_movements m join variants v on v.id = m.variant_id where v.sku like $1", [`${tag}-%`.toUpperCase()])).toBe(0);
  });

  it("refuses an import without catalog permission from a forged principal", async () => {
    const forged = Object.freeze({ userId: owner.userId, role: "owner" as const });
    const { bytes } = file(valid);
    expect(await errorCodeOf(previewImport(db, forged, bytes))).toBe("UNAUTHENTICATED");
    expect(await errorCodeOf(importCatalogueOnce(db, forged, randomUUID(), { bytes, fingerprint: "a".repeat(64) }))).toBe("UNAUTHENTICATED");
  });
});

describe("Admin import routes", () => {
  const post = (route: { POST: (r: Request) => Promise<Response> }, path: string, fields: Record<string, string | Blob>, headers: Record<string, string> = { origin: BASE_URL, cookie }) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return route.POST(new Request(`${BASE_URL}${path}`, { method: "POST", headers, body: form }));
  };

  it("preview and confirm work only from this origin with a session, within the size limit, and return no stack or SQL", async () => {
    const { bytes } = file(valid);
    const blob = new Blob([new Uint8Array(bytes)], { type: "text/csv" });
    expect((await post(previewRoute, "/admin/import/preview", { file: blob }, { origin: "https://elsewhere.example", cookie })).status).toBe(403);
    expect((await post(previewRoute, "/admin/import/preview", { file: blob }, { origin: BASE_URL })).status).toBe(401);
    expect((await post(previewRoute, "/admin/import/preview", { file: blob }, { origin: BASE_URL, cookie, "content-length": String(3 * 1024 * 1024) })).status).toBe(413);
    const preview = await (await post(previewRoute, "/admin/import/preview", { file: blob })).json();
    expect(preview).toMatchObject({ ok: true, counts: { products: 2 }, errorReport: null });
    expect(preview.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    const before = await snapshot();
    const confirm = async () => post(confirmRoute, "/admin/import/confirm", { file: blob, fingerprint: preview.fingerprint, idempotencyKey: preview.idempotencyKey });
    const first = await confirm();
    expect(first.status).toBe(200);
    const again = await (await confirm()).json();
    expect(again.replayed).toBe(true);
    expect((await snapshot()).products).toBe(before.products + 2);
    const conflict = await post(confirmRoute, "/admin/import/confirm", { file: blob, fingerprint: preview.fingerprint, idempotencyKey: randomUUID() });
    const body = await conflict.json();
    expect([conflict.status, body.error]).toEqual([409, "VERSION_CONFLICT"]);
    expect(JSON.stringify(body)).not.toMatch(/select|insert|stack|at \//i);

    const broken = await (await post(previewRoute, "/admin/import/preview", { file: new Blob(['product_slug,sku,price_bdt\n"open,X,1']) })).json();
    expect(broken).toMatchObject({ ok: false, fingerprint: null });
    expect(broken.errorReport).toContain("malformed_csv");
  });

  it("serves the template only to a signed-in Owner", async () => {
    const get = (headers: Record<string, string>) => templateRoute.GET(new Request(`${BASE_URL}/admin/import/template?format=csv`, { headers }));
    const anonymous = await get({});
    expect([anonymous.status, anonymous.headers.get("location")]).toEqual([303, "/admin/login"]);
    const owner = await get({ cookie });
    expect([owner.status, owner.headers.get("cache-control")]).toEqual([200, "no-store"]);
    expect(await owner.text()).toMatch(/^﻿?product_slug,/);
  });
});
