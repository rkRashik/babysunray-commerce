import "server-only";
import { and, asc, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import {
  advancePayments,
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
import { normalizeBdPhone, type OrderStatus, parseOrderNumber } from "./rules";

// Read models for the Owner (Admin and API). The guest view is in tracking.ts and shows far less.

export type OrderItem = typeof orderItems.$inferSelect;
export type OrderDetail = Order & {
  items: OrderItem[];
  reservations: (typeof stockReservations.$inferSelect)[];
  events: (typeof orderEvents.$inferSelect)[];
  cancellationRequests: (typeof cancellationRequests.$inferSelect)[];
  returns: ((typeof returns.$inferSelect) & { items: (typeof returnItems.$inferSelect)[] })[];
  quarantine: (typeof quarantineItems.$inferSelect)[];
  payments: (typeof paymentEntries.$inferSelect)[];
  /** Manual advance payment references and their verification (migration 0025), oldest first. */
  advancePayments: (typeof advancePayments.$inferSelect)[];
  trackingLink: { createdAt: Date } | null;
};

/**
 * One order with everything that belongs to it, read from one snapshot: a read-only REPEATABLE READ
 * transaction (a savepoint when `db` is already a transaction), with the queries run one after another, never
 * concurrently on one connection (node-postgres queues them today and pg@9 will refuse it). So the version,
 * the child rows and the totals always describe the same moment.
 */
export async function getOrderDetail(db: Db, orderId: string): Promise<OrderDetail> {
  const id = validateId(orderId, "orderId");
  return db.transaction(
    async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, id));
      if (!order) throw new DomainError("ORDER_NOT_FOUND", "Order not found.");
      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, id)).orderBy(asc(orderItems.sku));
      const reservations = await tx.select().from(stockReservations).where(eq(stockReservations.orderId, id)).orderBy(asc(stockReservations.createdAt));
      const events = await tx.select().from(orderEvents).where(eq(orderEvents.orderId, id)).orderBy(asc(orderEvents.id));
      const requests = await tx.select().from(cancellationRequests).where(eq(cancellationRequests.orderId, id)).orderBy(asc(cancellationRequests.createdAt));
      const rets = await tx.select().from(returns).where(eq(returns.orderId, id)).orderBy(asc(returns.createdAt));
      const lines = rets.length ? await tx.select().from(returnItems).where(inArray(returnItems.returnId, rets.map((r) => r.id))) : [];
      const quarantine = await tx.select().from(quarantineItems).where(eq(quarantineItems.orderId, id)).orderBy(asc(quarantineItems.receivedAt));
      const payments = await tx.select().from(paymentEntries).where(eq(paymentEntries.orderId, id)).orderBy(asc(paymentEntries.id));
      const advance = await tx.select().from(advancePayments).where(eq(advancePayments.orderId, id)).orderBy(asc(advancePayments.createdAt));
      const [link] = await tx
        .select({ createdAt: orderTrackingTokens.createdAt })
        .from(orderTrackingTokens)
        .where(and(eq(orderTrackingTokens.orderId, id), sql`${orderTrackingTokens.revokedAt} is null`));
      return {
        ...order,
        items,
        reservations,
        events,
        cancellationRequests: requests,
        returns: rets.map((r) => ({ ...r, items: lines.filter((l) => l.returnId === r.id) })),
        quarantine,
        payments,
        advancePayments: advance,
        trackingLink: link ?? null,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
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
  payment_to_verify: "Advance payment reference to verify",
  refund_due: "Cancelled or returned, with advance money to refund",
} as const;
export type OrderQueue = keyof typeof ORDER_QUEUES;
export const isOrderQueue = (value: unknown): value is OrderQueue => typeof value === "string" && Object.hasOwn(ORDER_QUEUES, value);

const openRequest = sql`exists (select 1 from ${cancellationRequests} where ${cancellationRequests.orderId} = ${orders.id} and ${cancellationRequests.status} = 'open')`;
// Cancelled, or returned to the shop undelivered, while holding verified advance money not paid back (rules.ts, advanceRefundDue).
const refundDue = sql`((${orders.orderStatus} = 'cancelled' or (${orders.orderStatus} = 'confirmed' and ${orders.fulfilmentStatus} = 'rto_received'))
  and ${orders.advanceReceivedPaisa} - ${orders.advanceRefundedPaisa} > 0 and ${orders.codCollectedPaisa} + ${orders.advanceReceivedPaisa} - ${orders.refundedPaisa} - ${orders.advanceRefundedPaisa} > 0)`;
const referenceToVerify = sql`exists (select 1 from ${advancePayments} where ${advancePayments.orderId} = ${orders.id} and ${advancePayments.status} = 'submitted')`;

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
      return sql`(${confirmed} and ${orders.fulfilmentStatus} in ('dispatched', 'delivered') and ${orders.codCollectedPaisa} + ${orders.advanceReceivedPaisa} < ${orders.totalPaisa})`;
    case "unsettled":
      return sql`(${orders.codSettledPaisa} + ${orders.codDeductedPaisa} < ${orders.codCollectedPaisa})`;
    case "payment_to_verify":
      return referenceToVerify;
    case "refund_due":
      return refundDue;
  }
}

/**
 * Needs the Owner now: past its verification deadline, expired, with an open cancellation request, with a payment
 * reference to verify, or cancelled with advance money still to refund.
 */
const attentionCondition = sql`(${orders.orderStatus} = 'verification_expired'
  or (${orders.orderStatus} = 'pending_verification' and ${orders.verificationExpiresAt} <= now())
  or ${openRequest}
  or ${referenceToVerify}
  or ${refundDue})`;

/**
 * How many orders each work queue (and "needs attention") holds now: one statement, one pass over the orders, using
 * the same conditions as the list a chip opens, so a count and its list always agree.
 */
export async function orderQueueCounts(db: Db): Promise<{ attention: number; queues: Record<OrderQueue, number> }> {
  const names = Object.keys(ORDER_QUEUES) as OrderQueue[];
  const { rows } = await db.execute<Record<string, string>>(
    sql`select count(*) filter (where ${attentionCondition}) as attention, ${sql.join(
      names.map((q) => sql`count(*) filter (where ${queueCondition(q)}) as ${sql.identifier(q)}`),
      sql`, `,
    )} from ${orders}`,
  );
  const row = rows[0];
  return { attention: Number(row.attention), queues: Object.fromEntries(names.map((q) => [q, Number(row[q])])) as Record<OrderQueue, number> };
}

export type OrderKey = { createdAt: string; id: string };
const createdAtKey = sql<string>`to_char(${orders.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** What a free-text order search is: an order number, a Bangladesh mobile number, or part of a customer's name. */
export type OrderSearch = { kind: "number"; number: number } | { kind: "phone"; phone: string } | { kind: "name"; name: string };
export const MIN_NAME_SEARCH = 2;
export const MAX_ORDER_SEARCH = 100;

/**
 * Reads a search box: a Bangladesh mobile number in any common form (+880, 880, 0, spaces, hyphens, Bangla digits) is a
 * phone search on the normalized number; "ORD-000042", "#42" or a short number is an order number; anything else of 2 to
 * 100 characters is part of a name. Null for an empty or unusable term.
 */
export function classifyOrderSearch(raw: unknown): OrderSearch | null {
  if (typeof raw !== "string") return null;
  const term = raw.normalize("NFC").trim();
  if (term === "" || term.length > MAX_ORDER_SEARCH || /[\u0000-\u001f\u007f]/.test(term)) return null;
  try {
    return { kind: "phone", phone: normalizeBdPhone(term) };
  } catch {
    // not a phone number
  }
  // Order numbers are short; a long run of digits is neither an order number nor a name. Bare digits starting 01 are an
  // incomplete mobile number (only whole numbers are searched), not an order number.
  if (/^(ORD-?|#)?\s*[0-9]{1,9}$/i.test(term) && !/^01[0-9]{2,}$/.test(term)) {
    const number = parseOrderNumber(term.replace(/\s/g, ""));
    if (number !== null) return { kind: "number", number };
  }
  if (/^[0-9+\s-]+$/.test(term)) return null;
  return term.length >= MIN_NAME_SEARCH ? { kind: "name", name: term } : null;
}

const escapeLike = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Orders newest first, in keyset pages. Filters: commercial status, "needs attention" (pending past its
 * deadline, expired, or with an open cancellation request), a work queue, the order number, and a search (number, exact
 * normalized phone, or part of the customer's name). Each page is bounded (at most 100 rows) and ordered by the
 * (created_at, id) index; the caller keeps contact details out of URLs.
 */
export async function listOrders(
  db: Db,
  options: { limit: number; status?: OrderStatus; attention?: boolean; queue?: OrderQueue; number?: string; search?: OrderSearch; after?: OrderKey },
): Promise<{ items: (Order & { key: OrderKey; openRequest: boolean })[]; hasMore: boolean }> {
  const { limit, status, attention, queue, after } = options;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalidInput("limit", "must be 1 to 100");
  let number: number | undefined;
  if (options.number !== undefined && options.number.trim() !== "") {
    const parsed = parseOrderNumber(options.number);
    if (parsed === null) throw invalidInput("number", "must be an order number such as ORD-000042");
    number = parsed;
  }
  const search = options.search;
  const rows = await db
    .select({ order: orders, key: createdAtKey, openRequest: sql<boolean>`${openRequest}` })
    .from(orders)
    .where(
      and(
        status ? eq(orders.orderStatus, status) : undefined,
        number !== undefined ? eq(orders.number, number) : undefined,
        search?.kind === "number" ? eq(orders.number, search.number) : undefined,
        search?.kind === "phone" ? eq(orders.customerPhone, search.phone) : undefined,
        search?.kind === "name" ? sql`normalize(${orders.customerName}, NFC) ilike ${escapeLike(search.name)}` : undefined,
        queue ? queueCondition(queue) : undefined,
        attention ? attentionCondition : undefined,
        after ? sql`(${orders.createdAt}, ${orders.id}) < (${after.createdAt}::timestamptz, ${validateId(after.id, "cursor")}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(limit + 1);
  return {
    items: rows.slice(0, limit).map((r) => ({ ...r.order, key: { createdAt: r.key, id: r.order.id }, openRequest: r.openRequest })),
    hasMore: rows.length > limit,
  };
}
