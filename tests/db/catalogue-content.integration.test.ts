import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/database";
import type { Principal } from "../../src/modules/auth/principal";
import { createCategoryOnce, replaceMeasurementsOnce, updateCategoryOnce, updateProductOnce, updateVariantOnce } from "../../src/modules/catalogue/operations";
import { archiveProduct, getProductWithVariants, updateProduct } from "../../src/modules/catalogue/service";
import { receiveStock } from "../../src/modules/inventory/service";
import { setDeliveryZoneOnce, submitOrderOnce } from "../../src/modules/orders/operations";
import { clearAuthState, count, createTestAuth, createVerifiedOwner } from "../support/auth";
import { createTestVariant, errorCodeOf, TEST_ACTOR } from "../support/fixtures";
import { createTestDb } from "../support/test-database";

// Structured bilingual product content against PostgreSQL: validation, optimistic versions, the fabric
// confirmation, categories, the size chart, and that no product edit ever changes an existing order.
// Fictional products and text only.

let db: Db;
let pool: Pool;
let owner: Principal;
const key = () => randomUUID();

beforeAll(async () => {
  ({ db, pool } = await createTestDb(6));
  const auth = createTestAuth(db);
  await clearAuthState(pool);
  ({ principal: owner } = await createVerifiedOwner(auth, db, pool, "content-owner@example.test"));
});

afterAll(async () => {
  await pool?.end();
});

const draft = async () => (await createTestVariant(db, "content")).product;
const edit = async (productId: string, changes: Parameters<typeof updateProductOnce>[3]["changes"], expectedVersion?: number) =>
  updateProductOnce(db, owner, key(), { productId, expectedVersion: expectedVersion ?? (await getProductWithVariants(db, productId)).version, changes });

describe("product content", () => {
  it("stores fabric, care and size guidance in both languages exactly (Unicode kept), and clears with blank", async () => {
    const product = await draft();
    const bangla = "১০০% সুতি (কাল্পনিক) — নরম";
    const { value } = await edit(product.id, { fabricEn: "  Fictional fabric line  ", fabricBn: bangla, careEn: "Fictional care", careBn: "কাল্পনিক যত্ন", sizeGuidanceEn: "Fictional guidance", featured: true });
    expect(value).toMatchObject({ fabricEn: "Fictional fabric line", fabricBn: bangla, careBn: "কাল্পনিক যত্ন", sizeGuidanceBn: null, featured: true, version: 2 });
    const { rows } = await pool.query("select fabric_bn from products where id = $1", [product.id]);
    expect(rows[0].fabric_bn).toBe(bangla);
    const { value: cleared } = await edit(product.id, { careEn: "", careBn: null, featured: false });
    expect(cleared).toMatchObject({ careEn: null, careBn: null, featured: false, fabricBn: bangla });
  });

  it("refuses text over 1000 characters, a non-boolean flag and a stale version", async () => {
    const product = await draft();
    expect(await errorCodeOf(edit(product.id, { careEn: "x".repeat(1001) }))).toBe("INVALID_INPUT");
    expect(await errorCodeOf(edit(product.id, { featured: "yes" as unknown as boolean }))).toBe("INVALID_INPUT");
    await edit(product.id, { careEn: "Fictional" });
    expect(await errorCodeOf(edit(product.id, { careBn: "কাল্পনিক" }, 1))).toBe("VERSION_CONFLICT");
    // The database refuses what the service would refuse, even from a direct write.
    await expect(pool.query("update products set care_en = $1 where id = $2", ["   ", product.id])).rejects.toMatchObject({ code: "23514" });
  });

  it("two edits from the same version: exactly one is saved", async () => {
    const product = await draft();
    const results = await Promise.allSettled([edit(product.id, { careEn: "Tab A" }, 1), edit(product.id, { careEn: "Tab B" }, 1)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code).toBe("VERSION_CONFLICT");
    expect((await getProductWithVariants(db, product.id)).version).toBe(2);
  });
});

describe("fabric statement confirmation", () => {
  it("needs text, records who and when, and is cleared by any change to the fabric text", async () => {
    const product = await draft();
    expect(await errorCodeOf(edit(product.id, { fabricConfirmed: true }))).toBe("INVALID_INPUT");
    const { value: confirmed } = await edit(product.id, { fabricEn: "Fictional fabric", fabricBn: "কাল্পনিক কাপড়", fabricConfirmed: true });
    expect(confirmed.fabricConfirmedAt).not.toBeNull();
    expect(confirmed.fabricConfirmedByUserId).toBe(owner.userId);
    // Other edits keep it; editing the fabric text without confirming again clears it.
    const { value: kept } = await edit(product.id, { careEn: "Fictional care", fabricBn: "কাল্পনিক কাপড়" });
    expect(kept.fabricConfirmedAt).toEqual(confirmed.fabricConfirmedAt);
    const { value: changed } = await edit(product.id, { fabricEn: "Changed fictional fabric" });
    expect([changed.fabricConfirmedAt, changed.fabricConfirmedByUserId]).toEqual([null, null]);
    const { value: again } = await edit(product.id, { fabricConfirmed: true });
    expect(again.fabricConfirmedAt).not.toBeNull();
    const { value: withdrawn } = await edit(product.id, { fabricConfirmed: false });
    expect(withdrawn.fabricConfirmedAt).toBeNull();
    // Only a signed-in user can confirm: a system actor cannot.
    expect(await errorCodeOf(updateProduct(db, product.id, withdrawn.version, { fabricConfirmed: true }, TEST_ACTOR))).toBe("INVALID_INPUT");
  });
});

describe("categories", () => {
  it("are created with a unique slug and a name, renamed with a version, and chosen on a product", async () => {
    const slug = `content-cat-${Date.now().toString(36)}`;
    const { value: category } = await createCategoryOnce(db, owner, key(), { slug, nameEn: "Fictional rompers", nameBn: "কাল্পনিক রম্পার" });
    expect(await errorCodeOf(createCategoryOnce(db, owner, key(), { slug, nameEn: "Again" }))).toBe("SLUG_TAKEN");
    expect(await errorCodeOf(createCategoryOnce(db, owner, key(), { slug: `${slug}-x` }))).toBe("INVALID_INPUT");
    const { value: renamed } = await updateCategoryOnce(db, owner, key(), { categoryId: category.id, expectedVersion: 1, nameEn: "Fictional sets", nameBn: null });
    expect(renamed).toMatchObject({ nameEn: "Fictional sets", nameBn: null, version: 2, slug });
    expect(await errorCodeOf(updateCategoryOnce(db, owner, key(), { categoryId: category.id, expectedVersion: 1, nameEn: "Stale", nameBn: null }))).toBe("VERSION_CONFLICT");

    const product = await draft();
    const { value } = await edit(product.id, { categoryId: category.id });
    expect(value.category).toMatchObject({ id: category.id, nameEn: "Fictional sets" });
    expect(await errorCodeOf(edit(product.id, { categoryId: randomUUID() }))).toBe("CATEGORY_NOT_FOUND");
    expect(await errorCodeOf(edit(product.id, { categoryId: "not-a-uuid" }))).toBe("INVALID_INPUT");
    const { value: none } = await edit(product.id, { categoryId: null });
    expect(none.category).toBeNull();
  });
});

describe("size chart", () => {
  it("replaces the whole chart in millimetres, in a stable order, and an empty list removes it", async () => {
    const product = await draft();
    const replace = async (measurements: { size: string; point: string; valueMm: number }[], expectedVersion?: number) =>
      replaceMeasurementsOnce(db, owner, key(), { productId: product.id, expectedVersion: expectedVersion ?? (await getProductWithVariants(db, product.id)).version, measurements });
    const { value } = await replace([
      { size: "3-6M", point: "length", valueMm: 420 },
      { size: "0-3M", point: "length", valueMm: 385 },
      { size: "0-3M", point: "chest", valueMm: 245 },
    ]);
    expect(value.measurements).toEqual([
      { size: "0-3M", point: "chest", valueMm: 245 },
      { size: "0-3M", point: "length", valueMm: 385 },
      { size: "3-6M", point: "length", valueMm: 420 },
    ]);
    expect(await errorCodeOf(replace([{ size: "0-3M", point: "neck", valueMm: 100 }]))).toBe("INVALID_INPUT");
    expect(await errorCodeOf(replace([{ size: "0-3M", point: "chest", valueMm: 3001 }]))).toBe("INVALID_INPUT");
    expect(await errorCodeOf(replace([{ size: "0-3M", point: "chest", valueMm: 245 }], 1))).toBe("VERSION_CONFLICT");
    // A refused change leaves the chart as it was.
    expect((await getProductWithVariants(db, product.id)).measurements).toHaveLength(3);
    const { value: cleared } = await replace([]);
    expect(cleared.measurements).toEqual([]);
    await archiveProduct(db, product.id);
    expect(await errorCodeOf(replace([{ size: "0-3M", point: "chest", valueMm: 245 }]))).toBe("PRODUCT_NOT_EDITABLE");
  });
});

describe("orders keep their snapshot", () => {
  it("renaming a product, changing its content and price never changes an order already placed", async () => {
    const zones = await pool.query<{ code: string; version: number }>("select code, version from delivery_zones");
    const zoneVersion = zones.rows.find((z) => z.code === "dhaka_city")?.version ?? null;
    if (zoneVersion === null) await setDeliveryZoneOnce(db, owner, key(), { code: "dhaka_city", chargePaisa: 6_000, active: true, expectedVersion: null });
    const { product, variant } = await createTestVariant(db, "content");
    await receiveStock(db, { sku: variant.sku, quantity: 2, actor: TEST_ACTOR });
    const { value: order } = await submitOrderOnce(db, owner, key(), {
      source: "whatsapp",
      customerName: "Test Customer",
      customerPhone: "01711000031",
      deliveryAddress: "House 31, Test Road",
      deliveryZone: "dhaka_city",
      items: [{ sku: variant.sku, quantity: 1 }],
    });
    const before = await pool.query("select * from order_items where order_id = $1", [order.id]);
    await edit(product.id, { nameEn: "Renamed fictional romper", nameBn: "নতুন নাম", fabricEn: "Fictional", careEn: "Fictional" });
    await updateVariantOnce(db, owner, key(), { variantId: variant.id, expectedVersion: 1, changes: { pricePaisa: 99_900, size: "3-6M" } });
    const after = await pool.query("select * from order_items where order_id = $1", [order.id]);
    expect(after.rows).toEqual(before.rows);
    expect(after.rows[0]).toMatchObject({ product_name_en: "Test Romper", size: "0-3M", unit_price_paisa: "85000" });
    expect(await count(pool, "select count(*) from orders where id = $1 and subtotal_paisa = 85000", [order.id])).toBe(1);
  });
});
