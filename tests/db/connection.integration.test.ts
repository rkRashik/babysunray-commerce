import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectTestClient } from "../support/test-database";

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
