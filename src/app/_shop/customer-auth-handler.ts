import "server-only";
import { CUSTOMER_AUTH_ROUTES, CUSTOMER_BASE_PATH } from "@/modules/customers/auth";
import { getCustomerAuth } from "@/modules/customers/server";
import { anonymousDatabaseWork } from "@/modules/rate-limit/bulkhead";
import { accessForRequest } from "./access";

// The HTTP door to the customer sign-in instance (src/modules/customers/auth.ts). It answers only while the shop is open for
// the request (acceptance pass or public launch), only when Google sign-in is configured, and only for the three allowlisted
// endpoints; everything else is 404, so a Better Auth upgrade cannot expose a new endpoint here. Customer traffic runs in the
// anonymous bulkhead, never in the Owner's sign-in bulkhead.

const notFound = () => new Response("Not Found", { status: 404, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });
const busy = () => new Response(JSON.stringify({ code: "BUSY", message: "Sign-in is busy right now. Try again in a moment." }), { status: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "retry-after": "1" } });

/** `request` must address CUSTOMER_BASE_PATH + one of CUSTOMER_AUTH_ROUTES. */
export async function customerAuthResponse(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const route = `${request.method} ${path.startsWith(`${CUSTOMER_BASE_PATH}/`) ? path.slice(CUSTOMER_BASE_PATH.length) : ""}`;
  if (!(CUSTOMER_AUTH_ROUTES as readonly string[]).includes(route)) return notFound();
  if ((await accessForRequest(request)) === "closed") return notFound();
  let auth: ReturnType<typeof getCustomerAuth>;
  try {
    auth = getCustomerAuth();
  } catch {
    return notFound();
  }
  if (!auth) return notFound();
  const done = await anonymousDatabaseWork(() => auth.handler(request));
  return done.ok ? done.value : busy();
}
