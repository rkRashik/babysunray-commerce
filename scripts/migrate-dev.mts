// `npm run db:migrate`: applies the committed migrations to the local development database only.
// Everything is checked before the first schema change, and the migrations run over the same
// connection whose identity PostgreSQL has just confirmed (src/db/migrate-verified.mts). Run with
// Node 22.18 or newer, which strips TypeScript types natively.
import path from "node:path";
import pg from "pg";
import { DEV_TARGET, parseSafeDatabaseUrl, resolveDatabaseUrl, sessionConfig } from "../src/db/connection-guard.mts";
import { migrateVerified } from "../src/db/migrate-verified.mts";

async function main(): Promise<void> {
  // 1. URL-level checks; stops here, before any connection, for a wrong target.
  const params = parseSafeDatabaseUrl(resolveDatabaseUrl(), DEV_TARGET);

  const client = new pg.Client(sessionConfig(params));
  await client.connect();
  try {
    // 2. PostgreSQL-side identity check, search_path pin, then the migrations, on this one connection.
    await migrateVerified(client, DEV_TARGET, path.resolve(import.meta.dirname, "../drizzle"));
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
