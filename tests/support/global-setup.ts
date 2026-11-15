import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadEnv } from "vite";
import type { Client } from "pg";
import type { TestProject } from "vitest/node";
import { DROP_MANAGED_STATEMENTS, unexpectedObjects } from "./schema-inventory";
import { assertSafeTestDatabaseUrl, connectTestClient, lockTestDatabase } from "./test-database";

// Every integration run replays all migrations from an empty schema in babysunray_test, so the
// committed migrations are proven to build the schema from scratch.
//
// Before dropping anything, PostgreSQL confirms it is babysunray_test and the session search_path is
// pinned to public (connectTestClient), then the database is compared with the objects and metadata the
// migrations create (schema-inventory.ts, which lists what it does and does not check). Any extra object
// stops the run with nothing changed. Only then are the managed tables, function and migration history
// dropped, by schema-qualified statements. The drops use RESTRICT (no CASCADE): a dependent object
// nobody listed would make PostgreSQL refuse and roll back instead of being dropped. Preflight and drops
// share one transaction. The development database is never touched.

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // DATABASE_URL may live only in .env.local. It is compared here and never passed to the tests.
  const appDatabaseUrl = process.env.DATABASE_URL ?? loadEnv("test", process.cwd(), "").DATABASE_URL;
  assertSafeTestDatabaseUrl(project.config.env.TEST_DATABASE_URL, appDatabaseUrl);
  // Held until the run ends, so a browser test run cannot reset the database under these tests (or the reverse).
  const lock = await lockTestDatabase(project.config.env.TEST_DATABASE_URL);
  try {
    await resetAndMigrate(project.config.env.TEST_DATABASE_URL);
  } catch (error) {
    await lock.end();
    throw error;
  }
  return () => lock.end();
}

export async function resetAndMigrate(url: string | undefined): Promise<void> {
  await dropManagedObjects(url, async (client) => {
    await migrate(drizzle({ client }), { migrationsFolder: path.resolve("drizzle") });
  });
}

/**
 * The destructive part of the reset alone (same identity check, unexpected-object check and RESTRICT drops),
 * then `after` on the same verified connection. The restore drill uses it to empty babysunray_test before
 * restoring a backup into it.
 */
export async function dropManagedObjects(url: string | undefined, after: (client: Client) => Promise<void> = async () => {}): Promise<void> {
  const client = await connectTestClient(url);
  try {
    await client.query("begin");
    try {
      const unexpected = await unexpectedObjects(client);
      if (unexpected.length > 0) {
        const shown = unexpected.slice(0, 10).join(", ");
        const more = unexpected.length > 10 ? `, and ${unexpected.length - 10} more` : "";
        throw new Error(
          `The test database contains objects the migrations do not create (${shown}${more}). Stopping without changing anything.`,
        );
      }
      await client.query(DROP_MANAGED_STATEMENTS.join("\n"));
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }

    await after(client);
  } finally {
    await client.end();
  }
}
