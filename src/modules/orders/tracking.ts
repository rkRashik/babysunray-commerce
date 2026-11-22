import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import { advancePayments, orderItems, orders, orderTrackingTokens } from "@/db/schema";
import type { Actor } from "../actor";
import { DomainError } from "../domain-error";
import { consumePublicLimit } from "../rate-limit/service";
import { type PaymentDetails, paymentDetails } from "../settings/payments";
import { MAX_OPEN_REFERENCES, MAX_REFERENCES, submitReference } from "./advance";
import { addEvent, lockOrder, type OrderActor } from "./internal";
import { advanceRefundDue, allowedActions, amountDue, formatOrderNumber, maskName, maskPhone, trackingLinkLive, ZONE_LABELS } from "./rules";
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
export async function createTrackingLink(tx: Db, orderId: string, actor: OrderActor): Promise<{ token: string; tokenId: string }> {
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

/** A live tracking link: the order it opens and the link's own id (never the token or its digest). */
export type TrackingLink = { orderId: string; tokenId: string };

/** True for text shaped like a token (43 base64url characters); anything else is refused without a lookup. */
export const wellFormedToken = (token: unknown): token is string => typeof token === "string" && TOKEN.test(token);

/** The link a token belongs to, or null for any malformed, unknown, revoked or expired token. */
export async function findLiveLink(db: Db, token: unknown): Promise<TrackingLink | null> {
  if (!wellFormedToken(token)) return null;
  const [row] = await db
    .select({
      orderId: orderTrackingTokens.orderId,
      tokenId: orderTrackingTokens.id,
      revokedAt: orderTrackingTokens.revokedAt,
      closedAt: orders.closedAt,
      now: sql<Date>`now()`.mapWith((v: string | Date) => new Date(v)),
    })
    .from(orderTrackingTokens)
    .innerJoin(orders, eq(orders.id, orderTrackingTokens.orderId))
    .where(eq(orderTrackingTokens.tokenHash, digest(token)));
  return row && trackingLinkLive(row.closedAt, row.revokedAt, row.now) ? { orderId: row.orderId, tokenId: row.tokenId } : null;
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
  /**
   * How the order is paid. For a manual advance payment: what is still due, where to send it (the store's current
   * receiving details, null when the method is no longer offered), and the state of the customer's references. A
   * reference submitted is never "paid": only the shop's verification is (`verifiedPaisa`).
   */
  payment: {
    method: string;
    dueNowPaisa: number;
    verifiedPaisa: number;
    state: "cod" | "awaiting_payment" | "reference_submitted" | "reference_problem" | "part_paid" | "paid" | "refund_due" | "refunded" | "not_needed";
    details: PaymentDetails | null;
    canSubmitReference: boolean;
  };
};

type PaymentState = GuestView["payment"]["state"];

/** The minimal, masked view a tracking link shows: no address, phone or name in full, no notes, no ids. */
export async function guestView(db: Db, token: unknown): Promise<GuestView | null> {
  const link = await findLiveLink(db, token);
  return link ? viewOf(db, link.orderId) : null;
}

/** The guest view of the order a live link opens (the link was checked by the caller). */
export function viewOf(db: Db, orderId: string): Promise<GuestView | null> {
  return db.transaction(async (tx) => {
    const locked = await lockOrder(tx, orderId);
    if (!locked) return null;
    const { order, state, now } = locked;
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.sku));
    const actions = allowedActions(state, now);
    const references = order.paymentMethod === "cod" ? [] : await tx.select({ status: advancePayments.status, source: advancePayments.source }).from(advancePayments).where(eq(advancePayments.orderId, orderId)).orderBy(desc(advancePayments.createdAt));
    const fromCustomer = references.filter((r) => r.source === "customer");
    const due = amountDue(order);
    const latest = references.find((r) => r.status !== "reversed")?.status;
    const paymentState: PaymentState =
      order.paymentMethod === "cod"
        ? "cod"
        : advanceRefundDue(order)
          ? "refund_due"
          : order.advanceRefundedPaisa > 0
            ? "refunded"
            : order.orderStatus === "cancelled"
              ? "not_needed"
              : due === 0
            ? "paid"
            : references.some((r) => r.status === "submitted")
              ? "reference_submitted"
              : latest === "rejected"
                ? "reference_problem"
                : order.advanceReceivedPaisa > 0
                  ? "part_paid"
                  : "awaiting_payment";
    const open = order.paymentMethod !== "cod" && due > 0 && order.orderStatus !== "closed" && order.orderStatus !== "cancelled" && order.fulfilmentStatus !== "rto" && order.fulfilmentStatus !== "rto_received";
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
      payment: {
        method: order.paymentMethod,
        dueNowPaisa: due,
        verifiedPaisa: order.advanceReceivedPaisa,
        state: paymentState,
        details: open ? await paymentDetails(tx, order.paymentMethod) : null,
        canSubmitReference: open && fromCustomer.filter((r) => r.status === "submitted").length < MAX_OPEN_REFERENCES && fromCustomer.length < MAX_REFERENCES,
      },
    };
  });
}

/** The customer's transfer reference through the link (the caller checked the link). Never marks anything paid. */
export async function referenceFor(db: Db, orderId: string, reference: unknown): Promise<GuestView | null> {
  await submitReference(db, orderId, reference);
  return viewOf(db, orderId);
}

/**
 * The customer's cancellation through the link (rule C): a Pending Verification order is cancelled at once;
 * a confirmed, undispatched one gets a request for the Owner; anything else is refused. Repeating the same
 * action is harmless: the order is already cancelled or already has its open request.
 */
export async function guestCancel(db: Db, token: unknown, action: "cancel" | "request", reason?: string | null): Promise<GuestView | null> {
  const link = await findLiveLink(db, token);
  return link ? cancelFor(db, link.orderId, action, reason) : null;
}

/** guestCancel for the order of a link the caller already checked. */
export async function cancelFor(db: Db, orderId: string, action: "cancel" | "request", reason?: string | null): Promise<GuestView | null> {
  try {
    await db.transaction(async (tx) => (action === "cancel" ? customerCancel(tx, orderId) : requestCancellation(tx, orderId, reason)));
  } catch (error) {
    if (!(error instanceof DomainError && error.code === "INVALID_TRANSITION")) throw error;
    const view = await viewOf(db, orderId);
    const repeated = view && (action === "cancel" ? view.orderStatus === "cancelled" : view.cancellationRequested);
    if (!repeated) throw error;
  }
  return viewOf(db, orderId);
}

/**
 * Public tracking limits, per minute (S-15). No client address is trusted before a hosting and proxy decision,
 * so the layers are: a malformed token is refused without touching the database; a live link has its own
 * bucket (`link:<link id>`), so nobody else's traffic can use it up; unknown, revoked and expired tokens share
 * one global `failure` bucket, which slows guessing without ever blocking a live link. Guessing itself is
 * defeated by the token's 256 random bits, not by this limit. What this cannot stop without a trusted proxy or
 * CDN: a flood that overloads the server or database, and anyone who holds a link using up that link's bucket.
 */
export const TRACKING_LIMITS = { failure: 30, link: 30 } as const;
export type TrackingBucket = "failure" | `link:${string}`;

/** Counts one request in a fixed one-minute window; false once the bucket is over its limit this minute. */
export function consumeTrackingLimit(db: Db, bucket: TrackingBucket): Promise<boolean> {
  return consumePublicLimit(db, bucket, bucket === "failure" ? TRACKING_LIMITS.failure : TRACKING_LIMITS.link);
}
