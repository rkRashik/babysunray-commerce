import { DEV_TARGET, parseSafeDatabaseUrl, RESTORE_TARGET, TEST_TARGET } from "../db/connection-guard.mts";
import { authSettingProblems } from "../modules/auth/settings";
import { mediaStoreConfig } from "../modules/media/storage";
import { DEFAULT_STORE_NAME, readInstallationIdentity } from "./installation";
import { readRateLimits } from "../modules/rate-limit/service";
import { maintenanceSecretProblem } from "../modules/maintenance/secret";
import { readGoogleSettings } from "../modules/customers/auth";
import { trustedClientHeaders } from "../modules/rate-limit/client";
import { databaseProblems, directDatabaseProblem, mediaProblems } from "./hosted";

// Configuration readiness for `npm run config:check`: which variables are set and valid. It reports variable names and reasons only, never a value, and changes
// nothing. The application still validates every value where it is used; this only explains problems early.

export type ConfigCheck = {
  name: string;
  /** required: the application cannot work without it; optional: only some commands need it. */
  need: "required" | "optional";
  status: "ok" | "missing" | "invalid";
  /** Why it is missing or invalid, or what it is for. Never contains the value. */
  detail: string;
};

type Env = Record<string, string | undefined>;

function check(name: string, need: ConfigCheck["need"], env: Env, validate: (value: string) => void, purpose: string): ConfigCheck {
  const value = env[name];
  if (value === undefined || value === "") return { name, need, status: "missing", detail: purpose };
  try {
    validate(value);
    return { name, need, status: "ok", detail: purpose };
  } catch (error) {
    // The validators name the variable and the rule, never the value.
    return { name, need, status: "invalid", detail: error instanceof Error ? error.message : "Not valid." };
  }
}

const AUTH_PURPOSE: Record<string, string> = {
  BETTER_AUTH_SECRET: "Signs sessions. Generate one with `openssl rand -base64 32`; changing it signs everyone out.",
  BETTER_AUTH_URL: "The site's origin, for example http://localhost:3000 locally.",
};

/** The sign-in settings, with the same rules the application applies when it starts. */
function authChecks(env: Env): ConfigCheck[] {
  const problems = authSettingProblems(env);
  const checks = Object.entries(AUTH_PURPOSE).map(([name, purpose]): ConfigCheck => {
    const problem = problems.find((p) => p.name === name);
    if (!problem) return { name, need: "required", status: "ok", detail: purpose };
    const missing = env[name] === undefined || env[name] === "";
    return { name, need: "required", status: missing ? "missing" : "invalid", detail: missing ? purpose : problem.problem };
  });
  return [...checks, ...problems.filter((p) => !Object.hasOwn(AUTH_PURPOSE, p.name)).map((p): ConfigCheck => ({ name: p.name, need: "required", status: "invalid", detail: p.problem }))];
}

/** Every variable this project reads, checked without connecting to anything. */
export function configChecks(env: Env, projectRoot = process.cwd()): ConfigCheck[] {
  const media = mediaStoreConfig(env, projectRoot);
  return [
    // Hosted (NODE_ENV=production) the application's database is whatever DATABASE_URL names, with TLS; the local-only
    // guards belong to the development commands.
    env.NODE_ENV === "production"
      ? check("DATABASE_URL", "required", env, () => {
          const problems = databaseProblems(env);
          if (problems.length) throw new Error(problems.map((p) => p.problem).join(" "));
        }, "The application's database (hosted: TLS required; settings DATABASE_RUNTIME, DATABASE_POOLER, DATABASE_POOL_MAX, DATABASE_SSL).")
      : check("DATABASE_URL", "required", env, (v) => parseSafeDatabaseUrl(v, DEV_TARGET), "The application's database: the local babysunray_dev database and role on port 5432."),
    ...(env.NODE_ENV === "production" ? [] : databaseSettingChecks(env)),
    check("DIRECT_DATABASE_URL", "optional", env, () => {
      const problem = directDatabaseProblem(env);
      if (problem) throw new Error(problem);
    }, "Migrations and backups on a hosted database (direct or session connection)."),
    check("MAINTENANCE_SECRET", "optional", env, () => {
      const problem = maintenanceSecretProblem(env);
      if (problem) throw new Error(problem);
    }, "Authorises POST /api/internal/maintenance; without it that endpoint is off."),
    ...authChecks(env),
    ...(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const).map((name) =>
      check(name, "optional", env, () => readGoogleSettings(env), "Optional customer sign-in with Google (both or neither); without them it is not offered."),
    ),
    check("TRUSTED_PROXY", "optional", env, () => trustedClientHeaders(env), "netlify on Netlify (per-client limits); leave it empty on any other host."),
    check("TEST_DATABASE_URL", "optional", env, (v) => parseSafeDatabaseUrl(v, TEST_TARGET), "Tests and the restore drill (local babysunray_test only)."),
    check("RESTORE_DATABASE_URL", "optional", env, (v) => parseSafeDatabaseUrl(v, RESTORE_TARGET), "Only for backup:restore (an empty local babysunray_restore)."),
    env.MEDIA_STORAGE_DIR
      ? { name: "MEDIA_STORAGE_DIR", need: "optional", status: media.ok ? "ok" : "invalid", detail: media.ok ? "Product photos (outside the project folder)." : media.problem }
      : { name: "MEDIA_STORAGE_DIR", need: "optional", status: "missing", detail: "Product photos; without it photos cannot be uploaded." },
    ...mediaProviderChecks(env, projectRoot),
    ...identityChecks(env),
    ...(["API_RATE_LIMIT_READS_PER_MINUTE", "API_RATE_LIMIT_WRITES_PER_MINUTE"] as const).map((name) =>
      check(name, "optional", env, () => readRateLimits(env), "Empty means the default."),
    ),
  ];
}

/** True when nothing required is missing or invalid, and nothing that is set is invalid. */
export const configReady = (checks: ConfigCheck[]) => checks.every((c) => c.status === "ok" || (c.need === "optional" && c.status === "missing"));

/** The shop's public identity settings (src/config/installation.ts): optional, with neutral defaults. */
function identityChecks(env: Env): ConfigCheck[] {
  const { problems } = readInstallationIdentity(env);
  const invalid = problems.map((problem): ConfigCheck => ({ name: problem.match(/STORE_[A-Z_*]+/)?.[0] ?? "STORE_*", need: "optional", status: "invalid", detail: problem }));
  if (invalid.some((c) => c.name === "STORE_NAME")) return invalid;
  const name: ConfigCheck = env.STORE_NAME?.trim()
    ? { name: "STORE_NAME", need: "optional", status: "ok", detail: "The shop's name in the storefront preview." }
    : { name: "STORE_NAME", need: "optional", status: "missing", detail: `The shop's name; the preview shows "${DEFAULT_STORE_NAME}" until it is set.` };
  return [name, ...invalid];
}

/** The pool settings outside production: optional, validated when set (they change nothing while unset). */
function databaseSettingChecks(env: Env): ConfigCheck[] {
  const problems = databaseProblems(env).filter((p) => p.name !== "DATABASE_URL");
  return ["DATABASE_RUNTIME", "DATABASE_POOLER", "DATABASE_POOL_MAX", "DATABASE_SSL", "DATABASE_SSL_CA"].flatMap((name): ConfigCheck[] => {
    const problem = problems.find((p) => p.name === name);
    if (problem) return [{ name, need: "optional", status: "invalid", detail: problem.problem }];
    return env[name] ? [{ name, need: "optional", status: "ok", detail: "Database pool setting (src/db/pool-settings.ts)." }] : [];
  });
}

/** The photo provider settings (Supabase Storage), only when a provider other than the local folder is chosen. */
function mediaProviderChecks(env: Env, projectRoot: string): ConfigCheck[] {
  if (env.MEDIA_STORAGE_PROVIDER === undefined || env.MEDIA_STORAGE_PROVIDER === "" || env.MEDIA_STORAGE_PROVIDER === "local") return [];
  const problem = mediaProblems(env, projectRoot)[0];
  return [{ name: "MEDIA_STORAGE_PROVIDER", need: "optional", status: problem ? "invalid" : "ok", detail: problem ? problem.problem : "Product photos in a private Supabase Storage bucket (SUPABASE_URL, SUPABASE_STORAGE_BUCKET, SUPABASE_SERVICE_ROLE_KEY)." }];
}
