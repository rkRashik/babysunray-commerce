// The part of `npm run db:migrate` that runs after the URL checks and the connection: PostgreSQL confirms
// the identity of this very connection, the schema resolution is pinned, and only then do the migrations
// run over the same connection. Kept separate from scripts/migrate-dev.mts so tests can drive the real
// boundary against the isolated test database. Not imported by application code.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Client } from "pg";
import { assertConnectedIdentity, pinSearchPath, type DatabaseTarget } from "./connection-guard.mts";

/**
 * Session advisory lock held while migrating (key pair in this project's namespace, per database). Drizzle's migrator
 * reads the last applied migration before its transaction, so without the lock two concurrent runs could both apply
 * the same pending migration; with it the second waits, then finds nothing pending.
 */
export const MIGRATION_LOCK = [1651725938, 2] as const;

export async function migrateVerified(client: Client, target: DatabaseTarget, migrationsFolder: string): Promise<void> {
  await assertConnectedIdentity(client, target);
  await pinSearchPath(client);
  await client.query("select pg_advisory_lock($1, $2)", [...MIGRATION_LOCK]);
  try {
    await migrate(drizzle({ client }), { migrationsFolder });
  } finally {
    // If the connection itself failed, PostgreSQL has already released the lock; keep the original error.
    await client.query("select pg_advisory_unlock($1, $2)", [...MIGRATION_LOCK]).catch(() => undefined);
  }
}
