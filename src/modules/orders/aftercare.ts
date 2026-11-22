import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import { orderItems, paymentEntries, quarantineItems, returnItems, returns } from "@/db/schema";
import type { Actor } from "../actor";
import { DomainError, invalidInput } from "../domain-error";
import { restockInspected } from "../inventory/reservations";
import { addEvent, computeReturnStatus, lockForAction, lockOrder, type LockedOrder, type Order, updateOrder } from "./internal";
import { optionalNote, paymentStatusFor, validateAmountPaisa, validatePastDate, validateQuantity } from "./rules";

// After dispatch: COD money (founder rules J, M), returns and exchanges (E, F, M) and inspection (G).
// Money rules are enforced here and again by database checks on orders (never more settled than
// collected, never more collected than expected, never more refunded than collected).

export type PaymentEntry = typeof paymentEntries.$inferSelect;
export type Return = typeof returns.$inferSelect;

const optionalReference = (raw: string | null | undefined) => optionalNote(raw, "reference", 100);

/** Money received from the customer (COD collected plus verified advance) not yet refunded in any way. */
export const refundableReceived = (o: Pick<Order, "codCollectedPaisa" | "advanceReceivedPaisa" | "refundedPaisa" | "advanceRefundedPaisa">) =>
  o.codCollectedPaisa + o.advanceReceivedPaisa - o.refundedPaisa - o.advanceRefundedPaisa;

async function lockVersioned(tx: Db, orderId: string, expectedVersion: number): Promise<LockedOrder> {
  const locked = await lockOrder(tx, orderId);
  if (!locked) throw new DomainError("ORDER_NOT_FOUND", "Order not found.");
  if (locked.order.version !== expectedVersion) {
    throw new DomainError("VERSION_CONFLICT", "This order was changed after you loaded it. Reload it, check its status and try again.");
  }
  return locked;
}

/**
 * Records money the courier collected, the Owner received (settlement) or the courier kept from what it collected
 * (deduction: its fees or other amounts on its statement, entered by the Owner; none is assumed). Partial amounts
 * are allowed; the running totals can never pass the expected COD (collection), and settled plus deducted can never
 * pass what was collected. Collected is never treated as settled.
 */
export async function recordPayment(
  tx: Db,
  orderId: string,
  expectedVersion: number,
  input: { kind: "collected" | "settled" | "deducted"; amountPaisa: number; occurredOn: string; reference?: string | null },
  actor: Actor,
): Promise<{ order: Order; entry: PaymentEntry }> {
  const action = input.kind === "collected" ? "record_collection" : input.kind === "settled" ? "record_settlement" : "record_deduction";
  const { order } = await lockForAction(tx, orderId, action, expectedVersion);
  const amount = validateAmountPaisa(input.amountPaisa);
  const occurredOn = validatePastDate(input.occurredOn, "occurredOn");
  const collected = order.codCollectedPaisa + (input.kind === "collected" ? amount : 0);
  const settled = order.codSettledPaisa + (input.kind === "settled" ? amount : 0);
  const deducted = order.codDeductedPaisa + (input.kind === "deducted" ? amount : 0);
  if (collected + order.advanceReceivedPaisa > order.totalPaisa) {
    throw new DomainError("PAYMENT_LIMIT_EXCEEDED", "That would record more collected than the order's expected COD (the total less any verified advance payment).");
  }
  if (settled + deducted > collected) throw new DomainError("PAYMENT_LIMIT_EXCEEDED", "That would record more settled and deducted than the courier has collected.");
  const [entry] = await tx
    .insert(paymentEntries)
    .values({ orderId, kind: input.kind, amountPaisa: amount, occurredOn, reference: optionalReference(input.reference), actorUserId: actor.ref })
    .returning();
  const updated = await updateOrder(tx, orderId, {
    codCollectedPaisa: collected,
    codSettledPaisa: settled,
    codDeductedPaisa: deducted,
    paymentStatus: paymentStatusFor(order.totalPaisa, collected, settled, deducted, order.advanceReceivedPaisa),
  });
  await addEvent(tx, orderId, `cod_${input.kind}`, actor, { amountPaisa: amount, paymentEntryId: entry.id });
  return { order: updated, entry };
}

/** Units of each order item already in a return that was not rejected. */
async function alreadyReturned(tx: Db, orderId: string): Promise<Map<string, number>> {
  const rows = await tx
    .select({ orderItemId: returnItems.orderItemId, quantity: sql<number>`sum(${returnItems.quantity})`.mapWith(Number) })
    .from(returnItems)
    .innerJoin(returns, eq(returns.id, returnItems.returnId))
    .where(and(eq(returns.orderId, orderId), inArray(returns.status, ["requested", "received", "approved", "completed"])))
    .groupBy(returnItems.orderItemId);
  return new Map(rows.map((r) => [r.orderItemId, r.quantity]));
}

/**
 * A return or exchange request within 7 days of delivery (rule E). Who pays return shipping follows from the
 * reason (rule F); the actual cost is recorded when the parcel arrives.
 */
export async function createReturn(
  tx: Db,
  orderId: string,
  expectedVersion: number,
  input: {
    kind: "return" | "exchange";
    reason: "size_or_preference" | "wrong_or_defective";
    items: { orderItemId: string; quantity: number }[];
    note?: string | null;
  },
  actor: Actor,
): Promise<Return> {
  const { order } = await lockForAction(tx, orderId, "create_return", expectedVersion);
  if (input.kind !== "return" && input.kind !== "exchange") throw invalidInput("kind", "must be return or exchange");
  if (input.reason !== "size_or_preference" && input.reason !== "wrong_or_defective") throw invalidInput("reason", "must be size_or_preference or wrong_or_defective");
  if (!Array.isArray(input.items) || input.items.length === 0) throw invalidInput("items", "must list at least one item");
  const owned = new Map((await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId))).map((i) => [i.id, i]));
  const earlier = await alreadyReturned(tx, orderId);
  const seen = new Set<string>();
  for (const item of input.items) {
    const line = owned.get(item.orderItemId);
    if (!line || seen.has(item.orderItemId)) throw invalidInput("items", "must name each item of this order at most once");
    seen.add(item.orderItemId);
    if (validateQuantity(item.quantity) > line.quantity - (earlier.get(line.id) ?? 0)) {
      throw invalidInput("items", `asks to return more of ${line.sku} than was delivered and not yet returned`);
    }
  }
  const [created] = await tx
    .insert(returns)
    .values({
      orderId,
      kind: input.kind,
      reason: input.reason,
      shippingPaidBy: input.reason === "wrong_or_defective" ? "business" : "customer",
      status: "requested",
      note: optionalNote(input.note, "note", 500),
      createdByUserId: actor.ref,
    })
    .returning();
  await tx.insert(returnItems).values(input.items.map((i) => ({ returnId: created.id, orderItemId: i.orderItemId, quantity: i.quantity })));
  await updateOrder(tx, orderId, { returnStatus: await computeReturnStatus(tx, order.id) });
  await addEvent(tx, orderId, "return_requested", actor, { returnId: created.id, kind: created.kind, reason: created.reason });
  return created;
}

async function lockReturn(tx: Db, returnId: string, expectedVersion: number) {
  const [ret] = await tx.select().from(returns).where(eq(returns.id, returnId));
  if (!ret) throw new DomainError("RETURN_NOT_FOUND", "Return not found.");
  const locked = await lockVersioned(tx, ret.orderId, expectedVersion);
  // Re-read under the order lock: every change to a return also locks its order.
  const [current] = await tx.select().from(returns).where(eq(returns.id, returnId));
  return { ret: current, locked };
}

const wrongState = (what: string) => new DomainError("INVALID_TRANSITION", `This return cannot be ${what} now.`);

/** The returned goods arrived: they enter quarantine for inspection; the actual return shipping cost is noted. */
export async function receiveReturn(tx: Db, returnId: string, expectedVersion: number, input: { returnShippingCostPaisa?: number | null }, actor: Actor): Promise<Return> {
  const { ret } = await lockReturn(tx, returnId, expectedVersion);
  if (ret.status !== "requested") throw wrongState("received");
  const cost = input.returnShippingCostPaisa == null ? null : validateAmountPaisa(input.returnShippingCostPaisa, "returnShippingCostPaisa", { allowZero: true, max: 1_000_000 });
  const lines = await tx
    .select({ orderItemId: returnItems.orderItemId, quantity: returnItems.quantity, variantId: orderItems.variantId })
    .from(returnItems)
    .innerJoin(orderItems, eq(orderItems.id, returnItems.orderItemId))
    .where(eq(returnItems.returnId, returnId));
  await tx.insert(quarantineItems).values(
    lines.map((l) => ({ orderId: ret.orderId, orderItemId: l.orderItemId, variantId: l.variantId, source: "return" as const, returnId, quantity: l.quantity, status: "awaiting_inspection" as const })),
  );
  const [updated] = await tx
    .update(returns)
    .set({ status: "received", receivedAt: sql`now()`, returnShippingCostPaisa: cost })
    .where(eq(returns.id, returnId))
    .returning();
  await updateOrder(tx, ret.orderId, { returnStatus: await computeReturnStatus(tx, ret.orderId) });
  await addEvent(tx, ret.orderId, "return_received", actor, { returnId, returnShippingCostPaisa: cost });
  return updated;
}

/**
 * Inspection of one quarantined line (rule G): passed → exactly one return_restock ledger row; failed → stays
 * out of stock as a non-sellable disposition. Either way it is decided once.
 */
export async function inspectQuarantineItem(
  tx: Db,
  quarantineItemId: string,
  expectedVersion: number,
  input: { outcome: "restock" | "reject"; note?: string | null },
  actor: Actor,
): Promise<void> {
  const [item] = await tx.select().from(quarantineItems).where(eq(quarantineItems.id, quarantineItemId));
  if (!item) throw new DomainError("QUARANTINE_ITEM_NOT_FOUND", "Quarantined item not found.");
  await lockVersioned(tx, item.orderId, expectedVersion);
  const [current] = await tx.select().from(quarantineItems).where(eq(quarantineItems.id, quarantineItemId));
  if (current.status !== "awaiting_inspection") throw new DomainError("INVALID_TRANSITION", "This item has already been inspected.");
  if (input.outcome !== "restock" && input.outcome !== "reject") throw invalidInput("outcome", "must be restock or reject");
  const note = optionalNote(input.note, "note", 500);
  const movement = input.outcome === "restock" ? await restockInspected(tx, { orderId: item.orderId, variantId: item.variantId, quantity: item.quantity, actor }) : null;
  await tx
    .update(quarantineItems)
    .set({ status: movement ? "restocked" : "rejected", note, inspectedAt: sql`now()`, inspectedByUserId: actor.ref, restockMovementId: movement?.id ?? null })
    .where(and(eq(quarantineItems.id, quarantineItemId), eq(quarantineItems.status, "awaiting_inspection")));
  await updateOrder(tx, item.orderId, {});
  await addEvent(tx, item.orderId, movement ? "inspection_restocked" : "inspection_rejected", actor, {
    quarantineItemId,
    source: item.source,
    units: item.quantity,
    ...(movement ? { movementId: movement.id } : {}),
  });
}

/** After every returned line is inspected (rule E), the Owner approves or rejects the request. */
export async function decideReturn(tx: Db, returnId: string, expectedVersion: number, decision: "approve" | "reject", actor: Actor): Promise<Return> {
  const { ret } = await lockReturn(tx, returnId, expectedVersion);
  if (ret.status !== "received") throw wrongState("decided (it must be received first)");
  const [{ waiting }] = await tx
    .select({ waiting: sql<number>`count(*)`.mapWith(Number) })
    .from(quarantineItems)
    .where(and(eq(quarantineItems.returnId, returnId), eq(quarantineItems.status, "awaiting_inspection")));
  if (waiting > 0) throw new DomainError("INVALID_TRANSITION", "Inspect every returned item before deciding.");
  const [updated] = await tx
    .update(returns)
    .set({ status: decision === "approve" ? "approved" : "rejected", decidedAt: sql`now()` })
    .where(eq(returns.id, returnId))
    .returning();
  await updateOrder(tx, ret.orderId, { returnStatus: await computeReturnStatus(tx, ret.orderId) });
  await addEvent(tx, ret.orderId, decision === "approve" ? "return_approved" : "return_rejected", actor, { returnId });
  return updated;
}

/** Value of the goods in a return (their snapshotted unit prices). */
async function returnValue(tx: Db, returnId: string): Promise<number> {
  const [{ value }] = await tx
    .select({ value: sql<string>`coalesce(sum(${returnItems.quantity} * ${orderItems.unitPricePaisa}), 0)` })
    .from(returnItems)
    .innerJoin(orderItems, eq(orderItems.id, returnItems.orderItemId))
    .where(eq(returnItems.returnId, returnId));
  return Number(value);
}

/**
 * A manual refund for an approved return (rule M), paid by bKash, Nagad or bank transfer. At most the money actually
 * received (COD collected plus verified advance) minus earlier refunds, and at most the returned goods' value.
 * Completes the return.
 */
export async function recordRefund(
  tx: Db,
  returnId: string,
  expectedVersion: number,
  input: { amountPaisa: number; method: "bkash" | "nagad" | "bank_transfer"; occurredOn: string; reference?: string | null },
  actor: Actor,
): Promise<{ order: Order; entry: PaymentEntry }> {
  const { ret, locked } = await lockReturn(tx, returnId, expectedVersion);
  if (ret.kind !== "return" || ret.status !== "approved") throw wrongState("refunded (only an approved return is refunded)");
  if (!["bkash", "nagad", "bank_transfer"].includes(input.method)) throw invalidInput("method", "must be bkash, nagad or bank_transfer");
  const amount = validateAmountPaisa(input.amountPaisa);
  const occurredOn = validatePastDate(input.occurredOn, "occurredOn");
  const order = locked.order;
  if (amount > refundableReceived(order)) {
    throw new DomainError("PAYMENT_LIMIT_EXCEEDED", "A refund cannot be more than the money actually received and not yet refunded.");
  }
  if (amount > (await returnValue(tx, returnId))) throw new DomainError("PAYMENT_LIMIT_EXCEEDED", "A refund cannot be more than the returned goods' value.");
  const [entry] = await tx
    .insert(paymentEntries)
    .values({ orderId: order.id, kind: "refunded", amountPaisa: amount, occurredOn, method: input.method, reference: optionalReference(input.reference), returnId, actorUserId: actor.ref })
    .returning();
  await tx.update(returns).set({ status: "completed", completedAt: sql`now()` }).where(eq(returns.id, returnId));
  const updated = await updateOrder(tx, order.id, { refundedPaisa: order.refundedPaisa + amount, returnStatus: await computeReturnStatus(tx, order.id) });
  await addEvent(tx, order.id, "refund_recorded", actor, { returnId, amountPaisa: amount, method: input.method, paymentEntryId: entry.id });
  return { order: updated, entry };
}

/**
 * Completes an approved return without a refund: an exchange (the replacement is a separate assisted order,
 * section 3 of order-policy-decisions.md) or a return where nothing was collected.
 */
export async function completeReturn(tx: Db, returnId: string, expectedVersion: number, actor: Actor): Promise<Return> {
  const { ret, locked } = await lockReturn(tx, returnId, expectedVersion);
  if (ret.status !== "approved") throw wrongState("completed (it must be approved first)");
  if (ret.kind === "return" && refundableReceived(locked.order) > 0) {
    throw new DomainError("INVALID_TRANSITION", "Money was received for this order: record the refund instead.");
  }
  const [updated] = await tx.update(returns).set({ status: "completed", completedAt: sql`now()` }).where(eq(returns.id, returnId)).returning();
  await updateOrder(tx, ret.orderId, { returnStatus: await computeReturnStatus(tx, ret.orderId) });
  await addEvent(tx, ret.orderId, "return_completed", actor, { returnId, kind: ret.kind });
  return updated;
}

