import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/database";
import type { Principal } from "../../src/modules/auth/principal";
import { bulkProducts } from "../../src/modules/catalogue/bulk";
import { updateProductOnce } from "../../src/modules/catalogue/operations";
import { getProductWithVariants, suggestUniqueSlug } from "../../src/modules/catalogue/service";
import { receiveStock } from "../../src/modules/inventory/service";
import { bulkTransition, MAX_BULK_ORDERS } from "../../src/modules/orders/bulk";
import { confirmOrderOnce, packOrderOnce, setDeliveryZoneOnce, submitOrderOnce } from "../../src/modules/orders/operations";
import { getOrderDetail, listOrders, orderQueueCounts } from "../../src/modules/orders/queries";
import { clearAuthState, count, createTestAuth, createVerifiedOwner } from "../support/auth";
import { createTestVariant, TEST_ACTOR } from "../support/fixtures";
import { createTestDb } from "../support/test-database";

// Bulk order steps, queue counts, bulk product steps and slug suggestions against PostgreSQL. Fictional data only.

let db: Db;
let pool: Pool;
let owner: Principal;

const CUSTOMER = { customerName: "Test Customer", customerPhone: "01711000077", deliveryAddress: "House 1, Road 2, Test Area", deliveryZone: "dhaka_city" as const };
const key = () => randomUUID();

beforeAll(async () => {
  ({ db, pool } = await createTestDb(8));
  const auth = createTestAuth(db);
  await clearAuthState(pool);
  ({ principal: owner } = await createVerifiedOwner(auth, db, pool, "bulk-owner@example.test"));
  await pool.query("delete from auth_rate_limits");
  const zones = await pool.query<{ code: string; version: number }>("select code, version from delivery_zones");
  const version = (code: string) => zones.rows.find((z) => z.code === code)?.version ?? null;
  await setDeliveryZoneOnce(db, owner, key(), { code: "dhaka_city", chargePaisa: 6_000, active: true, expectedVersion: version("dhaka_city") });
  await setDeliveryZoneOnce(db, owner, key(), { code: "outside_dhaka", chargePaisa: 12_000, active: true, expectedVersion: version("outside_dhaka") });
});

afterAll(async () => {
  await pool?.end();
});

async function confirmedOrders(n: number) {
  const { variant } = await createTestVariant(db, "bulk");
  await receiveStock(db, { sku: variant.sku, quantity: n + 2, actor: TEST_ACTOR });
  const made = [];
  for (let i = 0; i < n; i += 1) {
    const order = (await submitOrderOnce(db, owner, key(), { source: "whatsapp", ...CUSTOMER, items: [{ sku: variant.sku, quantity: 1 }] })).value;
    const confirmed = (await confirmOrderOnce(db, owner, key(), { orderId: order.id, expectedVersion: order.version })).value;
    made.push({ id: confirmed.id, version: confirmed.version });
  }
  return { sku: variant.sku, orders: made };
}
const item = (o: { id: string; version: number }) => ({ orderId: o.id, expectedVersion: o.version });

describe("bulk order steps", () => {
  it("packs several orders, each on its own, and a replay of the same batch changes nothing more", async () => {
    const { orders } = await confirmedOrders(3);
    const batch = `batch-${key()}`.slice(0, 40);
    const results = await bulkTransition(db, owner, batch, "pack", orders.map(item));
    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
    for (const o of orders) expect((await getOrderDetail(db, o.id)).fulfilmentStatus).toBe("packed");
    const versions = await Promise.all(orders.map(async (o) => (await getOrderDetail(db, o.id)).version));
    const again = await bulkTransition(db, owner, batch, "pack", orders.map(item));
    expect(again.every((r) => r.ok)).toBe(true);
    expect(await Promise.all(orders.map(async (o) => (await getOrderDetail(db, o.id)).version))).toEqual(versions);
  });

  it("reports a stale version, a step that is not allowed and an unknown order per order, and still does the rest", async () => {
    const { orders } = await confirmedOrders(3);
    // Another tab packs the first order after this list was loaded: its version moves on.
    await packOrderOnce(db, owner, key(), { orderId: orders[0].id, expectedVersion: orders[0].version });
    const missing = randomUUID();
    const results = await bulkTransition(db, owner, key().slice(0, 30), "pack", [item(orders[0]), item(orders[1]), { orderId: missing, expectedVersion: 1 }]);
    expect(results[0]).toMatchObject({ ok: false, number: expect.any(Number) });
    expect(results[0].message.length).toBeGreaterThan(10);
    expect(results[1].ok).toBe(true);
    expect(results[2]).toMatchObject({ ok: false, number: null });
    expect((await getOrderDetail(db, orders[1].id)).fulfilmentStatus).toBe("packed");
    expect((await getOrderDetail(db, orders[2].id)).fulfilmentStatus).toBe("unfulfilled");
    // Dispatching an order that is not packed is refused for that order only.
    const mixed = await bulkTransition(db, owner, key().slice(0, 30), "dispatch", [item(orders[2]), { orderId: orders[1].id, expectedVersion: (await getOrderDetail(db, orders[1].id)).version }]);
    expect(mixed.map((r) => r.ok)).toEqual([false, true]);
  });

  it("deducts stock only for the orders it dispatched", async () => {
    const { sku, orders } = await confirmedOrders(2);
    await bulkTransition(db, owner, key().slice(0, 30), "pack", orders.map(item));
    const before = await count(pool, `select on_hand from inventory_balances b join variants v on v.id = b.variant_id where v.sku = '${sku}'`);
    const first = { id: orders[0].id, version: (await getOrderDetail(db, orders[0].id)).version };
    const results = await bulkTransition(db, owner, key().slice(0, 30), "dispatch", [item(first), { orderId: orders[1].id, expectedVersion: 1 }]);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    const after = await count(pool, `select on_hand from inventory_balances b join variants v on v.id = b.variant_id where v.sku = '${sku}'`);
    expect(after).toBe(before - 1);
  });

  it("refuses a wrong request as a whole, and an unauthenticated caller before any change", async () => {
    const { orders } = await confirmedOrders(1);
    await expect(bulkTransition(db, owner, "batch-empty-1", "pack", [])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(bulkTransition(db, owner, "batch-twice-1", "pack", [item(orders[0]), item(orders[0])])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const many = Array.from({ length: MAX_BULK_ORDERS + 1 }, () => ({ orderId: randomUUID(), expectedVersion: 1 }));
    await expect(bulkTransition(db, owner, "batch-many-1", "pack", many)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    for (const other of ["cancel", "deliver", "confirm"]) {
      await expect(bulkTransition(db, owner, "batch-other-1", other as never, [item(orders[0])])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    const fake = Object.freeze({ userId: "00000000-0000-0000-0000-000000000000", role: "owner" as const });
    await expect(bulkTransition(db, fake, "batch-fake-1", "pack", [item(orders[0])])).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect((await getOrderDetail(db, orders[0].id)).fulfilmentStatus).toBe("unfulfilled");
  });
});

describe("order queue counts", () => {
  it("agree with the lists the chips open", async () => {
    await confirmedOrders(2);
    const counts = await orderQueueCounts(db);
    expect(counts.queues.to_pack).toBe((await listOrders(db, { limit: 100, queue: "to_pack" })).items.length);
    expect(counts.queues.to_pack).toBe(await count(pool, "select count(*) from orders where order_status = 'confirmed' and fulfilment_status = 'unfulfilled'"));
    const attention = await count(
      pool,
      `select count(*) from orders o where o.order_status = 'verification_expired' or (o.order_status = 'pending_verification' and o.verification_expires_at <= now()) or exists (select 1 from cancellation_requests c where c.order_id = o.id and c.status = 'open')`,
    );
    expect(counts.attention).toBe(attention);
  });
});

describe("bulk product steps", () => {
  it("sets a category and archives drafts one by one, refusing a product that changed since the list was loaded", async () => {
    const made = [];
    for (let i = 0; i < 3; i += 1) made.push((await createTestVariant(db, "bulkp")).product);
    const category = (await pool.query<{ id: string }>("insert into product_categories (slug, name_en) values ($1, 'Bulk set') returning id", [`bulk-${randomUUID().slice(0, 8)}`])).rows[0].id;
    // The second product is edited in another tab after the list was loaded.
    await updateProductOnce(db, owner, key(), { productId: made[1].id, expectedVersion: made[1].version, changes: { featured: true } });
    const set = await bulkProducts(db, owner, "batch-cat-0001", { kind: "category", categoryId: category }, made.map((p) => ({ productId: p.id, expectedVersion: p.version })));
    expect(set.map((r) => r.ok)).toEqual([true, false, true]);
    expect((await getProductWithVariants(db, made[0].id)).categoryId).toBe(category);
    expect((await getProductWithVariants(db, made[1].id)).categoryId).toBeNull();

    const fresh = await Promise.all(made.map(async (p) => ({ productId: p.id, expectedVersion: (await getProductWithVariants(db, p.id)).version })));
    // An edit between loading and archiving is refused for that product (its version moved on).
    const stale = [{ ...fresh[0], expectedVersion: fresh[0].expectedVersion - 1 }, fresh[1], fresh[2]];
    const archived = await bulkProducts(db, owner, "batch-arch-0001", { kind: "archive" }, stale);
    expect(archived.map((r) => r.ok)).toEqual([false, true, true]);
    expect((await getProductWithVariants(db, made[0].id)).status).toBe("draft");
    expect((await getProductWithVariants(db, made[2].id)).status).toBe("archived");
  });

  it("is refused without permission, and for an empty or repeated selection", async () => {
    const { product } = await createTestVariant(db, "bulkq");
    const fake = Object.freeze({ userId: "00000000-0000-0000-0000-000000000000", role: "owner" as const });
    await expect(bulkProducts(db, fake, "batch-fake-0001", { kind: "archive" }, [{ productId: product.id, expectedVersion: product.version }])).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(bulkProducts(db, owner, "batch-none-0001", { kind: "archive" }, [])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const same = { productId: product.id, expectedVersion: product.version };
    await expect(bulkProducts(db, owner, "batch-same-0001", { kind: "archive" }, [same, same])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await getProductWithVariants(db, product.id)).status).toBe("draft");
  });
});

describe("web address suggestion", () => {
  it("is the name's stem when free, and numbered when taken", async () => {
    const tag = randomUUID().slice(0, 8);
    expect(await suggestUniqueSlug(db, `Cotton Romper ${tag}`)).toBe(`cotton-romper-${tag}`);
    await pool.query("insert into products (slug, name_en) values ($1, 'x'), ($2, 'y')", [`cotton-romper-${tag}`, `cotton-romper-${tag}-2`]);
    expect(await suggestUniqueSlug(db, `Cotton Romper ${tag}`)).toBe(`cotton-romper-${tag}-3`);
  });
});
