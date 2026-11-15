import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import {
  assertConnectedIdentity,
  parseSafeDatabaseUrl,
  pinSearchPath,
  sessionConfig,
  TEST_TARGET,
} from "../../src/db/connection-guard.mts";
import type { Db } from "../../src/db/database";

export const TEST_DATABASE_NAME = TEST_TARGET.database;
export const TEST_ROLE = TEST_TARGET.role;

/**
 * Returns the connection string only if it names the local `babysunray_test` database and role on the
 * expected port, has no query parameters (which could redirect the connection), and does not identify
 * the same database as DATABASE_URL. Tests must never run against a development, shared or hosted database.
 */
export function assertSafeTestDatabaseUrl(url: string | undefined, appDatabaseUrl?: string): string {
  parseSafeDatabaseUrl(url, TEST_TARGET);
  if (appDatabaseUrl) {
    let app: URL;
    try {
      app = new URL(appDatabaseUrl);
    } catch {
      throw new Error("DATABASE_URL is not a valid URL.");
    }
    if (decodeURIComponent(app.pathname.slice(1)) === TEST_DATABASE_NAME) {
      throw new Error("DATABASE_URL and TEST_DATABASE_URL must not identify the same database.");
    }
  }
  return url as string;
}

/** Asks PostgreSQL itself which database and role the connection reached. Runs before any destructive step. */
export function assertConnectedToTestDatabase(conn: Pick<Client, "query">): Promise<void> {
  return assertConnectedIdentity(conn, TEST_TARGET);
}

/** Connects one verified client (identity checked, search_path pinned to public) to the test database. Caller must call `end()`. */
export async function connectTestClient(url = process.env.TEST_DATABASE_URL): Promise<Client> {
  const client = new Client(
    sessionConfig(parseSafeDatabaseUrl(assertSafeTestDatabaseUrl(url, process.env.DATABASE_URL), TEST_TARGET)),
  );
  await client.connect();
  try {
    await assertConnectedToTestDatabase(client);
    await pinSearchPath(client);
  } catch (error) {
    await client.end();
    throw error;
  }
  return client;
}

// Session-level advisory lock held for a whole `npm run test:db` or `npm run test:e2e` run, so one run can
// never reset babysunray_test while the other is using it. The key is an arbitrary project constant.
const TEST_RUN_LOCK = "select pg_try_advisory_lock(1651725938, 1) as locked";

/**
 * Takes the test-run lock on its own verified connection and keeps it until that client is ended. Refuses,
 * without waiting, if another test run holds it.
 */
export async function lockTestDatabase(url: string | undefined): Promise<Client> {
  const client = await connectTestClient(url);
  try {
    const { rows } = await client.query<{ locked: boolean }>(TEST_RUN_LOCK);
    if (!rows[0].locked) throw new Error("Another test run (npm run test:db or test:e2e) is using babysunray_test. Wait for it to finish.");
  } catch (error) {
    await client.end();
    throw error;
  }
  return client;
}

/** A verified Drizzle handle over its own pool of independent connections. Caller must `pool.end()`. */
export async function createTestDb(maxConnections = 4): Promise<{ db: Db; pool: Pool }> {
  const pool = new Pool({
    ...sessionConfig(
      parseSafeDatabaseUrl(assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL), TEST_TARGET),
    ),
    max: maxConnections,
  });
  try {
    await assertConnectedToTestDatabase(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
  return { db: drizzle({ client: pool }), pool };
}
