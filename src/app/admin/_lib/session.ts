import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { currentStoreIdentity } from "@/app/_design/identity";
import { getDb } from "@/db/client";
import type { Permission } from "@/modules/auth/permissions";
import { assertPermission, getPrincipal, type Principal } from "@/modules/auth/principal";
import { getAuth } from "@/modules/auth/server";
import { AuthConfigError } from "@/modules/auth/settings";

// Admin access. Every page and Server Action calls one of these itself (a layout check alone is not
// access control). Only the HttpOnly session cookie is used (getPrincipal); an Authorization header is
// ignored, so Bearer tokens never authenticate Admin.

/** The verified principal of this browser request, or null. */
export async function currentPrincipal(): Promise<Principal | null> {
  // headers() first: it marks the page as per-request, so nothing here runs (or needs secrets) at build time.
  const requestHeaders = await headers();
  return getPrincipal(getAuth(), getDb(), requestHeaders);
}

/**
 * Redirects to the sign-in page without a session (or while sign-in is not configured, where that page says
 * why); FORBIDDEN (error page) without every permission.
 */
export async function requireAdmin(...permissions: Permission[]): Promise<Principal> {
  // A page always shows the store name in its shell: read it while the session is checked instead of after the page's own
  // queries (each database round trip costs tens of milliseconds on a hosted database). Server Actions do not render a shell.
  if (!(await headers()).get("next-action")) void currentStoreIdentity();
  const principal = await currentPrincipal().catch((error: unknown) => {
    if (error instanceof AuthConfigError) redirect("/admin/login");
    throw error;
  });
  if (!principal) redirect("/admin/login");
  for (const permission of permissions) assertPermission(principal, permission);
  return principal;
}
