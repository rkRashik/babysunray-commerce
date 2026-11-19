import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import * as z from "zod";
import type { Db } from "@/db/database";
import { customerOrders, guestCheckoutSubmissions, orderItems, orders } from "@/db/schema";
import { normalizeSku } from "../catalogue/rules";
import { skusNotOrderableByCustomers } from "../catalogue/visibility";
import { DomainError } from "../domain-error";
import { canonicalJson } from "../idempotency/service";
import { GUEST_CHECKOUT } from "./internal";
import {
  checkCustomerDetails,
  type CustomerDetails,
  DELIVERY_ZONES,
  type DeliveryZone,
  formatOrderNumber,
  MAX_DELIVERY_CHARGE_PAISA,
  MAX_LINE_QUANTITY,
  MAX_ORDER_LINES,
} from "./rules";
import { expireOverdueVerifications, releaseOverdue, submitOrder } from "./service";
import { createTrackingLink } from "./tracking";

// The guest checkout (S-3, S-4), as an application service. Its only caller is the transport src/api/guest-checkout.ts,
// routed at /api/shop/checkout behind the shop access check (src/modules/launch/acceptance.ts): founder acceptance on the
// staging database now, the public only once the founder opens the launch gate (S-17, G-7).
//
// It reuses the order domain unchanged (submitOrder: Pending Verification, atomic reservation, no backorders,
// 24-hour verification window, server-side totals from the configured delivery zone) and differs from the
// Owner-assisted path only where an anonymous customer must:
// - no principal and no user actor: the order's history names the customer actor `guest-checkout`, and
//   created_by_user_id stays empty. Nothing here imports the authentication module, and the request schema is
//   strict, so a body cannot carry an actor, role, user id or order source (always `website`);
// - its own idempotency record (guest_checkout_submissions), keyed by the SHA-256 of a client-generated
//   high-entropy key, with an HMAC of the canonical request keyed by that same key: the table holds no customer
//   data and nothing a reader could test guesses against without the key;
// - the client sends the prices and delivery charge it showed; any difference refuses the order (QUOTE_CHANGED),
//   so a customer never gets an order at an amount they were not shown (S-7);
// - only active SKUs of published products can be ordered, the same rule as the public catalogue
//   (src/modules/catalogue/visibility.ts). Nothing can be published while no publication rule (I-6) is approved;
// - the order's tracking link is created in the same transaction and its token returned once, in this answer.
//   A replay never creates another link (that would revoke the first) and cannot show the token again: only its
//   digest is stored. A customer whose first answer was lost still sees that the order was received, and the
//   Owner, who verifies every order by hand (rule B), issues a new link through the Office.

/** Same alphabet as base64url and UUIDs; at least 32 characters (a UUID v4 has 122 random bits). */
const KEY = /^[A-Za-z0-9_-]{32,128}$/;
const OPERATION = "guest.checkout.v1";

export type GuestCheckoutFieldError = { field: string; code: string };

/** The request could not be accepted as sent. `errors` names fields and stable codes only, never values. */
export class GuestCheckoutInvalid extends DomainError {
  constructor(readonly errors: GuestCheckoutFieldError[]) {
    super("INVALID_INPUT", "The checkout details are not valid.");
    this.name = "GuestCheckoutInvalid";
  }
}

const requestSchema = z.strictObject({
  customer: z.strictObject({ name: z.string().max(400), phone: z.string().max(40), address: z.string().max(2000) }),
  deliveryZone: z.enum(DELIVERY_ZONES),
  items: z
    .array(z.strictObject({ sku: z.string().max(100), quantity: z.number(), unitPricePaisa: z.number() }))
    .min(1)
    .max(MAX_ORDER_LINES),
  deliveryChargePaisa: z.number(),
  totalPaisa: z.number(),
});

export type GuestCheckout = {
  customer: CustomerDetails;
  deliveryZone: DeliveryZone;
  items: { sku: string; quantity: number; unitPricePaisa: number }[];
  deliveryChargePaisa: number;
  totalPaisa: number;
};

const isAmount = (n: number, min: number, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= min && n <= max;

/** Validates an untrusted checkout request completely, or lists every problem (field names and codes). */
export function validateGuestCheckout(raw: unknown): { ok: true; value: GuestCheckout } | { ok: false; errors: GuestCheckoutFieldError[] } {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => ({ field: i.path.length ? i.path.map(String).join(".").replace(/[^A-Za-z0-9_.]/g, "") : "request", code: i.code === "unrecognized_keys" ? "unknown_field" : "invalid" })) };
  }
  const r = parsed.data;
  const errors: GuestCheckoutFieldError[] = [];
  const details = checkCustomerDetails(r.customer);
  for (const [field, code] of Object.entries(details.errors)) errors.push({ field: `customer.${field}`, code });
  const seen = new Set<string>();
  const items = r.items.map((item, i) => {
    let sku = "";
    try {
      sku = normalizeSku(item.sku);
    } catch {
      errors.push({ field: `items.${i}.sku`, code: "sku_invalid" });
    }
    if (sku && seen.has(sku)) errors.push({ field: `items.${i}.sku`, code: "sku_repeated" });
    seen.add(sku);
    if (!isAmount(item.quantity, 1, MAX_LINE_QUANTITY)) errors.push({ field: `items.${i}.quantity`, code: "quantity_invalid" });
    if (!isAmount(item.unitPricePaisa, 1)) errors.push({ field: `items.${i}.unitPricePaisa`, code: "amount_invalid" });
    return { sku, quantity: item.quantity, unitPricePaisa: item.unitPricePaisa };
  });
  if (!isAmount(r.deliveryChargePaisa, 0, MAX_DELIVERY_CHARGE_PAISA)) errors.push({ field: "deliveryChargePaisa", code: "amount_invalid" });
  if (!isAmount(r.totalPaisa, 1)) errors.push({ field: "totalPaisa", code: "amount_invalid" });
  if (errors.length || !details.values) return { ok: false, errors };
  return { ok: true, value: { customer: details.values, deliveryZone: r.deliveryZone, items, deliveryChargePaisa: r.deliveryChargePaisa, totalPaisa: r.totalPaisa } };
}

/** What the customer is shown after submitting: the order as received (never "confirmed"), without contact data. */
export type GuestOrderSummary = {
  reference: string;
  orderStatus: string;
  placedAt: string;
  deliveryZone: DeliveryZone;
  items: { sku: string; name: { en: string | null; bn: string | null }; size: string | null; colour: string | null; quantity: number; unitPricePaisa: number; lineTotalPaisa: number }[];
  subtotalPaisa: number;
  deliveryChargePaisa: number;
  totalPaisa: number;
};

export type GuestOrderResult = {
  replayed: boolean;
  order: GuestOrderSummary;
  /** The private tracking token, in the first answer only (null on a replay). Never log or store it. */
  trackingToken: string | null;
};

async function summary(tx: Db, orderId: string): Promise<GuestOrderSummary> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw new Error("Guest checkout submission names a missing order.");
  const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.sku));
  return {
    reference: formatOrderNumber(order.number),
    orderStatus: order.orderStatus,
    placedAt: order.createdAt.toISOString(),
    deliveryZone: order.deliveryZone,
    items: items.map((i) => ({ sku: i.sku, name: { en: i.productNameEn, bn: i.productNameBn }, size: i.size, colour: i.colour, quantity: i.quantity, unitPricePaisa: i.unitPricePaisa, lineTotalPaisa: i.lineTotalPaisa })),
    subtotalPaisa: order.subtotalPaisa,
    deliveryChargePaisa: order.deliveryChargePaisa,
    totalPaisa: order.totalPaisa,
  };
}

const hex = (value: string) => Buffer.from(value, "hex");
const macsEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(hex(a), hex(b));

/** Refuses the order if any price, the delivery charge or the total differs from what the customer was shown. */
async function assertAsShown(tx: Db, orderId: string, shown: GuestCheckout) {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
  const lines = await tx.select({ sku: orderItems.sku, unitPricePaisa: orderItems.unitPricePaisa }).from(orderItems).where(eq(orderItems.orderId, orderId));
  const changed =
    order.deliveryChargePaisa !== shown.deliveryChargePaisa ||
    order.totalPaisa !== shown.totalPaisa ||
    shown.items.some((s) => lines.find((l) => l.sku === s.sku)?.unitPricePaisa !== s.unitPricePaisa);
  if (changed) throw new DomainError("QUOTE_CHANGED", "A price or the delivery charge changed after the cart was shown. Review the cart and submit again.");
}

/** Who placed the order, from the server's own session check (never from the request body). */
export type CheckoutPlacer = { customerUserId: string | null };

async function attempt(db: Db, key: string, input: GuestCheckout, placer: CheckoutPlacer): Promise<GuestOrderResult> {
  const keyHash = createHash("sha256").update(key).digest("hex");
  const requestMac = createHmac("sha256", key).update(canonicalJson({ operation: OPERATION, request: input })).digest("hex");
  return db.transaction(async (tx) => {
    // Claim the key. A concurrent transaction with the same key waits here until the first commits (then this one
    // reads its row) or rolls back (then this one claims the key itself), exactly as runOnce does for users.
    const claimed = await tx.insert(guestCheckoutSubmissions).values({ keyHash, requestMac }).onConflictDoNothing().returning({ keyHash: guestCheckoutSubmissions.keyHash });
    if (claimed.length === 0) {
      const [existing] = await tx.select().from(guestCheckoutSubmissions).where(eq(guestCheckoutSubmissions.keyHash, keyHash));
      if (!existing?.orderId) throw new Error("Guest checkout submission is missing or incomplete.");
      if (!macsEqual(existing.requestMac, requestMac)) throw new DomainError("IDEMPOTENCY_KEY_REUSED", "This checkout key was already used for a different order.");
      return { replayed: true, order: await summary(tx, existing.orderId), trackingToken: null };
    }

    // Unknown, inactive, draft, withdrawn and archived SKUs are refused alike, so the answer reveals nothing about
    // products a customer cannot see.
    const refused = await skusNotOrderableByCustomers(tx, input.items.map((i) => i.sku));
    if (refused.length) throw new DomainError("VARIANT_NOT_ORDERABLE", "An item cannot be ordered.");
    const order = await submitOrder(
      tx,
      { source: "website", ...input.customer, deliveryZone: input.deliveryZone, note: null, items: input.items.map((i) => ({ sku: i.sku, quantity: i.quantity })) },
      GUEST_CHECKOUT,
    );
    await assertAsShown(tx, order.id, input);
    const link = await createTrackingLink(tx, order.id, GUEST_CHECKOUT);
    // A signed-in customer's order is listed in their account; a guest order has no link. Same transaction as the order.
    if (placer.customerUserId) await tx.insert(customerOrders).values({ orderId: order.id, customerUserId: placer.customerUserId });
    const stored = await tx.update(guestCheckoutSubmissions).set({ orderId: order.id }).where(eq(guestCheckoutSubmissions.keyHash, keyHash)).returning({ keyHash: guestCheckoutSubmissions.keyHash });
    if (stored.length !== 1) throw new Error("Guest checkout submission was not updated.");
    return { replayed: false, order: await summary(tx, order.id), trackingToken: link.token };
  });
}

/**
 * Places one website order for an anonymous customer, at most once per key: validates everything first
 * (GuestCheckoutInvalid lists the fields), then creates the order, its reservations, its tracking link and the
 * submission record in one transaction. Any failure leaves none of them. Same key and request again: the same
 * order, `replayed: true`, no token. Same key, different request: IDEMPOTENCY_KEY_REUSED, nothing created.
 */
export async function placeGuestOrder(db: Db, rawKey: unknown, raw: unknown, placer: CheckoutPlacer = { customerUserId: null }): Promise<GuestOrderResult> {
  if (typeof rawKey !== "string" || !KEY.test(rawKey)) throw new GuestCheckoutInvalid([{ field: "idempotencyKey", code: "key_invalid" }]);
  const checked = validateGuestCheckout(raw);
  if (!checked.ok) throw new GuestCheckoutInvalid(checked.errors);
  await releaseOverdue(db);
  try {
    return await attempt(db, rawKey, checked.value, placer);
  } catch (error) {
    // An order may have passed its deadline between the sweep and the reservation: sweep again, retry once.
    if (!(error instanceof DomainError && error.code === "INSUFFICIENT_STOCK")) throw error;
    if ((await expireOverdueVerifications(db)) === 0) throw error;
    return attempt(db, rawKey, checked.value, placer);
  }
}
