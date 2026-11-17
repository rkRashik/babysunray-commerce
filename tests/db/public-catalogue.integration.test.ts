import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { publicCatalogueResponse, type PublicResource } from "../../src/api/public-catalogue";
import type { Db } from "../../src/db/database";
import { actorFor, type Principal } from "../../src/modules/auth/principal";
import { createCategoryOnce } from "../../src/modules/catalogue/operations";
import { archiveProduct, createProduct, createVariant, deactivateVariant, updateProduct } from "../../src/modules/catalogue/service";
import { receiveStock } from "../../src/modules/inventory/service";
import { publicCheckoutGate } from "../../src/modules/launch/gate";
import { createBulkhead } from "../../src/modules/rate-limit/bulkhead";
import { setDeliveryZoneOnce } from "../../src/modules/orders/operations";
import { getPublicProduct, listPublicProducts, publicFacets, quotePublicCart } from "../../src/modules/storefront/public-catalogue";
import { clearAuthState, createTestAuth, createVerifiedOwner } from "../support/auth";
import { errorCodeOf, TEST_ACTOR } from "../support/fixtures";
import { publishNow, withdrawNow } from "../support/publication";
import { createTestDb } from "../support/test-database";

// The published-only public catalogue and its unrouted transport (Gate H.33) against PostgreSQL. Customers must
// never see a draft, withdrawn or archived product, through any list, search, filter, product page, quote or error.
// Fictional products only; drafts carry the marker SECRETDRAFT, which no public answer may contain.

let db: Db;
let pool: Pool;
let owner: Principal;
const BASE = "http://localhost:3000";
const tag = `pc${Date.now().toString(36)}`;
const open = () => ({ open: true });
let published: { slug: string; sku: string; outSku: string; inactiveSku: string };
let draftSku: string;
let draftSlug: string;
let withdrawnSlug: string;
let archivedSlug: string;

async function product(slug: string, nameEn: string, categoryId: string | null, stock: number) {
  const p = await createProduct(db, { slug, nameEn, nameBn: `${nameEn} বাংলা`, descriptionEn: "Fictional.", descriptionBn: "কাল্পনিক।" });
  if (categoryId) await updateProduct(db, p.id, 1, { categoryId });
  const v = await createVariant(db, { productId: p.id, sku: `${slug}-a`.toUpperCase(), size: "0-3M", colour: "Ivory", pricePaisa: 70_000 });
  if (stock) await receiveStock(db, { sku: v.sku, quantity: stock, actor: TEST_ACTOR });
  return { id: p.id, slug, sku: v.sku };
}

beforeAll(async () => {
  ({ db, pool } = await createTestDb(6));
  await clearAuthState(pool);
  ({ principal: owner } = await createVerifiedOwner(createTestAuth(db), db, pool, "public-catalogue-owner@example.test"));
  // Nothing published by other test files may show up here.
  await pool.query("update products set status = 'draft' where status = 'published'");
  for (const [code, charge, active] of [["dhaka_city", 6_000, true], ["outside_dhaka", 12_000, false]] as const) {
    const { rows } = await pool.query<{ version: number }>("select version from delivery_zones where code = $1", [code]);
    await setDeliveryZoneOnce(db, owner, randomUUID(), { code, chargePaisa: charge, active, expectedVersion: rows[0]?.version ?? null });
  }
  const shown = (await createCategoryOnce(db, owner, randomUUID(), { slug: `${tag}-shown`, nameEn: "Shown", nameBn: "দেখানো" })).value;
  const hidden = (await createCategoryOnce(db, owner, randomUUID(), { slug: `${tag}-hidden`, nameEn: "SECRETDRAFT category", nameBn: "গোপন" })).value;

  const draft = await product(`${tag}-draft`, "SECRETDRAFT Romper", hidden.id, 5);
  ({ sku: draftSku, slug: draftSlug } = draft);
  const live = await product(`${tag}-live`, "Live Romper", shown.id, 3);
  await updateProduct(db, live.id, 2, { fabricEn: "Cotton (fictional).", fabricBn: "সুতি (কাল্পনিক)।", fabricConfirmed: true, careEn: "Wash cold.", careBn: "ঠান্ডা পানিতে।" }, actorFor(owner));
  const out = await createVariant(db, { productId: live.id, sku: `${tag}-live-b`.toUpperCase(), size: "3-6M", colour: "Ivory", pricePaisa: 72_000 });
  const inactive = await createVariant(db, { productId: live.id, sku: `${tag}-live-c`.toUpperCase(), size: "6-12M", colour: "Ivory", pricePaisa: 74_000 });
  await publishNow(db, owner, live.id);
  await deactivateVariant(db, inactive.id);
  published = { slug: live.slug, sku: live.sku, outSku: out.sku, inactiveSku: inactive.sku };

  const withdrawn = await product(`${tag}-withdrawn`, "SECRETDRAFT Withdrawn", hidden.id, 2);
  await publishNow(db, owner, withdrawn.id);
  await withdrawNow(db, owner, withdrawn.id);
  withdrawnSlug = withdrawn.slug;
  const archived = await product(`${tag}-archived`, "SECRETDRAFT Archived", hidden.id, 2);
  await archiveProduct(db, archived.id);
  archivedSlug = archived.slug;
});

afterAll(async () => {
  await pool?.end();
});

describe("published-only reads", () => {
  it("lists, searches and filters only published products, with no ids, versions or stock counts", async () => {
    const all = await listPublicProducts(db, {});
    expect(all.items.map((i) => i.slug)).toEqual([published.slug]);
    expect(all.items[0]).toEqual({ slug: published.slug, name: { en: "Live Romper", bn: "Live Romper বাংলা" }, featured: false, pricePaisa: { min: 70_000, max: 72_000 }, stock: "partial", photo: null });
    for (const q of ["SECRETDRAFT", "Withdrawn", "Archived", tag]) {
      const found = await listPublicProducts(db, { q });
      expect(JSON.stringify(found)).not.toContain("SECRETDRAFT");
    }
    expect((await listPublicProducts(db, { category: `${tag}-hidden` })).items).toEqual([]);
    expect((await listPublicProducts(db, { category: `${tag}-shown`, inStock: true })).items).toHaveLength(1);
    expect(await errorCodeOf(listPublicProducts(db, { page: 101 }))).toBe("INVALID_INPUT");
    expect(await errorCodeOf(listPublicProducts(db, { q: "a\u0000b" }))).toBe("INVALID_INPUT");
    // Hostile search text is a bound parameter: it matches itself and changes nothing.
    expect((await listPublicProducts(db, { q: "%' or 1=1 --" })).items).toEqual([]);
  });

  it("filters offer only what published products have", async () => {
    const facets = await publicFacets(db);
    expect(facets.categories).toEqual([{ slug: `${tag}-shown`, name: { en: "Shown", bn: "দেখানো" } }]);
    expect(facets.sizes).toEqual(["0-3M", "3-6M"]);
    expect(JSON.stringify(facets)).not.toContain("SECRETDRAFT");
  });

  it("shows a published product as an allowlist; every other slug gets the same null", async () => {
    const p = await getPublicProduct(db, published.slug);
    expect(Object.keys(p!).sort()).toEqual(["care", "category", "deliveryZones", "description", "fabric", "measurements", "name", "photos", "sizeGuidance", "slug", "variants"]);
    expect(p!.fabric).toEqual({ en: "Cotton (fictional).", bn: "সুতি (কাল্পনিক)।" });
    expect(p!.variants).toEqual([
      { sku: published.sku, size: "0-3M", colour: "Ivory", pricePaisa: 70_000, inStock: true },
      { sku: published.outSku, size: "3-6M", colour: "Ivory", pricePaisa: 72_000, inStock: false },
    ]);
    // Only the active zone, with its configured charge.
    expect(p!.deliveryZones).toEqual([{ code: "dhaka_city", chargePaisa: 6_000 }]);
    expect(JSON.stringify(p)).not.toMatch(/version|userId|createdAt|"id"/);
    for (const slug of [draftSlug, withdrawnSlug, archivedSlug, `${tag}-unknown`, "Not A Slug", "x".repeat(101)]) expect(await getPublicProduct(db, slug)).toBeNull();
  });

  it("hides a fabric statement that is not confirmed", async () => {
    const p = await product(`${tag}-unconfirmed`, "Unconfirmed Romper", null, 1);
    await updateProduct(db, p.id, 1, { fabricEn: "Unconfirmed claim.", fabricBn: "অনিশ্চিত।" });
    await publishNow(db, owner, p.id);
    expect((await getPublicProduct(db, p.slug))!.fabric).toBeNull();
    await withdrawNow(db, owner, p.id);
  });

  it("quotes from the database: unknown, draft and inactive SKUs are alike and reveal nothing", async () => {
    const quote = await quotePublicCart(db, {
      zone: "dhaka_city",
      lines: [
        { sku: published.sku.toLowerCase(), quantity: 2 },
        { sku: published.outSku, quantity: 1 },
        { sku: draftSku, quantity: 1 },
        { sku: `${tag}-nothing`.toUpperCase(), quantity: 1 },
        { sku: published.inactiveSku, quantity: 1 },
      ],
    });
    expect(quote.lines[0]).toEqual({ sku: published.sku, quantity: 2, status: "ok", unitPricePaisa: 70_000, lineTotalPaisa: 140_000, productSlug: published.slug, name: { en: "Live Romper", bn: "Live Romper বাংলা" }, size: "0-3M", colour: "Ivory" });
    expect(quote.lines[1]).toMatchObject({ status: "insufficient", unitPricePaisa: 72_000 });
    const hidden = quote.lines.slice(2).map((l) => ({ ...l, sku: "(any)" }));
    expect(new Set(hidden.map((h) => JSON.stringify(h))).size).toBe(1);
    expect(hidden[0]).toEqual({ sku: "(any)", quantity: 1, status: "unavailable", unitPricePaisa: null, lineTotalPaisa: null, productSlug: null, name: null, size: null, colour: null });
    expect(quote).toMatchObject({ subtotalPaisa: 140_000 + 72_000, deliveryChargePaisa: 6_000, totalPaisa: 218_000, ready: false });
    expect(JSON.stringify(quote)).not.toContain("SECRETDRAFT");
    const ready = await quotePublicCart(db, { zone: "dhaka_city", lines: [{ sku: published.sku, quantity: 1 }] });
    expect(ready).toMatchObject({ ready: true, totalPaisa: 76_000 });
    expect((await quotePublicCart(db, { zone: "outside_dhaka", lines: [{ sku: published.sku, quantity: 1 }] })).ready).toBe(false);
    expect(await errorCodeOf(quotePublicCart(db, { lines: [{ sku: published.sku, quantity: 0 }] }))).toBe("INVALID_INPUT");
  });
});

describe("public catalogue transport (unrouted, test harness only)", () => {
  const call = (resource: PublicResource, init: RequestInit & { url?: string } = {}, gate = open, deps: Partial<{ db: Db }> = {}) =>
    publicCatalogueResponse(new Request(init.url ?? `${BASE}/shop`, { method: resource.kind === "quote" ? "POST" : "GET", ...init }), resource, { db: deps.db ?? db, baseUrl: BASE, gate });
  const quote = (body: unknown, headers: Record<string, string> = {}) =>
    call({ kind: "quote" }, { body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

  it("with the real launch gate, refuses every request before any database work", async () => {
    const untouchable = new Proxy({}, { get: () => { throw new Error("the database must not be used"); } }) as unknown as Db;
    const reviewed = { delivery: "reviewed", returns: "reviewed", privacy: "reviewed", checkout_notices: "reviewed" } as const;
    const realGate = () => publicCheckoutGate({ policies: reviewed, deliveryZonesConfigured: true, reviewedProducts: 1 });
    for (const resource of [{ kind: "products" }, { kind: "product", slug: published.slug }, { kind: "facets" }, { kind: "quote" }] as PublicResource[]) {
      const response = await call(resource, resource.kind === "quote" ? { body: "{}", headers: { "content-type": "application/json" } } : {}, realGate, { db: untouchable });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "shop_closed" });
    }
  });

  it("answers lists, products, filters and quotes with request ids, no CORS and no draft data", async () => {
    const list = await call({ kind: "products" }, { url: `${BASE}/shop?q=romper&page=1` });
    expect(list.status).toBe(200);
    expect(list.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(list.headers.get("access-control-allow-origin")).toBeNull();
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(await list.json()).toMatchObject({ data: [{ slug: published.slug }], page: { number: 1, hasMore: false, maxPage: 100 } });
    expect((await call({ kind: "product", slug: published.slug })).status).toBe(200);
    expect((await call({ kind: "facets" })).status).toBe(200);
    const priced = await quote({ zone: "dhaka_city", lines: [{ sku: published.sku, quantity: 1 }] });
    expect(await priced.json()).toMatchObject({ data: { ready: true, totalPaisa: 76_000 } });
    // A draft, an unknown and an archived product: the same answer apart from the request id.
    const misses = await Promise.all([draftSlug, `${tag}-unknown`, archivedSlug].map(async (slug) => {
      const r = await call({ kind: "product", slug });
      return [r.status, await r.text()];
    }));
    expect(new Set(misses.map((m) => JSON.stringify(m))).size).toBe(1);
    expect(misses[0][0]).toBe(404);
  });

  it("refuses unknown, repeated and out-of-range parameters, other origins, methods, media types and big bodies", async () => {
    for (const url of [`${BASE}/shop?sort=price`, `${BASE}/shop?page=1&page=2`, `${BASE}/shop?page=101`, `${BASE}/shop?page=0`, `${BASE}/shop?q=${"x".repeat(101)}`, `${BASE}/shop?inStock=yes`]) {
      expect((await call({ kind: "products" }, { url })).status).toBe(400);
    }
    expect((await call({ kind: "facets" }, { url: `${BASE}/shop?x=1` })).status).toBe(400);
    expect((await call({ kind: "products" }, { headers: { origin: "https://elsewhere.example" } })).status).toBe(403);
    expect((await call({ kind: "products" }, { headers: { origin: BASE } })).status).toBe(200);
    expect((await call({ kind: "products" }, { method: "POST", body: "{}" })).status).toBe(405);
    expect((await call({ kind: "quote" }, { method: "GET" })).status).toBe(405);
    expect((await quote({ lines: [] }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await quote(`{"lines":[],"pad":"${"x".repeat(9000)}"}`)).status).toBe(413);
    expect((await quote("{not json")).status).toBe(400);
    expect((await quote({ lines: [], extra: 1 })).status).toBe(400);
    expect((await quote({ lines: Array.from({ length: 21 }, (_, i) => ({ sku: `S${i}`, quantity: 1 })) })).status).toBe(400);
  });

  it("when anonymous database work is saturated, answers 503 busy at once without touching the database", async () => {
    const untouchable = new Proxy({}, { get: () => { throw new Error("the database must not be used"); } }) as unknown as Db;
    const full = createBulkhead(1, 0, 10);
    let release!: () => void;
    const holder = full(() => new Promise<void>((r) => (release = r)));
    for (const resource of [{ kind: "products" }, { kind: "product", slug: published.slug }, { kind: "facets" }] as PublicResource[]) {
      const r = await publicCatalogueResponse(new Request(`${BASE}/shop`), resource, { db: untouchable, baseUrl: BASE, gate: open, bulkhead: full });
      expect([r.status, r.headers.get("retry-after"), (await r.json()).error]).toEqual([503, "1", "busy"]);
    }
    const q = await publicCatalogueResponse(new Request(`${BASE}/shop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lines: [] }) }), { kind: "quote" }, { db: untouchable, baseUrl: BASE, gate: open, bulkhead: full });
    expect(q.status).toBe(503);
    release();
    await holder;
    // Invalid input is still refused before the bulkhead, so it never takes a slot.
    expect((await publicCatalogueResponse(new Request(`${BASE}/shop?page=0`), { kind: "products" }, { db: untouchable, baseUrl: BASE, gate: open, bulkhead: full })).status).toBe(400);
  });

  it("an unexpected failure is generic and logs neither the query nor the cart", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const broken = new Proxy({}, { get: () => () => { throw new Error("database is down"); } }) as unknown as Db;
      const response = await call({ kind: "products" }, { url: `${BASE}/shop?q=SECRETSEARCH` }, open, { db: broken });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal", message: "Something went wrong. Please try again." });
      const logged = log.mock.calls.flat().join(" ");
      expect(logged).toContain("public_catalogue_failed");
      expect(logged).not.toMatch(/SECRETSEARCH|database is down/);
    } finally {
      log.mockRestore();
    }
  });
});
