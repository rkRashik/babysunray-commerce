import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { type Db, pgErrorCode } from "./database";
import { parseDatabaseUrl, type PoolSettings, readPoolSettings } from "./pool-settings";

// The application's one connection pool, created on first use from DATABASE_URL (server-side only).
// Cached on globalThis so development hot reloads (and a warm function instance) do not open a new pool each time.
// Settings come from src/db/pool-settings.ts; with none set, the local development behaviour (10 connections, no TLS).
const cache = globalThis as unknown as { babysunrayDb?: Db };

/**
 * Fail fast instead of waiting without limit: a request that cannot get a connection within 10 seconds (every
 * connection busy) fails, and PostgreSQL cancels any single statement after 60 seconds, which includes waiting
 * for a row lock. Set per session by the client, so PostgreSQL's own configuration is never changed. Exports read
 * a cursor in short batches, so the statement limit does not cut a long download.
 */
export const POOL_LIMITS = { connectionTimeoutMillis: 10_000, statement_timeout: 60_000 } as const;

const DEFAULTS = ((): PoolSettings => {
  const result = readPoolSettings({});
  if (!result.ok) throw new Error("Default pool settings are invalid.");
  return result.settings;
})();

/** Pool configuration for a URL and validated settings. Explicit fields only: the URL cannot carry options. */
export function poolConfig(connectionString: string, settings: PoolSettings = DEFAULTS): PoolConfig {
  return {
    ...parseDatabaseUrl(connectionString),
    max: settings.max,
    idleTimeoutMillis: settings.idleTimeoutMillis,
    allowExitOnIdle: settings.allowExitOnIdle,
    connectionTimeoutMillis: settings.connectionTimeoutMillis,
    ssl: settings.ssl,
    ...(settings.statementTimeoutMillis === null ? {} : { statement_timeout: settings.statementTimeoutMillis }),
  };
}

/** The settings for a URL from the environment; throws an Error naming each wrong variable (never a value). */
export function poolSettingsFor(connectionString: string, env: Record<string, string | undefined> = process.env): PoolSettings {
  const result = readPoolSettings(env, parseDatabaseUrl(connectionString).host);
  if (!result.ok) throw new Error(result.problems.map((p) => p.problem).join(" "));
  return result.settings;
}

/**
 * The pool with listeners for connections lost (a database restart, a terminated backend). node-postgres's pool
 * listens for errors only while a connection is idle: it removes its listener when a connection is checked out (every
 * transaction does that), so a socket reset during a transaction had no listener at all and Node stopped the whole
 * process (found by killing a backend mid-order, Gate H.52). Every connection therefore gets its own permanent
 * listener, so a loss while in use fails only that request (the query reports the error) and is logged (names only);
 * the pool's own listener still covers idle connections, and the next request gets a new connection.
 */
export function createPool(connectionString: string, settings: PoolSettings = poolSettingsFor(connectionString)): Pool {
  const pool = new Pool(poolConfig(connectionString, settings));
  pool.on("connect", (client) => {
    client.on("error", (error) => {
      console.error(JSON.stringify({ level: "error", event: "db_connection_lost", errorName: error.name, sqlState: pgErrorCode(error) ?? null }));
    });
  });
  pool.on("error", (error) => {
    console.error(JSON.stringify({ level: "error", event: "db_idle_connection_lost", errorName: error.name, sqlState: pgErrorCode(error) ?? null }));
  });
  return pool;
}

export function getDb(): Db {
  if (!cache.babysunrayDb) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set.");
    cache.babysunrayDb = drizzle({ client: createPool(connectionString) });
  }
  return cache.babysunrayDb;
}
