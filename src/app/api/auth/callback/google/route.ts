import { customerAuthResponse } from "@/app/_shop/customer-auth-handler";
import { CUSTOMER_BASE_PATH } from "@/modules/customers/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/auth/callback/google: the redirect URI registered with Google for this installation. It belongs to the CUSTOMER
// sign-in, never to the Owner's (whose /api/auth instance has no social provider and refuses /callback/:id). This more
// specific route takes precedence over /api/auth/[...all] and hands the request, unchanged apart from its path, to the
// customer instance's own callback.
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = `${CUSTOMER_BASE_PATH}/callback/google`;
  return customerAuthResponse(new Request(url, { method: "GET", headers: request.headers }));
}
