import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { type Db, pgErrorCode } from "@/db/database";
import { advancePayments, paymentEntries } from "@/db/schema";
import { actorFor, assertPermission, type Principal } from "../auth/principal";
import { validateId } from "../catalogue/rules";
import { DomainError, invalidInput } from "../domain-error";
import { type Once, runOnce } from "../idempotency/service";
import { formatPaisa } from "../money";
import { isManualMethod, type ManualMethod } from "../settings/payments";
import type { Actor } from "../actor";
import { addEvent, CUSTOMER, lockForAction, lockOrder, type Order, updateOrder } from "./internal";
import { getOrderDetail, type OrderDetail } from "./queries";
import { amountDue, dhakaToday, optionalNote, paymentStatusFor, refundableAdvance, requiredText, validateAmountPaisa, validatePastDate } from "./rules";

// Manual advance payments (ADR-0013). The customer sends money with their own bKash, Nagad or bank app to the store's
// account shown after ordering, then submits the transaction reference through the order's private tracking link. A
// reference proves nothing: the Owner checks the real account and records what actually arrived (payments:verify). Only
// that verification writes money (an advance_received ledger row and the order's running total), at most the amount still
// due, and one reference counts at most once across all orders (a unique index). A mistaken verification is undone by an
// advance_reversed row, never by editing history. Advance money paid back for a cancelled order is an advance_refunded row
// (payments:record). None of this changes the order's status or its stock: verifying money never confirms an order or
// revives an expired reservation, and cancelling never returns money by itself.

/** A transaction id as the sender's app or bank shows it: 4 to 40 letters, digits, "-" or "/", stored upper case. */
export function normalizeReference(raw: unknown): string {
  const value = typeof raw === "string" ? raw.normalize("NFKC").trim().toUpperCase().replace(/\s+/g, "") : "";
  if (!/^[A-Z0-9][A-Z0-9/-]{3,39}$/.test(value)) throw invalidInput("reference", "must be the transaction ID from the payment message (4 to 40 letters and digits)");
  return value;
}

/** Customer submissions waiting for the Owner, and all submissions, allowed per order (spam and guessing bound, not policy). */
export const MAX_OPEN_REFERENCES = 3;
export const MAX_REFERENCES = 10;

/**
 * The customer's reference for a manual-payment order, through its live tracking link (the caller checked the link).
 * Accepted while money is still due and the order is not closed; the same open reference again is harmless. It records
 * nothing as paid: the order shows "awaiting verification" until the Owner checks the account.
 */
export async function submitReference(db: Db, orderId: string, raw: unknown): Promise<void> {
  const reference = normalizeReference(raw);
  await db.transaction(async (tx) => {
    const locked = await lockOrder(tx, orderId);
    if (!locked) throw new DomainError("ORDER_NOT_FOUND", "Order not found.");
    const { order } = locked;
    if (!isManualMethod(order.paymentMethod) || order.orderStatus === "closed" || order.orderStatus === "cancelled" || amountDue(order) === 0) {
      throw new DomainError("INVALID_TRANSITION", "A payment reference cannot be sent for this order now.");
    }
    const [counts] = await tx
      .select({ open: sql<number>`count(*) filter (where ${advancePayments.status} = 'submitted')`.mapWith(Number), all: sql<number>`count(*)`.mapWith(Number), same: sql<number>`count(*) filter (where ${advancePayments.status} = 'submitted' and ${advancePayments.reference} = ${reference})`.mapWith(Number) })
      .from(advancePayments)
      .where(and(eq(advancePayments.orderId, orderId), eq(advancePayments.source, "customer")));
    if (counts.same > 0) return;
    if (counts.all >= MAX_REFERENCES) throw new DomainError("INVALID_TRANSITION", "Too many payment references were sent for this order. Please contact the shop.");
    if (counts.open >= MAX_OPEN_REFERENCES) throw new DomainError("RATE_LIMITED", "The shop is still checking the references you sent. Please contact the shop.");
    const [row] = await tx.insert(advancePayments).values({ orderId, method: order.paymentMethod, reference, source: "customer", status: "submitted" }).returning({ id: advancePayments.id });
    await updateOrder(tx, orderId, {});
    await addEvent(tx, orderId, "advance_reference_submitted", CUSTOMER, { advancePaymentId: row.id, method: order.paymentMethod });
  });
}

const DUPLICATE = () => new DomainError("INVALID_INPUT", "This transaction reference is already verified, on this or another order. Check the account statement: one transfer counts once.");

/** Records verified money on the locked order: one ledger row, the running total and the derived payment status. */
async function receive(tx: Db, order: Order, input: { method: ManualMethod; reference: string; amountPaisa: number; receivedOn: string }, actor: Actor) {
  const due = amountDue(order);
  if (input.amountPaisa > due) throw new DomainError("PAYMENT_LIMIT_EXCEEDED", `That is more than the BDT ${formatPaisa(due)} still due. Record only what this order is owed.`);
  const [entry] = await tx
    .insert(paymentEntries)
    .values({ orderId: order.id, kind: "advance_received", amountPaisa: input.amountPaisa, occurredOn: input.receivedOn, method: input.method, reference: input.reference, actorUserId: actor.ref })
    .returning({ id: paymentEntries.id });
  const advance = order.advanceReceivedPaisa + input.amountPaisa;
  await updateOrder(tx, order.id, { advanceReceivedPaisa: advance, paymentStatus: paymentStatusFor(order.totalPaisa, order.codCollectedPaisa, order.codSettledPaisa, order.codDeductedPaisa, advance) });
  return entry.id;
}

export type VerifyInput = {
  orderId: string;
  expectedVersion: number;
  /** A customer's submission to verify, or null to record a transfer the customer did not submit (Owner-entered). */
  advancePaymentId: string | null;
  method?: string | null;
  reference?: string | null;
  amountPaisa: number;
  receivedOn: string;
};

/**
 * The Owner confirms money arrived in the store's account: the amount actually received (partial is fine, never more than
 * still due) on the date it arrived. Verifying a submission uses its reference; recording one the customer did not send
 * needs the method and reference from the account statement.
 */
export async function verifyAdvance(tx: Db, input: VerifyInput, actor: Actor): Promise<void> {
  const { order } = await lockForAction(tx, input.orderId, "record_advance", input.expectedVersion);
  const amountPaisa = validateAmountPaisa(input.amountPaisa);
  const receivedOn = validatePastDate(input.receivedOn, "receivedOn");
  let id: string;
  let method: ManualMethod;
  let reference: string;
  if (input.advancePaymentId) {
    const [row] = await tx.select().from(advancePayments).where(and(eq(advancePayments.id, validateId(input.advancePaymentId, "advancePaymentId")), eq(advancePayments.orderId, order.id))).for("update");
    if (!row) throw new DomainError("INVALID_INPUT", "That payment reference was not found on this order.");
    if (row.status !== "submitted") throw new DomainError("INVALID_TRANSITION", "This reference was already decided.");
    ({ id, method, reference } = row);
  } else {
    if (!isManualMethod(input.method)) throw invalidInput("method", "must be bKash, Nagad or bank transfer");
    method = input.method;
    reference = normalizeReference(input.reference);
    // The customer may have sent the same ID: verify that submission rather than leave it waiting.
    const [open] = await tx
      .select({ id: advancePayments.id })
      .from(advancePayments)
      .where(and(eq(advancePayments.orderId, order.id), eq(advancePayments.method, method), eq(advancePayments.reference, reference), eq(advancePayments.status, "submitted")))
      .for("update");
    // Otherwise written below, once its ledger row exists (a verified row always names its entry).
    id = open?.id ?? "";
  }
  const [taken] = await tx.select({ id: advancePayments.id }).from(advancePayments).where(and(eq(advancePayments.method, method), eq(advancePayments.reference, reference), eq(advancePayments.status, "verified")));
  if (taken) throw DUPLICATE();
  const entryId = await receive(tx, order, { method, reference, amountPaisa, receivedOn }, actor);
  try {
    if (id) {
      await tx.update(advancePayments).set({ status: "verified", amountPaisa, receivedOn, decidedAt: sql`now()`, decidedByUserId: actor.ref, paymentEntryId: entryId }).where(eq(advancePayments.id, id));
    } else {
      const [row] = await tx.insert(advancePayments).values({ orderId: order.id, method, reference, source: "owner", status: "verified", amountPaisa, receivedOn, decidedAt: sql`now()`, decidedByUserId: actor.ref, paymentEntryId: entryId }).returning({ id: advancePayments.id });
      id = row.id;
    }
  } catch (error) {
    // Two verifications of one reference racing: the unique index lets exactly one commit.
    if (pgErrorCode(error) === "23505") throw DUPLICATE();
    throw error;
  }
  await addEvent(tx, order.id, "advance_verified", actor, { advancePaymentId: id, method, amountPaisa, paymentEntryId: entryId, source: input.advancePaymentId ? "customer" : "owner" });
}

/** The reference does not match a transfer in the account: the customer sees that there is a problem and may send another. */
export async function rejectReference(tx: Db, input: { orderId: string; expectedVersion: number; advancePaymentId: string; note: unknown }, actor: Actor): Promise<void> {
  const locked = await lockOrder(tx, input.orderId);
  if (!locked) throw new DomainError("ORDER_NOT_FOUND", "Order not found.");
  if (locked.order.version !== input.expectedVersion) throw new DomainError("VERSION_CONFLICT", "This order was changed after you loaded it. Reload it, check its status and try again.");
  const note = requiredText(input.note, "note", 300);
  const updated = await tx
    .update(advancePayments)
    .set({ status: "rejected", note, decidedAt: sql`now()`, decidedByUserId: actor.ref })
    .where(and(eq(advancePayments.id, validateId(input.advancePaymentId, "advancePaymentId")), eq(advancePayments.orderId, input.orderId), eq(advancePayments.status, "submitted")))
    .returning({ id: advancePayments.id });
  if (updated.length !== 1) throw new DomainError("INVALID_TRANSITION", "This reference was already decided.");
  await updateOrder(tx, input.orderId, {});
  await addEvent(tx, input.orderId, "advance_reference_rejected", actor, { advancePaymentId: input.advancePaymentId });
}

/** Undoes a mistaken verification with a reversing ledger row. Refused if the money was already paid back. */
export async function reverseAdvance(tx: Db, input: { orderId: string; expectedVersion: number; advancePaymentId: string; note: unknown }, actor: Actor): Promise<void> {
  const { order } = await lockForAction(tx, input.orderId, "reverse_advance", input.expectedVersion);
  const note = requiredText(input.note, "note", 300);
  const [row] = await tx.select().from(advancePayments).where(and(eq(advancePayments.id, validateId(input.advancePaymentId, "advancePaymentId")), eq(advancePayments.orderId, order.id))).for("update");
  if (!row || row.status !== "verified" || row.amountPaisa === null) throw new DomainError("INVALID_TRANSITION", "Only a verified payment can be undone.");
  const advance = order.advanceReceivedPaisa - row.amountPaisa;
  if (advance < order.advanceRefundedPaisa || order.codCollectedPaisa + advance < order.refundedPaisa + order.advanceRefundedPaisa) {
    throw new DomainError("INVALID_TRANSITION", "Money was already refunded from this payment, so it cannot be undone.");
  }
  const [entry] = await tx
    .insert(paymentEntries)
    // Dated the day the mistake was corrected (Asia/Dhaka).
    .values({ orderId: order.id, kind: "advance_reversed", amountPaisa: row.amountPaisa, occurredOn: dhakaToday(), method: row.method, reference: row.reference, actorUserId: actor.ref })
    .returning({ id: paymentEntries.id });
  await tx.update(advancePayments).set({ status: "reversed", note, reversalEntryId: entry.id }).where(eq(advancePayments.id, row.id));
  await updateOrder(tx, order.id, { advanceReceivedPaisa: advance, paymentStatus: paymentStatusFor(order.totalPaisa, order.codCollectedPaisa, order.codSettledPaisa, order.codDeductedPaisa, advance) });
  await addEvent(tx, order.id, "advance_reversed", actor, { advancePaymentId: row.id, amountPaisa: row.amountPaisa, paymentEntryId: entry.id });
}

/** Advance money paid back by hand for a cancelled order, as the Owner actually paid it (amount, method, date, reference). */
export async function refundAdvance(
  tx: Db,
  input: { orderId: string; expectedVersion: number; amountPaisa: number; method: unknown; occurredOn: string; reference?: string | null },
  actor: Actor,
): Promise<void> {
  const { order } = await lockForAction(tx, input.orderId, "refund_advance", input.expectedVersion);
  if (!isManualMethod(input.method)) throw invalidInput("method", "must be bKash, Nagad or bank transfer");
  const amount = validateAmountPaisa(input.amountPaisa);
  const occurredOn = validatePastDate(input.occurredOn, "occurredOn");
  if (amount > refundableAdvance(order)) throw new DomainError("PAYMENT_LIMIT_EXCEEDED", "A refund cannot be more than the verified advance money not yet refunded.");
  const [entry] = await tx
    .insert(paymentEntries)
    .values({ orderId: order.id, kind: "advance_refunded", amountPaisa: amount, occurredOn, method: input.method, reference: optionalNote(input.reference, "reference", 100), actorUserId: actor.ref })
    .returning({ id: paymentEntries.id });
  await updateOrder(tx, order.id, { advanceRefundedPaisa: order.advanceRefundedPaisa + amount });
  await addEvent(tx, order.id, "advance_refunded", actor, { amountPaisa: amount, method: input.method, paymentEntryId: entry.id });
}

/** "method:reference" of this order's open references that also appear on another order (a warning for the Owner). */
export async function referencesOnOtherOrders(db: Db, orderId: string): Promise<Set<string>> {
  const { rows } = await db.execute<{ key: string }>(sql`
    select distinct a.method || ':' || a.reference as key from advance_payments a
      join advance_payments mine on mine.method = a.method and mine.reference = a.reference and mine.order_id = ${orderId} and mine.status = 'submitted'
     where a.order_id <> ${orderId}`);
  return new Set(rows.map((r) => r.key));
}

// --- Operations (idempotent, permission checked first, the verified user as the actor; ADR-0005) ---------------------

const loadOrder = (db: Db, ref: { orderId: string }) => getOrderDetail(db, ref.orderId);

export async function verifyAdvanceOnce(db: Db, principal: Principal, key: string, input: VerifyInput): Promise<Once<OrderDetail>> {
  const user = assertPermission(principal, "payments:verify");
  const request = { ...input, method: input.method ?? null, reference: input.reference ?? null };
  return runOnce(db, { userId: user.userId, operation: "orders.advance.verify", key, request }, async (tx) => (await verifyAdvance(tx, request, actorFor(user)), { orderId: input.orderId }), loadOrder);
}

export async function rejectReferenceOnce(db: Db, principal: Principal, key: string, input: { orderId: string; expectedVersion: number; advancePaymentId: string; note: unknown }): Promise<Once<OrderDetail>> {
  const user = assertPermission(principal, "payments:verify");
  const request = { ...input, note: input.note ?? null };
  return runOnce(db, { userId: user.userId, operation: "orders.advance.reject", key, request }, async (tx) => (await rejectReference(tx, request, actorFor(user)), { orderId: input.orderId }), loadOrder);
}

export async function reverseAdvanceOnce(db: Db, principal: Principal, key: string, input: { orderId: string; expectedVersion: number; advancePaymentId: string; note: unknown }): Promise<Once<OrderDetail>> {
  const user = assertPermission(principal, "payments:verify");
  const request = { ...input, note: input.note ?? null };
  return runOnce(db, { userId: user.userId, operation: "orders.advance.reverse", key, request }, async (tx) => (await reverseAdvance(tx, request, actorFor(user)), { orderId: input.orderId }), loadOrder);
}

export async function refundAdvanceOnce(
  db: Db,
  principal: Principal,
  key: string,
  input: { orderId: string; expectedVersion: number; amountPaisa: number; method: unknown; occurredOn: string; reference?: string | null },
): Promise<Once<OrderDetail>> {
  const user = assertPermission(principal, "payments:record");
  const request = { ...input, reference: input.reference ?? null };
  return runOnce(db, { userId: user.userId, operation: "orders.advance.refund", key, request }, async (tx) => (await refundAdvance(tx, request, actorFor(user)), { orderId: input.orderId }), loadOrder);
}
