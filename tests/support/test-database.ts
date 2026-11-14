import { Client } from "pg";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Returns the connection string only if it points at a local database whose name
 * ends in `_test`. Tests must never run against a development, shared or hosted database.
 */
export function assertSafeTestDatabaseUrl(url: string | undefined): string {
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
  if (!/_test$/.test(decodeURIComponent(parsed.pathname.slice(1)))) {
    throw new Error("TEST_DATABASE_URL must name a database ending in _test.");
  }
  return url;
}

/** Connects a single client to the isolated test database. Caller must call `end()`. */
export async function connectTestClient(): Promise<Client> {
  const client = new Client({
    connectionString: assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL),
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}
