import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Db } from "../../src/db/database";
import type { Principal } from "../../src/modules/auth/principal";
import { replaceMeasurementsOnce, reviewProductOnce, updateProductOnce } from "../../src/modules/catalogue/operations";
import { reviewStates } from "../../src/modules/catalogue/review";
import { createProduct, createVariant } from "../../src/modules/catalogue/service";
import { getStockLevel, receiveStock } from "../../src/modules/inventory/service";
import { launchReadiness } from "../../src/modules/launch/readiness";
import { placeGuestOrder } from "../../src/modules/orders/guest-checkout";
import {
  confirmOrderOnce,
  createReturnOnce,
  deliverOrderOnce,
  dispatchOrderOnce,
  inspectQuarantineOnce,
  markRtoOnce,
  packOrderOnce,
  receiveRtoOnce,
  recordPaymentOnce,
  returnStepOnce,
  setDeliveryZoneOnce,
} from "../../src/modules/orders/operations";
import { getOrderDetail } from "../../src/modules/orders/queries";
import { dhakaToday } from "../../src/modules/orders/rules";
import { guestView } from "../../src/modules/orders/tracking";
import { parseDateRange } from "../../src/modules/reports/dates";
import { getPeriodReport } from "../../src/modules/reports/summary";
import { addToCart, setQuantity } from "../../src/modules/storefront/cart";
import { quoteCart } from "../../src/modules/storefront/service";
import { clearAuthState, count, createTestAuth, createVerifiedOwner } from "../support/auth";
import { errorCodeOf, TEST_ACTOR } from "../support/fixtures";
import { createTestDb } from "../support/test-database";

// A private launch rehearsal (Gate H.28), test database only: one fictional product from preparation to review, a
// cart, the guest checkout service (anonymous: no principal), reservation, private tracking, the Owner's
// verification, packing, dispatch, COD collection and settlement, a return with refund, a second order returned to
// sender, and the ledger, report and readiness checks at the end. Backup and restore of these rows is rehearsed by
// `npm run backup:drill`, which seeds the same kinds of rows. The public HTTP endpoint does not exist and is not
// simulated here: checkout stays disabled (S-17).

let db: Db;
let pool: Pool;
let owner: Principal;
const key = () => randomUUID();
const today = dhakaToday();

beforeAll(async () => {
  ({ db, pool } = await createTestDb(6));
  await clearAuthState(pool);
  ({ principal: owner } = await createVerifiedOwner(createTestAuth(db), db, pool, "rehearsal-owner@example.test"));
  for (const [code, chargePaisa] of [["dhaka_city", 6_000], ["outside_dhaka", 12_000]] as const) {
    const { rows } = await pool.query<{ version: number }>("select version from delivery_zones where code = $1", [code]);
    await setDeliveryZoneOnce(db, owner, key(), { code, chargePaisa, active: true, expectedVersion: rows[0]?.version ?? null });
  }
});

afterAll(async () => {
  await pool?.end();
});

it("rehearses the whole customer and Owner journey on one fictional product", async () => {
  // 1-3. A product with bilingual content, a confirmed fabric statement, measurements, two SKUs and stock.
  const product = await createProduct(db, { slug: "rehearsal-romper", nameEn: "Rehearsal Romper", nameBn: "রিহার্সাল রম্পার", descriptionEn: "Fictional.", descriptionBn: "কাল্পনিক।" });
  const small = await createVariant(db, { productId: product.id, sku: "REHEARSAL-03", size: "0-3M", colour: "Ivory", pricePaisa: 85_000 });
  const large = await createVariant(db, { productId: product.id, sku: "REHEARSAL-36", size: "3-6M", colour: "Ivory", pricePaisa: 92_050 });
  const version = (await updateProductOnce(db, owner, key(), { productId: product.id, expectedVersion: 1, changes: { fabricEn: "Fictional fabric.", fabricBn: "কাল্পনিক কাপড়।", fabricConfirmed: true, careEn: "Fictional care.", careBn: "কাল্পনিক যত্ন।" } })).value.version;
  await replaceMeasurementsOnce(db, owner, key(), { productId: product.id, expectedVersion: version, measurements: ["0-3M", "3-6M"].flatMap((size, i) => [{ size, point: "chest", valueMm: 245 + i * 15 }, { size, point: "length", valueMm: 380 + i * 30 }]) });
  await receiveStock(db, { sku: small.sku, quantity: 4, actor: TEST_ACTOR });
  await receiveStock(db, { sku: large.sku, quantity: 2, actor: TEST_ACTOR });
  await reviewProductOnce(db, owner, key(), { productId: product.id, contentSha256: (await reviewStates(db, [product.id])).get(product.id)?.contentSha256 ?? "" });

  // 4-5. A cart with quantity changes, priced from the database with the delivery charge (the Owner's preview quote;
  // a public, published-only quote does not exist yet).
  let cart = addToCart([], small.sku, 1);
  cart = addToCart(cart, large.sku, 1);
  cart = setQuantity(cart, small.sku, 2);
  const quote = await quoteCart(db, owner, { lines: cart, zone: "dhaka_city" });
  expect(quote).toMatchObject({ ready: true, subtotalPaisa: 2 * 85_000 + 92_050, deliveryChargePaisa: 6_000, totalPaisa: 2 * 85_000 + 92_050 + 6_000 });
  const shown = {
    customer: { name: "Rehearsal Guest", phone: "০১৭১১-০০০৩০৩", address: "House 3, Rehearsal Road, Test Area" },
    deliveryZone: "dhaka_city",
    items: quote.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, unitPricePaisa: l.unitPricePaisa })),
    deliveryChargePaisa: quote.deliveryChargePaisa,
    totalPaisa: quote.totalPaisa,
  };

  // 6. Validation before anything is created.
  expect(await errorCodeOf(placeGuestOrder(db, key(), { ...shown, customer: { ...shown.customer, phone: "12345" } }))).toBe("INVALID_INPUT");

  // 7-10. Anonymous submission: Pending Verification, stock held at once, a private tracking link, no user named.
  const users = await count(pool, "select count(*) from auth_users");
  const placed = await placeGuestOrder(db, key(), shown);
  expect(placed.order).toMatchObject({ orderStatus: "pending_verification", totalPaisa: quote.totalPaisa });
  expect(await count(pool, "select count(*) from auth_users")).toBe(users);
  const [{ order_id: orderId }] = (await pool.query<{ order_id: string }>("select order_id from guest_checkout_submissions order by created_at desc limit 1")).rows;
  expect(await getStockLevel(db, small.sku)).toMatchObject({ onHand: 4, reserved: 2, available: 2 });
  const view = await guestView(db, placed.trackingToken);
  expect(view).toMatchObject({ reference: placed.order.reference, orderStatus: "pending_verification", canCancel: true, customer: { name: "R***", phone: "017******03" } });
  const detail = await getOrderDetail(db, orderId);
  expect(detail).toMatchObject({ source: "website", createdByUserId: null, customerPhone: "01711000303" });

  // 11-13. The Owner verifies, packs and dispatches: the hold becomes a ledger deduction.
  const v = async () => (await getOrderDetail(db, orderId)).version;
  for (const op of [confirmOrderOnce, packOrderOnce, dispatchOrderOnce, deliverOrderOnce]) await op(db, owner, key(), { orderId, expectedVersion: await v() });
  expect(await getStockLevel(db, small.sku)).toMatchObject({ onHand: 2, reserved: 0 });
  expect((await guestView(db, placed.trackingToken))?.fulfilmentStatus).toBe("delivered");

  // 14. COD collected by the courier and settled to the Owner, by hand.
  await recordPaymentOnce(db, owner, key(), { orderId, expectedVersion: await v(), kind: "collected", amountPaisa: quote.totalPaisa as number, occurredOn: today });
  await recordPaymentOnce(db, owner, key(), { orderId, expectedVersion: await v(), kind: "settled", amountPaisa: quote.totalPaisa as number, occurredOn: today });
  expect((await getOrderDetail(db, orderId)).paymentStatus).toBe("settled");

  // 15. A return of one unit: received into quarantine, inspected and restocked, approved, refunded.
  const itemId = (await getOrderDetail(db, orderId)).items.find((i) => i.sku === small.sku)?.id ?? "";
  await createReturnOnce(db, owner, key(), { orderId, expectedVersion: await v(), kind: "return", reason: "size_or_preference", items: [{ orderItemId: itemId, quantity: 1 }] });
  const returnId = (await getOrderDetail(db, orderId)).returns[0].id;
  await returnStepOnce(db, owner, key(), { orderId, returnId, expectedVersion: await v(), step: "receive", returnShippingCostPaisa: null });
  await inspectQuarantineOnce(db, owner, key(), { orderId, quarantineItemId: (await getOrderDetail(db, orderId)).quarantine[0].id, expectedVersion: await v(), outcome: "restock" });
  await returnStepOnce(db, owner, key(), { orderId, returnId, expectedVersion: await v(), step: "approve" });
  await returnStepOnce(db, owner, key(), { orderId, returnId, expectedVersion: await v(), step: "refund", amountPaisa: 85_000, method: "bkash", occurredOn: today });
  expect((await getOrderDetail(db, orderId)).returns[0].status).toBe("completed"); // a refund completes the return
  expect(await getStockLevel(db, small.sku)).toMatchObject({ onHand: 3, reserved: 0 });

  // 15b. A second guest order refused at the door: dispatched, returned to sender, inspected back into stock.
  const second = await placeGuestOrder(db, key(), { ...shown, items: [{ sku: large.sku, quantity: 1, unitPricePaisa: 92_050 }], totalPaisa: 92_050 + 6_000 });
  const [{ order_id: rtoId }] = (await pool.query<{ order_id: string }>("select order_id from guest_checkout_submissions order by created_at desc limit 1")).rows;
  expect(second.order.reference).not.toBe(placed.order.reference);
  const rv = async () => (await getOrderDetail(db, rtoId)).version;
  for (const op of [confirmOrderOnce, packOrderOnce, dispatchOrderOnce, markRtoOnce, receiveRtoOnce]) await op(db, owner, key(), { orderId: rtoId, expectedVersion: await rv() });
  expect(await getStockLevel(db, large.sku)).toMatchObject({ onHand: 0, reserved: 0 });
  await inspectQuarantineOnce(db, owner, key(), { orderId: rtoId, quarantineItemId: (await getOrderDetail(db, rtoId)).quarantine[0].id, expectedVersion: await rv(), outcome: "restock" });
  expect(await getStockLevel(db, large.sku)).toMatchObject({ onHand: 1, reserved: 0 });

  // 16. The ledger explains every balance; the period report counts both orders and the money; readiness agrees.
  const ledger = await pool.query<{ sku: string; sum: string; on_hand: number }>(
    "select v.sku, coalesce(sum(m.quantity_delta), 0) as sum, b.on_hand from variants v join inventory_balances b on b.variant_id = v.id left join stock_movements m on m.variant_id = v.id where v.product_id = $1 group by v.sku, b.on_hand",
    [product.id],
  );
  for (const row of ledger.rows) expect(Number(row.sum), row.sku).toBe(row.on_hand);
  const report = await getPeriodReport(db, parseDateRange(today, today));
  expect(JSON.stringify(report)).toContain(String(quote.totalPaisa));
  const readiness = await launchReadiness(db, owner);
  expect(readiness.sections.find((s) => s.id === "commerce")?.checks.find((c) => c.id === "integrity")?.status).toBe("ready");
  expect(readiness.gate.open).toBe(false);
  // Every action in both orders' history is the customer's or the Owner's own, never a user for the customer's.
  const actors = await pool.query<{ event: string; actor_type: string }>("select event, actor_type from order_events where order_id in ($1, $2) order by id", [orderId, rtoId]);
  expect(actors.rows.filter((e) => e.event === "submitted" || e.event === "tracking_link_created").every((e) => e.actor_type === "customer")).toBe(true);
  expect(actors.rows.filter((e) => e.event === "confirmed").every((e) => e.actor_type === "user")).toBe(true);
});
