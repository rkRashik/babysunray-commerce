import "server-only";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { AuthConfigError, readAuthSettings } from "@/modules/auth/settings";
import { ACCEPTANCE_COOKIE, passFromCookieHeader, type ShopAccess, shopAccess } from "@/modules/launch/acceptance";

// The shop's access check for pages, Server Actions and route handlers (src/modules/launch/acceptance.ts decides).
// Every shop page, action and route calls one of these itself; the layout's check alone is not access control.

const deps = { db: getDb, secret: () => readAuthSettings(process.env).secret };

async function decide(pass: string | undefined): Promise<ShopAccess> {
  try {
    return await shopAccess(deps, pass);
  } catch (error) {
    // Sign-in not configured: no pass can be verified, so the shop is closed.
    if (error instanceof AuthConfigError) return "closed";
    throw error;
  }
}

/** For a route handler: the access of this request, from its Cookie header. */
export const accessForRequest = (request: Request): Promise<ShopAccess> => decide(passFromCookieHeader(request.headers.get("cookie")));

/** For a page or Server Action: the access of this request. */
export async function currentShopAccess(): Promise<ShopAccess> {
  return decide((await cookies()).get(ACCEPTANCE_COOKIE)?.value);
}

/** For a page: a closed shop does not exist (404), so nothing about it is revealed. */
export async function requireShop(): Promise<Exclude<ShopAccess, "closed">> {
  const access = await currentShopAccess();
  if (access === "closed") notFound();
  return access;
}
