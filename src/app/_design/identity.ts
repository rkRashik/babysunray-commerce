import "server-only";
import { cache } from "react";
import { DEFAULT_STORE_NAME, type InstallationIdentity, installationIdentity } from "@/config/installation";
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
  } catch (error) {
    // Visible in the server log (no names or values): the store name then comes from the installation settings only.
    console.error("The store identity could not be read from the database; using the installation settings.", (error as { code?: string })?.code ?? "");
    return installationIdentity();
  }
});

/** The name to show in Admin: the configured one, or a neutral placeholder (never the installation default as if it were a brand). */
export const adminStoreName = (identity: InstallationIdentity) => (identity.storeName === DEFAULT_STORE_NAME ? "Your store" : identity.storeName);
