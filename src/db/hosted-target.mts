// Fail-closed checks for commands and tests that touch a HOSTED staging database (Gate H.45): the staging migration and
// backup commands and the staging test suite. Plain TypeScript (no aliases, no server-only) so Node runs it from
// scripts/. Not imported by application code. Like connection-guard.mts, these are safeguards against mistakes (a
// wrong URL, a production project, a project holding real data), not a security boundary.
//
// A database counts as staging only when PostgreSQL itself says so: the founder creates, once, an empty schema
// `babysunray_target` with the comment 'babysunray:staging' (docs/operations/staging-setup.md). A production database
// would carry 'babysunray:production' and is refused by every command here. No marker, no access.

import { readFileSync } from "node:fs";
import { readBackupHeader } from "./backup-status.mts";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { Client } from "pg";

export const TARGET_SCHEMA = "babysunray_target";
export const STAGING_MARKER = "babysunray:staging";
/** The production database's marker, set by the founder by hand in the production project (installation-production.md). */
export const PRODUCTION_MARKER = "babysunray:production";
/** The application's own login role on a hosted database (db/hosted/privileges.sql). */
export const APP_ROLE = "babysunray_app";
export const TRANSACTION_POOLER_PORT = 6543;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export type HostedConnection = {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  ssl: { rejectUnauthorized: boolean; ca?: string };
  /** For pg_dump: the libpq sslmode and, for verify-full, the CA file. */
  sslMode: "require" | "verify-full";
  sslRootCert?: string;
};

type Env = Record<string, string | undefined>;

/**
 * Explicit connection fields for a hosted staging URL. Refuses a local host (that is the development or test database),
 * a query string (it could override TLS), and, unless `pooled`, the transaction pooler (migrations, backups and session
 * locks need a direct or session connection). TLS is required: STAGING_DATABASE_SSL is `require` or `verify-full`
 * (with STAGING_DATABASE_SSL_ROOT_CERT, an absolute path to the CA certificate). Errors never contain the URL.
 */
export function parseStagingUrl(env: Env, envName: string, options: { pooled: boolean; prefix?: "STAGING" | "PRODUCTION" }): HostedConnection {
  const prefix = options.prefix ?? "STAGING";
  const raw = env[envName];
  if (!raw) throw new Error(`${envName} is not set.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${envName} is not a valid URL.`);
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") throw new Error(`${envName} must start with postgresql://.`);
  if (url.search || url.hash) throw new Error(`${envName} must not have query parameters; TLS is set by STAGING_DATABASE_SSL.`);
  if (LOCAL_HOSTS.has(url.hostname.toLowerCase())) throw new Error(`${envName} points at this machine; this command is for a hosted database. Local databases have their own commands.`);
  const port = url.port ? Number(url.port) : 5432;
  if (options.pooled && port !== TRANSACTION_POOLER_PORT) throw new Error(`${envName} must use the transaction pooler (port ${TRANSACTION_POOLER_PORT}), as the hosted application will.`);
  if (!options.pooled && port === TRANSACTION_POOLER_PORT) throw new Error(`${envName} must be a direct or session connection (port 5432), never the transaction pooler.`);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(url.username);
  if (!database || !user) throw new Error(`${envName} needs a database and a user.`);
  const mode = env[`${prefix}_DATABASE_SSL`];
  if (mode !== "require" && mode !== "verify-full") throw new Error(`${prefix}_DATABASE_SSL must be require or verify-full.`);
  let ca: string | undefined;
  if (mode === "verify-full") {
    const file = env[`${prefix}_DATABASE_SSL_ROOT_CERT`];
    if (!file) throw new Error(`${prefix}_DATABASE_SSL_ROOT_CERT must name the CA certificate file for verify-full.`);
    try {
      ca = readFileSync(file, "utf8");
    } catch {
      throw new Error(`${prefix}_DATABASE_SSL_ROOT_CERT could not be read.`);
    }
    if (!ca.includes("-----BEGIN CERTIFICATE-----")) throw new Error(`${prefix}_DATABASE_SSL_ROOT_CERT is not a PEM certificate.`);
  }
  return {
    host: url.hostname,
    port,
    database,
    user,
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ssl: mode === "require" ? { rejectUnauthorized: false } : { rejectUnauthorized: true, ca },
    sslMode: mode,
    ...(mode === "verify-full" ? { sslRootCert: env[`${prefix}_DATABASE_SSL_ROOT_CERT`] } : {}),
  };
}

/** The staging URL must not be the same database as any local one this machine uses. */
export function assertNotLocalDatabase(staging: HostedConnection, env: Env): void {
  for (const name of ["DATABASE_URL", "TEST_DATABASE_URL", "RESTORE_DATABASE_URL"]) {
    const other = env[name];
    if (!other) continue;
    try {
      const u = new URL(other);
      if (u.hostname.toLowerCase() === staging.host.toLowerCase() && decodeURIComponent(u.pathname.slice(1)) === staging.database) throw new Error(`The staging database is the same as ${name}. Refusing.`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("The staging database")) throw error;
    }
  }
}

export type StagingIdentity = { database: string; user: string; marker: string | null; serverVersion: number; superuser: boolean };

/** Asks PostgreSQL which database and role this is and whether it carries the staging marker. Read-only. */
export async function readIdentity(client: Pick<Client, "query">): Promise<StagingIdentity> {
  const { rows } = await client.query<{ db: string; usr: string; marker: string | null; v: string; su: string }>(
    `select current_database() as db, current_user as usr,
            obj_description(to_regnamespace($1)::oid, 'pg_namespace') as marker,
            current_setting('server_version_num') as v, current_setting('is_superuser') as su`,
    [TARGET_SCHEMA],
  );
  const r = rows[0];
  return { database: r.db, user: r.usr, marker: r.marker, serverVersion: Number(r.v), superuser: r.su === "on" };
}

/** Throws unless the database carries `marker`; names what is wrong, never a value from the URL. */
export async function assertMarkedTarget(client: Pick<Client, "query">, marker: string): Promise<StagingIdentity> {
  const identity = await readIdentity(client);
  if (identity.marker === null) throw new Error(`This database is not marked (schema ${TARGET_SCHEMA} with comment '${marker}' is missing). Refusing.`);
  if (identity.marker !== marker) throw new Error(`This database is marked '${identity.marker}', not '${marker}'. Refusing.`);
  return identity;
}

/** Throws unless the database is marked staging. */
export const assertStagingTarget = (client: Pick<Client, "query">) => assertMarkedTarget(client, STAGING_MARKER);

export type MigrationState = {
  /** Migrations in this checkout. */
  expected: number;
  /** Rows in drizzle.__drizzle_migrations (0 when the table does not exist yet). */
  applied: number;
  /** Applied rows that match this checkout's migration at the same position (hash and time). */
  matching: number;
  /** Positions where the database's history differs from this checkout. */
  mismatches: number[];
  /** True when the database has migrations this checkout does not know (it is newer than this code). */
  ahead: boolean;
};

/**
 * Compares the database's migration history with this checkout's, migration by migration (Drizzle records each one's
 * SHA-256 and its journal time). The database must be a prefix of the checkout: same hashes in the same order.
 */
export async function migrationState(client: Pick<Client, "query">, migrationsFolder: string): Promise<MigrationState> {
  const files = readMigrationFiles({ migrationsFolder });
  const exists = (await client.query<{ t: string | null }>("select to_regclass('drizzle.__drizzle_migrations')::text as t")).rows[0].t !== null;
  const rows = exists ? (await client.query<{ hash: string; created_at: string }>("select hash, created_at::text from drizzle.__drizzle_migrations order by id")).rows : [];
  const mismatches: number[] = [];
  rows.forEach((row, i) => {
    const file = files[i];
    if (!file || file.hash !== row.hash || String(file.folderMillis) !== row.created_at) mismatches.push(i);
  });
  return { expected: files.length, applied: rows.length, matching: rows.length - mismatches.length, mismatches, ahead: rows.length > files.length };
}

/** The application tables present (to tell an empty, first-time database from one that needs a backup first). */
export async function applicationTableCount(client: Pick<Client, "query">): Promise<number> {
  return Number((await client.query<{ n: string }>("select count(*)::text as n from pg_tables where schemaname = 'public'")).rows[0].n);
}

/** Reads a database backup's readable header (format, database, time, host) without its passphrase; only the header is read. */
export function backupHeaderOf(file: string): { database: string; createdAt: string; host: string | null } {
  const header = readBackupHeader(file);
  if (header.kind !== "database") throw new Error("The backup file's header is not readable: it is not a database backup.");
  return { database: header.database, createdAt: header.createdAt, host: header.host };
}

/**
 * The backup that must precede a migration: a staging backup (it records its host) of this host and database, made within
 * `maxAgeMs` (default 24 hours). Supabase databases are all named `postgres`, so the host is what tells projects apart.
 */
export function assertRecentBackup(file: string, target: { host: string; database: string }, now = Date.now(), maxAgeMs = 24 * 3_600_000): { createdAt: string } {
  const header = backupHeaderOf(file);
  if (header.host === null) throw new Error("The backup does not record its host: it is not a staging backup. Take one with npm run backup:create:staging.");
  if (header.host.toLowerCase() !== target.host.toLowerCase() || header.database !== target.database) throw new Error("The backup is of another database. Take a backup of this one first (npm run backup:create:staging).");
  const age = now - Date.parse(header.createdAt);
  if (!(age >= 0 && age <= maxAgeMs)) throw new Error("The backup is older than 24 hours (or dated in the future). Take a fresh one first (npm run backup:create:staging).");
  return { createdAt: header.createdAt };
}
