// Connection-pool settings from the environment (Gate H.44), validated once at the boundary. Pure: no server-only, no
// driver import, so the pool, the bulkheads and `npm run config:check` share one definition. Messages name variables
// and rules, never a value. Defaults reproduce the local development behaviour exactly.
//
//   DATABASE_RUNTIME  server (default) | serverless   a long-lived Node process, or functions that may be frozen
//   DATABASE_POOLER   direct (default) | transaction  a direct or session connection, or a transaction-mode pooler
//   DATABASE_POOL_MAX 5..20                           connections this process may hold (default 10, serverless 5)
//   DATABASE_SSL      disable | require | verify-full (required for a database that is not on this machine)
//   DATABASE_SSL_CA   PEM text of the CA certificate, for verify-full against a provider's own CA
//
// A transaction-mode pooler (for example Supabase's, port 6543) hands each transaction a different server connection,
// so nothing may depend on session state: no session-level SET, session advisory locks, LISTEN or temporary tables,
// and no named prepared statements. The application uses none (Drizzle's node-postgres driver sends unnamed
// statements; a test scans the source for the rest). PostgreSQL's per-session statement_timeout cannot be relied on
// as a startup parameter through every pooler, so in that mode it is NOT sent: set it on the database role instead
// (docs/operations/infrastructure.md).

type Env = Record<string, string | undefined>;

export const DEFAULT_POOL_MAX = { server: 10, serverless: 5 } as const;
/** The smallest pool the bulkheads (src/modules/rate-limit/bulkhead.ts) can share and still leave room for the Owner. */
export const MIN_POOL_MAX = 5;
export const MAX_POOL_MAX = 20;

export type SslMode = "disable" | "require" | "verify-full";
export type PoolSettings = {
  runtime: "server" | "serverless";
  pooler: "direct" | "transaction";
  max: number;
  idleTimeoutMillis: number;
  allowExitOnIdle: boolean;
  /** Sent as a startup parameter; null when the pooler may not accept it (set on the role instead). */
  statementTimeoutMillis: number | null;
  connectionTimeoutMillis: number;
  ssl: false | { rejectUnauthorized: boolean; ca?: string };
};
export type SettingProblem = { name: string; problem: string };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
export const isLocalHost = (host: string) => LOCAL_HOSTS.has(host.toLowerCase());

export type DatabaseConnection = { host: string; port: number; database: string; user: string; password?: string };

/**
 * The explicit connection fields of a URL. A URL's query string is refused: node-postgres lets `sslmode` and similar
 * parameters in a connection string override the settings above, so TLS and pooling are configured only through them.
 * Throws an Error that never contains the URL or the password.
 */
export function parseDatabaseUrl(raw: string | undefined): DatabaseConnection {
  if (!raw) throw new Error("DATABASE_URL is not set.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL.");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") throw new Error("DATABASE_URL must start with postgresql://.");
  if (url.search || url.hash) throw new Error("DATABASE_URL must not have query parameters; use DATABASE_SSL, DATABASE_POOLER and DATABASE_POOL_MAX.");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(url.username);
  if (!url.hostname || !database || !user) throw new Error("DATABASE_URL needs a host, a database and a user.");
  const port = url.port ? Number(url.port) : 5432;
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port, database, user, ...(url.password ? { password: decodeURIComponent(url.password) } : {}) };
}

/** The settings, or every problem found. `host` is the database host from DATABASE_URL, when it could be read. */
export function readPoolSettings(env: Env, host?: string): { ok: true; settings: PoolSettings } | { ok: false; problems: SettingProblem[] } {
  const problems: SettingProblem[] = [];
  const oneOf = <T extends string>(name: string, values: readonly T[], fallback: T): T => {
    const value = env[name];
    if (value === undefined || value === "") return fallback;
    if ((values as readonly string[]).includes(value)) return value as T;
    problems.push({ name, problem: `${name} must be one of: ${values.join(", ")}.` });
    return fallback;
  };
  const runtime = oneOf("DATABASE_RUNTIME", ["server", "serverless"], "server");
  const pooler = oneOf("DATABASE_POOLER", ["direct", "transaction"], "direct");
  let max: number = DEFAULT_POOL_MAX[runtime];
  if (env.DATABASE_POOL_MAX) {
    max = /^[0-9]{1,2}$/.test(env.DATABASE_POOL_MAX) ? Number(env.DATABASE_POOL_MAX) : 0;
    if (max < MIN_POOL_MAX || max > MAX_POOL_MAX) {
      problems.push({ name: "DATABASE_POOL_MAX", problem: `DATABASE_POOL_MAX must be a whole number from ${MIN_POOL_MAX} to ${MAX_POOL_MAX}.` });
      max = DEFAULT_POOL_MAX[runtime];
    }
  }
  const remote = host !== undefined && !isLocalHost(host);
  const sslMode = oneOf("DATABASE_SSL", ["disable", "require", "verify-full"], remote ? "require" : "disable");
  if (remote && !env.DATABASE_SSL) problems.push({ name: "DATABASE_SSL", problem: "DATABASE_SSL must be set (require or verify-full) for a database that is not on this machine." });
  if (remote && sslMode === "disable") problems.push({ name: "DATABASE_SSL", problem: "A database that is not on this machine must use TLS: DATABASE_SSL=disable is refused." });
  if (sslMode === "verify-full" && env.DATABASE_SSL_CA && !/-----BEGIN CERTIFICATE-----/.test(env.DATABASE_SSL_CA)) {
    problems.push({ name: "DATABASE_SSL_CA", problem: "DATABASE_SSL_CA must hold PEM text (-----BEGIN CERTIFICATE-----)." });
  }
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    settings: {
      runtime,
      pooler,
      max,
      // Frozen functions must not keep connections the database would count: close idle ones quickly (Vercel's guide
      // suggests about 5 seconds) and let the process end when nothing else keeps it alive.
      idleTimeoutMillis: runtime === "serverless" ? 5_000 : 10_000,
      allowExitOnIdle: runtime === "serverless",
      statementTimeoutMillis: pooler === "transaction" ? null : 60_000,
      connectionTimeoutMillis: 10_000,
      ssl: sslMode === "disable" ? false : sslMode === "require" ? { rejectUnauthorized: false } : { rejectUnauthorized: true, ...(env.DATABASE_SSL_CA ? { ca: env.DATABASE_SSL_CA } : {}) },
    },
  };
}

/** The pool size to size bulkheads from: the configured one, or the default when the settings are invalid. */
export const configuredPoolMax = (env: Env): number => {
  const result = readPoolSettings(env);
  return result.ok ? result.settings.max : DEFAULT_POOL_MAX.server;
};
