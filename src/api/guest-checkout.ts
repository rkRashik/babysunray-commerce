import "server-only";
import { randomUUID } from "node:crypto";
import { type Db, pgErrorCode } from "@/db/database";
import { DomainError } from "@/modules/domain-error";
import { GuestCheckoutInvalid, placeGuestOrder, validateGuestCheckout } from "@/modules/orders/guest-checkout";
import { anonymousCheckoutWork, type Bulkhead } from "@/modules/rate-limit/bulkhead";
import { consumePublicLimit } from "@/modules/rate-limit/service";
import { ApiProblem, readBody } from "./v1/http";

// The future public checkout transport, prepared but NOT ROUTED: no file under src/app imports this module (a test
// checks), so no request can reach it in development or production. Tests call it directly against babysunray_test
// to prove the HTTP behaviour. Opening it needs a route file that passes the real launch gate
// (src/modules/launch/gate.ts), which refuses in this version, and abuse protection the hosting decision allows.
//
// Order of checks: the gate (closed: answered before reading anything), origin (same origin only, no CORS), media
// type, Idempotency-Key header, body size (64 KiB, counted while streaming), JSON, then the service. Answers carry
// fixed messages only, never echoed input. The tracking token is in the first success answer only and is never
// logged; errors log the error name and SQL state only.

export type CheckoutDeps = { db: Db; baseUrl: string; gate: () => { open: boolean }; bulkhead?: Bulkhead };

const HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "content-type": "application/json; charset=utf-8",
};
const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...headers } });
const refusal = (status: number, error: string, message: string) => answer(status, { error, message });

const JSON_TYPE = /^application\/json\s*(;\s*charset\s*=\s*("?)utf-8\2\s*)?$/i;
const KEY_HEADER = /^(?:"([A-Za-z0-9_-]{32,128})"|([A-Za-z0-9_-]{32,128}))$/;

const BUSINESS: Partial<Record<DomainError["code"], [number, string, string]>> = {
  INSUFFICIENT_STOCK: [409, "out_of_stock", "Some items are no longer available in the quantity you chose. Your order was not placed."],
  VARIANT_NOT_FOUND: [409, "unavailable", "An item in your cart can no longer be ordered. Your order was not placed."],
  VARIANT_NOT_ORDERABLE: [409, "unavailable", "An item in your cart can no longer be ordered. Your order was not placed."],
  DELIVERY_ZONE_UNAVAILABLE: [409, "zone_unavailable", "Delivery to this area cannot be ordered online right now. Your order was not placed."],
  QUOTE_CHANGED: [409, "quote_changed", "A price or the delivery charge changed. Please review your cart. Your order was not placed."],
  IDEMPOTENCY_KEY_REUSED: [422, "key_reused", "This checkout was already used for a different order. Start the checkout again."],
};

/**
 * Guest checkout submissions accepted per minute from all clients together (a technical bound, not policy): it
 * limits how many anonymous orders, and so 24-hour stock holds, a flood can create. Anyone can use it up, which
 * blocks checkout for everyone until the minute ends; a per-client limit needs a trusted proxy (decision 1).
 */
export const GUEST_CHECKOUTS_PER_MINUTE = 20;

export async function guestCheckoutResponse(request: Request, deps: CheckoutDeps): Promise<Response> {
  const requestId = randomUUID();
  const response = await respond(request, deps, requestId);
  response.headers.set("x-request-id", requestId);
  return response;
}

async function respond(request: Request, deps: CheckoutDeps, requestId: string): Promise<Response> {
  if (request.method !== "POST") return answer(405, { error: "method_not_allowed", message: "Use POST." }, { allow: "POST" });
  if (!deps.gate().open) return refusal(503, "checkout_closed", "Online ordering is not open yet. Please contact the shop to order.");
  if (request.headers.get("origin") !== deps.baseUrl) return refusal(403, "forbidden", "This request is not allowed.");
  if (!JSON_TYPE.test(request.headers.get("content-type") ?? "")) return refusal(415, "unsupported_media_type", "Send the order as application/json (UTF-8).");
  const key = KEY_HEADER.exec(request.headers.get("idempotency-key") ?? "");
  if (!key) return refusal(400, "key_required", "Send an Idempotency-Key header: 32 to 128 random characters (a UUID fits).");
  try {
    let body: unknown;
    try {
      body = JSON.parse((await readBody(request)) ?? "");
    } catch (error) {
      if (error instanceof ApiProblem && error.code === "PAYLOAD_TOO_LARGE") return refusal(413, "too_large", "The order is too large.");
      return refusal(400, "bad_request", "The order could not be read.");
    }
    // Counted only for requests that pass every field check, so malformed or invalid traffic (refused here without
    // any database work) cannot use up the minute's submissions. A retry of an earlier submission counts too.
    const checked = validateGuestCheckout(body);
    if (!checked.ok) return answer(400, { error: "invalid", message: "Please check the highlighted details.", errors: checked.errors });
    // All database work inside the checkout's own bulkhead (src/modules/rate-limit/bulkhead.ts).
    const done = await (deps.bulkhead ?? anonymousCheckoutWork)(async () => {
      if (!(await consumePublicLimit(deps.db, "checkout", GUEST_CHECKOUTS_PER_MINUTE))) {
        return answer(429, { error: "rate_limited", message: "Many orders are being placed right now. Please try again in a minute. Your order was not placed." }, { "retry-after": "60" });
      }
      const result = await placeGuestOrder(deps.db, key[1] ?? key[2], body);
      return answer(result.replayed ? 200 : 201, { data: { order: result.order, trackingToken: result.trackingToken } }, { "idempotent-replayed": String(result.replayed) });
    });
    return done.ok ? done.value : answer(503, { error: "busy", message: "Ordering is busy right now. Please try again in a moment. Your order was not placed." }, { "retry-after": "1" });
  } catch (error) {
    if (error instanceof GuestCheckoutInvalid) return answer(400, { error: "invalid", message: "Please check the highlighted details.", errors: error.errors });
    if (error instanceof DomainError && BUSINESS[error.code]) {
      const [status, code, message] = BUSINESS[error.code] as [number, string, string];
      return refusal(status, code, message);
    }
    console.error(JSON.stringify({ level: "error", event: "guest_checkout_failed", requestId, errorName: error instanceof Error ? error.name : typeof error, sqlState: pgErrorCode(error) ?? null }));
    return refusal(500, "internal", "Your order was not recorded. Please try again, or contact the shop.");
  }
}
