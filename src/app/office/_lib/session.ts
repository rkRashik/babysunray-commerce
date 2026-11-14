import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import type { Permission } from "@/modules/auth/permissions";
import { assertPermission, getPrincipal, type Principal } from "@/modules/auth/principal";
import { getAuth } from "@/modules/auth/server";

// Owner Office access. Every page and Server Action calls one of these itself (a layout check alone is not
// access control). Only the HttpOnly session cookie is used (getPrincipal); an Authorization header is
// ignored, so Bearer tokens never authenticate the Office.

/** The verified principal of this browser request, or null. */
export async function currentPrincipal(): Promise<Principal | null> {
  // headers() first: it marks the page as per-request, so nothing here runs (or needs secrets) at build time.
  const requestHeaders = await headers();
  return getPrincipal(getAuth(), getDb(), requestHeaders);
}

/** Redirects to the sign-in page without a session; FORBIDDEN (error page) without every permission. */
export async function requireOffice(...permissions: Permission[]): Promise<Principal> {
  const principal = await currentPrincipal();
  if (!principal) redirect("/office/login");
  for (const permission of permissions) assertPermission(principal, permission);
  return principal;
}
