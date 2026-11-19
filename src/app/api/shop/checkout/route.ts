import { guestCheckoutResponse } from "@/api/guest-checkout";
import { accessForRequest } from "@/app/_shop/access";
import { getDb } from "@/db/client";
import type { Db } from "@/db/database";
import { readAuthSettings } from "@/modules/auth/settings";
import { currentCustomer } from "@/modules/customers/server";
import { clientKey } from "@/modules/rate-limit/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/shop/checkout: places a real Cash on Delivery order (src/api/guest-checkout.ts has the HTTP rules; the service
// is src/modules/orders/guest-checkout.ts). Open only while the shop is open for this request: the public launch gate
// (closed in this version) or a founder acceptance pass on the staging database (src/modules/launch/acceptance.ts).
// Closed: 503 before anything is read, and no database work (the closed transport never touches `db`).
const CLOSED = () => ({ open: false });
const OPEN = () => ({ open: true });

async function handle(request: Request): Promise<Response> {
  if (request.method !== "POST" || (await accessForRequest(request)) === "closed") {
    return guestCheckoutResponse(request, { db: null as unknown as Db, baseUrl: "", gate: CLOSED });
  }
  const { baseURL, secret } = readAuthSettings(process.env);
  // The customer comes from the customer session cookie, verified here; the body cannot name one.
  const customer = await currentCustomer(request.headers).catch(() => null);
  return guestCheckoutResponse(request, {
    db: getDb(),
    baseUrl: baseURL,
    gate: OPEN,
    placer: { customerUserId: customer?.id ?? null },
    clientKey: clientKey(request.headers, process.env, secret),
  });
}
export { handle as POST, handle as GET, handle as PUT, handle as DELETE, handle as PATCH };
