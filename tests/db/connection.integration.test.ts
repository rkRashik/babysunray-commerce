import { type Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool, POOL_LIMITS, poolConfig } from "../../src/db/client";
import { assertConnectedToTestDatabase, assertSafeTestDatabaseUrl, connectTestClient, lockTestDatabase } from "../support/test-database";

let client: Client;

beforeAll(async () => {
  client = await connectTestClient();
});

afterAll(async () => {
  await client?.end();
});

describe("PostgreSQL connection", () => {
  it("connects to an isolated test database as a non-superuser", async () => {
    const { rows } = await client.query<{
      db: string;
      version_num: number;
      is_super: string;
    }>(
      `select current_database() as db,
              current_setting('server_version_num')::int as version_num,
              current_setting('is_superuser') as is_super`,
    );
    expect(rows[0].db).toMatch(/_test$/);
    expect(rows[0].version_num).toBeGreaterThanOrEqual(180000);
    expect(rows[0].is_super).toBe("off");
  });
});

describe("application pool limits", () => {
  it("waits at most 10 s for a connection, and PostgreSQL cancels a statement (or lock wait) after 60 s", async () => {
    expect(POOL_LIMITS.connectionTimeoutMillis).toBe(10_000);
    const pool = new Pool({ ...poolConfig(assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL)), max: 1 });
    try {
      await assertConnectedToTestDatabase(pool);
      const { rows } = await pool.query<{ statement_timeout: string }>("show statement_timeout");
      expect(rows[0].statement_timeout).toBe("1min");
    } finally {
      await pool.end();
    }
  });
});

describe("lost connections", () => {
  it("a connection dropped while idle is logged and replaced; the process keeps running", async () => {
    const pool = createPool(assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await assertConnectedToTestDatabase(pool);
      const before = (await pool.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
      // What a database restart does to an idle pooled connection.
      expect((await client.query<{ ok: boolean }>("select pg_terminate_backend($1) as ok", [before])).rows[0].ok).toBe(true);
      const deadline = Date.now() + 5_000;
      while (!log.mock.calls.flat().join(" ").includes("db_idle_connection_lost")) {
        if (Date.now() > deadline) throw new Error("The lost connection was not reported.");
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(log.mock.calls.flat().join(" ")).toContain('"sqlState":"57P01"');
      const after = (await pool.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
      expect(after).not.toBe(before);
    } finally {
      log.mockRestore();
      await pool.end();
    }
  });
});

describe("transactions", () => {
  // Session-scoped temp table: nothing persists in the database after the test run.
  beforeAll(async () => {
    await client.query("create temp table tx_probe (n int not null)");
  });

  it("discards changes on ROLLBACK", async () => {
    await client.query("begin");
    await client.query("insert into tx_probe (n) values (1)");
    const inside = await client.query("select count(*)::int as c from tx_probe");
    expect(inside.rows[0].c).toBe(1);
    await client.query("rollback");

    const after = await client.query("select count(*)::int as c from tx_probe");
    expect(after.rows[0].c).toBe(0);
  });

  it("keeps changes on COMMIT", async () => {
    await client.query("begin");
    await client.query("insert into tx_probe (n) values (2)");
    await client.query("commit");

    const after = await client.query("select count(*)::int as c from tx_probe");
    expect(after.rows[0].c).toBe(1);
  });

  it("rolls back the whole transaction when a statement fails", async () => {
    await client.query("begin");
    await client.query("insert into tx_probe (n) values (3)");
    await expect(client.query("insert into tx_probe (n) values (null)")).rejects.toThrow();
    await client.query("rollback");

    const after = await client.query("select count(*)::int as c from tx_probe where n = 3");
    expect(after.rows[0].c).toBe(0);
  });
});

describe("test-run lock", () => {
  it("is held for the whole run, so a second run (for example the browser tests) is refused at once", async () => {
    // tests/support/global-setup.ts took the lock before resetting the database and keeps it until the end.
    await expect(lockTestDatabase(process.env.TEST_DATABASE_URL)).rejects.toThrow(/Another test run/);
    const { rows } = await client.query<{ n: number }>(
      "select count(*)::int as n from pg_locks where locktype = 'advisory' and classid = 1651725938 and objid = 1 and granted",
    );
    expect(rows[0].n).toBe(1);
  });
});
