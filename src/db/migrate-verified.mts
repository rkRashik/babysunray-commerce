// The part of `npm run db:migrate` that runs after the URL checks and the connection: PostgreSQL confirms
// the identity of this very connection, the schema resolution is pinned, and only then do the migrations
// run over the same connection. Kept separate from scripts/migrate-dev.mts so tests can drive the real
// boundary against the isolated test database. Not imported by application code.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Client } from "pg";
import { assertConnectedIdentity, pinSearchPath, type DatabaseTarget } from "./connection-guard.mts";

export async function migrateVerified(client: Client, target: DatabaseTarget, migrationsFolder: string): Promise<void> {
  await assertConnectedIdentity(client, target);
  await pinSearchPath(client);
  await migrate(drizzle({ client }), { migrationsFolder });
}
