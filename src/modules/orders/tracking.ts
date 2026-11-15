import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import { orderItems, orders, orderTrackingTokens } from "@/db/schema";
import type { Actor } from "../actor";
import { DomainError } from "../domain-error";
import { addEvent, lockOrder } from "./internal";
import { allowedActions, formatOrderNumber, maskName, maskPhone, trackingLinkLive, ZONE_LABELS } from "./rules";
import { customerCancel, requestCancellation } from "./service";

// Guest order tracking (founder rule K, S-15). A link carries a 256-bit random token; only its SHA-256 digest
// is stored, so the database never holds a usable link. Lookups are by digest only: an order number or phone
// digits can never find an order. The view is minimal and masked. Nothing here logs or returns the token.

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Revokes the order's current link (if any) and creates a new one. The token is returned only here, once,
 * for the Owner to send to the customer; it cannot be shown again (create another instead).
 */
export async function createTrackingLink(tx: Db, orderId: string, actor: Actor): Promise<{ token: string; tokenId: string }> {
  const locked = await lockOrder(tx, orderId);
  if (!locked) throw new DomainError("ORDER_NOT_FOUND", "Order not found.");
  const revoked = await tx
    .update(orderTrackingTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(orderTrackingTokens.orderId, orderId), sql`${orderTrackingTokens.revokedAt} is null`))
    .returning({ id: orderTrackingTokens.id });
  const token = randomBytes(32).toString("base64url");
  const [row] = await tx.insert(orderTrackingTokens).values({ orderId, tokenHash: digest(token) }).returning({ id: orderTrackingTokens.id });
  await addEvent(tx, orderId, "tracking_link_created", actor, { replacedEarlier: revoked.length > 0 });
  return { token, tokenId: row.id };
}

export async function revokeTrackingLink(tx: Db, orderId: string, actor: Actor): Promise<boolean> {
  const locked = await lockOrder(tx, orderId);
  if (!locked) throw new DomainError("ORDER_NOT_FOUND", "Order not found.");
  const revoked = await tx
    .update(orderTrackingTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(orderTrackingTokens.orderId, orderId), sql`${orderTrackingTokens.revokedAt} is null`))
    .returning({ id: orderTrackingTokens.id });
  if (revoked.length) await addEvent(tx, orderId, "tracking_link_revoked", actor);
  return revoked.length > 0;
}

/** The order a live token belongs to, or null for any malformed, unknown, revoked or expired token. */
async function orderIdForToken(db: Db, token: unknown): Promise<string | null> {
  if (typeof token !== "string" || !TOKEN.test(token)) return null;
  const [row] = await db
    .select({ orderId: orderTrackingTokens.orderId, revokedAt: orderTrackingTokens.revokedAt, closedAt: orders.closedAt, now: sql<Date>`now()`.mapWith((v: string | Date) => new Date(v)) })
    .from(orderTrackingTokens)
    .innerJoin(orders, eq(orders.id, orderTrackingTokens.orderId))
    .where(eq(orderTrackingTokens.tokenHash, digest(token)));
  return row && trackingLinkLive(row.closedAt, row.revokedAt, row.now) ? row.orderId : null;
}

export type GuestView = {
  reference: string;
  placedAt: string;
  orderStatus: string;
  fulfilmentStatus: string;
  paymentStatus: string;
  customer: { name: string; phone: string };
  deliveryZone: string;
  items: { name: { en: string | null; bn: string | null }; size: string | null; colour: string | null; quantity: number; unitPricePaisa: number }[];
  subtotalPaisa: number;
  deliveryChargePaisa: number;
  totalPaisa: number;
  cancellationRequested: boolean;
  canCancel: boolean;
  canRequestCancellation: boolean;
};

/** The minimal, masked view a tracking link shows: no address, phone or name in full, no notes, no ids. */
export async function guestView(db: Db, token: unknown): Promise<GuestView | null> {
  const orderId = await orderIdForToken(db, token);
  if (!orderId) return null;
  return db.transaction(async (tx) => {
    const locked = await lockOrder(tx, orderId);
    if (!locked) return null;
    const { order, state, now } = locked;
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.sku));
    const actions = allowedActions(state, now);
    return {
      reference: formatOrderNumber(order.number),
      placedAt: order.createdAt.toISOString(),
      orderStatus: order.orderStatus,
      fulfilmentStatus: order.fulfilmentStatus,
      paymentStatus: order.paymentStatus,
      customer: { name: maskName(order.customerName), phone: maskPhone(order.customerPhone) },
      deliveryZone: ZONE_LABELS[order.deliveryZone],
      items: items.map((i) => ({ name: { en: i.productNameEn, bn: i.productNameBn }, size: i.size, colour: i.colour, quantity: i.quantity, unitPricePaisa: i.unitPricePaisa })),
      subtotalPaisa: order.subtotalPaisa,
      deliveryChargePaisa: order.deliveryChargePaisa,
      totalPaisa: order.totalPaisa,
      cancellationRequested: state.openCancellationRequest,
      canCancel: actions.has("customer_cancel"),
      canRequestCancellation: actions.has("customer_request_cancellation"),
    };
  });
}

/**
 * The customer's cancellation through the link (rule C): a Pending Verification order is cancelled at once;
 * a confirmed, undispatched one gets a request for the Owner; anything else is refused. Repeating the same
 * action is harmless: the order is already cancelled or already has its open request.
 */
export async function guestCancel(db: Db, token: unknown, action: "cancel" | "request", reason?: string | null): Promise<GuestView | null> {
  const orderId = await orderIdForToken(db, token);
  if (!orderId) return null;
  try {
    await db.transaction(async (tx) => (action === "cancel" ? customerCancel(tx, orderId) : requestCancellation(tx, orderId, reason)));
  } catch (error) {
    if (!(error instanceof DomainError && error.code === "INVALID_TRANSITION")) throw error;
    const view = await guestView(db, token);
    const repeated = view && (action === "cancel" ? view.orderStatus === "cancelled" : view.cancellationRequested);
    if (!repeated) throw error;
  }
  return guestView(db, token);
}

export const TRACKING_LIMITS = { lookup: 600, failure: 30 } as const;

/**
 * Global fixed-window counters for the public tracking endpoint (no client address is trusted). Every lookup
 * counts in 'lookup'; a failed one also in 'failure'. Over either limit, lookups are refused for the rest of
 * the minute.
 */
export async function consumeTrackingLimit(db: Db, bucket: keyof typeof TRACKING_LIMITS): Promise<boolean> {
  const { rows } = await db.execute<{ count: number }>(sql`
    insert into tracking_rate_limits as r (bucket, window_start, count)
    values (${bucket}, date_trunc('minute', now()), 1)
    on conflict (bucket) do update set
      count = case when r.window_start = excluded.window_start then r.count + 1 else 1 end,
      window_start = excluded.window_start
    returning count`);
  return rows[0].count <= TRACKING_LIMITS[bucket];
}

/** True while the failure bucket is over its limit this minute (checked before a lookup is attempted). */
export async function trackingLocked(db: Db): Promise<boolean> {
  const { rows } = await db.execute<{ count: number }>(
    sql`select count from tracking_rate_limits where bucket = 'failure' and window_start = date_trunc('minute', now())`,
  );
  return (rows[0]?.count ?? 0) > TRACKING_LIMITS.failure;
}
