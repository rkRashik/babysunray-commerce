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
