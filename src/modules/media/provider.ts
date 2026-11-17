import "server-only";
import { DomainError } from "../domain-error";
import { type MediaStore, mediaStoreConfig } from "./storage";
import { type SupabaseMediaStore, supabaseMediaStore, supabaseStorageConfig } from "./supabase-store";

// Which MediaStore this installation uses: MEDIA_STORAGE_PROVIDER = local (default: the MEDIA_STORAGE_DIR folder,
// src/modules/media/storage.ts) or supabase (a private Supabase Storage bucket, supabase-store.ts). Anything else is
// refused, so a typo can never silently fall back to a different place.

export type MediaProvider = "local" | "supabase";
export type ConfiguredStore = { ok: true; provider: MediaProvider; store: MediaStore; supabase?: SupabaseMediaStore } | { ok: false; problem: string };

export function configuredMediaStore(env: Record<string, string | undefined>, projectRoot: string): ConfiguredStore {
  const provider = env.MEDIA_STORAGE_PROVIDER || "local";
  if (provider === "local") {
    const local = mediaStoreConfig(env, projectRoot);
    return local.ok ? { ok: true, provider, store: local.store } : local;
  }
  if (provider === "supabase") {
    const config = supabaseStorageConfig(env);
    if (!config.ok) return { ok: false, problem: config.problems.map((p) => p.problem).join(" ") };
    const store = supabaseMediaStore(config.config);
    return { ok: true, provider, store, supabase: store };
  }
  return { ok: false, problem: "MEDIA_STORAGE_PROVIDER must be local or supabase." };
}

/** The application's store, from the environment; MEDIA_STORAGE_UNAVAILABLE (with the reason) without one. */
export function getMediaStore(): MediaStore {
  const configured = configuredMediaStore(process.env, process.cwd());
  if (!configured.ok) throw new DomainError("MEDIA_STORAGE_UNAVAILABLE", configured.problem);
  return configured.store;
}
