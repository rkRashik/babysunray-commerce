import "server-only";
import { getDb } from "@/db/client";
import { readAuthSettings } from "../auth/settings";
import { emailAvailable, emailSender } from "../email/service";
import { type CustomerAuth, createCustomerAuth, readGoogleSettings } from "./auth";

// The installation's customer sign-in instance, created on first use (a build needs no secrets). Null when neither Google
// nor email is set up: then nothing is offered and every customer-auth route answers 404. Email and password accounts need
// email (RESEND_API_KEY, EMAIL_FROM) for verification and password reset; without it only Google is offered.

let instance: CustomerAuth | null | undefined;

export function getCustomerAuth(): CustomerAuth | null {
  if (instance !== undefined) return instance;
  const google = readGoogleSettings(process.env);
  const email = emailAvailable() ? emailSender() : null;
  if (!google && !email) return (instance = null);
  const { secret, baseURL } = readAuthSettings(process.env);
  instance = createCustomerAuth(getDb(), { baseURL, secret, google, email, storeName: process.env.STORE_NAME?.trim() || undefined });
  return instance;
}

/** Which customer sign-in methods are offered. Never throws. */
export function customerSignInMethods(): { google: boolean; email: boolean } {
  try {
    return { google: readGoogleSettings(process.env) !== null && getCustomerAuth() !== null, email: emailAvailable() && getCustomerAuth() !== null };
  } catch {
    return { google: false, email: false };
  }
}

/** Whether "Continue with Google" can be offered (configured and valid). Never throws. */
export function customerSignInAvailable(): boolean {
  return customerSignInMethods().google;
}

/** The signed-in customer of this request (its customer cookie only), or null. */
export async function currentCustomer(headers: Headers): Promise<{ id: string; name: string } | null> {
  const methods = customerSignInMethods();
  if (!methods.google && !methods.email) return null;
  const cookie = headers.get("cookie");
  if (!cookie) return null;
  const session = await getCustomerAuth()!.api.getSession({ headers: new Headers({ cookie }), query: { disableCookieCache: true } });
  return session ? { id: session.user.id, name: session.user.name } : null;
}
