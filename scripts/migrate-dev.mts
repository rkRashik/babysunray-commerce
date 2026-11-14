// `npm run db:migrate`: applies the committed migrations to the local development database only.
// Everything is checked before the first schema change, and the migrations run over the same
// connection whose identity PostgreSQL has just confirmed. Run with Node 22.18 or newer, which
// strips TypeScript types natively.
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import {
  assertConnectedIdentity,
  DEV_TARGET,
  parseSafeDatabaseUrl,
  resolveDatabaseUrl,
} from "../src/db/connection-guard.mts";

async function main(): Promise<void> {
  // 1. URL-level checks; stops here, before any connection, for a wrong target.
  const params = parseSafeDatabaseUrl(resolveDatabaseUrl(), DEV_TARGET);

  const client = new pg.Client({ ...params, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    // 2. PostgreSQL-side identity check on the connection that will run the migrations.
    await assertConnectedIdentity(client, DEV_TARGET);
    await migrate(drizzle({ client }), { migrationsFolder: path.resolve(import.meta.dirname, "../drizzle") });
    console.log(`Migrations are up to date in ${DEV_TARGET.database}.`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  // Message only: never print a stack, a URL or a password.
  console.error(error instanceof Error ? error.message : "Migration failed.");
  process.exitCode = 1;
});
