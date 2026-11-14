import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Db } from "./database";

// The application's one connection pool, created on first use from DATABASE_URL (server-side only).
// Cached on globalThis so development hot reloads do not open a new pool each time.
const cache = globalThis as unknown as { babysunrayDb?: Db };

export function getDb(): Db {
  if (!cache.babysunrayDb) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set.");
    cache.babysunrayDb = drizzle({ client: new Pool({ connectionString }) });
  }
  return cache.babysunrayDb;
}
