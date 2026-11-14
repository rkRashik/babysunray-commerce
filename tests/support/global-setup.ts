import path from "node:path";
import { getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadEnv } from "vite";
import type { TestProject } from "vitest/node";
import * as schema from "../../src/db/schema";
import { assertSafeTestDatabaseUrl, connectTestClient } from "./test-database";

// Every integration run replays all migrations from an empty schema in babysunray_test, so the
// committed migrations are proven to build the schema from scratch. Only objects the migrations
// create are dropped; anything else stops the run before any change.
const TABLES = Object.values(schema).map((table) => getTableName(table));
const FUNCTIONS = ["stock_movements_reject_change"];

export default async function setup(project: TestProject): Promise<void> {
  // DATABASE_URL may live only in .env.local. It is compared here and never passed to the tests.
  const appDatabaseUrl = process.env.DATABASE_URL ?? loadEnv("test", process.cwd(), "").DATABASE_URL;
  assertSafeTestDatabaseUrl(project.config.env.TEST_DATABASE_URL, appDatabaseUrl);
  await resetAndMigrate(project.config.env.TEST_DATABASE_URL);
}

export async function resetAndMigrate(url: string | undefined): Promise<void> {
  const client = await connectTestClient(url);
  try {
    const { rows } = await client.query<{ object: string }>(
      `select 'schema ' || nspname as object from pg_namespace
        where nspname not in ('public', 'drizzle', 'information_schema') and nspname not like 'pg\\_%'
       union all
       select 'relation ' || n.nspname || '.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p', 'v', 'm', 'f')
          and ((n.nspname = 'public' and c.relname <> all($1::text[]))
            or (n.nspname = 'drizzle' and c.relname <> '__drizzle_migrations'))
       union all
       select 'function ' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'drizzle') and p.proname <> all($2::text[])`,
      [TABLES, FUNCTIONS],
    );
    if (rows.length > 0) {
      throw new Error(
        `The test database contains objects the migrations do not create (${rows
          .map((r) => r.object)
          .join(", ")}). Stopping without changing anything.`,
      );
    }

    const tableList = TABLES.map((t) => `"${t}"`).join(", ");
    await client.query("begin");
    await client.query("drop schema if exists drizzle cascade");
    await client.query(`drop table if exists ${tableList} cascade`);
    await client.query(`drop function if exists ${FUNCTIONS.map((f) => `"${f}"()`).join(", ")}`);
    await client.query("commit");

    await migrate(drizzle({ client }), { migrationsFolder: path.resolve(import.meta.dirname, "../../drizzle") });
  } finally {
    await client.end();
  }
}
