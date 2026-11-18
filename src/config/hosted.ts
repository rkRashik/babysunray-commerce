import { parseDatabaseUrl, readPoolSettings, type SettingProblem } from "../db/pool-settings";
import { authSettingProblems } from "../modules/auth/settings";
import { cdnConfig } from "../modules/media/cdn";
import { configuredMediaStore } from "../modules/media/provider";

// What a hosted installation needs to be configured correctly (Gate H.44), as names and rules only, never values. Shared by
// the readiness probe (src/api/health.ts) and `npm run config:check`. It checks the environment and connects to nothing.
// The local-only guards of the development commands (the database must be babysunray_dev on port 5432) do not apply to
// the application itself, which is told its database by DATABASE_URL.

/** The Supabase transaction pooler's port: a connection there must be declared with DATABASE_POOLER=transaction. */
export const TRANSACTION_POOLER_PORT = 6543;

/** Problems with DATABASE_URL and the pool settings (DATABASE_RUNTIME, _POOLER, _POOL_MAX, _SSL, _SSL_CA). */
export function databaseProblems(env: Record<string, string | undefined>): SettingProblem[] {
  let host: string | undefined;
  let port = 0;
  const problems: SettingProblem[] = [];
  try {
    const connection = parseDatabaseUrl(env.DATABASE_URL);
    host = connection.host;
    port = connection.port;
  } catch (error) {
    problems.push({ name: "DATABASE_URL", problem: error instanceof Error ? error.message : "DATABASE_URL is not valid." });
  }
  const settings = readPoolSettings(env, host);
  if (!settings.ok) problems.push(...settings.problems);
  else if (port === TRANSACTION_POOLER_PORT && settings.settings.pooler !== "transaction") {
    problems.push({ name: "DATABASE_POOLER", problem: `Port ${TRANSACTION_POOLER_PORT} is a transaction pooler: set DATABASE_POOLER=transaction.` });
  }
  return problems;
}

/** The migration and backup connection: never the transaction pooler (advisory locks and pg_dump need a session). */
export function directDatabaseProblem(env: Record<string, string | undefined>): string | null {
  if (!env.DIRECT_DATABASE_URL) return null;
  try {
    const { port } = parseDatabaseUrl(env.DIRECT_DATABASE_URL);
    return port === TRANSACTION_POOLER_PORT ? "DIRECT_DATABASE_URL must be a direct or session connection, not the transaction pooler (port 6543)." : null;
  } catch (error) {
    return error instanceof Error ? error.message.replace("DATABASE_URL", "DIRECT_DATABASE_URL") : "DIRECT_DATABASE_URL is not valid.";
  }
}

/** Problems with the configured photo store, only when a provider or a folder is set at all (photos are optional). */
export function mediaProblems(env: Record<string, string | undefined>, projectRoot: string): SettingProblem[] {
  if (!env.MEDIA_STORAGE_PROVIDER && !env.MEDIA_STORAGE_DIR) return [];
  const configured = configuredMediaStore(env, projectRoot);
  return configured.ok ? [] : [{ name: env.MEDIA_STORAGE_PROVIDER === "supabase" ? "SUPABASE_*" : "MEDIA_STORAGE_*", problem: configured.problem }];
}

/** Problems with the Cloudinary settings, only when any CLOUDINARY_* setting is present (the CDN is optional). */
export function cdnProblems(env: Record<string, string | undefined>): SettingProblem[] {
  const configured = cdnConfig(env);
  return configured.ok ? [] : configured.problems;
}

/** Everything that must be valid for the application to serve requests when hosted. Empty means ready. */
export function hostedConfigProblems(env: Record<string, string | undefined>, projectRoot = process.cwd()): SettingProblem[] {
  return [...databaseProblems(env), ...authSettingProblems(env), ...mediaProblems(env, projectRoot), ...cdnProblems(env)];
}
