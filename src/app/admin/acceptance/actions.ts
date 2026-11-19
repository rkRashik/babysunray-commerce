"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { readAuthSettings } from "@/modules/auth/settings";
import { ACCEPTANCE_COOKIE, isStagingDatabase, issuePass } from "@/modules/launch/acceptance";
import type { FormState } from "../_lib/form";
import { requireAdmin } from "../_lib/session";

// Starting and ending founder acceptance in this browser (ADR-0011). Each action checks the Owner session and
// `acceptance:run` itself. A pass is issued only while the database carries the staging marker; it is an HttpOnly cookie
// (page scripts cannot read it), sent only to this site, for PASS_HOURS. Ending it removes the cookie from this browser.

export async function startAcceptanceAction(): Promise<FormState> {
  const principal = await requireAdmin("acceptance:run");
  if (!(await isStagingDatabase(getDb()))) {
    return { error: "This database is not marked as the staging database, so founder acceptance cannot start here. It never can on a production or development database." };
  }
  const { secret, baseURL } = readAuthSettings(process.env);
  const pass = issuePass(secret, principal.userId);
  (await cookies()).set(ACCEPTANCE_COOKIE, pass.value, {
    httpOnly: true,
    secure: baseURL.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    expires: pass.expiresAt,
  });
  redirect("/admin/acceptance?done=acceptanceStarted");
}

export async function endAcceptanceAction(): Promise<FormState> {
  await requireAdmin("acceptance:run");
  (await cookies()).delete(ACCEPTANCE_COOKIE);
  redirect("/admin/acceptance?done=acceptanceEnded");
}
