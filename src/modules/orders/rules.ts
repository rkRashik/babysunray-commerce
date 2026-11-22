import { invalidInput } from "../domain-error";

// Order input validation and the lifecycle rules (docs/product/order-policy-decisions.md). Pure functions, so
// the services, Admin (which buttons to show) and the tests share one definition.

export const ORDER_SOURCES = ["website", "messenger", "whatsapp", "other"] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];
export const DELIVERY_ZONES = ["dhaka_city", "outside_dhaka"] as const;
/** How a customer pays: cash on delivery, or a manual advance transfer (ADR-0013). */
export const ORDER_PAYMENT_METHODS = ["cod", "bkash", "nagad", "bank_transfer"] as const;
export type OrderPaymentMethod = (typeof ORDER_PAYMENT_METHODS)[number];
export type DeliveryZone = (typeof DELIVERY_ZONES)[number];
export const ZONE_LABELS: Record<DeliveryZone, string> = { dhaka_city: "Dhaka City", outside_dhaka: "Outside Dhaka" };

export const VERIFICATION_WINDOW_HOURS = 24; // founder rule D
export const RETURN_WINDOW_DAYS = 7; // founder rule E
export const TRACKING_DAYS_AFTER_CLOSE = 30; // founder rule N
// Technical bounds, not business policy.
export const MAX_ORDER_LINES = 20;
export const MAX_LINE_QUANTITY = 1000;
export const MAX_DELIVERY_CHARGE_PAISA = 1_000_000;

/**
 * Bangladesh mobile number → 01XXXXXXXXX (text, leading zero kept). Accepts +880 / 880 / 0 prefixes with
 * spaces, hyphens or dots, in ASCII or Bangla digits (০-৯); the operator digit after 01 is 3 to 9.
 */
export function normalizeBdPhone(raw: string): string {
  if (typeof raw !== "string") throw invalidInput("phone", "must be text");
  const compact = raw.trim().replace(/[০-৯]/g, (d) => String("০১২৩৪৫৬৭৮৯".indexOf(d))).replace(/[\s.-]/g, "");
  const match = /^(?:\+?880|0)?(1[3-9][0-9]{8})$/.exec(compact);
  if (!match) throw invalidInput("phone", "must be a Bangladesh mobile number such as 01712345678");
  return `0${match[1]}`;
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Required free text: trimmed, 1 to max characters, no control characters (line breaks allowed if multiline). */
export function requiredText(raw: unknown, field: string, max: number, multiline = false): string {
  if (typeof raw !== "string") throw invalidInput(field, "is required");
  const text = raw.trim();
  if (text.length === 0) throw invalidInput(field, "is required");
  if (text.length > max) throw invalidInput(field, `must be at most ${max} characters`);
  if (CONTROL.test(text) || (!multiline && /[\r\n]/.test(text))) throw invalidInput(field, "contains characters that are not allowed");
  return text;
}

export type DetailsField = "name" | "phone" | "address";
export type DetailsError = "name_required" | "name_too_long" | "name_invalid" | "phone_invalid" | "address_required" | "address_too_long" | "address_invalid";
export type CustomerDetails = { customerName: string; customerPhone: string; deliveryAddress: string };

/**
 * A customer's own name, Bangladesh mobile number and delivery address, checked by the same rules as an order
 * (submitOrder): either the normalised values or a stable error code per field (for bilingual messages). Used by
 * the storefront preview's simulation and the guest checkout service, so both accept exactly the same input.
 */
export function checkCustomerDetails(input: { name: unknown; phone: unknown; address: unknown }): { values: CustomerDetails | null; errors: Partial<Record<DetailsField, DetailsError>> } {
  const errors: Partial<Record<DetailsField, DetailsError>> = {};
  const text = (raw: unknown, field: string, max: number, multiline: boolean, prefix: "name" | "address") => {
    try {
      return requiredText(raw, field, max, multiline);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      errors[prefix] = message.includes("is required") ? `${prefix}_required` : message.includes("at most") ? `${prefix}_too_long` : `${prefix}_invalid`;
      return null;
    }
  };
  const customerName = text(input.name, "customerName", 100, false, "name");
  const deliveryAddress = text(input.address, "deliveryAddress", 500, true, "address");
  let customerPhone: string | null = null;
  try {
    customerPhone = normalizeBdPhone(typeof input.phone === "string" ? input.phone : "");
  } catch {
    errors.phone = "phone_invalid";
  }
  return { values: customerName && deliveryAddress && customerPhone ? { customerName, customerPhone, deliveryAddress } : null, errors };
}

export function optionalNote(raw: unknown, field: string, max: number): string | null {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return null;
  return requiredText(raw, field, max, true);
}

export function validateQuantity(raw: number, field = "quantity"): number {
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > MAX_LINE_QUANTITY) throw invalidInput(field, `must be a whole number from 1 to ${MAX_LINE_QUANTITY}`);
  return raw;
}

/** A positive amount of money in paisa, exact as a JavaScript number. */
export function validateAmountPaisa(raw: number, field = "amountPaisa", options: { allowZero?: boolean; max?: number } = {}): number {
  const min = options.allowZero ? 0 : 1;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(raw) || raw < min || raw > max) throw invalidInput(field, `must be a whole number of paisa from ${min} to ${max}`);
  return raw;
}

/** A calendar date (YYYY-MM-DD) that is not after today in Asia/Dhaka. */
export function validatePastDate(raw: string, field: string, today = dhakaToday()): string {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    throw invalidInput(field, "must be a date (YYYY-MM-DD)");
  }
  if (new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) !== raw) throw invalidInput(field, "must be a real calendar date");
  if (raw > today) throw invalidInput(field, "cannot be in the future");
  return raw;
}

export function dhakaToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Shown to people as text (O-7). It is a reference, never a credential. */
export const formatOrderNumber = (n: number) => `ORD-${String(n).padStart(6, "0")}`;

/** "ORD-000042", "ord42", "#42" or "42" → 42; anything else → null. */
export function parseOrderNumber(raw: string): number | null {
  const match = /^(?:ORD-?|#)?0*([0-9]{1,15})$/i.exec(raw.trim());
  return match ? Number(match[1]) : null;
}

export type OrderStatus = "pending_verification" | "verification_expired" | "confirmed" | "cancelled" | "closed";
export type FulfilmentStatus = "unfulfilled" | "packed" | "dispatched" | "delivered" | "rto" | "rto_received";

/** What the transition rules need to know about an order (see the table in order-policy-decisions.md). */
export type OrderState = {
  orderStatus: OrderStatus;
  fulfilmentStatus: FulfilmentStatus;
  verificationExpiresAt: Date;
  deliveredAt: Date | null;
  totalPaisa: number;
  codCollectedPaisa: number;
  codSettledPaisa: number;
  /** Kept by the courier from the collected money, as the Owner recorded it (migration 0016). */
  codDeductedPaisa: number;
  /** Refunds recorded for returns (founder rule M). */
  refundedPaisa: number;
  /** The customer's chosen payment method and the advance money verified and refunded (migration 0025). */
  paymentMethod: OrderPaymentMethod;
  advanceReceivedPaisa: number;
  advanceRefundedPaisa: number;
  openCancellationRequest: boolean;
  openReturn: boolean;
  awaitingInspection: boolean;
};

export const ORDER_ACTIONS = [
  "confirm",
  "cancel",
  "pack",
  "dispatch",
  "deliver",
  "mark_rto",
  "receive_rto",
  "record_rto_charge",
  "close",
  "review_cancellation",
  "record_collection",
  "record_settlement",
  "record_deduction",
  "create_return",
  "customer_cancel",
  "customer_request_cancellation",
  // Manual advance payments (ADR-0013): verify money received, undo a mistaken verification, pay advance money back.
  "record_advance",
  "reverse_advance",
  "refund_advance",
] as const;
export type OrderAction = (typeof ORDER_ACTIONS)[number];

const HOUR = 3_600_000;

/** The last moment a return can be requested (founder rule E): 7 × 24 hours after the recorded delivery. */
export const returnWindowEnd = (deliveredAt: Date) => new Date(deliveredAt.getTime() + RETURN_WINDOW_DAYS * 24 * HOUR);

/** True once 24 elapsed hours have passed since submission, whether or not the expiry has been recorded. */
export const verificationOverdue = (s: Pick<OrderState, "orderStatus" | "verificationExpiresAt">, now: Date) =>
  s.orderStatus === "verification_expired" || (s.orderStatus === "pending_verification" && now.getTime() >= s.verificationExpiresAt.getTime());

/** Every action the rules allow for this order right now. Services refuse anything else (INVALID_TRANSITION). */
export function allowedActions(s: OrderState, now: Date): Set<OrderAction> {
  const allowed = new Set<OrderAction>();
  const beforeDispatch = s.fulfilmentStatus === "unfulfilled" || s.fulfilmentStatus === "packed";
  if (s.orderStatus === "pending_verification" || s.orderStatus === "verification_expired") {
    allowed.add("confirm").add("cancel");
    if (s.orderStatus === "pending_verification") allowed.add("customer_cancel");
  }
  if (s.orderStatus === "confirmed") {
    if (beforeDispatch) {
      allowed.add("cancel");
      if (s.openCancellationRequest) allowed.add("review_cancellation");
      else allowed.add("customer_request_cancellation");
    }
    if (s.fulfilmentStatus === "unfulfilled") allowed.add("pack");
    if (s.fulfilmentStatus === "packed" && !s.openCancellationRequest) allowed.add("dispatch");
    if (s.fulfilmentStatus === "dispatched") allowed.add("deliver").add("mark_rto");
    if (s.fulfilmentStatus === "rto") allowed.add("receive_rto");
    if (s.fulfilmentStatus === "rto" || s.fulfilmentStatus === "rto_received") allowed.add("record_rto_charge");
    // The courier can only collect what the customer has not already paid in advance.
    if ((s.fulfilmentStatus === "dispatched" || s.fulfilmentStatus === "delivered") && s.codCollectedPaisa + s.advanceReceivedPaisa < s.totalPaisa) allowed.add("record_collection");
    const windowOpen = s.deliveredAt !== null && now.getTime() <= returnWindowEnd(s.deliveredAt).getTime();
    if (s.fulfilmentStatus === "delivered" && !s.openReturn && windowOpen) allowed.add("create_return");
    // A delivered order is closed only after its return window, so closing (or settling) never ends the
    // customer's right to ask for a return (engineering default, order-policy-decisions.md section 3).
    const closable = s.fulfilmentStatus === "rto_received" || (s.fulfilmentStatus === "delivered" && s.deliveredAt !== null && !windowOpen);
    // A parcel that came back holds the customer's advance money: it is not closed until the refund is recorded.
    const advanceHeld = s.fulfilmentStatus === "rto_received" && refundableAdvance(s) > 0;
    if (closable && accounted(s) === s.codCollectedPaisa && !s.openReturn && !s.awaitingInspection && !advanceHeld) allowed.add("close");
  }
  // Collected money still with the courier: neither settled to the Owner nor recorded as deducted.
  if (accounted(s) < s.codCollectedPaisa && s.orderStatus !== "cancelled") allowed.add("record_settlement").add("record_deduction");
  // Advance money is a fact once it reached the store's account, whatever the order's status (a late transfer after
  // expiry or cancellation included), so it can be recorded until the order is closed. Recording it never confirms the
  // order or reserves stock again.
  if (s.paymentMethod !== "cod" && s.orderStatus !== "closed") {
    if (s.codCollectedPaisa + s.advanceReceivedPaisa < s.totalPaisa) allowed.add("record_advance");
    if (s.advanceReceivedPaisa > 0) allowed.add("reverse_advance");
  }
  // Money received for an order that will not be delivered (cancelled, or returned to the shop undelivered) must be paid
  // back by hand, never automatically.
  if (advanceRefundDue(s)) allowed.add("refund_advance");
  return allowed;
}

/** True when the order will not be delivered (cancelled, or the parcel came back) but still holds verified advance money. */
export const advanceRefundDue = (s: Pick<OrderState, "orderStatus" | "fulfilmentStatus" | "codCollectedPaisa" | "refundedPaisa" | "advanceReceivedPaisa" | "advanceRefundedPaisa">) =>
  (s.orderStatus === "cancelled" || (s.orderStatus === "confirmed" && s.fulfilmentStatus === "rto_received")) && refundableAdvance(s) > 0;

/** Verified advance money not yet paid back (by an advance refund or a return refund). */
export const refundableAdvance = (s: Pick<OrderState, "codCollectedPaisa" | "refundedPaisa" | "advanceReceivedPaisa" | "advanceRefundedPaisa">) =>
  Math.min(s.advanceReceivedPaisa - s.advanceRefundedPaisa, s.codCollectedPaisa + s.advanceReceivedPaisa - s.refundedPaisa - s.advanceRefundedPaisa);

/** What the customer still owes: the total less COD collected and verified advance money. */
export const amountDue = (s: Pick<OrderState, "totalPaisa" | "codCollectedPaisa" | "advanceReceivedPaisa">) => Math.max(0, s.totalPaisa - s.codCollectedPaisa - s.advanceReceivedPaisa);

/** Collected money the courier has accounted for: settled to the Owner or recorded as deducted. */
const accounted = (s: Pick<OrderState, "codSettledPaisa" | "codDeductedPaisa">) => s.codSettledPaisa + s.codDeductedPaisa;

/**
 * Payment status is a function of the amounts (the database checks the same rule): money received (COD collected plus
 * verified advance) against the total. 'settled' means every COD taka collected is settled to the Owner or recorded as
 * deducted by the courier (verified advance money is already the Owner's).
 */
export function paymentStatusFor(totalPaisa: number, collected: number, settled: number, deducted: number, advance = 0) {
  if (collected + advance === 0) return "unpaid" as const;
  if (collected + advance < totalPaisa) return "partially_collected" as const;
  return settled + deducted < collected ? ("collected" as const) : ("settled" as const);
}

/** A tracking link works until it is revoked, or until 30 days after the order was closed. */
export function trackingLinkLive(closedAt: Date | null, revokedAt: Date | null, now: Date): boolean {
  if (revokedAt) return false;
  return closedAt === null || now.getTime() < closedAt.getTime() + TRACKING_DAYS_AFTER_CLOSE * 24 * HOUR;
}

export const maskName = (name: string) => `${Array.from(name.trim())[0] ?? ""}***`;
export const maskPhone = (phone: string) => `${phone.slice(0, 3)}******${phone.slice(-2)}`;
