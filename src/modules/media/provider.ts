import "server-only";
import { DomainError } from "../domain-error";
import { type MediaStore, mediaStoreConfig } from "./storage";
import { type SupabaseMediaStore, supabaseMediaStore, supabaseStorageConfig } from "./supabase-store";

// Which MediaStore this installation uses: MEDIA_STORAGE_PROVIDER = local (default: the MEDIA_STORAGE_DIR folder,
// src/modules/media/storage.ts) or supabase (a private Supabase Storage bucket, supabase-store.ts). Anything else is
// refused, so a typo can never silently fall back to a different place.
//
// A public bucket would make every stored photo, drafts included, reachable by URL. So a Supabase store refuses to WRITE
// unless the bucket was confirmed private (and unversioned) within the last minute, and readiness reports not ready
// (src/api/health.ts). The answer is remembered per bucket for one minute in this process.

export type MediaProvider = "local" | "supabase";
export type ConfiguredStore = { ok: true; provider: MediaProvider; store: MediaStore; supabase?: SupabaseMediaStore } | { ok: false; problem: string };

export const PRIVACY_CHECK_MS = 60_000;
const privacy = new Map<string, { at: number; ok: Promise<boolean> }>();

/** Whether the bucket is private, asked at most once a minute per bucket; a failed check is not remembered. */
export function bucketConfirmedPrivate(id: string, store: SupabaseMediaStore, now = Date.now()): Promise<boolean> {
  const known = privacy.get(id);
  if (known && now - known.at < PRIVACY_CHECK_MS) return known.ok;
  const ok = store.bucketIsPrivate();
  privacy.set(id, { at: now, ok });
  void ok.then((result) => {
    if (!result) privacy.delete(id);
  });
  return ok;
}

function writeOnlyWhenPrivate(id: string, store: SupabaseMediaStore): SupabaseMediaStore {
  return {
    ...store,
    async put(key, data) {
      if (!(await bucketConfirmedPrivate(id, store))) {
        throw new DomainError("MEDIA_STORAGE_UNAVAILABLE", "The photo bucket is not confirmed private (or is versioned), so no photo is stored. Make it private in Supabase Storage.");
      }
      return store.put(key, data);
    },
  };
}

export function configuredMediaStore(env: Record<string, string | undefined>, projectRoot: string): ConfiguredStore {
  const provider = env.MEDIA_STORAGE_PROVIDER || "local";
  if (provider === "local") {
    const local = mediaStoreConfig(env, projectRoot);
    return local.ok ? { ok: true, provider, store: local.store } : local;
  }
  if (provider === "supabase") {
    const config = supabaseStorageConfig(env);
    if (!config.ok) return { ok: false, problem: config.problems.map((p) => p.problem).join(" ") };
    const store = writeOnlyWhenPrivate(`${config.config.origin}/${config.config.bucket}`, supabaseMediaStore(config.config));
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

/** For readiness: null when photos are not in Supabase; otherwise whether the configured bucket is confirmed private. */
export function configuredBucketPrivate(env: Record<string, string | undefined>): Promise<boolean> | null {
  if (env.MEDIA_STORAGE_PROVIDER !== "supabase") return null;
  const config = supabaseStorageConfig(env);
  if (!config.ok) return Promise.resolve(false);
  return bucketConfirmedPrivate(`${config.config.origin}/${config.config.bucket}`, supabaseMediaStore(config.config));
}
