import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/database";
import type { Principal } from "../../src/modules/auth/principal";
import { updateVariant } from "../../src/modules/catalogue/service";
import { adjustStockOnce } from "../../src/modules/inventory/operations";
import { getStockLevel, receiveStock } from "../../src/modules/inventory/service";
import {
  cancelOrderOnce,
  closeOrderOnce,
  confirmOrderOnce,
  createReturnOnce,
  createTrackingLinkOnce,
  deliverOrderOnce,
  dispatchOrderOnce,
  inspectQuarantineOnce,
  markRtoOnce,
  packOrderOnce,
  receiveRtoOnce,
  recordPaymentOnce,
  recordRtoChargeOnce,
  returnStepOnce,
  revokeTrackingLinkOnce,
  reviewCancellationOnce,
  setDeliveryZoneOnce,
  submitOrderOnce,
} from "../../src/modules/orders/operations";
import { getOrderDetail } from "../../src/modules/orders/queries";
import { dhakaToday } from "../../src/modules/orders/rules";
import { expireOverdueVerifications } from "../../src/modules/orders/service";
import { guestCancel, guestView } from "../../src/modules/orders/tracking";
import { clearAuthState, count, createTestAuth, createVerifiedOwner } from "../support/auth";
import { createTestVariant, errorCodeOf, TEST_ACTOR, withFailingInserts } from "../support/fixtures";
import { createTestDb } from "../support/test-database";

// The order domain against PostgreSQL: atomic reservations, the lifecycle rules, expiry, cancellation, COD,
// returns, RTO and guest tracking (docs/product/order-policy-decisions.md). Concurrency tests hold the
// contested row from another session until PostgreSQL reports every attempt blocked, so overlap is proven.
// Fictional customers only (example names, 0171 test numbers).

let db: Db;
let pool: Pool;
let owner: Principal;
let ownerB: Principal;

const CUSTOMER = { customerName: "Test Customer", customerPhone: "+880 1711-000001", deliveryAddress: "House 1, Road 2, Test Area", deliveryZone: "dhaka_city" as "dhaka_city" | "outside_dhaka" };
const key = () => randomUUID();
const today = dhakaToday();

beforeAll(async () => {
  ({ db, pool } = await createTestDb(8));
  const auth = createTestAuth(db);
  await clearAuthState(pool);
  ({ principal: owner } = await createVerifiedOwner(auth, db, pool, "orders-owner@example.test"));
  ({ principal: ownerB } = await createVerifiedOwner(auth, db, pool, "orders-owner-b@example.test"));
  await pool.query("delete from auth_rate_limits");
  const zones = await pool.query<{ code: string; version: number }>("select code, version from delivery_zones");
  const version = (code: string) => zones.rows.find((z) => z.code === code)?.version ?? null;
  await setDeliveryZoneOnce(db, owner, key(), { code: "dhaka_city", chargePaisa: 6_000, active: true, expectedVersion: version("dhaka_city") });
  await setDeliveryZoneOnce(db, owner, key(), { code: "outside_dhaka", chargePaisa: 12_000, active: true, expectedVersion: version("outside_dhaka") });
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  // Every test checks the global invariant on the way out of the previous one.
  await expectReservationsConsistent();
});

async function newSku(stock: number, pricePaisa = 85_000) {
  const { variant, product } = await createTestVariant(db, "ord");
  if (pricePaisa !== 85_000) await updateVariant(db, variant.id, 1, { pricePaisa });
  if (stock > 0) await receiveStock(db, { sku: variant.sku, quantity: stock, actor: TEST_ACTOR });
  return { sku: variant.sku, variantId: variant.id, productId: product.id };
}

const submit = (items: { sku: string; quantity: number }[], extra: Partial<typeof CUSTOMER> = {}, k = key(), principal = owner) =>
  submitOrderOnce(db, principal, k, { source: "whatsapp", ...CUSTOMER, ...extra, items });

const level = (sku: string) => getStockLevel(db, sku);
const v = async (orderId: string) => (await getOrderDetail(db, orderId)).version;
const step = async <T>(op: (db: Db, p: Principal, k: string, i: { orderId: string; expectedVersion: number }) => Promise<T>, orderId: string) =>
  op(db, owner, key(), { orderId, expectedVersion: await v(orderId) });

async function confirmedPacked(sku: string, quantity = 1) {
  const { value } = await submit([{ sku, quantity }]);
  await step(confirmOrderOnce, value.id);
  await step(packOrderOnce, value.id);
  return value.id;
}

async function delivered(sku: string, quantity = 1) {
  const id = await confirmedPacked(sku, quantity);
  await step(dispatchOrderOnce, id);
  await step(deliverOrderOnce, id);
  return id;
}

/** The invariant: for every SKU, the balance's reserved equals the sum of its active holds, and never exceeds on-hand. */
async function expectReservationsConsistent() {
  const bad = await count(
    pool,
    `select count(*) from inventory_balances b
      where b.reserved <> coalesce((select sum(quantity) from stock_reservations r where r.variant_id = b.variant_id and r.status = 'active'), 0)
         or b.reserved > b.on_hand`,
  );
  expect(bad).toBe(0);
  // A cancelled, expired or dispatched order never keeps an active hold.
  expect(
    await count(pool, "select count(*) from stock_reservations r join orders o on o.id = r.order_id where r.status = 'active' and (o.order_status in ('cancelled', 'verification_expired', 'closed') or o.fulfilment_status not in ('unfulfilled', 'packed'))"),
  ).toBe(0);
}

const overdue = (orderId: string) => pool.query("update orders set verification_expires_at = now() - interval '1 minute' where id = $1", [orderId]);
const orderCount = () => count(pool, "select count(*) from orders");

/** Runs every attempt on its own connection while `lockSql` holds the row, then lets them go at once. */
async function race(lockSql: string, id: string, attempts: (racingDb: Db) => Promise<unknown>[], waitingLike = "%", blocked?: number) {
  const { db: racingDb, pool: racingPool } = await createTestDb(6);
  const gate = await pool.connect();
  try {
    await gate.query("begin");
    await gate.query(lockSql, [id]);
    const runs = attempts(racingDb).map((p) => p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error: error as { code?: string } })));
    const deadline = Date.now() + 10_000;
    for (;;) {
      const waiting = await count(pool, "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like $1", [waitingLike]);
      if (waiting >= (blocked ?? runs.length)) break;
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

describe("submission and reservation", () => {
  it("1. holds every ordered unit at submission, snapshots prices and the delivery charge, and starts Pending Verification", async () => {
    const a = await newSku(5, 50_000);
    const b = await newSku(2, 30_000);
    const { value, replayed } = await submit([{ sku: a.sku.toLowerCase(), quantity: 2 }, { sku: b.sku, quantity: 1 }, { sku: a.sku, quantity: 1 }]);
    expect(replayed).toBe(false);
    expect(value).toMatchObject({
      orderStatus: "pending_verification",
      fulfilmentStatus: "unfulfilled",
      paymentStatus: "unpaid",
      returnStatus: "none",
      customerPhone: "01711000001",
      subtotalPaisa: 3 * 50_000 + 30_000,
      deliveryChargePaisa: 6_000,
      totalPaisa: 3 * 50_000 + 30_000 + 6_000,
    });
    // Two lines for the same SKU are merged into one.
    expect(value.items.map((i) => [i.sku, i.quantity, i.unitPricePaisa, i.lineTotalPaisa])).toEqual(
      [[a.sku, 3, 50_000, 150_000], [b.sku, 1, 30_000, 30_000]].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
    expect(value.verificationExpiresAt.getTime() - value.createdAt.getTime()).toBe(24 * 3_600_000);
    expect(await level(a.sku)).toMatchObject({ onHand: 5, reserved: 3, available: 2 });
    expect(await level(b.sku)).toMatchObject({ onHand: 2, reserved: 1, available: 1 });
    expect(value.reservations.map((r) => r.status)).toEqual(["active", "active"]);
    expect(value.events.map((e) => [e.event, e.actorType])).toEqual([["submitted", "user"]]);
  });

  it("3. a multi-SKU submission with one short line creates nothing at all", async () => {
    const a = await newSku(5);
    const b = await newSku(1);
    const before = await orderCount();
    expect(await errorCodeOf(submit([{ sku: a.sku, quantity: 2 }, { sku: b.sku, quantity: 2 }]))).toBe("INSUFFICIENT_STOCK");
    expect(await orderCount()).toBe(before);
    expect(await level(a.sku)).toMatchObject({ reserved: 0 });
    expect(await count(pool, "select count(*) from order_items where variant_id = $1", [a.variantId])).toBe(0);
  });

  it("rolls back everything when the database fails in the middle of a submission", async () => {
    const a = await newSku(3);
    const before = await orderCount();
    expect(await errorCodeOf(withFailingInserts(pool, "stock_reservations", () => submit([{ sku: a.sku, quantity: 1 }])))).toBe("P0001");
    expect(await orderCount()).toBe(before);
    expect(await level(a.sku)).toMatchObject({ reserved: 0 });
    expect(await count(pool, "select count(*) from idempotency_records where operation = 'orders.submit' and result is null")).toBe(0);
  });

  it("4. the same key submits once, also after a lost response; another Owner's identical key is a separate order", async () => {
    const a = await newSku(5);
    const k = key();
    const first = await submit([{ sku: a.sku, quantity: 1 }], {}, k);
    const retry = await submit([{ sku: a.sku, quantity: 1 }], {}, k);
    expect(retry.replayed).toBe(true);
    expect(retry.value.id).toBe(first.value.id);
    expect(await errorCodeOf(submit([{ sku: a.sku, quantity: 2 }], {}, k))).toBe("IDEMPOTENCY_KEY_REUSED");
    const other = await submit([{ sku: a.sku, quantity: 1 }], {}, k, ownerB);
    expect(other.value.id).not.toBe(first.value.id);
    expect(await level(a.sku)).toMatchObject({ reserved: 2 });
  });

  it("5. a fresh order sees only unreserved stock; no backorders", async () => {
    const a = await newSku(3);
    await submit([{ sku: a.sku, quantity: 2 }]);
    expect(await errorCodeOf(submit([{ sku: a.sku, quantity: 2 }]))).toBe("INSUFFICIENT_STOCK");
    await submit([{ sku: a.sku, quantity: 1 }]);
    expect(await level(a.sku)).toMatchObject({ onHand: 3, reserved: 3, available: 0 });
    expect(await errorCodeOf(submit([{ sku: a.sku, quantity: 1 }]))).toBe("INSUFFICIENT_STOCK");
  });

  it("6. a stock adjustment cannot take on-hand below what orders have reserved", async () => {
    const a = await newSku(5);
    await submit([{ sku: a.sku, quantity: 4 }]);
    expect(await errorCodeOf(adjustStockOnce(db, owner, key(), { sku: a.sku, quantityDelta: -2, reason: "Recount" }))).toBe("INSUFFICIENT_STOCK");
    await adjustStockOnce(db, owner, key(), { sku: a.sku, quantityDelta: -1, reason: "Recount" });
    expect(await level(a.sku)).toMatchObject({ onHand: 4, reserved: 4, available: 0 });
  });

  it.each([
    ["an unconfigured zone", async () => pool.query("update delivery_zones set active = false where code = 'outside_dhaka'"), "outside_dhaka"],
  ])("22. refuses %s and an inactive SKU, creating nothing", async (_name, arrange, zone) => {
    const a = await newSku(2);
    await arrange();
    try {
      expect(await errorCodeOf(submit([{ sku: a.sku, quantity: 1 }], { deliveryZone: zone as "outside_dhaka" }))).toBe("DELIVERY_ZONE_UNAVAILABLE");
    } finally {
      await pool.query("update delivery_zones set active = true where code = 'outside_dhaka'");
    }
    await pool.query("update variants set status = 'inactive', version = version + 1 where id = $1", [a.variantId]);
    expect(await errorCodeOf(submit([{ sku: a.sku, quantity: 1 }]))).toBe("VARIANT_NOT_ORDERABLE");
    expect(await errorCodeOf(submit([{ sku: "NO-SUCH-SKU", quantity: 1 }]))).toBe("VARIANT_NOT_FOUND");
    expect(await level(a.sku)).toMatchObject({ reserved: 0 });
  });

  it("validates contact details, quantities and lines on the server", async () => {
    const a = await newSku(2);
    for (const [extra, items] of [
      [{ customerPhone: "01211000000" }, [{ sku: a.sku, quantity: 1 }]],
      [{ customerPhone: "0171100000" }, [{ sku: a.sku, quantity: 1 }]],
      [{ customerPhone: "+44 1711000001" }, [{ sku: a.sku, quantity: 1 }]],
      [{ customerName: "  " }, [{ sku: a.sku, quantity: 1 }]],
      [{ deliveryAddress: "" }, [{ sku: a.sku, quantity: 1 }]],
      [{}, []],
      [{}, [{ sku: a.sku, quantity: 0 }]],
      [{}, [{ sku: a.sku, quantity: 1.5 }]],
      [{}, [{ sku: a.sku, quantity: 1001 }]],
    ] as const) {
      expect(await errorCodeOf(submit(items as never, extra as never)), JSON.stringify(extra)).toBe("INVALID_INPUT");
    }
    for (const phone of ["01711000001", "+8801711000001", "8801711000001", "0171 1000 001", "017-11-000001", "1711000001"]) {
      const { value } = await submit([{ sku: a.sku, quantity: 1 }], { customerPhone: phone });
      expect(value.customerPhone).toBe("01711000001");
      await step(cancelOrderOnce, value.id);
    }
  });

  it("20, 21. later price and delivery-rate changes never alter an existing order", async () => {
    const a = await newSku(2, 40_000);
    const { value } = await submit([{ sku: a.sku, quantity: 1 }]);
    await updateVariant(db, a.variantId, 2, { pricePaisa: 99_000 });
    const zone = (await pool.query("select version, charge_paisa from delivery_zones where code = 'dhaka_city'")).rows[0];
    await setDeliveryZoneOnce(db, owner, key(), { code: "dhaka_city", chargePaisa: 9_900, active: true, expectedVersion: zone.version });
    const after = await getOrderDetail(db, value.id);
    expect([after.items[0].unitPricePaisa, after.deliveryChargePaisa, after.totalPaisa]).toEqual([40_000, 6_000, 46_000]);
    const next = await submit([{ sku: a.sku, quantity: 1 }]);
    expect([next.value.items[0].unitPricePaisa, next.value.deliveryChargePaisa]).toEqual([99_000, 9_900]);
    const restored = (await pool.query("select version from delivery_zones where code = 'dhaka_city'")).rows[0];
    await setDeliveryZoneOnce(db, owner, key(), { code: "dhaka_city", chargePaisa: 6_000, active: true, expectedVersion: restored.version });
  });
});

describe("verification, expiry and confirmation", () => {
  it("7. confirming before the deadline keeps the reservation", async () => {
    const a = await newSku(2);
    const { value } = await submit([{ sku: a.sku, quantity: 2 }]);
    const { value: confirmed } = await step(confirmOrderOnce, value.id);
    expect(confirmed.orderStatus).toBe("confirmed");
    expect(confirmed.reservations.map((r) => r.status)).toEqual(["active"]);
    expect(await level(a.sku)).toMatchObject({ reserved: 2 });
  });

  it("12, 13. expiry after 24 hours releases the hold without cancelling; running it again changes nothing", async () => {
    const a = await newSku(2);
    const { value } = await submit([{ sku: a.sku, quantity: 2 }]);
    await overdue(value.id);
    expect(await expireOverdueVerifications(db)).toBeGreaterThanOrEqual(1);
    const after = await getOrderDetail(db, value.id);
    expect(after).toMatchObject({ orderStatus: "verification_expired", closedAt: null });
    expect(after.reservations.map((r) => [r.status, r.releaseReason])).toEqual([["released", "expired"]]);
    expect(after.events.at(-1)).toMatchObject({ event: "verification_expired", actorType: "system", actorRef: "verification-expiry" });
    expect(await level(a.sku)).toMatchObject({ reserved: 0, available: 2 });
    expect(await expireOverdueVerifications(db)).toBe(0);
    expect((await getOrderDetail(db, value.id)).events.filter((e) => e.event === "verification_expired")).toHaveLength(1);
  });

  it("14. an overdue hold that no runner has released yet never blocks a fresh order", async () => {
    const a = await newSku(1);
    const { value } = await submit([{ sku: a.sku, quantity: 1 }]);
    await overdue(value.id);
    const fresh = await submit([{ sku: a.sku, quantity: 1 }]);
    expect(fresh.value.orderStatus).toBe("pending_verification");
    expect((await getOrderDetail(db, value.id)).orderStatus).toBe("verification_expired");
  });

  it("15. a late confirmation reserves again only if stock is available, and never revives the old hold", async () => {
    const a = await newSku(1);
    const { value } = await submit([{ sku: a.sku, quantity: 1 }]);
    await overdue(value.id);
    await expireOverdueVerifications(db);
    const other = await submit([{ sku: a.sku, quantity: 1 }]);
    expect(await errorCodeOf(step(confirmOrderOnce, value.id))).toBe("INSUFFICIENT_STOCK");
    expect((await getOrderDetail(db, value.id)).orderStatus).toBe("verification_expired");
    await step(cancelOrderOnce, other.value.id);
    const { value: confirmed } = await step(confirmOrderOnce, value.id);
    expect(confirmed.orderStatus).toBe("confirmed");
    expect(confirmed.reservations.map((r) => r.status)).toEqual(["released", "active"]);
    expect(confirmed.events.at(-1)?.detail).toEqual({ reservedAgain: true });
  });

  it("a confirmation that meets an unrecorded deadline treats the hold as expired and re-checks stock", async () => {
    const a = await newSku(2);
    const { value } = await submit([{ sku: a.sku, quantity: 2 }]);
    await overdue(value.id);
    const { value: confirmed } = await step(confirmOrderOnce, value.id);
    expect(confirmed.events.map((e) => e.event)).toEqual(["submitted", "verification_expired", "confirmed"]);
    expect(await level(a.sku)).toMatchObject({ reserved: 2 });
  });

  it("refuses a stale version instead of applying a transition from an outdated screen", async () => {
    const a = await newSku(1);
    const { value } = await submit([{ sku: a.sku, quantity: 1 }]);
    await confirmOrderOnce(db, owner, key(), { orderId: value.id, expectedVersion: value.version });
    expect(await errorCodeOf(cancelOrderOnce(db, owner, key(), { orderId: value.id, expectedVersion: value.version }))).toBe("VERSION_CONFLICT");
    expect((await getOrderDetail(db, value.id)).orderStatus).toBe("confirmed");
  });
});

describe("cancellation", () => {
  it("8. a pending order is cancelled once and its stock released once", async () => {
    const a = await newSku(2);
    const { value } = await submit([{ sku: a.sku, quantity: 2 }]);
    const { value: cancelled } = await step(cancelOrderOnce, value.id);
    expect(cancelled).toMatchObject({ orderStatus: "cancelled" });
    expect(cancelled.closedAt).not.toBeNull();
    expect(await level(a.sku)).toMatchObject({ reserved: 0 });
    expect(await errorCodeOf(step(cancelOrderOnce, value.id))).toBe("INVALID_TRANSITION");
    expect(await level(a.sku)).toMatchObject({ onHand: 2, reserved: 0 });
  });

  it("9, 10. a customer's request on a confirmed order changes no stock; the Owner's approval cancels exactly once", async () => {
    const a = await newSku(2);
    const id = await confirmedPacked(a.sku, 2);
    const { token } = (await createTrackingLinkOnce(db, owner, key(), { orderId: id })).value;
    const view = await guestCancel(db, token, "request", "Ordered twice by mistake");
    expect(view).toMatchObject({ cancellationRequested: true, canCancel: false, canRequestCancellation: false });
    expect(await level(a.sku)).toMatchObject({ reserved: 2 });
    // A repeated request is harmless; dispatch waits for the Owner's decision.
    expect(await guestCancel(db, token, "request")).toMatchObject({ cancellationRequested: true });
    expect(await count(pool, "select count(*) from cancellation_requests where order_id = $1", [id])).toBe(1);
    expect(await errorCodeOf(step(dispatchOrderOnce, id))).toBe("INVALID_TRANSITION");
    const { value: done } = await reviewCancellationOnce(db, owner, key(), { orderId: id, expectedVersion: await v(id), decision: "approve" });
    expect(done.orderStatus).toBe("cancelled");
    expect(done.cancellationRequests.map((r) => r.status)).toEqual(["approved"]);
    expect(await level(a.sku)).toMatchObject({ reserved: 0, onHand: 2 });
    expect(await errorCodeOf(reviewCancellationOnce(db, owner, key(), { orderId: id, expectedVersion: await v(id), decision: "approve" }))).toBe("INVALID_TRANSITION");
  });

  it("a rejected request leaves the order and its stock as they were", async () => {
    const a = await newSku(1);
    const id = await confirmedPacked(a.sku);
    const { token } = (await createTrackingLinkOnce(db, owner, key(), { orderId: id })).value;
    await guestCancel(db, token, "request");
    const { value } = await reviewCancellationOnce(db, owner, key(), { orderId: id, expectedVersion: await v(id), decision: "reject" });
    expect(value).toMatchObject({ orderStatus: "confirmed", fulfilmentStatus: "packed" });
    expect(await level(a.sku)).toMatchObject({ reserved: 1 });
    // Rejected: the customer may ask again.
    expect(await guestView(db, token)).toMatchObject({ canRequestCancellation: true });
  });

  it("11, 31. customer actions follow the stage: cancel while pending, request when confirmed, nothing once dispatched", async () => {
    const a = await newSku(3);
    const { value: pending } = await submit([{ sku: a.sku, quantity: 1 }]);
    const pendingToken = (await createTrackingLinkOnce(db, owner, key(), { orderId: pending.id })).value.token;
    expect(await guestView(db, pendingToken)).toMatchObject({ canCancel: true, canRequestCancellation: false });
    expect(await errorCodeOf(guestCancel(db, pendingToken, "request"))).toBe("INVALID_TRANSITION");
    expect(await guestCancel(db, pendingToken, "cancel")).toMatchObject({ orderStatus: "cancelled", canCancel: false });
    expect(await guestCancel(db, pendingToken, "cancel")).toMatchObject({ orderStatus: "cancelled" });
    expect((await getOrderDetail(db, pending.id)).events.filter((e) => e.event === "cancelled_by_customer")).toHaveLength(1);

    const id = await confirmedPacked(a.sku);
    const token = (await createTrackingLinkOnce(db, owner, key(), { orderId: id })).value.token;
    expect(await errorCodeOf(guestCancel(db, token, "cancel"))).toBe("INVALID_TRANSITION");
    await step(dispatchOrderOnce, id);
    expect(await guestView(db, token)).toMatchObject({ canCancel: false, canRequestCancellation: false });
    expect(await errorCodeOf(guestCancel(db, token, "request"))).toBe("INVALID_TRANSITION");
    expect(await errorCodeOf(step(cancelOrderOnce, id))).toBe("INVALID_TRANSITION");
    expect(await level(a.sku)).toMatchObject({ onHand: 2, reserved: 0 });
  });
});

describe("fulfilment and stock", () => {
  it("16, 17. dispatch lowers on-hand and reserved together once, with ledger rows; a repeat never deducts again", async () => {
    const a = await newSku(5);
    const b = await newSku(3);
    const { value } = await submit([{ sku: a.sku, quantity: 2 }, { sku: b.sku, quantity: 3 }]);
    await step(confirmOrderOnce, value.id);
    await step(packOrderOnce, value.id);
    const k = key();
    const version = await v(value.id);
    const first = await dispatchOrderOnce(db, owner, k, { orderId: value.id, expectedVersion: version });
    const replay = await dispatchOrderOnce(db, owner, k, { orderId: value.id, expectedVersion: version });
    expect([first.replayed, replay.replayed]).toEqual([false, true]);
    expect(await errorCodeOf(step(dispatchOrderOnce, value.id))).toBe("INVALID_TRANSITION");
    expect(await level(a.sku)).toMatchObject({ onHand: 3, reserved: 0 });
    expect(await level(b.sku)).toMatchObject({ onHand: 0, reserved: 0 });
    const ledger = await pool.query("select movement_type, quantity_delta, order_id, actor_type from stock_movements where order_id = $1 order by variant_id", [value.id]);
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.rows.every((r) => r.movement_type === "dispatch" && r.actor_type === "user")).toBe(true);
    expect(first.value.reservations.every((r) => r.status === "consumed")).toBe(true);
  });

  it("19. dispatch is all or nothing: a failure on one line leaves every line reserved", async () => {
    const a = await newSku(2);
    const b = await newSku(2);
    const { value } = await submit([{ sku: a.sku, quantity: 1 }, { sku: b.sku, quantity: 1 }]);
    await step(confirmOrderOnce, value.id);
    await step(packOrderOnce, value.id);
    expect(await errorCodeOf(withFailingInserts(pool, "stock_movements", () => step(dispatchOrderOnce, value.id)))).toBe("P0001");
    expect(await level(a.sku)).toMatchObject({ onHand: 2, reserved: 1 });
    expect(await level(b.sku)).toMatchObject({ onHand: 2, reserved: 1 });
    expect((await getOrderDetail(db, value.id)).fulfilmentStatus).toBe("packed");
  });

  it("18. refuses impossible transitions", async () => {
    const a = await newSku(2);
    const { value } = await submit([{ sku: a.sku, quantity: 1 }]);
    for (const op of [packOrderOnce, dispatchOrderOnce, deliverOrderOnce, markRtoOnce, receiveRtoOnce, closeOrderOnce]) {
      expect(await errorCodeOf(step(op, value.id))).toBe("INVALID_TRANSITION");
    }
    await step(confirmOrderOnce, value.id);
    expect(await errorCodeOf(step(confirmOrderOnce, value.id))).toBe("INVALID_TRANSITION");
    expect(await errorCodeOf(step(dispatchOrderOnce, value.id))).toBe("INVALID_TRANSITION");
    expect(await errorCodeOf(step(deliverOrderOnce, value.id))).toBe("INVALID_TRANSITION");
    expect(await errorCodeOf(confirmOrderOnce(db, owner, key(), { orderId: randomUUID(), expectedVersion: 1 }))).toBe("ORDER_NOT_FOUND");
  });

  it("delivered is not closed, and closing waits for every collected taka to be settled", async () => {
    const a = await newSku(1);
    const id = await delivered(a.sku);
    const order = await getOrderDetail(db, id);
    expect(order).toMatchObject({ fulfilmentStatus: "delivered", orderStatus: "confirmed", paymentStatus: "unpaid", closedAt: null });
    await recordPaymentOnce(db, owner, key(), { orderId: id, expectedVersion: await v(id), kind: "collected", amountPaisa: order.totalPaisa, occurredOn: today });
    expect(await errorCodeOf(step(closeOrderOnce, id))).toBe("INVALID_TRANSITION");
    await recordPaymentOnce(db, owner, key(), { orderId: id, expectedVersion: await v(id), kind: "settled", amountPaisa: order.totalPaisa, occurredOn: today });
    const { value: closed } = await step(closeOrderOnce, id);
    expect(closed).toMatchObject({ orderStatus: "closed", paymentStatus: "settled" });
    expect(closed.closedAt).not.toBeNull();
  });
});

describe("COD money", () => {
  it("23. collection and settlement are recorded separately, partially, and never automatically", async () => {
    const a = await newSku(1, 100_000);
    const id = await delivered(a.sku);
    const total = 106_000;
    const pay = async (kind: "collected" | "settled", amountPaisa: number, k = key()) =>
      (await recordPaymentOnce(db, owner, k, { orderId: id, expectedVersion: await v(id), kind, amountPaisa, occurredOn: today, reference: "Courier slip 7" })).value;
    expect(await errorCodeOf(pay("settled", 1))).toBe("INVALID_TRANSITION");
    expect(await pay("collected", 50_000)).toMatchObject({ paymentStatus: "partially_collected", codCollectedPaisa: 50_000, codSettledPaisa: 0 });
    expect(await pay("settled", 20_000)).toMatchObject({ paymentStatus: "partially_collected", codSettledPaisa: 20_000 });
    expect(await errorCodeOf(pay("settled", 40_000))).toBe("PAYMENT_LIMIT_EXCEEDED");
    expect(await errorCodeOf(pay("collected", total))).toBe("PAYMENT_LIMIT_EXCEEDED");
    expect(await pay("collected", total - 50_000)).toMatchObject({ paymentStatus: "collected" });
    expect(await pay("settled", total - 20_000)).toMatchObject({ paymentStatus: "settled", codSettledPaisa: total });
    expect(await count(pool, "select count(*) from payment_entries where order_id = $1", [id])).toBe(4);
  });

  it("24. a repeated money entry never counts twice: same key replays, a stale screen is refused", async () => {
    const a = await newSku(1);
    const id = await delivered(a.sku);
    const version = await v(id);
    const k = key();
    const input = { orderId: id, expectedVersion: version, kind: "collected" as const, amountPaisa: 10_000, occurredOn: today };
    await recordPaymentOnce(db, owner, k, input);
    const again = await recordPaymentOnce(db, owner, k, input);
    expect(again.replayed).toBe(true);
    expect(await errorCodeOf(recordPaymentOnce(db, owner, key(), input))).toBe("VERSION_CONFLICT");
    expect((await getOrderDetail(db, id)).codCollectedPaisa).toBe(10_000);
    expect(await errorCodeOf(recordPaymentOnce(db, owner, key(), { ...input, expectedVersion: await v(id), occurredOn: "2999-01-01" }))).toBe("INVALID_INPUT");
    expect(await errorCodeOf(pool.query("update payment_entries set amount_paisa = 1 where order_id = $1", [id]))).toBe("23001");
  });
});

describe("returns, RTO and inspection", () => {
  async function returnFlow(sku: string, reason: "size_or_preference" | "wrong_or_defective", kind: "return" | "exchange" = "return") {
    const id = await delivered(sku, 2);
    const order = await getOrderDetail(db, id);
    await recordPaymentOnce(db, owner, key(), { orderId: id, expectedVersion: order.version, kind: "collected", amountPaisa: order.totalPaisa, occurredOn: today });
    const { value } = await createReturnOnce(db, owner, key(), {
      orderId: id,
      expectedVersion: await v(id),
      kind,
      reason,
      items: [{ orderItemId: order.items[0].id, quantity: 1 }],
    });
    return { id, order: value, ret: value.returns[0] };
  }

  it("26, 27, 28. returned goods enter quarantine; a failed one never becomes sellable; a passed one is restocked once", async () => {
    const a = await newSku(3);
    const { id, ret, order } = await returnFlow(a.sku, "wrong_or_defective");
    expect(ret).toMatchObject({ status: "requested", shippingPaidBy: "business" });
    expect(order.returnStatus).toBe("requested");
    const r1 = await returnStepOnce(db, owner, key(), { orderId: id, returnId: ret.id, expectedVersion: await v(id), step: "receive", returnShippingCostPaisa: 8_000 });
    expect(r1.value.quarantine).toHaveLength(1);
    expect(await level(a.sku)).toMatchObject({ onHand: 1, available: 1 });
    expect(await errorCodeOf(returnStepOnce(db, owner, key(), { orderId: id, returnId: ret.id, expectedVersion: await v(id), step: "approve" }))).toBe("INVALID_TRANSITION");
    const item = r1.value.quarantine[0];
    await inspectQuarantineOnce(db, owner, key(), { orderId: id, quarantineItemId: item.id, expectedVersion: await v(id), outcome: "restock", note: "Unused, tags intact" });
    expect(await errorCodeOf(inspectQuarantineOnce(db, owner, key(), { orderId: id, quarantineItemId: item.id, expectedVersion: await v(id), outcome: "restock" }))).toBe("INVALID_TRANSITION");
    expect(await level(a.sku)).toMatchObject({ onHand: 2 });
    expect(await count(pool, "select count(*) from stock_movements where order_id = $1 and movement_type = 'return_restock'", [id])).toBe(1);

    const b = await newSku(3);
    const flow = await returnFlow(b.sku, "size_or_preference");
    expect(flow.ret.shippingPaidBy).toBe("customer");
    const received = await returnStepOnce(db, owner, key(), { orderId: flow.id, returnId: flow.ret.id, expectedVersion: await v(flow.id), step: "receive" });
    await inspectQuarantineOnce(db, owner, key(), { orderId: flow.id, quarantineItemId: received.value.quarantine[0].id, expectedVersion: await v(flow.id), outcome: "reject", note: "Washed" });
    expect(await level(b.sku)).toMatchObject({ onHand: 1 });
    expect(await count(pool, "select count(*) from stock_movements where order_id = $1 and movement_type = 'return_restock'", [flow.id])).toBe(0);
  });

  it("25. a refund needs an approved, inspected return and never exceeds the money collected or the goods' value", async () => {
    const a = await newSku(3, 50_000);
    const { id, ret } = await returnFlow(a.sku, "wrong_or_defective");
    const r = await returnStepOnce(db, owner, key(), { orderId: id, returnId: ret.id, expectedVersion: await v(id), step: "receive" });
    const refund = (amountPaisa: number) =>
      returnStepOnce(db, owner, key(), { orderId: id, returnId: ret.id, expectedVersion: 0, step: "refund", amountPaisa, method: "bkash", occurredOn: today }).catch((e) => Promise.reject(e));
    await inspectQuarantineOnce(db, owner, key(), { orderId: id, quarantineItemId: r.value.quarantine[0].id, expectedVersion: await v(id), outcome: "reject" });
    await returnStepOnce(db, owner, key(), { orderId: id, returnId: ret.id, expectedVersion: await v(id), step: "approve" });
    expect(await errorCodeOf(refund(1))).toBe("VERSION_CONFLICT");
    const tryRefund = async (amountPaisa: number) =>
      returnStepOnce(db, owner, key(), { orderId: id, returnId: ret.id, expectedVersion: await v(id), step: "refund", amountPaisa, method: "nagad", occurredOn: today, reference: "TX-1" });
    expect(await errorCodeOf(tryRefund(50_001))).toBe("PAYMENT_LIMIT_EXCEEDED");
    const { value } = await tryRefund(50_000);
    expect(value).toMatchObject({ refundedPaisa: 50_000, returnStatus: "resolved" });
    expect(value.returns[0].status).toBe("completed");
    expect(value.payments.at(-1)).toMatchObject({ kind: "refunded", method: "nagad", amountPaisa: 50_000 });
  });

  it("refuses a return after 7 days and one larger than what was delivered", async () => {
    const a = await newSku(2);
    const id = await delivered(a.sku);
    const order = await getOrderDetail(db, id);
    expect(await errorCodeOf(createReturnOnce(db, owner, key(), { orderId: id, expectedVersion: order.version, kind: "return", reason: "size_or_preference", items: [{ orderItemId: order.items[0].id, quantity: 2 }] }))).toBe("INVALID_INPUT");
    await pool.query("update orders set delivered_at = now() - interval '7 days 1 minute' where id = $1", [id]);
    expect(await errorCodeOf(createReturnOnce(db, owner, key(), { orderId: id, expectedVersion: order.version, kind: "return", reason: "size_or_preference", items: [{ orderItemId: order.items[0].id, quantity: 1 }] }))).toBe("INVALID_TRANSITION");
  });

  it("an exchange is inspected and decided, then completed without a refund or extra stock", async () => {
    const a = await newSku(3);
    const { id, ret } = await returnFlow(a.sku, "size_or_preference", "exchange");
    const r = await returnStepOnce(db, owner, key(), { orderId: id, returnId: ret.id, expectedVersion: await v(id), step: "receive" });
    await inspectQuarantineOnce(db, owner, key(), { orderId: id, quarantineItemId: r.value.quarantine[0].id, expectedVersion: await v(id), outcome: "restock" });
    await returnStepOnce(db, owner, key(), { orderId: id, returnId: ret.id, expectedVersion: await v(id), step: "approve" });
    expect(await errorCodeOf(returnStepOnce(db, owner, key(), { orderId: id, returnId: ret.id, expectedVersion: await v(id), step: "refund", amountPaisa: 1, method: "bkash", occurredOn: today }))).toBe("INVALID_TRANSITION");
    const { value } = await returnStepOnce(db, owner, key(), { orderId: id, returnId: ret.id, expectedVersion: await v(id), step: "complete" });
    expect(value.returnStatus).toBe("resolved");
    expect(await level(a.sku)).toMatchObject({ onHand: 2, reserved: 0 });
  });

  it("26. an RTO parcel goes to quarantine, never straight back to stock, with its charge recorded apart", async () => {
    const a = await newSku(2);
    const id = await confirmedPacked(a.sku, 2);
    await step(dispatchOrderOnce, id);
    await step(markRtoOnce, id);
    expect(await level(a.sku)).toMatchObject({ onHand: 0 });
    const { value } = await step(receiveRtoOnce, id);
    expect(value.fulfilmentStatus).toBe("rto_received");
    expect(value.quarantine.map((q) => [q.source, q.quantity, q.status])).toEqual([["rto", 2, "awaiting_inspection"]]);
    expect(await level(a.sku)).toMatchObject({ onHand: 0 });
    await recordRtoChargeOnce(db, owner, key(), { orderId: id, expectedVersion: await v(id), chargePaisa: 5_000 });
    expect(await errorCodeOf(step(closeOrderOnce, id))).toBe("INVALID_TRANSITION");
    await inspectQuarantineOnce(db, owner, key(), { orderId: id, quarantineItemId: value.quarantine[0].id, expectedVersion: await v(id), outcome: "restock" });
    expect(await level(a.sku)).toMatchObject({ onHand: 2, reserved: 0 });
    const { value: closed } = await step(closeOrderOnce, id);
    expect(closed).toMatchObject({ orderStatus: "closed", rtoChargePaisa: 5_000, totalPaisa: closed.subtotalPaisa + closed.deliveryChargePaisa });
  });
});

describe("guest tracking", () => {
  it("29, 30. only a live token opens its own order, masked; malformed, unknown, revoked and expired ones look the same", async () => {
    const a = await newSku(2);
    const { value: mine } = await submit([{ sku: a.sku, quantity: 1 }], { customerName: "Rahima Test", customerPhone: "01811000002" });
    const { value: theirs } = await submit([{ sku: a.sku, quantity: 1 }], { customerName: "Other Test" });
    const { token } = (await createTrackingLinkOnce(db, owner, key(), { orderId: mine.id })).value;
    const other = (await createTrackingLinkOnce(db, owner, key(), { orderId: theirs.id })).value.token!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const view = await guestView(db, token);
    expect(view).toMatchObject({ customer: { name: "R***", phone: "018******02" }, deliveryZone: "Dhaka City", orderStatus: "pending_verification" });
    const json = JSON.stringify(view);
    for (const secret of ["Rahima", "01811000002", "House 1", mine.id, a.variantId]) expect(json).not.toContain(secret);
    expect((await guestView(db, other))?.customer.name).toBe("O***");
    // Only the digest is stored.
    expect(await count(pool, "select count(*) from order_tracking_tokens where token_hash = $1 or token_hash like $2", [token, `%${token!.slice(0, 10)}%`])).toBe(0);

    for (const bad of [undefined, "", "x", `${token}x`, token!.replace(/.$/, token!.endsWith("A") ? "B" : "A"), String(mine.number), "01811000002"]) {
      expect(await guestView(db, bad)).toBeNull();
    }
    const replaced = (await createTrackingLinkOnce(db, owner, key(), { orderId: mine.id })).value.token;
    expect(await guestView(db, token)).toBeNull();
    expect(await guestView(db, replaced)).not.toBeNull();
    await revokeTrackingLinkOnce(db, owner, key(), { orderId: mine.id });
    expect(await guestView(db, replaced)).toBeNull();

    await step(cancelOrderOnce, theirs.id);
    expect(await guestView(db, other)).not.toBeNull();
    await pool.query("update orders set closed_at = now() - interval '30 days 1 minute' where id = $1", [theirs.id]);
    expect(await guestView(db, other)).toBeNull();
  });

  it("a replayed link creation returns no token, and the link it created keeps working", async () => {
    const a = await newSku(1);
    const { value } = await submit([{ sku: a.sku, quantity: 1 }]);
    const k = key();
    const first = await createTrackingLinkOnce(db, owner, k, { orderId: value.id });
    const again = await createTrackingLinkOnce(db, owner, k, { orderId: value.id });
    expect([again.replayed, again.value.token]).toEqual([true, null]);
    expect(await guestView(db, first.value.token)).not.toBeNull();
    expect(await count(pool, "select count(*) from order_tracking_tokens where order_id = $1", [value.id])).toBe(1);
  });
});

describe("concurrency", () => {
  const lockBalance = "select on_hand from inventory_balances where variant_id = $1 for update";
  const lockOrderRow = "select id from orders where id = $1 for update";

  it("2. two orders for the last unit: exactly one wins, the other creates nothing", async () => {
    const a = await newSku(1);
    const before = await orderCount();
    const results = await race(lockBalance, a.variantId, (racing) => [1, 2].map(() => submitOrderOnce(racing, owner, key(), { source: "messenger", ...CUSTOMER, items: [{ sku: a.sku, quantity: 1 }] })), "%inventory_balances%");
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)?.error.code).toBe("INSUFFICIENT_STOCK");
    expect(await orderCount()).toBe(before + 1);
    expect(await level(a.sku)).toMatchObject({ onHand: 1, reserved: 1, available: 0 });
  });

  it("orders for the same SKUs in opposite order never deadlock", async () => {
    const a = await newSku(5);
    const b = await newSku(5);
    const results = await race(lockBalance, a.variantId, (racing) => [
      submitOrderOnce(racing, owner, key(), { source: "other", ...CUSTOMER, items: [{ sku: a.sku, quantity: 1 }, { sku: b.sku, quantity: 1 }] }),
      submitOrderOnce(racing, owner, key(), { source: "other", ...CUSTOMER, items: [{ sku: b.sku, quantity: 1 }, { sku: a.sku, quantity: 1 }] }),
    ], "%inventory_balances%");
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await level(a.sku)).toMatchObject({ reserved: 2 });
  });

  it("a stock adjustment racing an order never lets them consume the same units", async () => {
    const a = await newSku(3);
    const results = await race(lockBalance, a.variantId, (racing) => [
      submitOrderOnce(racing, owner, key(), { source: "other", ...CUSTOMER, items: [{ sku: a.sku, quantity: 2 }] }),
      adjustStockOnce(racing, owner, key(), { sku: a.sku, quantityDelta: -2, reason: "Damaged" }),
    ], "%inventory_balances%");
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const l = await level(a.sku);
    expect(l.onHand - l.reserved).toBeGreaterThanOrEqual(0);
    expect([l.onHand, l.reserved]).toEqual(results[0].ok ? [3, 2] : [1, 0]);
  });

  it("32. confirmation racing expiry, cancellation racing confirmation and dispatch: one outcome, stock consistent", { timeout: 60_000 }, async () => {
    const a = await newSku(4);
    const { value: expiring } = await submit([{ sku: a.sku, quantity: 1 }]);
    await overdue(expiring.id);
    const v1 = await v(expiring.id);
    const r1 = await race(lockOrderRow, expiring.id, (racing) => [
      confirmOrderOnce(racing, owner, key(), { orderId: expiring.id, expectedVersion: v1 }),
      // The expiry batch skips an order another transaction holds (SKIP LOCKED), so only the confirmation waits.
      racing.transaction((tx) => import("../../src/modules/orders/service").then((m) => m.expireIfOverdue(tx, expiring.id))),
    ], "%orders%", 1);
    const after1 = await getOrderDetail(db, expiring.id);
    expect(["confirmed", "verification_expired"]).toContain(after1.orderStatus);
    expect(after1.reservations.filter((r) => r.status === "active")).toHaveLength(after1.orderStatus === "confirmed" ? 1 : 0);
    expect(r1.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);

    const { value: contested } = await submit([{ sku: a.sku, quantity: 1 }]);
    const v2 = await v(contested.id);
    const r2 = await race(lockOrderRow, contested.id, (racing) => [
      confirmOrderOnce(racing, owner, key(), { orderId: contested.id, expectedVersion: v2 }),
      cancelOrderOnce(racing, owner, key(), { orderId: contested.id, expectedVersion: v2 }),
    ], "%orders%");
    expect(r2.filter((r) => r.ok)).toHaveLength(1);
    expect(r2.find((r) => !r.ok)?.error.code).toBe("VERSION_CONFLICT");

    const id = await confirmedPacked(a.sku);
    const v3 = await v(id);
    const r3 = await race(lockOrderRow, id, (racing) => [
      dispatchOrderOnce(racing, owner, key(), { orderId: id, expectedVersion: v3 }),
      dispatchOrderOnce(racing, owner, key(), { orderId: id, expectedVersion: v3 }),
      cancelOrderOnce(racing, owner, key(), { orderId: id, expectedVersion: v3 }),
    ], "%orders%");
    expect(r3.filter((r) => r.ok)).toHaveLength(1);
    expect(await count(pool, "select count(*) from stock_movements where order_id = $1", [id])).toBe((await getOrderDetail(db, id)).fulfilmentStatus === "dispatched" ? 1 : 0);
    await expectReservationsConsistent();
  });

  it("a customer's cancellation racing the Owner's: released exactly once", async () => {
    const a = await newSku(1);
    const { value } = await submit([{ sku: a.sku, quantity: 1 }]);
    const { token } = (await createTrackingLinkOnce(db, owner, key(), { orderId: value.id })).value;
    const version = await v(value.id);
    const results = await race(lockOrderRow, value.id, (racing) => [
      guestCancel(racing, token, "cancel"),
      cancelOrderOnce(racing, owner, key(), { orderId: value.id, expectedVersion: version }),
    ], "%orders%");
    expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
    const after = await getOrderDetail(db, value.id);
    expect(after.orderStatus).toBe("cancelled");
    expect(after.events.filter((e) => e.event.startsWith("cancelled_"))).toHaveLength(1);
    expect(await level(a.sku)).toMatchObject({ onHand: 1, reserved: 0 });
  });
});

describe("authorisation and audit", () => {
  it("every operation checks the verified principal first; history is append-only and names the user", async () => {
    const forged = { userId: (owner as { userId: string }).userId, role: "owner" } as Principal;
    const a = await newSku(1);
    expect(await errorCodeOf(submitOrderOnce(db, forged, key(), { source: "other", ...CUSTOMER, items: [{ sku: a.sku, quantity: 1 }] }))).toBe("UNAUTHENTICATED");
    expect(await errorCodeOf(setDeliveryZoneOnce(db, forged, key(), { code: "dhaka_city", chargePaisa: 0, active: true, expectedVersion: 1 }))).toBe("UNAUTHENTICATED");
    const { value } = await submit([{ sku: a.sku, quantity: 1 }]);
    expect(value.events[0]).toMatchObject({ actorType: "user", actorUserId: (owner as { userId: string }).userId });
    expect(await errorCodeOf(pool.query("update order_events set event = 'x' where order_id = $1", [value.id]))).toBe("23001");
    expect(await errorCodeOf(pool.query("delete from order_events where order_id = $1", [value.id]))).toBe("23001");
  });

  it("delivery charges: no amount until the Owner sets one, versioned edits, bounded amounts", async () => {
    const zones = await pool.query("select code, charge_paisa, active, version from delivery_zones order by code");
    expect(zones.rows.map((z) => z.code)).toEqual(["dhaka_city", "outside_dhaka"]);
    const current = zones.rows[0];
    expect(await errorCodeOf(setDeliveryZoneOnce(db, owner, key(), { code: "dhaka_city", chargePaisa: 1, active: true, expectedVersion: current.version - 1 }))).toBe("VERSION_CONFLICT");
    expect(await errorCodeOf(setDeliveryZoneOnce(db, owner, key(), { code: "dhaka_city", chargePaisa: 1_000_001, active: true, expectedVersion: current.version }))).toBe("INVALID_INPUT");
    expect(await errorCodeOf(setDeliveryZoneOnce(db, owner, key(), { code: "dhaka_city", chargePaisa: -1, active: true, expectedVersion: current.version }))).toBe("INVALID_INPUT");
    expect(await errorCodeOf(setDeliveryZoneOnce(db, owner, key(), { code: "chittagong" as "dhaka_city", chargePaisa: 1, active: true, expectedVersion: null }))).toBe("INVALID_INPUT");
  });
});
