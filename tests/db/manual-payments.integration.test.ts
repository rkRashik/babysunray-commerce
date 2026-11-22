import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/database";
import { getPrincipal, type Principal } from "../../src/modules/auth/principal";
import { inviteStaffOnce, redeemStaffLink } from "../../src/modules/auth/staff";
import { createProduct, createVariant } from "../../src/modules/catalogue/service";
import { DomainError } from "../../src/modules/domain-error";
import { receiveStock } from "../../src/modules/inventory/service";
import { refundAdvanceOnce, rejectReferenceOnce, reverseAdvanceOnce, verifyAdvanceOnce } from "../../src/modules/orders/advance";
import { bulkTransition } from "../../src/modules/orders/bulk";
import { placeGuestOrder } from "../../src/modules/orders/guest-checkout";
import {
  cancelOrderOnce,
  closeOrderOnce,
  confirmOrderOnce,
  deliverOrderOnce,
  dispatchOrderOnce,
  inspectQuarantineOnce,
  markRtoOnce,
  packOrderOnce,
  receiveRtoOnce,
  recordPaymentOnce,
  setDeliveryZoneOnce,
  submitOrderOnce,
} from "../../src/modules/orders/operations";
import { getOrderDetail, listOrders } from "../../src/modules/orders/queries";
import { dhakaToday } from "../../src/modules/orders/rules";
import { expireOverdueVerifications } from "../../src/modules/orders/service";
import { referenceFor, viewOf } from "../../src/modules/orders/tracking";
import { getOutstanding } from "../../src/modules/reports/summary";
import { enabledPaymentMethods, savePaymentMethodOnce } from "../../src/modules/settings/payments";
import { BASE_URL, clearAuthState, count, createTestAuth, createVerifiedOwner, headersWith, signIn } from "../support/auth";
import { errorCodeOf, TEST_ACTOR } from "../support/fixtures";
import { publishNow } from "../support/publication";
import { createTestDb } from "../support/test-database";

// Manual advance payments (ADR-0013) against PostgreSQL: methods off until the Owner enables them with complete, approved
// details; the website order records the chosen method; a customer's transaction ID never counts as money; only the
// Owner's verification does, at most what is still due, once per reference; verifying never confirms an order or revives
// its stock; a cancelled paid order shows a refund due until the refund is recorded by hand; reports keep COD and advance
// money apart and still reconcile. Fictional people and references only.

let db: Db;
let pool: Pool;
let owner: Principal;
let ordersStaff: Principal;
const key = () => randomUUID();
const DHAKA = 6_000;
const today = dhakaToday();
let counter = 0;

const blank = { accountName: null, accountNumber: null, accountKind: null, bankName: null, branchName: null, routingNumber: null, instructionsEn: null, instructionsBn: null };
const BKASH = { ...blank, method: "bkash", enabled: true, approved: true, accountName: "Test Shop", accountNumber: "01811 000 999", accountKind: "merchant", instructionsEn: "Use the order number as the reference." };

beforeAll(async () => {
  ({ db, pool } = await createTestDb(6));
  const auth = createTestAuth(db);
  await clearAuthState(pool);
  ({ principal: owner } = await createVerifiedOwner(auth, db, pool, "payments-owner@example.test"));
  await pool.query("delete from auth_rate_limits");
  await pool.query("delete from tracking_rate_limits");
  const { rows } = await pool.query<{ version: number }>("select version from delivery_zones where code = 'dhaka_city'");
  await setDeliveryZoneOnce(db, owner, key(), { code: "dhaka_city", chargePaisa: DHAKA, active: true, expectedVersion: rows[0]?.version ?? null });
  // Orders Staff, through a real invitation and sign-in.
  const invited = await inviteStaffOnce(db, owner, key(), { email: "payments-orders-staff@example.test", role: "orders" }, { send: null, baseUrl: BASE_URL, storeName: "Test" });
  await redeemStaffLink(db, { token: invited.token, name: "Payments Orders Staff", password: "a long staff password for tests" });
  const { cookie } = await signIn(auth, "payments-orders-staff@example.test", "a long staff password for tests");
  ordersStaff = (await getPrincipal(auth, db, headersWith(cookie)))!;
});

afterAll(async () => {
  await pool?.end();
});

async function publishedSku(stock: number, pricePaisa = 100_000) {
  counter += 1;
  const product = await createProduct(db, { slug: `pay-p-${counter}`, nameEn: "Payment Test Romper", nameBn: "পেমেন্ট পরীক্ষা রম্পার", descriptionEn: "Fictional.", descriptionBn: "কাল্পনিক।" });
  const variant = await createVariant(db, { productId: product.id, sku: `PAY-${counter}`, size: "6-12M", colour: "Ivory", pricePaisa });
  if (stock > 0) await receiveStock(db, { sku: variant.sku, quantity: stock, actor: TEST_ACTOR });
  await publishNow(db, owner, product.id);
  return { sku: variant.sku, variantId: variant.id, pricePaisa };
}

/** A website order as a customer places it (guest checkout), with the shown prices. */
async function websiteOrder(paymentMethod?: string, quantity = 1) {
  const s = await publishedSku(5);
  const result = await placeGuestOrder(db, randomUUID(), {
    customer: { name: "Advance Tester", phone: "01711 000 555", address: "House 7, Road 8, Test Town" },
    deliveryZone: "dhaka_city",
    items: [{ sku: s.sku, quantity, unitPricePaisa: s.pricePaisa }],
    deliveryChargePaisa: DHAKA,
    totalPaisa: s.pricePaisa * quantity + DHAKA,
    ...(paymentMethod ? { paymentMethod } : {}),
  });
  const { rows } = await pool.query<{ id: string }>("select id from orders where number = $1", [Number(result.order.reference.slice(4))]);
  return { ...result, orderId: rows[0].id, sku: s.sku, variantId: s.variantId };
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof DomainError ? error.code : "other";
  }
  return "allowed";
};
const detail = (orderId: string) => getOrderDetail(db, orderId);
const reserved = (variantId: string) => count(pool, "select reserved from inventory_balances where variant_id = $1", [variantId]);
const submissionOf = async (orderId: string) => (await detail(orderId)).advancePayments.find((a) => a.status === "submitted")!;

describe("payment methods", () => {
  it("are all off by default, so a website order can only be cash on delivery", async () => {
    expect(await enabledPaymentMethods(db)).toEqual([]);
    await expect(websiteOrder("bkash")).rejects.toMatchObject({ code: "PAYMENT_METHOD_UNAVAILABLE" });
    expect(await count(pool, "select count(*) from orders where payment_method <> 'cod'")).toBe(0);
  });

  it("refuse incomplete or unapproved details, a wallet number that is not a Bangladesh mobile, and bank details without a bank", async () => {
    const save = (input: Record<string, unknown>) => savePaymentMethodOnce(db, owner, key(), { ...blank, enabled: false, approved: false, expectedVersion: 0, method: "bkash", ...input } as Parameters<typeof savePaymentMethodOnce>[3]);
    expect(await code(save({ ...BKASH, approved: false }))).toBe("INVALID_INPUT");
    expect(await code(save({ ...BKASH, accountNumber: "12345" }))).toBe("INVALID_INPUT");
    expect(await code(save({ ...BKASH, accountKind: null }))).toBe("INVALID_INPUT");
    expect(await code(save({ method: "bank_transfer", enabled: true, approved: true, accountName: "Test Shop", accountNumber: "0123456789" }))).toBe("INVALID_INPUT");
    expect(await code(save({ method: "bank_transfer", accountKind: "merchant" }))).toBe("INVALID_INPUT");
    expect(await count(pool, "select count(*) from payment_methods")).toBe(0);
    // The database refuses an enabled method without its details or approval, even from a direct write.
    const { rows } = await pool.query<{ id: string }>("select id from auth_users where email = 'payments-owner@example.test'");
    expect(await errorCodeOf(pool.query("insert into payment_methods (method, enabled, updated_by_user_id) values ('nagad', true, $1)", [rows[0].id]))).toBe("23514");
  });

  it("an enabled method shows its receiving details to customers; staff cannot change it", async () => {
    await savePaymentMethodOnce(db, owner, key(), { ...BKASH, expectedVersion: 0 } as Parameters<typeof savePaymentMethodOnce>[3]);
    const [bkash] = await enabledPaymentMethods(db);
    expect(bkash).toMatchObject({ method: "bkash", accountName: "Test Shop", accountNumber: "01811000999", accountKind: "merchant" });
    expect(await count(pool, "select count(*) from payment_methods where method = 'bkash' and approved_at is not null and approved_by_user_id is not null")).toBe(1);
    expect(await code(savePaymentMethodOnce(db, ordersStaff, key(), { ...BKASH, expectedVersion: 1 } as Parameters<typeof savePaymentMethodOnce>[3]))).toBe("FORBIDDEN");
  });
});

describe("an advance payment order", () => {
  it("records the method, shows the exact total and where to send it, and stays unpaid until the Owner verifies", async () => {
    const placed = await websiteOrder("bkash");
    expect(placed.order.payment).toMatchObject({ method: "bkash", amountPaisa: placed.order.totalPaisa, details: { accountNumber: "01811000999" } });
    let order = await detail(placed.orderId);
    expect(order).toMatchObject({ paymentMethod: "bkash", orderStatus: "pending_verification", paymentStatus: "unpaid", advanceReceivedPaisa: 0 });
    let view = (await viewOf(db, placed.orderId))!;
    expect(view.payment).toMatchObject({ method: "bkash", state: "awaiting_payment", dueNowPaisa: order.totalPaisa, canSubmitReference: true });

    // The customer's transaction ID: awaiting verification, never paid.
    view = (await referenceFor(db, placed.orderId, " 9a7b 6c5d4e "))!;
    expect(view.payment.state).toBe("reference_submitted");
    expect(view.payment.verifiedPaisa).toBe(0);
    order = await detail(placed.orderId);
    expect(order).toMatchObject({ paymentStatus: "unpaid", advanceReceivedPaisa: 0 });
    expect(order.advancePayments).toMatchObject([{ reference: "9A7B6C5D4E", status: "submitted", source: "customer", amountPaisa: null }]);
    expect(await count(pool, "select count(*) from payment_entries where order_id = $1", [placed.orderId])).toBe(0);
    // Sending the same ID again changes nothing; an ID that is not shaped like one is refused.
    await referenceFor(db, placed.orderId, "9A7B6C5D4E");
    expect((await detail(placed.orderId)).advancePayments).toHaveLength(1);
    expect(await code(referenceFor(db, placed.orderId, "x"))).toBe("INVALID_INPUT");
    expect((await listOrders(db, { limit: 50, queue: "payment_to_verify" })).items.map((o) => o.id)).toContain(placed.orderId);

    // Orders Staff cannot verify money; the Owner does, once.
    const submission = await submissionOf(placed.orderId);
    expect(await code(verifyAdvanceOnce(db, ordersStaff, key(), { orderId: placed.orderId, expectedVersion: order.version, advancePaymentId: submission.id, amountPaisa: order.totalPaisa, receivedOn: today }))).toBe("FORBIDDEN");
    const k = key();
    const verify = { orderId: placed.orderId, expectedVersion: order.version, advancePaymentId: submission.id, amountPaisa: order.totalPaisa, receivedOn: today };
    const first = await verifyAdvanceOnce(db, owner, k, verify);
    const replay = await verifyAdvanceOnce(db, owner, k, verify);
    expect(replay.replayed).toBe(true);
    order = await detail(placed.orderId);
    expect(order).toMatchObject({ advanceReceivedPaisa: order.totalPaisa, paymentStatus: "settled", orderStatus: "pending_verification" });
    expect(first.value.version).toBe(order.version);
    expect(await count(pool, "select count(*) from payment_entries where order_id = $1 and kind = 'advance_received' and method = 'bkash' and reference = '9A7B6C5D4E'", [placed.orderId])).toBe(1);
    expect(await count(pool, "select count(*) from order_events where order_id = $1 and event = 'advance_verified' and actor_type = 'user'", [placed.orderId])).toBe(1);
    expect((await viewOf(db, placed.orderId))!.payment).toMatchObject({ state: "paid", dueNowPaisa: 0, canSubmitReference: false });
    // A second verification of the same reference is refused, and nothing more can be received.
    expect(await code(verifyAdvanceOnce(db, owner, key(), { ...verify, expectedVersion: order.version }))).not.toBe("allowed");
    expect(await code(verifyAdvanceOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version, advancePaymentId: null, method: "bkash", reference: "OTHERREF1", amountPaisa: 100, receivedOn: today }))).toBe("INVALID_TRANSITION");
    expect(await count(pool, "select count(*) from payment_entries where order_id = $1", [placed.orderId])).toBe(1);

    // The courier then has nothing to collect: COD collection is refused.
    await confirmOrderOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version });
    await packOrderOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: (await detail(placed.orderId)).version });
    await dispatchOrderOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: (await detail(placed.orderId)).version });
    await deliverOrderOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: (await detail(placed.orderId)).version });
    expect(await code(recordPaymentOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: (await detail(placed.orderId)).version, kind: "collected", amountPaisa: 100, occurredOn: today }))).toBe("INVALID_TRANSITION");
  });

  it("one transfer reference counts once across all orders", async () => {
    const a = await websiteOrder("bkash");
    const b = await websiteOrder("bkash");
    await referenceFor(db, a.orderId, "SHAREDREF77");
    await referenceFor(db, b.orderId, "SHAREDREF77");
    const orderA = await detail(a.orderId);
    await verifyAdvanceOnce(db, owner, key(), { orderId: a.orderId, expectedVersion: orderA.version, advancePaymentId: (await submissionOf(a.orderId)).id, amountPaisa: orderA.totalPaisa, receivedOn: today });
    const orderB = await detail(b.orderId);
    expect(await code(verifyAdvanceOnce(db, owner, key(), { orderId: b.orderId, expectedVersion: orderB.version, advancePaymentId: (await submissionOf(b.orderId)).id, amountPaisa: orderB.totalPaisa, receivedOn: today }))).toBe("INVALID_INPUT");
    expect(await code(verifyAdvanceOnce(db, owner, key(), { orderId: b.orderId, expectedVersion: orderB.version, advancePaymentId: null, method: "bkash", reference: "sharedref77", amountPaisa: 100, receivedOn: today }))).toBe("INVALID_INPUT");
    expect((await detail(b.orderId)).advanceReceivedPaisa).toBe(0);
  });

  it("a partial payment is not full payment, and more than is due is never recorded", async () => {
    const placed = await websiteOrder("bkash");
    await referenceFor(db, placed.orderId, "PARTREF001");
    let order = await detail(placed.orderId);
    expect(await code(verifyAdvanceOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version, advancePaymentId: (await submissionOf(placed.orderId)).id, amountPaisa: order.totalPaisa + 1, receivedOn: today }))).toBe("PAYMENT_LIMIT_EXCEEDED");
    await verifyAdvanceOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version, advancePaymentId: (await submissionOf(placed.orderId)).id, amountPaisa: 50_000, receivedOn: today });
    order = await detail(placed.orderId);
    expect(order).toMatchObject({ advanceReceivedPaisa: 50_000, paymentStatus: "partially_collected" });
    expect((await viewOf(db, placed.orderId))!.payment).toMatchObject({ state: "part_paid", dueNowPaisa: order.totalPaisa - 50_000, canSubmitReference: true });
    // The rest arrives later, recorded by the Owner from the statement (the customer sent no ID).
    await verifyAdvanceOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version, advancePaymentId: null, method: "nagad", reference: "NAGADREST9", amountPaisa: order.totalPaisa - 50_000, receivedOn: today });
    expect((await detail(placed.orderId)).paymentStatus).toBe("settled");
  });

  it("an advance order cannot be dispatched, singly or in bulk, until the whole amount is verified", async () => {
    const placed = await websiteOrder("bkash");
    await referenceFor(db, placed.orderId, "DISPREF001");
    let order = await detail(placed.orderId);
    await verifyAdvanceOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version, advancePaymentId: (await submissionOf(placed.orderId)).id, amountPaisa: order.totalPaisa - 100, receivedOn: today });
    await confirmOrderOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: (await detail(placed.orderId)).version });
    await packOrderOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: (await detail(placed.orderId)).version });
    order = await detail(placed.orderId);
    expect(await code(dispatchOrderOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version }))).toBe("INVALID_TRANSITION");
    const [bulk] = await bulkTransition(db, owner, key(), "dispatch", [{ orderId: placed.orderId, expectedVersion: order.version }]);
    expect(bulk.ok).toBe(false);
    expect(await reserved(placed.variantId)).toBe(1);
    await verifyAdvanceOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version, advancePaymentId: null, method: "bkash", reference: "DISPREF002", amountPaisa: 100, receivedOn: today });
    await dispatchOrderOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: (await detail(placed.orderId)).version });
    expect((await detail(placed.orderId)).fulfilmentStatus).toBe("dispatched");
  });

  it("a rejected reference tells the customer to contact the shop and lets them send another", async () => {
    const placed = await websiteOrder("bkash");
    await referenceFor(db, placed.orderId, "WRONGREF12");
    const order = await detail(placed.orderId);
    await rejectReferenceOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version, advancePaymentId: (await submissionOf(placed.orderId)).id, note: "No such transfer in the account" });
    const view = (await viewOf(db, placed.orderId))!;
    expect(view.payment).toMatchObject({ state: "reference_problem", canSubmitReference: true });
    expect((await referenceFor(db, placed.orderId, "RIGHTREF34"))!.payment.state).toBe("reference_submitted");
    // At most three references wait for the shop at once.
    await referenceFor(db, placed.orderId, "SPAMREF0001");
    await referenceFor(db, placed.orderId, "SPAMREF0002");
    expect(await code(referenceFor(db, placed.orderId, "SPAMREF0003"))).toBe("RATE_LIMITED");
  });

  it("a payment after the 24-hour window never revives the released stock", async () => {
    const placed = await websiteOrder("bkash");
    expect(await reserved(placed.variantId)).toBe(1);
    await pool.query("update orders set verification_expires_at = now() - interval '1 minute' where id = $1", [placed.orderId]);
    await expireOverdueVerifications(db);
    expect(await reserved(placed.variantId)).toBe(0);
    await referenceFor(db, placed.orderId, "LATEREF001");
    const order = await detail(placed.orderId);
    await verifyAdvanceOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version, advancePaymentId: (await submissionOf(placed.orderId)).id, amountPaisa: order.totalPaisa, receivedOn: today });
    const after = await detail(placed.orderId);
    expect(after).toMatchObject({ orderStatus: "verification_expired", advanceReceivedPaisa: order.totalPaisa });
    expect(await reserved(placed.variantId)).toBe(0);
    expect(after.reservations.every((r) => r.status === "released")).toBe(true);
  });

  it("cancelling an unpaid order releases its stock and owes nothing", async () => {
    const placed = await websiteOrder("bkash");
    await cancelOrderOnce(db, ordersStaff, key(), { orderId: placed.orderId, expectedVersion: (await detail(placed.orderId)).version });
    expect(await reserved(placed.variantId)).toBe(0);
    expect((await listOrders(db, { limit: 100, queue: "refund_due" })).items.map((o) => o.id)).not.toContain(placed.orderId);
  });

  it("a paid order can be cancelled only with payments:verify, then shows a refund due until the refund is recorded by hand", async () => {
    const placed = await websiteOrder("bkash");
    await referenceFor(db, placed.orderId, "PAIDCANCEL1");
    let order = await detail(placed.orderId);
    await verifyAdvanceOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version, advancePaymentId: (await submissionOf(placed.orderId)).id, amountPaisa: order.totalPaisa, receivedOn: today });
    order = await detail(placed.orderId);
    expect(await code(cancelOrderOnce(db, ordersStaff, key(), { orderId: placed.orderId, expectedVersion: order.version }))).toBe("FORBIDDEN");
    await cancelOrderOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version });
    order = await detail(placed.orderId);
    expect(order).toMatchObject({ orderStatus: "cancelled", advanceReceivedPaisa: order.totalPaisa, advanceRefundedPaisa: 0 });
    expect(await reserved(placed.variantId)).toBe(0);
    expect((await listOrders(db, { limit: 100, queue: "refund_due" })).items.map((o) => o.id)).toContain(placed.orderId);
    expect((await viewOf(db, placed.orderId))!.payment.state).toBe("refund_due");
    expect((await getOutstanding(db)).advanceRefundDue.count).toBeGreaterThan(0);

    expect(await code(refundAdvanceOnce(db, ordersStaff, key(), { orderId: placed.orderId, expectedVersion: order.version, amountPaisa: order.totalPaisa, method: "bkash", occurredOn: today }))).toBe("FORBIDDEN");
    expect(await code(refundAdvanceOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version, amountPaisa: order.totalPaisa + 1, method: "bkash", occurredOn: today }))).toBe("PAYMENT_LIMIT_EXCEEDED");
    await refundAdvanceOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version, amountPaisa: order.totalPaisa, method: "bkash", occurredOn: today, reference: "REFUND-1" });
    order = await detail(placed.orderId);
    expect(order.advanceRefundedPaisa).toBe(order.totalPaisa);
    expect((await listOrders(db, { limit: 100, queue: "refund_due" })).items.map((o) => o.id)).not.toContain(placed.orderId);
    // Money already paid back cannot be undone as a mistaken verification.
    const verified = order.advancePayments.find((a) => a.status === "verified")!;
    expect(await code(reverseAdvanceOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version, advancePaymentId: verified.id, note: "Mistake" }))).toBe("INVALID_TRANSITION");
  });

  it("a mistaken verification is undone by a reversing entry, history kept, and the reference can then be verified again", async () => {
    const placed = await websiteOrder("bkash");
    await referenceFor(db, placed.orderId, "UNDOREF0001");
    let order = await detail(placed.orderId);
    await verifyAdvanceOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version, advancePaymentId: (await submissionOf(placed.orderId)).id, amountPaisa: 40_000, receivedOn: today });
    order = await detail(placed.orderId);
    const verified = order.advancePayments.find((a) => a.status === "verified")!;
    await reverseAdvanceOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version, advancePaymentId: verified.id, note: "Amount misread" });
    order = await detail(placed.orderId);
    expect(order).toMatchObject({ advanceReceivedPaisa: 0, paymentStatus: "unpaid" });
    expect(await count(pool, "select count(*) from payment_entries where order_id = $1 and kind in ('advance_received', 'advance_reversed')", [placed.orderId])).toBe(2);
    await verifyAdvanceOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version, advancePaymentId: null, method: "bkash", reference: "UNDOREF0001", amountPaisa: order.totalPaisa, receivedOn: today });
    expect((await detail(placed.orderId)).paymentStatus).toBe("settled");
  });
});

describe("edge cases found in review", () => {
  it("a prepaid parcel that comes back cannot be closed while it holds the customer's money; the refund is due and then it closes", async () => {
    const placed = await websiteOrder("bkash");
    await referenceFor(db, placed.orderId, "RTOREF0001");
    let order = await detail(placed.orderId);
    await verifyAdvanceOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version, advancePaymentId: (await submissionOf(placed.orderId)).id, amountPaisa: order.totalPaisa, receivedOn: today });
    for (const op of [confirmOrderOnce, packOrderOnce, dispatchOrderOnce, markRtoOnce, receiveRtoOnce]) await op(db, owner, key(), { orderId: placed.orderId, expectedVersion: (await detail(placed.orderId)).version });
    order = await detail(placed.orderId);
    await inspectQuarantineOnce(db, owner, key(), { orderId: placed.orderId, quarantineItemId: order.quarantine[0].id, expectedVersion: order.version, outcome: "restock" });
    order = await detail(placed.orderId);
    expect(await code(closeOrderOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version }))).toBe("INVALID_TRANSITION");
    expect((await listOrders(db, { limit: 100, queue: "refund_due" })).items.map((o) => o.id)).toContain(placed.orderId);
    expect((await viewOf(db, placed.orderId))!.payment.state).toBe("refund_due");
    await refundAdvanceOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version, amountPaisa: order.totalPaisa, method: "bkash", occurredOn: today });
    await closeOrderOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: (await detail(placed.orderId)).version });
    expect((await detail(placed.orderId)).orderStatus).toBe("closed");
  });

  it("a cancelled order takes no customer reference, and its page says no payment is needed; a refunded one says so", async () => {
    const unpaid = await websiteOrder("bkash");
    await cancelOrderOnce(db, owner, key(), { orderId: unpaid.orderId, expectedVersion: (await detail(unpaid.orderId)).version });
    expect(await code(referenceFor(db, unpaid.orderId, "LATEREF999"))).toBe("INVALID_TRANSITION");
    expect((await viewOf(db, unpaid.orderId))!.payment).toMatchObject({ state: "not_needed", canSubmitReference: false, details: null });

    const paid = await websiteOrder("bkash");
    await referenceFor(db, paid.orderId, "REFUNDED001");
    let order = await detail(paid.orderId);
    await verifyAdvanceOnce(db, owner, key(), { orderId: paid.orderId, expectedVersion: order.version, advancePaymentId: (await submissionOf(paid.orderId)).id, amountPaisa: order.totalPaisa, receivedOn: today });
    await cancelOrderOnce(db, owner, key(), { orderId: paid.orderId, expectedVersion: (await detail(paid.orderId)).version });
    order = await detail(paid.orderId);
    await refundAdvanceOnce(db, owner, key(), { orderId: paid.orderId, expectedVersion: order.version, amountPaisa: order.totalPaisa, method: "bkash", occurredOn: today });
    expect((await viewOf(db, paid.orderId))!.payment.state).toBe("refunded");
  });

  it("recording a transfer the customer already sent verifies that submission instead of leaving it waiting", async () => {
    const placed = await websiteOrder("bkash");
    await referenceFor(db, placed.orderId, "SAMEREF0042");
    const order = await detail(placed.orderId);
    await verifyAdvanceOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version, advancePaymentId: null, method: "bkash", reference: "sameref0042", amountPaisa: order.totalPaisa, receivedOn: today });
    const after = await detail(placed.orderId);
    expect(after.advancePayments).toMatchObject([{ reference: "SAMEREF0042", status: "verified", source: "customer" }]);
    expect((await listOrders(db, { limit: 100, queue: "payment_to_verify" })).items.map((o) => o.id)).not.toContain(placed.orderId);
    expect((await viewOf(db, placed.orderId))!.payment.state).toBe("paid");
  });

  it("after ten references on one order the form is gone and the answer says to contact the shop", async () => {
    const placed = await websiteOrder("bkash");
    for (let n = 0; n < 10; n += 1) {
      await referenceFor(db, placed.orderId, `CAPREF${String(n).padStart(4, "0")}`);
      const order = await detail(placed.orderId);
      await rejectReferenceOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version, advancePaymentId: (await submissionOf(placed.orderId)).id, note: "Not in the account" });
    }
    expect((await viewOf(db, placed.orderId))!.payment.canSubmitReference).toBe(false);
    expect(await code(referenceFor(db, placed.orderId, "CAPREF9999"))).toBe("INVALID_TRANSITION");
  });

  it("a malformed payment id is an input error, not a failure", async () => {
    const placed = await websiteOrder("bkash");
    const order = await detail(placed.orderId);
    expect(await code(verifyAdvanceOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version, advancePaymentId: "x", amountPaisa: 100, receivedOn: today }))).toBe("INVALID_INPUT");
    expect(await code(rejectReferenceOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version, advancePaymentId: "x", note: "n" }))).toBe("INVALID_INPUT");
  });
});

describe("cash on delivery and the books", () => {
  it("a COD order is unchanged: no advance can be recorded on it, and the courier collects the whole total", async () => {
    const placed = await websiteOrder();
    let order = await detail(placed.orderId);
    expect(order.paymentMethod).toBe("cod");
    expect(placed.order.payment).toMatchObject({ method: "cod", details: null });
    expect((await viewOf(db, placed.orderId))!.payment).toMatchObject({ state: "cod", details: null, canSubmitReference: false });
    expect(await code(referenceFor(db, placed.orderId, "CODREF0001"))).toBe("INVALID_TRANSITION");
    expect(await code(verifyAdvanceOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version, advancePaymentId: null, method: "bkash", reference: "CODREF0001", amountPaisa: 100, receivedOn: today }))).toBe("INVALID_TRANSITION");
    for (const op of [confirmOrderOnce, packOrderOnce, dispatchOrderOnce, deliverOrderOnce]) await op(db, owner, key(), { orderId: placed.orderId, expectedVersion: (await detail(placed.orderId)).version });
    order = await detail(placed.orderId);
    await recordPaymentOnce(db, owner, key(), { orderId: placed.orderId, expectedVersion: order.version, kind: "collected", amountPaisa: order.totalPaisa, occurredOn: today });
    expect((await detail(placed.orderId)).paymentStatus).toBe("collected");
    // The database refuses advance money on a COD order even from a direct write.
    expect(await errorCodeOf(pool.query("update orders set advance_received_paisa = 1 where id = $1", [placed.orderId]))).toBe("23514");
  });

  it("an assisted order can take an enabled advance method, never a disabled one", async () => {
    const s = await publishedSku(2);
    const input = { source: "whatsapp" as const, customerName: "Assisted Tester", customerPhone: "01711000556", deliveryAddress: "House 9, Test Road", deliveryZone: "dhaka_city" as const, items: [{ sku: s.sku, quantity: 1 }] };
    expect((await submitOrderOnce(db, owner, key(), { ...input, paymentMethod: "bkash" })).value.paymentMethod).toBe("bkash");
    expect(await code(submitOrderOnce(db, owner, key(), { ...input, paymentMethod: "nagad" }))).toBe("PAYMENT_METHOD_UNAVAILABLE");
  });

  it("the payment entries still agree with every order's running totals, advance money included", async () => {
    const outstanding = await getOutstanding(db);
    expect(outstanding.reconciled).toBe(true);
    expect(outstanding.ledger.advanceReceivedPaisa).toBeGreaterThan(0);
    expect(outstanding.ledger.advanceReceivedPaisa).toBe(outstanding.orderTotals.advanceReceivedPaisa);
    expect(outstanding.ledger.advanceRefundedPaisa).toBe(outstanding.orderTotals.advanceRefundedPaisa);
    // Every order's payment status matches its money (the database check), and no advance entry lacks its method.
    expect(await count(pool, "select count(*) from payment_entries where kind like 'advance%' and method is null")).toBe(0);
  });
});
