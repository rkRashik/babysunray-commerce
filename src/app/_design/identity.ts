import "server-only";
import { cache } from "react";
import { type InstallationIdentity, installationIdentity } from "@/config/installation";
import { getDb } from "@/db/client";
import { storeIdentity } from "@/modules/settings/store";

/**
 * The store identity for a page: the Owner's settings over the installation defaults (src/modules/settings/store.ts), read
 * once per request. When the database cannot be read (a fresh or misconfigured installation), the defaults are used, so the
 * sign-in and setup pages still render.
 */
export const currentStoreIdentity = cache(async (): Promise<InstallationIdentity> => {
  try {
    return await storeIdentity(getDb());
  } catch {
    return installationIdentity();
  }
});
