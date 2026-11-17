import { parseStagingUrl } from "./hosted-target.mts";

// What is still missing or wrong in the staging settings, judged from the settings alone: no network, no connection,
// and no value is ever returned (only setting names and fixed messages). Gate H.46B. It cannot see the things that
// are only visible on the database (the staging marker, the application role, the private bucket): the commands
// check those themselves, after connecting, and refuse.

type Env = Record<string, string | undefined>;
export type SettingState = { name: string; state: "ok" | "missing" | "invalid"; note?: string };

export const MIGRATION_URL = "STAGING_MIGRATION_DATABASE_URL";
export const APP_URL = "STAGING_DATABASE_URL";
export const STAGING_SETTINGS = [MIGRATION_URL, APP_URL, "STAGING_DATABASE_SSL", "STAGING_SUPABASE_URL", "STAGING_SUPABASE_PUBLISHABLE_KEY", "STAGING_SUPABASE_SECRET_KEY", "STAGING_STORAGE_BUCKET"] as const;

/** The project ref in `db.<ref>.supabase.co` (a direct connection) or in a pooler user `<role>.<ref>`. */
function refOf(url: string, how: "host" | "user"): string | null {
  try {
    const u = new URL(url);
    if (how === "user") {
      const user = decodeURIComponent(u.username);
      return user.includes(".") ? user.slice(user.indexOf(".") + 1) : null;
    }
    return /^db\.([a-z0-9]+)\.supabase\.co$/.exec(u.hostname)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function stagingPreflight(env: Env): { settings: SettingState[]; ready: boolean; connectionMode: string | null } {
  const out: SettingState[] = [];
  const add = (name: string, state: SettingState["state"], note?: string) => out.push({ name, state, ...(note ? { note } : {}) });
  const refs = new Set<string>();
  let connectionMode: string | null = null;

  const check = (name: string, pooled: boolean) => {
    const raw = env[name];
    if (!raw) return add(name, "missing");
    try {
      const conn = parseStagingUrl(env, name, { pooled });
      if (pooled) {
        if (!conn.user.startsWith("babysunray_app.")) return add(name, "invalid", "the user must be babysunray_app.<project-ref>, never the administrator");
        refs.add(conn.user.slice("babysunray_app.".length));
      } else {
        if (conn.user.startsWith("babysunray_app")) return add(name, "invalid", "the administrator connection must not use the application role");
        const ref = refOf(raw, "host") ?? refOf(raw, "user");
        if (ref) refs.add(ref);
        connectionMode = refOf(raw, "host") ? "direct connection" : conn.user.includes(".") ? "session pooler" : "unrecognised host";
      }
      add(name, "ok");
    } catch (error) {
      add(name, "invalid", error instanceof Error ? error.message.split(name).join("this setting") : "not valid");
    }
  };
  check(MIGRATION_URL, false);
  check(APP_URL, true);
  const ssl = env.STAGING_DATABASE_SSL;
  if (!ssl) add("STAGING_DATABASE_SSL", "missing");
  else if (ssl === "require" || ssl === "verify-full") add("STAGING_DATABASE_SSL", "ok");
  else add("STAGING_DATABASE_SSL", "invalid", "must be require or verify-full");

  const url = env.STAGING_SUPABASE_URL;
  if (!url) add("STAGING_SUPABASE_URL", "missing");
  else {
    const m = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(url);
    if (!m) add("STAGING_SUPABASE_URL", "invalid", "must look like https://<project-ref>.supabase.co");
    else {
      refs.add(m[1]);
      add("STAGING_SUPABASE_URL", "ok");
    }
  }
  const publishable = env.STAGING_SUPABASE_PUBLISHABLE_KEY;
  const secret = env.STAGING_SUPABASE_SECRET_KEY;
  if (!publishable) add("STAGING_SUPABASE_PUBLISHABLE_KEY", "missing");
  else if (publishable.startsWith("sb_secret_")) add("STAGING_SUPABASE_PUBLISHABLE_KEY", "invalid", "this is a secret key; use the publishable key");
  else add("STAGING_SUPABASE_PUBLISHABLE_KEY", "ok");
  if (!secret) add("STAGING_SUPABASE_SECRET_KEY", "missing");
  else if (secret.startsWith("sb_publishable_")) add("STAGING_SUPABASE_SECRET_KEY", "invalid", "this is a publishable key; use the secret key");
  else if (secret === publishable) add("STAGING_SUPABASE_SECRET_KEY", "invalid", "the same value as the publishable key");
  else if (!secret.startsWith("sb_secret_") && secret.split(".").length !== 3) add("STAGING_SUPABASE_SECRET_KEY", "invalid", "not a secret key (sb_secret_...) or a legacy service_role key");
  else add("STAGING_SUPABASE_SECRET_KEY", "ok");
  add("STAGING_STORAGE_BUCKET", env.STAGING_STORAGE_BUCKET ? "ok" : "missing");

  if (refs.size > 1) add("(project consistency)", "invalid", "the settings name more than one Supabase project");
  const byName = new Map(out.map((s) => [s.name, s]));
  const settings = [...STAGING_SETTINGS.map((n) => byName.get(n)!), ...out.filter((s) => s.name.startsWith("("))];
  return { settings, ready: settings.every((s) => s.state === "ok"), connectionMode };
}
