import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadEnv } from "vite";
import type { TestProject } from "vitest/node";
import { MANAGED_FUNCTIONS, MANAGED_TABLES, unexpectedObjects } from "./schema-inventory";
import { assertSafeTestDatabaseUrl, connectTestClient } from "./test-database";

// Every integration run replays all migrations from an empty schema in babysunray_test, so the
// committed migrations are proven to build the schema from scratch.
//
// Before dropping anything, PostgreSQL confirms it is babysunray_test (connectTestClient), then the
// whole database is compared with the objects the migrations create (schema-inventory.ts). Any extra
// object stops the run with nothing changed. Only then are the managed tables, function and migration
// history dropped. The drops use RESTRICT (no CASCADE): a dependent object nobody listed would make
// PostgreSQL refuse and roll back instead of being dropped. The development database is never touched.

export default async function setup(project: TestProject): Promise<void> {
  // DATABASE_URL may live only in .env.local. It is compared here and never passed to the tests.
  const appDatabaseUrl = process.env.DATABASE_URL ?? loadEnv("test", process.cwd(), "").DATABASE_URL;
  assertSafeTestDatabaseUrl(project.config.env.TEST_DATABASE_URL, appDatabaseUrl);
  await resetAndMigrate(project.config.env.TEST_DATABASE_URL);
}

export async function resetAndMigrate(url: string | undefined): Promise<void> {
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
      const tables = MANAGED_TABLES.map((t) => `"${t}"`).join(", ");
      const functions = MANAGED_FUNCTIONS.map((f) => `"${f}"()`).join(", ");
      await client.query(`
        drop table if exists ${tables} restrict;
        drop function if exists ${functions} restrict;
        drop table if exists drizzle.__drizzle_migrations restrict;
        drop schema if exists drizzle restrict;
      `);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }

    await migrate(drizzle({ client }), { migrationsFolder: path.resolve(import.meta.dirname, "../../drizzle") });
  } finally {
    await client.end();
  }
}
