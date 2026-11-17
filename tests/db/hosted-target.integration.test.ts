import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditPrivileges } from "../../src/db/hosted-security.mts";
import { assertStagingTarget, migrationState, STAGING_MARKER, TARGET_SCHEMA } from "../../src/db/hosted-target.mts";
import { connectTestClient } from "../support/test-database";

// The hosted-staging guards and the privilege audit against the local babysunray_test (Gate H.45). Read-only, or inside
// a transaction that is rolled back: nothing here leaves a change behind. The real staging checks are tests/staging.

let client: Client;
const dir = mkdtempSync(path.join(tmpdir(), "bs-h45-migrations-"));

beforeAll(async () => {
  client = await connectTestClient();
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await client?.end();
});

/** Runs `work` in a transaction that is always rolled back. */
async function rolledBack<T>(work: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    return await work();
  } finally {
    await client.query("rollback");
  }
}

describe("the staging marker", () => {
  it("an unmarked database (the local test database) is refused", async () => {
    await expect(assertStagingTarget(client)).rejects.toThrow(/not marked as staging/);
  });
  it("a database marked production is refused; only the exact staging marker passes", async () => {
    await rolledBack(async () => {
      await client.query(`create schema ${TARGET_SCHEMA}`);
      await client.query(`comment on schema ${TARGET_SCHEMA} is 'babysunray:production'`);
      await expect(assertStagingTarget(client)).rejects.toThrow(/marked 'babysunray:production'/);
      await client.query(`comment on schema ${TARGET_SCHEMA} is '${STAGING_MARKER}'`);
      await expect(assertStagingTarget(client)).resolves.toMatchObject({ marker: STAGING_MARKER, database: "babysunray_test" });
    });
    await expect(assertStagingTarget(client)).rejects.toThrow(/not marked/);
  });
});

describe("the migration history check", () => {
  it("matches this checkout exactly on a migrated database", async () => {
    const state = await migrationState(client, "drizzle");
    expect(state).toMatchObject({ ahead: false, mismatches: [] });
    expect(state.applied).toBe(state.expected);
    expect(state.matching).toBe(state.applied);
  });
  it("finds a changed migration file, and a database that is ahead of the checkout", async () => {
    const changed = path.join(dir, "changed");
    cpSync("drizzle", changed, { recursive: true });
    const journal = JSON.parse(readFileSync(path.join(changed, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
    const third = path.join(changed, `${journal.entries[2].tag}.sql`);
    writeFileSync(third, `${readFileSync(third, "utf8")}\n-- edited after it was applied\n`);
    expect((await migrationState(client, changed)).mismatches).toEqual([2]);

    const older = path.join(dir, "older");
    cpSync("drizzle", older, { recursive: true });
    const olderJournal = JSON.parse(readFileSync(path.join(older, "meta", "_journal.json"), "utf8")) as { entries: unknown[] };
    olderJournal.entries.pop();
    writeFileSync(path.join(older, "meta", "_journal.json"), JSON.stringify(olderJournal));
    expect((await migrationState(client, older)).ahead).toBe(true);
  });
});

describe("the privilege audit", () => {
  it("reports a role that owns the tables (owners bypass grants) and a missing application role", async () => {
    const asOwner = await auditPrivileges(client, "babysunray_test");
    expect(asOwner.some((f) => f.check.includes("owns an object"))).toBe(true);
    expect(asOwner.some((f) => f.check.includes("can create objects"))).toBe(true);
    expect(await auditPrivileges(client, "no_such_role_h45")).toEqual([{ severity: "high", check: "the application role does not exist", object: "no_such_role_h45" }]);
  });
  it("reports a table opened to PUBLIC (every role, the API roles included)", async () => {
    await rolledBack(async () => {
      await client.query("grant select on orders to public");
      expect(await auditPrivileges(client, "no_such_role_h45")).toContainEqual({ severity: "critical", check: "PUBLIC has a privilege on a table or sequence", object: "public.orders" });
    });
    expect((await auditPrivileges(client, "no_such_role_h45")).some((f) => f.check.startsWith("PUBLIC"))).toBe(false);
  });
});

describe("the hosted privilege script", () => {
  it("runs on plain PostgreSQL (Supabase's roles absent: skipped) inside a transaction, which is then rolled back", async () => {
    await rolledBack(async () => {
      await client.query(readFileSync(path.join("db", "hosted", "privileges.sql"), "utf8"));
      // PUBLIC can no longer execute the trigger functions inside this transaction.
      const { rows } = await client.query<{ n: number }>(
        "select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where n.nspname = 'public' and a.grantee = 0",
      );
      expect(rows[0].n).toBe(0);
    });
  });
});
