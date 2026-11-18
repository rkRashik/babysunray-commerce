import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, poolSettingsFor } from "../../src/db/client";
import type { Db } from "../../src/db/database";
import type { Principal } from "../../src/modules/auth/principal";
import { createProduct, createVariant } from "../../src/modules/catalogue/service";
import { receiveStock } from "../../src/modules/inventory/service";
import { runMaintenance } from "../../src/modules/maintenance/jobs";
import { placeGuestOrder } from "../../src/modules/orders/guest-checkout";
import { getOrderDetail } from "../../src/modules/orders/queries";
import { setDeliveryZoneOnce, submitOrderOnce } from "../../src/modules/orders/operations";
import { clearAuthState, count, createTestAuth, createVerifiedOwner } from "../support/auth";
import { TEST_ACTOR } from "../support/fixtures";
import { publishNow } from "../support/publication";
import { assertSafeTestDatabaseUrl, createTestDb } from "../support/test-database";

// Gate H.52: the gaps found by reviewing the existing concurrency suites, against babysunray_test with fictional data.
// (1) An Owner-assisted order and a guest checkout (the inactive service) racing for the last unit. (2) A database
// connection killed while an order is in flight, as a restart or a failover does. (3) The maintenance run overlapping
// ordinary traffic on a pool of two connections. Contested rows are held from another session until PostgreSQL reports
// every attempt blocked, so the overlap is proven rather than hoped for.

let db: Db;
let pool: Pool;
let owner: Principal;
const key = () => randomUUID();
const tag = `h52${Date.now().toString(36)}`;
const url = () => assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
const DHAKA = 6_000;
const OWNER_CUSTOMER = { customerName: "Test Customer", customerPhone: "+880 1711-000052", deliveryAddress: "House 1, Road 2, Test Area", deliveryZone: "dhaka_city" as const };

beforeAll(async () => {
  ({ db, pool } = await createTestDb(8));
  await clearAuthState(pool);
  ({ principal: owner } = await createVerifiedOwner(createTestAuth(db), db, pool, "concurrency-owner@example.test"));
  const zones = await pool.query<{ code: string; version: number }>("select code, version from delivery_zones");
  for (const [code, charge] of [["dhaka_city", DHAKA], ["outside_dhaka", 12_000]] as const) {
    await setDeliveryZoneOnce(db, owner, key(), { code, chargePaisa: charge, active: true, expectedVersion: zones.rows.find((z) => z.code === code)?.version ?? null });
  }
});

afterAll(async () => {
  await pool?.end();
});

async function newSku(stock: number, publish = false) {
  const slug = `${tag}-${Math.random().toString(36).slice(2, 8)}`;
  const product = await createProduct(db, { slug, nameEn: "Concurrency Romper", nameBn: "Romper bn", descriptionEn: "Fictional.", descriptionBn: "Fictional bn." });
  const variant = await createVariant(db, { productId: product.id, sku: slug.toUpperCase(), size: "0-3M", colour: "Ivory", pricePaisa: 85_000 });
  if (stock) await receiveStock(db, { sku: variant.sku, quantity: stock, actor: TEST_ACTOR });
  if (publish) await publishNow(db, owner, product.id);
  return { variantId: variant.id, sku: variant.sku, pricePaisa: 85_000 };
}
const ownerOrder = (d: Db, sku: string, k = key()) => submitOrderOnce(d, owner, k, { source: "whatsapp", ...OWNER_CUSTOMER, items: [{ sku, quantity: 1 }] });
const guestOrder = (d: Db, s: { sku: string; pricePaisa: number }) =>
  placeGuestOrder(d, key(), {
    customer: { name: "Guest Tester", phone: "01711 000 252", address: "House 5, Road 6, Test Town" },
    deliveryZone: "dhaka_city",
    items: [{ sku: s.sku, quantity: 1, unitPricePaisa: s.pricePaisa }],
    deliveryChargePaisa: DHAKA,
    totalPaisa: s.pricePaisa + DHAKA,
  });
const reserved = (variantId: string) => count(pool, "select reserved from inventory_balances where variant_id = $1", [variantId]);
const holds = (variantId: string) => count(pool, "select count(*) from stock_reservations where variant_id = $1 and status = 'active'", [variantId]);
const blockedSessions = () => count(pool, "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");

async function untilBlocked(n: number) {
  const deadline = Date.now() + 10_000;
  while ((await blockedSessions()) < n) {
    if (Date.now() > deadline) throw new Error(`Fewer than ${n} attempts were blocked.`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("an Owner-assisted order and a guest checkout for the last unit", () => {
  it("exactly one wins, whichever commits first; the loser creates nothing and the stock agrees", async () => {
    const racing = await createTestDb(4);
    const gate = await pool.connect();
    try {
      const a = await newSku(1, true);
      const before = { orders: await count(pool, "select count(*) from orders"), submissions: await count(pool, "select count(*) from guest_checkout_submissions") };
      await gate.query("begin");
      await gate.query("select 1 from inventory_balances where variant_id = $1 for update", [a.variantId]);
      const settled = [ownerOrder(racing.db, a.sku), guestOrder(racing.db, a)].map((p) => p.then(() => "won", (e: { code?: string }) => e.code ?? "failed"));
      await untilBlocked(2);
      await gate.query("commit");
      const outcomes = await Promise.all(settled);
      expect(outcomes.filter((o) => o === "won")).toHaveLength(1);
      expect(outcomes.filter((o) => o !== "won")).toEqual(["INSUFFICIENT_STOCK"]);
      expect(await count(pool, "select count(*) from orders")).toBe(before.orders + 1);
      expect(await reserved(a.variantId)).toBe(1);
      expect(await holds(a.variantId)).toBe(1);
      // A guest submission row exists only if the guest attempt is the one that won.
      const guestWon = outcomes[1] === "won";
      expect(await count(pool, "select count(*) from guest_checkout_submissions")).toBe(before.submissions + (guestWon ? 1 : 0));
    } finally {
      gate.release();
      await racing.pool.end();
    }
  });
});

describe("a database connection killed while an order is in flight", () => {
  it("fails that attempt, leaves nothing half-written, and the same key then works once on a replaced connection", async () => {
    const victim = createPool(url(), { ...poolSettingsFor(url(), { DATABASE_RUNTIME: "serverless", DATABASE_POOL_MAX: "1" }), connectionTimeoutMillis: 3_000 });
    const gate = await pool.connect();
    try {
      const a = await newSku(1);
      const k = key();
      const ordersBefore = await count(pool, "select count(*) from orders");
      const claimsBefore = await count(pool, "select count(*) from idempotency_records");
      await gate.query("begin");
      await gate.query("select 1 from inventory_balances where variant_id = $1 for update", [a.variantId]);
      const attempt = ownerOrder(drizzle({ client: victim }), a.sku, k).then(() => "committed", () => "failed");
      await untilBlocked(1);
      const { rows } = await pool.query<{ pid: number }>("select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");
      expect(rows).toHaveLength(1);
      expect((await pool.query<{ ok: boolean }>("select pg_terminate_backend($1) as ok", [rows[0].pid])).rows[0].ok).toBe(true);
      expect(await attempt).toBe("failed");
      await gate.query("rollback");

      expect(await count(pool, "select count(*) from orders")).toBe(ordersBefore);
      expect(await count(pool, "select count(*) from idempotency_records")).toBe(claimsBefore);
      expect(await reserved(a.variantId)).toBe(0);
      expect(await holds(a.variantId)).toBe(0);

      // The pool drops the broken connection and opens a new one; the client's retry with the same key places exactly one order.
      const retry = await ownerOrder(drizzle({ client: victim }), a.sku, k);
      expect(retry.value.orderStatus).toBe("pending_verification");
      expect(await count(pool, "select count(*) from orders")).toBe(ordersBefore + 1);
      expect(await reserved(a.variantId)).toBe(1);
    } finally {
      gate.release();
      await victim.end();
    }
  });
});

describe("the maintenance run overlapping ordinary traffic on a pool of two connections", () => {
  it("everything completes, the overdue order is expired once and its stock freed for a new order", async () => {
    const two = createPool(url(), { ...poolSettingsFor(url(), { DATABASE_RUNTIME: "serverless", DATABASE_POOL_MAX: "2" }), connectionTimeoutMillis: 5_000 });
    try {
      const tdb = drizzle({ client: two });
      const stale = await newSku(1);
      const { value: staleOrder } = await ownerOrder(db, stale.sku);
      await pool.query("update orders set verification_expires_at = now() - interval '1 minute' where id = $1", [staleOrder.id]);
      const fresh = await Promise.all(Array.from({ length: 5 }, () => newSku(1)));

      const [m1, m2, ...orders] = await Promise.all([
        runMaintenance(tdb),
        runMaintenance(tdb),
        ...fresh.map((s) => ownerOrder(tdb, s.sku)),
        ownerOrder(tdb, stale.sku), // takes the unit the overdue hold still shows, whether or not a run got there first
      ]);
      expect([m1.status, m2.status]).toEqual(["ok", "ok"]);
      expect(orders.every((o) => "value" in o && o.value.orderStatus === "pending_verification")).toBe(true);
      expect((await getOrderDetail(db, staleOrder.id)).events.filter((e) => e.event === "verification_expired")).toHaveLength(1);
      expect(await holds(stale.variantId)).toBe(1); // only the new order holds the unit
      expect(await reserved(stale.variantId)).toBe(1);
    } finally {
      await two.end();
    }
  });
});
