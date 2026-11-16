import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import type { Db } from "./database";

// The application's one connection pool, created on first use from DATABASE_URL (server-side only).
// Cached on globalThis so development hot reloads do not open a new pool each time.
const cache = globalThis as unknown as { babysunrayDb?: Db };

/**
 * Fail fast instead of waiting without limit: a request that cannot get a connection within 10 seconds (every
 * connection busy) fails, and PostgreSQL cancels any single statement after 60 seconds, which includes waiting
 * for a row lock. Set per session by the client, so PostgreSQL's own configuration is never changed. Exports read
 * a cursor in short batches, so the statement limit does not cut a long download.
 * shortcut: fixed values and the driver's default of 10 connections; revisit with the hosting decision (decision 1).
 */
export const POOL_LIMITS = { connectionTimeoutMillis: 10_000, statement_timeout: 60_000 } as const;

export function poolConfig(connectionString: string): PoolConfig {
  return { connectionString, ...POOL_LIMITS };
}

export function getDb(): Db {
  if (!cache.babysunrayDb) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set.");
    cache.babysunrayDb = drizzle({ client: new Pool(poolConfig(connectionString)) });
  }
  return cache.babysunrayDb;
}
