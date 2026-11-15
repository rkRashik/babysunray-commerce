import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/database";
import type { Principal } from "../../src/modules/auth/principal";
import { archiveProductOnce, updateProductOnce, updateVariantOnce } from "../../src/modules/catalogue/operations";
import { createProduct, getProductWithVariants, listProducts, updateProduct, updateVariant } from "../../src/modules/catalogue/service";
import { getStockLevel, receiveStock } from "../../src/modules/inventory/service";
import { clearAuthState, count, createTestAuth, createVerifiedOwner } from "../support/auth";
import { createTestVariant, errorCodeOf, TEST_ACTOR } from "../support/fixtures";
import { createTestDb } from "../support/test-database";

// Draft editing (optimistic versions, idempotent operations) and Owner search, against PostgreSQL.
// Concurrency is proven by holding the row lock from another session until every attempt is blocked.

let db: Db;
let pool: Pool;
let owner: Principal;

beforeAll(async () => {
  ({ db, pool } = await createTestDb(4));
  await clearAuthState(pool);
  ({ principal: owner } = await createVerifiedOwner(createTestAuth(db), db, pool, "edit-owner@example.test"));
});

afterAll(async () => {
  await pool?.end();
});

/** Runs every attempt on its own connection while `lockSql` holds the row, then releases it. */
async function race<T>(lockSql: string, id: string, attempts: (racingDb: Db) => Promise<T>[]) {
  const { db: racingDb, pool: racingPool } = await createTestDb(6);
  const gate = await pool.connect();
  try {
    await gate.query("begin");
    await gate.query(lockSql, [id]);
    const runs = attempts(racingDb).map((p) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e })));
    const deadline = Date.now() + 10_000;
    for (;;) {
      const waiting = await count(pool, "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%for update%'");
      if (waiting === runs.length) break;
      if (Date.now() > deadline) throw new Error(`Only ${waiting} of ${runs.length} attempts were blocked.`);
      await new Promise((r) => setTimeout(r, 20));
    }
    await gate.query("commit");
    return await Promise.all(runs);
  } finally {
    gate.release();
    await racingPool.end();
  }
}

describe("product editing", () => {
  it("changes only the fields sent, clears with null, keeps slug, id and status, and bumps the version", async () => {
    const { product } = await createTestVariant(db, "edit");
    const updated = await updateProduct(db, product.id, 1, { nameEn: "  Soft Romper  ", descriptionBn: "নরম সুতি" });
    expect(updated).toMatchObject({ id: product.id, slug: product.slug, status: "draft", version: 2, nameEn: "Soft Romper", nameBn: product.nameBn, descriptionBn: "নরম সুতি" });
    const cleared = await updateProduct(db, product.id, 2, { nameEn: null, descriptionBn: "" });
    expect(cleared).toMatchObject({ nameEn: null, nameBn: product.nameBn, descriptionBn: null, version: 3 });
  });

  it("stores Bangla text exactly as typed", async () => {
    const { product } = await createTestVariant(db, "editbn");
    const text = "শিশুর জন্য নরম সুতির রম্পার — ০-৩ মাস";
    await updateProduct(db, product.id, 1, { nameBn: text });
    expect((await pool.query("select name_bn from products where id = $1", [product.id])).rows[0].name_bn).toBe(text);
  });

  it.each([
    ["removing both names", { nameEn: null, nameBn: null }, "INVALID_INPUT"],
    ["an empty change", {}, "INVALID_INPUT"],
    ["a too long name", { nameEn: "x".repeat(201) }, "INVALID_INPUT"],
  ])("refuses %s", async (_name, changes, code) => {
    const { product } = await createTestVariant(db, "editbad");
    expect(await errorCodeOf(updateProduct(db, product.id, 1, changes))).toBe(code);
    expect((await getProductWithVariants(db, product.id)).version).toBe(1);
  });

  it("refuses an archived product and never turns it back into a draft", async () => {
    const { product } = await createTestVariant(db, "editarch");
    await archiveProductOnce(db, owner, randomUUID(), product.id);
    expect(await errorCodeOf(updateProduct(db, product.id, 2, { nameEn: "Revived" }))).toBe("PRODUCT_NOT_EDITABLE");
    expect(await getProductWithVariants(db, product.id)).toMatchObject({ status: "archived", nameEn: "Test Romper" });
  });

  it("lets exactly one of several edits based on the same version win", async () => {
    const { product } = await createTestVariant(db, "editrace");
    const results = await race("select id from products where id = $1 for update", product.id, (racingDb) =>
      [1, 2, 3, 4].map((i) => updateProductOnce(racingDb, owner, randomUUID(), { productId: product.id, expectedVersion: 1, changes: { nameEn: `Edit ${i}` } })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((r) => !r.ok)) expect((r as { e: { code: string } }).e.code).toBe("VERSION_CONFLICT");
    const final = await getProductWithVariants(db, product.id);
    expect(final.version).toBe(2);
    expect(final.nameEn).toBe((results.find((r) => r.ok) as { v: { value: { nameEn: string } } }).v.value.nameEn);
  });

  it("runs a retried edit once: the same key returns the first result even after the version moved on", async () => {
    const { product } = await createTestVariant(db, "editonce");
    const k = randomUUID();
    const input = { productId: product.id, expectedVersion: 1, changes: { nameEn: "Once only" } };
    const first = await updateProductOnce(db, owner, k, input);
    const again = await updateProductOnce(db, owner, k, input);
    expect([first.replayed, again.replayed]).toEqual([false, true]);
    expect(again.value.version).toBe(2);
    expect(await count(pool, "select count(*) from idempotency_records where idempotency_key = $1", [k])).toBe(1);
    // An absent field and a null field are different requests: reusing the key for "clear" is refused.
    expect(await errorCodeOf(updateProductOnce(db, owner, k, { ...input, changes: { nameEn: "Once only", nameBn: null } }))).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("checks the principal before anything else", async () => {
    const { product } = await createTestVariant(db, "editauth");
    const forged = { userId: owner.userId, role: "owner" } as Principal;
    const input = { productId: product.id, expectedVersion: 1, changes: { nameEn: "Forged" } };
    expect(await errorCodeOf(updateProductOnce(db, forged, randomUUID(), input))).toBe("UNAUTHENTICATED");
    expect(await errorCodeOf(updateVariantOnce(db, forged, randomUUID(), { variantId: product.id, expectedVersion: 1, changes: { size: "1Y" } }))).toBe("UNAUTHENTICATED");
    expect((await getProductWithVariants(db, product.id)).version).toBe(1);
  });
});

describe("variant editing", () => {
  it("changes size, colour and price exactly, keeps SKU and status, and never touches stock", async () => {
    const { variant } = await createTestVariant(db, "vedit");
    await receiveStock(db, { sku: variant.sku, quantity: 9, actor: TEST_ACTOR });
    const movementsBefore = await count(pool, "select count(*) from stock_movements where variant_id = $1", [variant.id]);
    const updated = await updateVariant(db, variant.id, 1, { size: "3-6M", colour: null, pricePaisa: 99_950 });
    expect(updated).toMatchObject({ id: variant.id, sku: variant.sku, status: "active", size: "3-6M", colour: null, pricePaisa: 99_950, version: 2 });
    expect((await getStockLevel(db, variant.sku)).onHand).toBe(9);
    expect(await count(pool, "select count(*) from stock_movements where variant_id = $1", [variant.id])).toBe(movementsBefore);
    expect((await updateVariant(db, variant.id, 2, { pricePaisa: Number.MAX_SAFE_INTEGER })).pricePaisa).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    ["a zero price", { pricePaisa: 0 }],
    ["a fractional price", { pricePaisa: 850.5 }],
    ["an unsafe price", { pricePaisa: Number.MAX_SAFE_INTEGER + 1 }],
    ["a too long size", { size: "x".repeat(65) }],
    ["an empty change", {}],
  ])("refuses %s", async (_name, changes) => {
    const { variant } = await createTestVariant(db, "vbad");
    expect(await errorCodeOf(updateVariant(db, variant.id, 1, changes))).toBe("INVALID_INPUT");
  });

  it("refuses a stale version, an inactive variant and a variant of an archived product", async () => {
    const one = await createTestVariant(db, "vstate");
    await updateVariant(db, one.variant.id, 1, { size: "1Y" });
    expect(await errorCodeOf(updateVariant(db, one.variant.id, 1, { size: "2Y" }))).toBe("VERSION_CONFLICT");
    await pool.query("update variants set status = 'inactive', version = version + 1 where id = $1", [one.variant.id]);
    expect(await errorCodeOf(updateVariant(db, one.variant.id, 3, { size: "2Y" }))).toBe("VARIANT_NOT_EDITABLE");
    const two = await createTestVariant(db, "vstate");
    await archiveProductOnce(db, owner, randomUUID(), two.product.id);
    expect(await errorCodeOf(updateVariant(db, two.variant.id, 1, { size: "2Y" }))).toBe("VARIANT_NOT_EDITABLE");
  });

  it("lets exactly one of several edits based on the same version win", async () => {
    const { variant } = await createTestVariant(db, "vrace");
    const results = await race("select id from variants where id = $1 for update", variant.id, (racingDb) =>
      [100, 200, 300].map((paisa) => updateVariantOnce(racingDb, owner, randomUUID(), { variantId: variant.id, expectedVersion: 1, changes: { pricePaisa: paisa } })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await pool.query("select version from variants where id = $1", [variant.id])).rows[0].version).toBe(2);
  });
});

describe("search", () => {
  const ids = async (options: Parameters<typeof listProducts>[1]) => (await listProducts(db, options)).items.map((p) => p.id);

  it("matches English case-insensitively, Bangla in any Unicode form, slug and SKU", async () => {
    const tag = randomUUID().slice(0, 8);
    const precomposed = await createProduct(db, { slug: `search-${tag}`, nameEn: `Cotton Kurta ${tag}`, nameBn: `কোমল কুর্তা ${tag}` });
    // Stored decomposed (ো typed as ে + া), found with precomposed input, and the other way round.
    const decomposed = await createProduct(db, { slug: `search-${tag}-nfd`, nameBn: `কোমল জামা ${tag}` });
    const { variant } = await createTestVariant(db, `s${tag}`);
    expect(await ids({ limit: 100, q: `COTTON KURTA ${tag}` })).toEqual([precomposed.id]);
    expect(await ids({ limit: 100, q: `কোমল জামা ${tag}` })).toEqual([decomposed.id]);
    expect(await ids({ limit: 100, q: `কোমল কুর্তা ${tag}` })).toEqual([precomposed.id]);
    expect(await ids({ limit: 100, q: `search-${tag}` })).toEqual([precomposed.id, decomposed.id]);
    expect(await ids({ limit: 100, q: variant.sku.toLowerCase() })).toEqual([variant.productId]);
  });

  it("combines search with the status filter and pages through the matches in a stable order", async () => {
    const tag = randomUUID().slice(0, 8);
    const created = [];
    for (let i = 0; i < 5; i += 1) created.push(await createProduct(db, { slug: `page-${tag}-${i}`, nameEn: `Paged ${tag}` }));
    await archiveProductOnce(db, owner, randomUUID(), created[1].id);
    const seen: string[] = [];
    let after;
    for (;;) {
      const page = await listProducts(db, { limit: 2, q: tag, after });
      seen.push(...page.items.map((p) => p.id));
      if (!page.hasMore) break;
      after = page.items.at(-1)?.key;
    }
    expect(seen).toEqual(created.map((p) => p.id));
    expect(await ids({ limit: 100, q: tag, status: "archived" })).toEqual([created[1].id]);
    expect(await ids({ limit: 100, q: tag, status: "draft" })).toHaveLength(4);
  });

  it("treats % _ \\ and quotes as plain characters and finds nothing for an unknown term", async () => {
    const tag = randomUUID().slice(0, 8);
    await createProduct(db, { slug: `wild-${tag}`, nameEn: `Plain ${tag}` });
    const withPercent = await createProduct(db, { slug: `wild-${tag}-pct`, nameEn: `Sale 50% ${tag}` });
    expect(await ids({ limit: 100, q: `50% ${tag}` })).toEqual([withPercent.id]);
    expect(await ids({ limit: 100, q: `% ${tag}` })).toEqual([withPercent.id]);
    expect(await ids({ limit: 100, q: `_${tag}` })).toEqual([]);
    expect(await ids({ limit: 100, q: `' or ''='` })).toEqual([]);
    expect(await ids({ limit: 100, q: `nothing-like-this-${tag}` })).toEqual([]);
  });

  it("treats a blank term as no search and refuses unsafe input", async () => {
    const all = await listProducts(db, { limit: 100 });
    expect((await listProducts(db, { limit: 100, q: "   " })).items.length).toBe(all.items.length);
    expect(await errorCodeOf(listProducts(db, { limit: 10, q: "x".repeat(101) }))).toBe("INVALID_INPUT");
    expect(await errorCodeOf(listProducts(db, { limit: 10, q: "nul\u0000byte" }))).toBe("INVALID_INPUT");
  });
});
