import { DEV_TARGET, parseSafeDatabaseUrl, RESTORE_TARGET, TEST_TARGET } from "../db/connection-guard.mts";
import { authSettingProblems } from "../modules/auth/settings";
import { mediaStoreConfig } from "../modules/media/storage";
import { readRateLimits } from "../modules/rate-limit/service";

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
    check("DATABASE_URL", "required", env, (v) => parseSafeDatabaseUrl(v, DEV_TARGET), "The application's database: the local babysunray_dev database and role on port 5432."),
    ...authChecks(env),
    check("TEST_DATABASE_URL", "optional", env, (v) => parseSafeDatabaseUrl(v, TEST_TARGET), "Tests and the restore drill (local babysunray_test only)."),
    check("RESTORE_DATABASE_URL", "optional", env, (v) => parseSafeDatabaseUrl(v, RESTORE_TARGET), "Only for backup:restore (an empty local babysunray_restore)."),
    env.MEDIA_STORAGE_DIR
      ? { name: "MEDIA_STORAGE_DIR", need: "optional", status: media.ok ? "ok" : "invalid", detail: media.ok ? "Product photos (outside the project folder)." : media.problem }
      : { name: "MEDIA_STORAGE_DIR", need: "optional", status: "missing", detail: "Product photos; without it photos cannot be uploaded." },
    ...(["API_RATE_LIMIT_READS_PER_MINUTE", "API_RATE_LIMIT_WRITES_PER_MINUTE"] as const).map((name) =>
      check(name, "optional", env, () => readRateLimits(env), "Empty means the default."),
    ),
  ];
}

/** True when nothing required is missing or invalid, and nothing that is set is invalid. */
export const configReady = (checks: ConfigCheck[]) => checks.every((c) => c.status === "ok" || (c.need === "optional" && c.status === "missing"));
