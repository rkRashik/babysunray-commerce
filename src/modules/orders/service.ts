import "server-only";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import { cancellationRequests, deliveryZones, orderItems, orders, products, quarantineItems, variants } from "@/db/schema";
import type { Actor } from "../actor";
import { normalizeSku } from "../catalogue/rules";
import { DomainError, invalidInput } from "../domain-error";
import { consumeReservationsForDispatch, releaseReservations, reserveStock } from "../inventory/reservations";
import { addEvent, CUSTOMER, EXPIRY_ACTOR, lockForAction, lockOrder, type Order, type OrderActor, settleOpenRequest, updateOrder } from "./internal";
import {
  DELIVERY_ZONES,
  type DeliveryZone,
  MAX_DELIVERY_CHARGE_PAISA,
  MAX_ORDER_LINES,
  normalizeBdPhone,
  optionalNote,
  ORDER_SOURCES,
  type OrderSource,
  requiredText,
  validateAmountPaisa,
  validateQuantity,
  VERIFICATION_WINDOW_HOURS,
  verificationOverdue,
} from "./rules";

// Order submission and lifecycle transitions (docs/product/order-policy-decisions.md). Every function runs in
// the caller's transaction (the idempotent operations in operations.ts open it) and locks the order row first.

export type NewOrder = {
  source: OrderSource;
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  deliveryZone: DeliveryZone;
  note?: string | null;
  items: { sku: string; quantity: number }[];
};

/** Validates and merges lines: one line per SKU, quantities added up. */
function normaliseItems(items: NewOrder["items"]): { sku: string; quantity: number }[] {
  if (!Array.isArray(items) || items.length === 0) throw invalidInput("items", "must list at least one SKU");
  if (items.length > MAX_ORDER_LINES) throw invalidInput("items", `must have at most ${MAX_ORDER_LINES} lines`);
  const merged = new Map<string, number>();
  for (const item of items) {
    const sku = normalizeSku(item.sku);
    merged.set(sku, (merged.get(sku) ?? 0) + validateQuantity(item.quantity, "lineQuantity"));
  }
  return [...merged].map(([sku, quantity]) => ({ sku, quantity: validateQuantity(quantity, "lineQuantity") }));
}

/**
 * Creates a Pending Verification order and reserves every line in one transaction (founder rules A, B, I).
 * The delivery charge comes from the active configured zone and, with each line's price and names, is
 * snapshotted. Throws (and creates nothing) if a zone is unconfigured, a SKU is unknown or not orderable, or
 * any line lacks available stock. Totals are computed here; no client-supplied amount is used.
 */
export async function submitOrder(tx: Db, input: NewOrder, actor: OrderActor): Promise<Order> {
  if (!ORDER_SOURCES.includes(input.source)) throw invalidInput("source", "must be website, messenger, whatsapp or other");
  if (!DELIVERY_ZONES.includes(input.deliveryZone)) throw invalidInput("deliveryZone", "must be dhaka_city or outside_dhaka");
  const values = {
    source: input.source,
    customerName: requiredText(input.customerName, "customerName", 100),
    customerPhone: normalizeBdPhone(input.customerPhone),
    deliveryAddress: requiredText(input.deliveryAddress, "deliveryAddress", 500, true),
    deliveryZone: input.deliveryZone,
    note: optionalNote(input.note, "note", 1000),
  };
  const lines = normaliseItems(input.items);

  const [zone] = await tx.select().from(deliveryZones).where(eq(deliveryZones.code, values.deliveryZone));
  if (!zone || !zone.active) {
    throw new DomainError("DELIVERY_ZONE_UNAVAILABLE", "No active delivery charge is configured for this zone, so the order cannot be taken.");
  }
  const deliveryChargePaisa = validateAmountPaisa(zone.chargePaisa, "deliveryCharge", { allowZero: true, max: MAX_DELIVERY_CHARGE_PAISA });

  const catalogue = await tx
    .select({ variant: variants, productStatus: products.status, nameEn: products.nameEn, nameBn: products.nameBn })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(inArray(variants.sku, lines.map((l) => l.sku)));
  const bySku = new Map(catalogue.map((c) => [c.variant.sku, c]));
  const snapshot = lines.map((line) => {
    const c = bySku.get(line.sku);
    if (!c) throw new DomainError("VARIANT_NOT_FOUND", `No variant has the SKU ${line.sku}.`);
    if (c.variant.status !== "active" || c.productStatus === "archived") {
      throw new DomainError("VARIANT_NOT_ORDERABLE", `${line.sku} is inactive or its product is archived, so it cannot be ordered.`);
    }
    const lineTotalPaisa = c.variant.pricePaisa * line.quantity;
    if (!Number.isSafeInteger(lineTotalPaisa)) throw invalidInput("items", "total is too large");
    return {
      variantId: c.variant.id,
      sku: c.variant.sku,
      productNameEn: c.nameEn,
      productNameBn: c.nameBn,
      size: c.variant.size,
      colour: c.variant.colour,
      unitPricePaisa: c.variant.pricePaisa,
      quantity: line.quantity,
      lineTotalPaisa,
    };
  });
  const subtotalPaisa = snapshot.reduce((sum, l) => sum + l.lineTotalPaisa, 0);
  const totalPaisa = subtotalPaisa + deliveryChargePaisa;
  if (!Number.isSafeInteger(totalPaisa)) throw invalidInput("items", "total is too large");

  const [order] = await tx
    .insert(orders)
    .values({
      ...values,
      subtotalPaisa,
      deliveryChargePaisa,
      totalPaisa,
      orderStatus: "pending_verification",
      fulfilmentStatus: "unfulfilled",
      paymentStatus: "unpaid",
      returnStatus: "none",
      verificationExpiresAt: sql`now() + make_interval(hours => ${VERIFICATION_WINDOW_HOURS})`,
      createdByUserId: actor.type === "user" ? actor.ref : null,
    })
    .returning();
  await tx.insert(orderItems).values(snapshot.map((l) => ({ ...l, orderId: order.id })));
  await reserveStock(tx, order.id, snapshot.map((l) => ({ variantId: l.variantId, quantity: l.quantity })));
  await addEvent(tx, order.id, "submitted", actor, { source: order.source, lines: snapshot.length, totalPaisa, deliveryChargePaisa });
  return order;
}

const itemLines = async (tx: Db, orderId: string) =>
  (await tx.select({ variantId: orderItems.variantId, quantity: orderItems.quantity }).from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.variantId)));

/**
 * Owner verification (rule B). Before the 24-hour deadline the existing reservation is kept. After it (expiry
 * recorded or not) any stale hold is released and stock is reserved afresh, only if available (rule D).
 */
export async function confirmOrder(tx: Db, orderId: string, expectedVersion: number, actor: Actor): Promise<Order> {
  const { order, now } = await lockForAction(tx, orderId, "confirm", expectedVersion);
  const late = verificationOverdue(order, now);
  if (late) {
    const released = await releaseReservations(tx, orderId, "expired");
    if (order.orderStatus === "pending_verification") await addEvent(tx, orderId, "verification_expired", EXPIRY_ACTOR, { releasedUnits: released });
    await reserveStock(tx, orderId, await itemLines(tx, orderId));
  }
  const updated = await updateOrder(tx, orderId, { orderStatus: "confirmed", confirmedAt: sql`now()` });
  await addEvent(tx, orderId, "confirmed", actor, { reservedAgain: late });
  return updated;
}

/**
 * Records verification expiry for one order if it is still pending and overdue: releases its hold once and
 * sets Verification Expired (not cancelled). Skips an order another transaction holds; that one re-checks.
 */
export async function expireIfOverdue(tx: Db, orderId: string): Promise<boolean> {
  const locked = await lockOrder(tx, orderId, { skipLocked: true });
  if (!locked || locked.order.orderStatus !== "pending_verification" || !verificationOverdue(locked.order, locked.now)) return false;
  const released = await releaseReservations(tx, orderId, "expired");
  await updateOrder(tx, orderId, { orderStatus: "verification_expired" });
  await addEvent(tx, orderId, "verification_expired", EXPIRY_ACTOR, { releasedUnits: released });
  return true;
}

/**
 * The repeatable expiry batch: every pending order past its deadline, each in its own short transaction.
 * Running it twice, or concurrently, changes nothing more. Returns how many orders it expired.
 */
export async function expireOverdueVerifications(db: Db, options: { limit?: number } = {}): Promise<number> {
  const limit = options.limit ?? 500;
  const due = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.orderStatus, "pending_verification"), lte(orders.verificationExpiresAt, sql`now()`)))
    .orderBy(asc(orders.verificationExpiresAt))
    .limit(limit);
  let expired = 0;
  for (const { id } of due) if (await db.transaction((tx) => expireIfOverdue(tx, id))) expired += 1;
  return expired;
}

/**
 * Expired holds never block new work (founder rule D): before reserving, release overdue ones. Cheap when
 * nothing is overdue (one indexed query).
 */
export async function releaseOverdue(db: Db): Promise<void> {
  const [due] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.orderStatus, "pending_verification"), lte(orders.verificationExpiresAt, sql`now()`)))
    .limit(1);
  if (due) await expireOverdueVerifications(db);
}

/** Effective cancellation (rule C): releases any active hold exactly once and closes the order. */
async function cancel(tx: Db, order: Order, actor: OrderActor, event: string) {
  const released = await releaseReservations(tx, order.id, "cancelled");
  const updated = await updateOrder(tx, order.id, { orderStatus: "cancelled", closedAt: sql`now()` });
  await addEvent(tx, order.id, event, actor, { releasedUnits: released, from: order.orderStatus, fulfilment: order.fulfilmentStatus });
  return updated;
}

/** Owner cancellation: pending, expired, or confirmed before dispatch. An open customer request is approved with it. */
export async function cancelOrder(tx: Db, orderId: string, expectedVersion: number, actor: Actor): Promise<Order> {
  const { order } = await lockForAction(tx, orderId, "cancel", expectedVersion);
  if (await settleOpenRequest(tx, orderId, "approved", actor)) await addEvent(tx, orderId, "cancellation_request_approved", actor);
  return cancel(tx, order, actor, "cancelled_by_owner");
}

/** The customer's own cancellation, only while Pending Verification (rule C). */
export async function customerCancel(tx: Db, orderId: string): Promise<Order> {
  const { order } = await lockForAction(tx, orderId, "customer_cancel", null);
  return cancel(tx, order, CUSTOMER, "cancelled_by_customer");
}

/** A confirmed, undispatched order: the customer asks; stock is not released (rule C). */
export async function requestCancellation(tx: Db, orderId: string, reason?: string | null): Promise<void> {
  await lockForAction(tx, orderId, "customer_request_cancellation", null);
  await tx.insert(cancellationRequests).values({ orderId, status: "open", reason: optionalNote(reason, "reason", 500) });
  await updateOrder(tx, orderId, {});
  await addEvent(tx, orderId, "cancellation_requested", CUSTOMER);
}

/** The Owner's decision on an open request: approve cancels (once); reject leaves the order as it is. */
export async function reviewCancellation(tx: Db, orderId: string, expectedVersion: number, decision: "approve" | "reject", actor: Actor): Promise<Order> {
  const { order } = await lockForAction(tx, orderId, "review_cancellation", expectedVersion);
  if (decision === "approve") {
    await settleOpenRequest(tx, orderId, "approved", actor);
    await addEvent(tx, orderId, "cancellation_request_approved", actor);
    return cancel(tx, order, actor, "cancelled_on_request");
  }
  await settleOpenRequest(tx, orderId, "rejected", actor);
  const updated = await updateOrder(tx, orderId, {});
  await addEvent(tx, orderId, "cancellation_request_rejected", actor);
  return updated;
}

export async function packOrder(tx: Db, orderId: string, expectedVersion: number, actor: Actor): Promise<Order> {
  await lockForAction(tx, orderId, "pack", expectedVersion);
  const updated = await updateOrder(tx, orderId, { fulfilmentStatus: "packed" });
  await addEvent(tx, orderId, "packed", actor);
  return updated;
}

/** Dispatch (rule L): the whole order leaves; its holds become on-hand deductions with ledger rows. */
export async function dispatchOrder(tx: Db, orderId: string, expectedVersion: number, actor: Actor): Promise<Order> {
  await lockForAction(tx, orderId, "dispatch", expectedVersion);
  const movements = await consumeReservationsForDispatch(tx, orderId, await itemLines(tx, orderId), actor);
  const updated = await updateOrder(tx, orderId, { fulfilmentStatus: "dispatched" });
  await addEvent(tx, orderId, "dispatched", actor, { movementIds: movements.map((m) => m.id) });
  return updated;
}

/** Delivered is a fulfilment fact only: it implies nothing about collection or settlement (rule J). */
export async function deliverOrder(tx: Db, orderId: string, expectedVersion: number, actor: Actor): Promise<Order> {
  await lockForAction(tx, orderId, "deliver", expectedVersion);
  const updated = await updateOrder(tx, orderId, { fulfilmentStatus: "delivered", deliveredAt: sql`now()` });
  await addEvent(tx, orderId, "delivered", actor);
  return updated;
}

/** Refused or undelivered: the parcel is coming back. Nothing changes in stock yet (rule G). */
export async function markRto(tx: Db, orderId: string, expectedVersion: number, actor: Actor): Promise<Order> {
  await lockForAction(tx, orderId, "mark_rto", expectedVersion);
  const updated = await updateOrder(tx, orderId, { fulfilmentStatus: "rto" });
  await addEvent(tx, orderId, "rto_marked", actor);
  return updated;
}

/** The returned parcel arrived: every line goes into quarantine for inspection, never straight into stock. */
export async function receiveRto(tx: Db, orderId: string, expectedVersion: number, actor: Actor): Promise<Order> {
  await lockForAction(tx, orderId, "receive_rto", expectedVersion);
  const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  await tx.insert(quarantineItems).values(
    items.map((i) => ({ orderId, orderItemId: i.id, variantId: i.variantId, source: "rto" as const, quantity: i.quantity, status: "awaiting_inspection" as const })),
  );
  const updated = await updateOrder(tx, orderId, { fulfilmentStatus: "rto_received" });
  await addEvent(tx, orderId, "rto_received", actor, { units: items.reduce((n, i) => n + i.quantity, 0) });
  return updated;
}

/** The courier's RTO charge as actually billed; recorded separately from the order total (rule G). */
export async function recordRtoCharge(tx: Db, orderId: string, expectedVersion: number, chargePaisa: number, actor: Actor): Promise<Order> {
  await lockForAction(tx, orderId, "record_rto_charge", expectedVersion);
  const amount = validateAmountPaisa(chargePaisa, "rtoChargePaisa", { allowZero: true, max: MAX_DELIVERY_CHARGE_PAISA });
  const updated = await updateOrder(tx, orderId, { rtoChargePaisa: amount });
  await addEvent(tx, orderId, "rto_charge_recorded", actor, { rtoChargePaisa: amount });
  return updated;
}

/**
 * Closing is explicit: delivered (or RTO received), every collected taka settled, no open return and nothing
 * awaiting inspection. Delivered alone is not closed. The tracking link stops 30 days after this.
 */
export async function closeOrder(tx: Db, orderId: string, expectedVersion: number, actor: Actor): Promise<Order> {
  await lockForAction(tx, orderId, "close", expectedVersion);
  const updated = await updateOrder(tx, orderId, { orderStatus: "closed", closedAt: sql`now()` });
  await addEvent(tx, orderId, "closed", actor);
  return updated;
}

/** For tests and Admin: orders whose open cancellation request awaits review. */
export const hasOpenRequest = async (db: Db, orderId: string) =>
  (await db.select({ id: cancellationRequests.id }).from(cancellationRequests).where(and(eq(cancellationRequests.orderId, orderId), eq(cancellationRequests.status, "open")))).length > 0;
