import { invalidInput } from "../domain-error";

// Order input validation and the lifecycle rules (docs/product/order-policy-decisions.md). Pure functions, so
// the services, the Office (which buttons to show) and the tests share one definition.

export const ORDER_SOURCES = ["website", "messenger", "whatsapp", "other"] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];
export const DELIVERY_ZONES = ["dhaka_city", "outside_dhaka"] as const;
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
 * spaces, hyphens or dots; the operator digit after 01 is 3 to 9.
 */
export function normalizeBdPhone(raw: string): string {
  if (typeof raw !== "string") throw invalidInput("phone", "must be text");
  const compact = raw.trim().replace(/[\s.-]/g, "");
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
  "create_return",
  "customer_cancel",
  "customer_request_cancellation",
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
    if ((s.fulfilmentStatus === "dispatched" || s.fulfilmentStatus === "delivered") && s.codCollectedPaisa < s.totalPaisa) allowed.add("record_collection");
    const windowOpen = s.deliveredAt !== null && now.getTime() <= returnWindowEnd(s.deliveredAt).getTime();
    if (s.fulfilmentStatus === "delivered" && !s.openReturn && windowOpen) allowed.add("create_return");
    // A delivered order is closed only after its return window, so closing (or settling) never ends the
    // customer's right to ask for a return (engineering default, order-policy-decisions.md section 3).
    const closable = s.fulfilmentStatus === "rto_received" || (s.fulfilmentStatus === "delivered" && s.deliveredAt !== null && !windowOpen);
    if (closable && s.codSettledPaisa === s.codCollectedPaisa && !s.openReturn && !s.awaitingInspection) allowed.add("close");
  }
  if (s.codSettledPaisa < s.codCollectedPaisa && s.orderStatus !== "cancelled") allowed.add("record_settlement");
  return allowed;
}

/** Payment status is a function of the amounts (the database checks the same rule). */
export function paymentStatusFor(totalPaisa: number, collected: number, settled: number) {
  if (collected === 0) return "unpaid" as const;
  if (collected < totalPaisa) return "partially_collected" as const;
  return settled < collected ? ("collected" as const) : ("settled" as const);
}

/** A tracking link works until it is revoked, or until 30 days after the order was closed. */
export function trackingLinkLive(closedAt: Date | null, revokedAt: Date | null, now: Date): boolean {
  if (revokedAt) return false;
  return closedAt === null || now.getTime() < closedAt.getTime() + TRACKING_DAYS_AFTER_CLOSE * 24 * HOUR;
}

export const maskName = (name: string) => `${Array.from(name.trim())[0] ?? ""}***`;
export const maskPhone = (phone: string) => `${phone.slice(0, 3)}******${phone.slice(-2)}`;
