// Fail-closed checks for commands that change a database: the development migration and the
// destructive test reset. Not imported by application code. Plain TypeScript (no aliases, no
// server-only) so Node can run it directly from scripts/ and drizzle.config.ts can load it.
//
// These are application-level safeguards against mistakes (a stale environment variable, the wrong
// database). They are not a security boundary: anyone who can run arbitrary commands can bypass them.
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import type { Client } from "pg";

export type DatabaseTarget = { envName: string; database: string; role: string };

export const DEV_TARGET: DatabaseTarget = {
  envName: "DATABASE_URL",
  database: "babysunray_dev",
  role: "babysunray_dev",
};
export const TEST_TARGET: DatabaseTarget = {
  envName: "TEST_DATABASE_URL",
  database: "babysunray_test",
  role: "babysunray_test",
};

// The local PostgreSQL port. Another port needs the founder's explicit authorisation.
export const EXPECTED_PORT = 5432;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type ConnectionParams = {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
};

// The only schema the migrations and the test reset may resolve unqualified names in. Drizzle's own
// bookkeeping table is always schema-qualified (`drizzle.__drizzle_migrations`), so it does not depend on this.
export const SAFE_SEARCH_PATH = "public";

/**
 * Connection settings for the verified clients: the explicit fields from `parseSafeDatabaseUrl`, plus a
 * startup `options` value. node-postgres reads the PGOPTIONS environment variable only when no `options`
 * value is given, so passing one means PGOPTIONS cannot change the session. Role-level and database-level
 * `search_path` settings are lower priority than a startup option in PostgreSQL, but this project does not
 * rely on that: `pinSearchPath` sets the value again and reads it back.
 */
export function sessionConfig(params: ConnectionParams): ConnectionParams & { options: string; connectionTimeoutMillis: number } {
  return { ...params, options: `-c search_path=${SAFE_SEARCH_PATH}`, connectionTimeoutMillis: 5000 };
}

/**
 * Validates a connection URL before any connection is made and returns explicit connection fields
 * (host, port, database, role), so a URL query parameter or a PGHOST, PGPORT, PGDATABASE or PGUSER
 * variable cannot redirect the connection. Other PG* variables are handled by `sessionConfig`
 * (PGOPTIONS) or are not security-relevant here. Error messages never contain the URL or the password.
 */
export function parseSafeDatabaseUrl(url: string | undefined, target: DatabaseTarget): ConnectionParams {
  const { envName } = target;
  if (!url) {
    throw new Error(`${envName} is not set.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${envName} is not a valid URL.`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${envName} must use the postgres:// or postgresql:// scheme.`);
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(`${envName} must point at a local host.`);
  }
  if ((parsed.port === "" ? EXPECTED_PORT : Number(parsed.port)) !== EXPECTED_PORT) {
    throw new Error(`${envName} must use port ${EXPECTED_PORT}.`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error(`${envName} must not have query parameters.`);
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (database !== target.database) {
    throw new Error(`${envName} must name the ${target.database} database.`);
  }
  const user = decodeURIComponent(parsed.username);
  if (user !== target.role) {
    throw new Error(`${envName} must connect as the ${target.role} role.`);
  }
  return {
    host: parsed.hostname === "[::1]" ? "::1" : parsed.hostname,
    port: EXPECTED_PORT,
    database,
    user,
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
  };
}

/**
 * Asks PostgreSQL itself which database, role, session user, port and server address the connection
 * reached, before anything is changed. A URL that looks right cannot get past this if it is not.
 */
export async function assertConnectedIdentity(conn: Pick<Client, "query">, target: DatabaseTarget): Promise<void> {
  const { rows } = await conn.query<{
    db: string;
    current_role: string;
    session_role: string;
    is_super: string;
    port: number | null;
    is_loopback: boolean | null;
  }>(
    `select current_database() as db,
            current_user as current_role,
            session_user as session_role,
            current_setting('is_superuser') as is_super,
            inet_server_port() as port,
            (inet_server_addr() <<= inet '127.0.0.0/8' or inet_server_addr() = inet '::1') as is_loopback`,
  );
  const s = rows[0];
  if (s.db !== target.database) throw new Error(`Connected database is not ${target.database}.`);
  if (s.current_role !== target.role || s.session_role !== target.role) {
    throw new Error(`Connected role is not ${target.role}.`);
  }
  if (s.is_super !== "off") throw new Error("Refusing to continue as a PostgreSQL superuser.");
  if (s.port !== EXPECTED_PORT) throw new Error(`Connected server is not on port ${EXPECTED_PORT}.`);
  if (s.is_loopback !== true) throw new Error("Connected server is not on a loopback address.");
}

/**
 * Sets the session `search_path` to `public` on this connection and reads the effective value back, so
 * unqualified names in migrations resolve in one known schema whatever PGOPTIONS, a role-level or a
 * database-level setting said. Only this session changes; no role, database or server setting does.
 * It does not stop a migration file that sets `search_path` itself (migrations are reviewed).
 */
export async function pinSearchPath(conn: Pick<Client, "query">): Promise<void> {
  await conn.query(`set search_path to ${SAFE_SEARCH_PATH}`);
  const { rows } = await conn.query<{ setting: string; schemas: string[] }>(
    "select current_setting('search_path') as setting, current_schemas(false)::text[] as schemas",
  );
  const { setting, schemas } = rows[0];
  if (setting !== SAFE_SEARCH_PATH || schemas.length !== 1 || schemas[0] !== SAFE_SEARCH_PATH) {
    throw new Error(`The session search_path is not ${SAFE_SEARCH_PATH}.`);
  }
}

/**
 * Picks one value for an environment variable from the shell and from .env.local. When both define it
 * and they differ, the result is ambiguous, so it stops instead of letting a stale shell variable
 * silently win. Never includes either value in the error.
 */
export function resolveEnvValue(
  name: string,
  shellValue: string | undefined,
  fileValue: string | undefined,
): string | undefined {
  if (shellValue) {
    if (fileValue && fileValue !== shellValue) {
      throw new Error(`${name} is set in the shell and differs from ${name} in .env.local. Unset one of them.`);
    }
    return shellValue;
  }
  return fileValue || undefined;
}

/** Effective DATABASE_URL from the shell and `.env.local` (the only env file this project's tooling reads). */
export function resolveDatabaseUrl(envFile = ".env.local"): string | undefined {
  let fileValues: Record<string, string | undefined> = {};
  try {
    fileValues = parseEnv(readFileSync(envFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return resolveEnvValue(DEV_TARGET.envName, process.env[DEV_TARGET.envName], fileValues[DEV_TARGET.envName]);
}
