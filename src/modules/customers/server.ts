import "server-only";
import { getDb } from "@/db/client";
import { readAuthSettings } from "../auth/settings";
import { type CustomerAuth, createCustomerAuth, readGoogleSettings } from "./auth";

// The installation's customer sign-in instance, created on first use (a build needs no secrets). Null when Google sign-in
// is not configured: then nothing is offered and every customer-auth route answers 404.

let instance: CustomerAuth | null | undefined;

export function getCustomerAuth(): CustomerAuth | null {
  if (instance !== undefined) return instance;
  const google = readGoogleSettings(process.env);
  if (!google) return (instance = null);
  const { secret, baseURL } = readAuthSettings(process.env);
  instance = createCustomerAuth(getDb(), { baseURL, secret, google });
  return instance;
}

/** Whether "Continue with Google" can be offered (configured and valid). Never throws. */
export function customerSignInAvailable(): boolean {
  try {
    return getCustomerAuth() !== null;
  } catch {
    return false;
  }
}

/** The signed-in customer of this request (its customer cookie only), or null. */
export async function currentCustomer(headers: Headers): Promise<{ id: string; name: string } | null> {
  if (!customerSignInAvailable()) return null;
  const cookie = headers.get("cookie");
  if (!cookie) return null;
  const session = await getCustomerAuth()!.api.getSession({ headers: new Headers({ cookie }), query: { disableCookieCache: true } });
  return session ? { id: session.user.id, name: session.user.name } : null;
}
