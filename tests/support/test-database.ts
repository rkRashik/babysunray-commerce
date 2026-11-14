import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import type { Db } from "../../src/db/database";

export const TEST_DATABASE_NAME = "babysunray_test";
export const TEST_ROLE = "babysunray_test";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Returns the connection string only if it names the local `babysunray_test` database and role, has no
 * query parameters (which could redirect the connection), and does not identify the same database as
 * DATABASE_URL. Tests must never run against a development, shared or hosted database.
 */
export function assertSafeTestDatabaseUrl(url: string | undefined, appDatabaseUrl?: string): string {
  if (!url) {
    throw new Error("TEST_DATABASE_URL is not set.");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("TEST_DATABASE_URL is not a valid URL.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("TEST_DATABASE_URL must use the postgres:// or postgresql:// scheme.");
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error("TEST_DATABASE_URL must point at a local host.");
  }
  if (parsed.search !== "") {
    throw new Error("TEST_DATABASE_URL must not have query parameters.");
  }
  if (decodeURIComponent(parsed.pathname.slice(1)) !== TEST_DATABASE_NAME) {
    throw new Error(`TEST_DATABASE_URL must name the ${TEST_DATABASE_NAME} database.`);
  }
  if (decodeURIComponent(parsed.username) !== TEST_ROLE) {
    throw new Error(`TEST_DATABASE_URL must connect as the ${TEST_ROLE} role.`);
  }
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
  return url;
}

/**
 * Asks PostgreSQL itself which database, role and server the connection reached. Runs before any
 * destructive test step, so a misleading URL (or a superuser role) cannot get past the URL checks.
 */
export async function assertConnectedToTestDatabase(conn: Pick<Client, "query">): Promise<void> {
  const { rows } = await conn.query<{
    db: string;
    current_role: string;
    session_role: string;
    is_super: string;
    is_local: boolean;
  }>(
    `select current_database() as db,
            current_user as current_role,
            session_user as session_role,
            current_setting('is_superuser') as is_super,
            (inet_server_addr() is null
              or inet_server_addr() <<= inet '127.0.0.0/8'
              or inet_server_addr() = inet '::1') as is_local`,
  );
  const s = rows[0];
  if (s.db !== TEST_DATABASE_NAME) throw new Error(`Connected database is not ${TEST_DATABASE_NAME}.`);
  if (s.current_role !== TEST_ROLE || s.session_role !== TEST_ROLE) {
    throw new Error(`Connected role is not ${TEST_ROLE}.`);
  }
  if (s.is_super !== "off") throw new Error("Refusing to run tests as a PostgreSQL superuser.");
  if (!s.is_local) throw new Error("Connected server is not on a loopback address.");
}

/** Connects one verified client to the test database. Caller must call `end()`. */
export async function connectTestClient(url = process.env.TEST_DATABASE_URL): Promise<Client> {
  const client = new Client({
    connectionString: assertSafeTestDatabaseUrl(url, process.env.DATABASE_URL),
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    await assertConnectedToTestDatabase(client);
  } catch (error) {
    await client.end();
    throw error;
  }
  return client;
}

/** A verified Drizzle handle over its own pool of independent connections. Caller must `pool.end()`. */
export async function createTestDb(maxConnections = 4): Promise<{ db: Db; pool: Pool }> {
  const pool = new Pool({
    connectionString: assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL),
    connectionTimeoutMillis: 5000,
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
