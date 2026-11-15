import "server-only";
import { and, asc, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import {
  cancellationRequests,
  orderEvents,
  orderItems,
  orders,
  orderTrackingTokens,
  paymentEntries,
  quarantineItems,
  returnItems,
  returns,
  stockReservations,
} from "@/db/schema";
import { validateId } from "../catalogue/rules";
import { DomainError, invalidInput } from "../domain-error";
import type { Order } from "./internal";
import { type OrderStatus, parseOrderNumber } from "./rules";

// Read models for the Owner (Office and API). The guest view is in tracking.ts and shows far less.

export type OrderItem = typeof orderItems.$inferSelect;
export type OrderDetail = Order & {
  items: OrderItem[];
  reservations: (typeof stockReservations.$inferSelect)[];
  events: (typeof orderEvents.$inferSelect)[];
  cancellationRequests: (typeof cancellationRequests.$inferSelect)[];
  returns: ((typeof returns.$inferSelect) & { items: (typeof returnItems.$inferSelect)[] })[];
  quarantine: (typeof quarantineItems.$inferSelect)[];
  payments: (typeof paymentEntries.$inferSelect)[];
  trackingLink: { createdAt: Date } | null;
};

export async function getOrderDetail(db: Db, orderId: string): Promise<OrderDetail> {
  const id = validateId(orderId, "orderId");
  const [order] = await db.select().from(orders).where(eq(orders.id, id));
  if (!order) throw new DomainError("ORDER_NOT_FOUND", "Order not found.");
  const [items, reservations, events, requests, rets, quarantine, payments, links] = await Promise.all([
    db.select().from(orderItems).where(eq(orderItems.orderId, id)).orderBy(asc(orderItems.sku)),
    db.select().from(stockReservations).where(eq(stockReservations.orderId, id)).orderBy(asc(stockReservations.createdAt)),
    db.select().from(orderEvents).where(eq(orderEvents.orderId, id)).orderBy(asc(orderEvents.id)),
    db.select().from(cancellationRequests).where(eq(cancellationRequests.orderId, id)).orderBy(asc(cancellationRequests.createdAt)),
    db.select().from(returns).where(eq(returns.orderId, id)).orderBy(asc(returns.createdAt)),
    db.select().from(quarantineItems).where(eq(quarantineItems.orderId, id)).orderBy(asc(quarantineItems.receivedAt)),
    db.select().from(paymentEntries).where(eq(paymentEntries.orderId, id)).orderBy(asc(paymentEntries.id)),
    db.select({ createdAt: orderTrackingTokens.createdAt }).from(orderTrackingTokens).where(and(eq(orderTrackingTokens.orderId, id), sql`${orderTrackingTokens.revokedAt} is null`)),
  ]);
  const lines = rets.length ? await db.select().from(returnItems).where(inArray(returnItems.returnId, rets.map((r) => r.id))) : [];
  return {
    ...order,
    items,
    reservations,
    events,
    cancellationRequests: requests,
    returns: rets.map((r) => ({ ...r, items: lines.filter((l) => l.returnId === r.id) })),
    quarantine,
    payments,
    trackingLink: links[0] ?? null,
  };
}

/**
 * Work queues for the Owner (dashboard and order list). One definition, so a dashboard count and the list it
 * links to always agree. Each is a condition on the order row, evaluated with the database clock.
 */
export const ORDER_QUEUES = {
  pending: "Waiting for verification (within 24 hours)",
  overdue: "Past the 24-hour verification window",
  to_pack: "Confirmed, to pack",
  to_dispatch: "Packed, to dispatch",
  in_transit: "Dispatched, awaiting delivery",
  cancellation_requests: "Cancellation request to review",
  returning: "Returning to sender (RTO), not received yet",
  awaiting_collection: "Dispatched or delivered, COD not fully collected",
  unsettled: "Collected by the courier, not fully settled to you",
} as const;
export type OrderQueue = keyof typeof ORDER_QUEUES;
export const isOrderQueue = (value: unknown): value is OrderQueue => typeof value === "string" && Object.hasOwn(ORDER_QUEUES, value);

const openRequest = sql`exists (select 1 from ${cancellationRequests} where ${cancellationRequests.orderId} = ${orders.id} and ${cancellationRequests.status} = 'open')`;

export function queueCondition(queue: OrderQueue): SQL {
  const confirmed = sql`${orders.orderStatus} = 'confirmed'`;
  switch (queue) {
    case "pending":
      return sql`(${orders.orderStatus} = 'pending_verification' and ${orders.verificationExpiresAt} > now())`;
    case "overdue":
      return sql`(${orders.orderStatus} = 'verification_expired' or (${orders.orderStatus} = 'pending_verification' and ${orders.verificationExpiresAt} <= now()))`;
    case "to_pack":
      return sql`(${confirmed} and ${orders.fulfilmentStatus} = 'unfulfilled')`;
    case "to_dispatch":
      return sql`(${confirmed} and ${orders.fulfilmentStatus} = 'packed')`;
    case "in_transit":
      return sql`(${confirmed} and ${orders.fulfilmentStatus} = 'dispatched')`;
    case "cancellation_requests":
      return openRequest;
    case "returning":
      return sql`(${confirmed} and ${orders.fulfilmentStatus} = 'rto')`;
    case "awaiting_collection":
      return sql`(${confirmed} and ${orders.fulfilmentStatus} in ('dispatched', 'delivered') and ${orders.codCollectedPaisa} < ${orders.totalPaisa})`;
    case "unsettled":
      return sql`(${orders.codSettledPaisa} < ${orders.codCollectedPaisa})`;
  }
}

export type OrderKey = { createdAt: string; id: string };
const createdAtKey = sql<string>`to_char(${orders.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Orders newest first, in keyset pages. Filters: commercial status, "needs attention" (pending past its
 * deadline, expired, or with an open cancellation request), and the order number. Contact details are not
 * searchable here, so they never travel in a URL.
 */
export async function listOrders(
  db: Db,
  options: { limit: number; status?: OrderStatus; attention?: boolean; queue?: OrderQueue; number?: string; after?: OrderKey },
): Promise<{ items: (Order & { key: OrderKey })[]; hasMore: boolean }> {
  const { limit, status, attention, queue, after } = options;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalidInput("limit", "must be 1 to 100");
  let number: number | undefined;
  if (options.number !== undefined && options.number.trim() !== "") {
    const parsed = parseOrderNumber(options.number);
    if (parsed === null) throw invalidInput("number", "must be an order number such as ORD-000042");
    number = parsed;
  }
  const rows = await db
    .select({ order: orders, key: createdAtKey })
    .from(orders)
    .where(
      and(
        status ? eq(orders.orderStatus, status) : undefined,
        number !== undefined ? eq(orders.number, number) : undefined,
        queue ? queueCondition(queue) : undefined,
        attention
          ? sql`(${orders.orderStatus} = 'verification_expired'
              or (${orders.orderStatus} = 'pending_verification' and ${orders.verificationExpiresAt} <= now())
              or exists (select 1 from ${cancellationRequests} where ${cancellationRequests.orderId} = ${orders.id} and ${cancellationRequests.status} = 'open'))`
          : undefined,
        after ? sql`(${orders.createdAt}, ${orders.id}) < (${after.createdAt}::timestamptz, ${validateId(after.id, "cursor")}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(limit + 1);
  return {
    items: rows.slice(0, limit).map((r) => ({ ...r.order, key: { createdAt: r.key, id: r.order.id } })),
    hasMore: rows.length > limit,
  };
}
