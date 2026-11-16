import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Db } from "@/db/database";
import { cancellationRequests, orderEvents, orders, quarantineItems, returns } from "@/db/schema";
import { type Actor, validateActor } from "../actor";
import { DomainError } from "../domain-error";
import { allowedActions, type OrderAction, type OrderState } from "./rules";

// Shared by the order services: lock an order, check a transition against the rules, record history.

export type Order = typeof orders.$inferSelect;
/**
 * Who acted. Customers carry no identity: they act through a tracking link, or (once public checkout is approved)
 * submit through the guest checkout service. Neither is ever a user: a customer action never names the Owner.
 */
export type OrderActor = Actor | { type: "customer"; ref: "tracking-link" | "guest-checkout" };
export const CUSTOMER: OrderActor = { type: "customer", ref: "tracking-link" };
export const GUEST_CHECKOUT: OrderActor = { type: "customer", ref: "guest-checkout" };
export const EXPIRY_ACTOR: Actor = { type: "system", ref: "verification-expiry" };

export type LockedOrder = { order: Order; state: OrderState; now: Date };

/**
 * Locks the order row (FOR UPDATE) and reads what the rules need, with the database clock. Every order
 * operation starts here, so concurrent operations on one order run one after the other.
 */
export async function lockOrder(tx: Db, orderId: string, options: { skipLocked?: boolean } = {}): Promise<LockedOrder | null> {
  const [row] = await tx
    .select({ order: orders, now: sql<Date>`now()`.mapWith((v: string | Date) => new Date(v)) })
    .from(orders)
    .where(eq(orders.id, orderId))
    .for("update", options.skipLocked ? { skipLocked: true } : undefined);
  if (!row) return null;
  const result = await tx.execute<{ open_request: boolean; open_return: boolean; awaiting: boolean }>(sql`select
      exists (select 1 from ${cancellationRequests} where ${cancellationRequests.orderId} = ${orderId} and ${cancellationRequests.status} = 'open') as open_request,
      exists (select 1 from ${returns} where ${returns.orderId} = ${orderId} and ${returns.status} in ('requested', 'received', 'approved')) as open_return,
      exists (select 1 from ${quarantineItems} where ${quarantineItems.orderId} = ${orderId} and ${quarantineItems.status} = 'awaiting_inspection') as awaiting`);
  const flags = { openRequest: result.rows[0].open_request, openReturn: result.rows[0].open_return, awaiting: result.rows[0].awaiting };
  const o = row.order;
  return {
    order: o,
    now: row.now,
    state: {
      orderStatus: o.orderStatus,
      fulfilmentStatus: o.fulfilmentStatus,
      verificationExpiresAt: o.verificationExpiresAt,
      deliveredAt: o.deliveredAt,
      totalPaisa: o.totalPaisa,
      codCollectedPaisa: o.codCollectedPaisa,
      codSettledPaisa: o.codSettledPaisa,
      codDeductedPaisa: o.codDeductedPaisa,
      openCancellationRequest: Boolean(flags.openRequest),
      openReturn: Boolean(flags.openReturn),
      awaitingInspection: Boolean(flags.awaiting),
    },
  };
}

/** Locks the order and checks the version the caller saw (Owner screens and API clients) and the transition. */
export async function lockForAction(tx: Db, orderId: string, action: OrderAction, expectedVersion: number | null): Promise<LockedOrder> {
  const locked = await lockOrder(tx, orderId);
  if (!locked) throw new DomainError("ORDER_NOT_FOUND", "Order not found.");
  if (expectedVersion !== null && locked.order.version !== expectedVersion) {
    throw new DomainError("VERSION_CONFLICT", "This order was changed after you loaded it. Reload it, check its status and try again.");
  }
  assertAllowed(locked, action);
  return locked;
}

const LABEL: Record<OrderAction, string> = {
  confirm: "confirmed",
  cancel: "cancelled",
  pack: "packed",
  dispatch: "dispatched",
  deliver: "marked delivered",
  mark_rto: "marked for return to sender",
  receive_rto: "received back",
  record_rto_charge: "given an RTO charge",
  close: "closed",
  review_cancellation: "reviewed for cancellation",
  record_collection: "given a courier collection",
  record_settlement: "given a settlement",
  record_deduction: "given a courier deduction",
  create_return: "given a return request",
  customer_cancel: "cancelled here",
  customer_request_cancellation: "given a cancellation request",
};

export function assertAllowed(locked: LockedOrder, action: OrderAction): void {
  if (!allowedActions(locked.state, locked.now).has(action)) {
    const { orderStatus, fulfilmentStatus } = locked.state;
    throw new DomainError(
      "INVALID_TRANSITION",
      `This order cannot be ${LABEL[action]} now (order ${orderStatus.replace(/_/g, " ")}, fulfilment ${fulfilmentStatus.replace(/_/g, " ")}).`,
    );
  }
}

/** Updates the order row and adds one to its version. The row is already locked by the caller. */
export async function updateOrder(tx: Db, orderId: string, set: PgUpdateSetSource<typeof orders>): Promise<Order> {
  const [order] = await tx
    .update(orders)
    .set({ ...set, version: sql`${orders.version} + 1`, updatedAt: sql`now()` })
    .where(eq(orders.id, orderId))
    .returning();
  return order;
}

/** Appends one history row. detail carries ids, amounts and statuses only, never contact data. */
export async function addEvent(tx: Db, orderId: string, event: string, actor: OrderActor, detail?: Record<string, unknown>): Promise<void> {
  const verified = actor.type === "customer" ? actor : validateActor(actor);
  await tx.insert(orderEvents).values({
    orderId,
    event,
    actorType: verified.type,
    actorRef: verified.ref,
    actorUserId: verified.type === "user" ? verified.ref : null,
    detail: detail ?? null,
  });
}

/** The return dimension, recomputed from the order's return requests (O-1: stored separately). */
export async function computeReturnStatus(tx: Db, orderId: string): Promise<Order["returnStatus"]> {
  const rows = await tx.select({ status: returns.status }).from(returns).where(eq(returns.orderId, orderId));
  const statuses = rows.map((r) => r.status);
  const value: Order["returnStatus"] =
    statuses.length === 0 ? "none" : statuses.includes("requested") ? "requested" : statuses.some((s) => s === "received" || s === "approved") ? "in_progress" : "resolved";
  return value;
}

/** Closes the open cancellation request of an order (if any) with the Owner's decision. */
export async function settleOpenRequest(tx: Db, orderId: string, status: "approved" | "rejected", actor: OrderActor): Promise<boolean> {
  const reviewer = actor.type === "user" ? actor.ref : null;
  if (!reviewer) return false;
  const closed = await tx
    .update(cancellationRequests)
    .set({ status, reviewedAt: sql`now()`, reviewedByUserId: reviewer })
    .where(and(eq(cancellationRequests.orderId, orderId), inArray(cancellationRequests.status, ["open"])))
    .returning({ id: cancellationRequests.id });
  return closed.length > 0;
}
