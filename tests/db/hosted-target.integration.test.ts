import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditPrivilegeReport, auditPrivileges } from "../../src/db/hosted-security.mts";
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
    await expect(assertStagingTarget(client)).rejects.toThrow(/not marked/);
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

describe("the privilege audit and the API roles (Gate H.56)", () => {
  // The Supabase roles do not exist on plain PostgreSQL and the test role cannot create roles, so the built-in pg_monitor
  // stands in for an API role. Everything is rolled back.
  const API = ["pg_monitor"];
  const audit = () => auditPrivilegeReport(client, "no_such_role_h45", API);
  it("fails on a default privilege for an API role owned by the connection's own role, in public or in every schema (never exempted)", async () => {
    expect((await audit()).findings.some((f) => f.check.includes("default privileges"))).toBe(false);
    await rolledBack(async () => {
      await client.query("alter default privileges in schema public grant select on tables to pg_monitor");
      const report = await audit();
      expect(report.findings).toContainEqual({ severity: "high", check: "pg_monitor would get privileges on new objects (default privileges)", object: "public (r)" });
      expect(report.warnings).toEqual([]);
    });
    await rolledBack(async () => {
      await client.query("alter default privileges grant usage on sequences to pg_monitor");
      expect((await audit()).findings).toContainEqual({ severity: "high", check: "pg_monitor would get privileges on new objects (default privileges)", object: "all schemas (S)" });
    });
  });
  it("fails on a table that an API role can reach, and reports no warning for it", async () => {
    await rolledBack(async () => {
      await client.query("grant select on orders to pg_monitor");
      const report = await audit();
      expect(report.findings).toContainEqual({ severity: "critical", check: "pg_monitor can read or change a table", object: "public.orders" });
      expect(report.warnings).toEqual([]);
    });
  });
});

describe("the privilege audit and row-level security (Gate H.56)", () => {
  // Found on the first hosted run: Supabase switches row-level security on for every table, and with no policy the
  // application role is denied every row.
  it("fails when row-level security is on and the application role has no policy, and passes once it has one", async () => {
    await rolledBack(async () => {
      await client.query("alter table orders enable row level security");
      expect(await auditPrivileges(client, "babysunray_test")).toContainEqual({ severity: "high", check: "row-level security is on and the application role has no policy (the application would be denied every row)", object: "orders" });
      await client.query("create policy app_only on orders for all to babysunray_test using (true) with check (true)");
      expect((await auditPrivileges(client, "babysunray_test")).some((f) => f.check.includes("row-level security"))).toBe(false);
    });
  });
  it("fails on a policy that applies to PUBLIC or to any role other than the application role", async () => {
    await rolledBack(async () => {
      await client.query("create policy open_to_all on orders for select using (true)");
      expect(await auditPrivileges(client, "babysunray_test")).toContainEqual({ severity: "high", check: "a row-level security policy applies to a role other than the application role", object: "orders.open_to_all" });
    });
    await rolledBack(async () => {
      await client.query("create policy to_monitor on orders for select to pg_monitor using (true)");
      expect((await auditPrivileges(client, "babysunray_test")).map((f) => f.object)).toContain("orders.to_monitor");
    });
  });
});

describe("the hosted privilege script", () => {
  it("gives the application role one policy per table, once (idempotent), and the audit then finds no row-level security problem (the script run as the test role, rolled back)", async () => {
    await rolledBack(async () => {
      const script = readFileSync(path.join("db", "hosted", "privileges.sql"), "utf8").replaceAll("babysunray_app", "babysunray_test").replace("exists (select 1 from pg_namespace where nspname = 'drizzle')", "false"); // the test role does not own the drizzle schema, so its revokes are left out
      await client.query("alter table orders enable row level security");
      await client.query("alter table order_items enable row level security");
      await client.query(script);
      await client.query(script);
      const tables = Number((await client.query("select count(*) as n from pg_tables where schemaname = 'public'")).rows[0].n);
      const policies = await client.query<{ n: string }>("select count(*) as n from pg_policies where schemaname = 'public' and policyname = 'babysunray_test_all' and roles = array['babysunray_test']::name[]");
      expect(Number(policies.rows[0].n)).toBe(tables);
      expect((await auditPrivileges(client, "babysunray_test")).filter((f) => f.check.includes("row-level security"))).toEqual([]);
    });
  });
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
