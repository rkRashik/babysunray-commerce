import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEV_TARGET, TEST_TARGET } from "../../src/db/connection-guard.mts";
import type { Db } from "../../src/db/database";
import { bootstrapFirstOwner } from "../../src/modules/auth/owner-bootstrap.mts";
import { getPrincipal } from "../../src/modules/auth/principal";
import { call, clearAuthState, count, createTestAuth, createTestUser, headersWith, OWNER, signIn } from "../support/auth";
import { resetAndMigrate } from "../support/global-setup";
import { connectTestClient, createTestDb } from "../support/test-database";

// The first-Owner bootstrap: one Owner, Better Auth-compatible credentials, refusal on any existing
// account, on concurrent runs and on a wrong database, and a CLI that never takes a password from a pipe.

const SCRIPT = path.resolve(import.meta.dirname, "../../scripts/bootstrap-owner.mts");

let db: Db;
let pool: Pool;
let client: Client;

beforeAll(async () => {
  await resetAndMigrate(process.env.TEST_DATABASE_URL);
  ({ db, pool } = await createTestDb(8));
  client = await connectTestClient();
});

afterAll(async () => {
  await client?.end();
  await pool?.end();
});

beforeEach(async () => {
  await clearAuthState(pool);
});

const users = () => count(pool, "select count(*) from auth_users");

describe("bootstrapFirstOwner", () => {
  it("creates exactly one Owner with a hashed credential that Better Auth accepts over HTTP", async () => {
    const { userId } = await bootstrapFirstOwner(client, TEST_TARGET, { ...OWNER, email: "  Owner@Example.TEST " });

    const user = await pool.query("select id, email, name, email_verified from auth_users");
    expect(user.rows).toEqual([{ id: userId, email: OWNER.email, name: OWNER.name, email_verified: false }]);
    // Audited in the same transaction: the operator's command and the access grant (migration 0017).
    const events = await pool.query("select event, actor_type, subject_user_id, transport from auth_events where subject_user_id = $1 order by id", [userId]);
    expect(events.rows).toEqual([
      { event: "access_changed", actor_type: "system", subject_user_id: userId, transport: "database" },
      { event: "owner_created", actor_type: "operator", subject_user_id: userId, transport: "cli" },
    ]);
    expect(JSON.stringify((await pool.query("select * from auth_events where subject_user_id = $1", [userId])).rows)).not.toMatch(/example.test|staple/i);
    const account = await pool.query("select account_id, provider_id, user_id, password from auth_accounts");
    expect(account.rows).toHaveLength(1);
    expect(account.rows[0]).toMatchObject({ account_id: userId, provider_id: "credential", user_id: userId });
    // Better Auth's scrypt format (hex salt:hex key); the password itself is stored nowhere.
    expect(account.rows[0].password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(account.rows[0].password).not.toContain(OWNER.password);
    const plaintext = await count(
      pool,
      "select count(*) from auth_users u join auth_accounts a on a.user_id = u.id where position($1 in row(u.*, a.*)::text) > 0",
      [OWNER.password],
    );
    expect(plaintext).toBe(0);
    expect((await pool.query("select user_id, role, disabled_at from user_access")).rows).toEqual([
      { user_id: userId, role: "owner", disabled_at: null },
    ]);

    const auth = createTestAuth(db);
    const { response, cookie } = await signIn(auth, OWNER.email, OWNER.password);
    expect(response.status).toBe(200);
    expect(await getPrincipal(auth, db, headersWith(cookie))).toEqual({ userId, role: "owner" });
  });

  it("refuses to run again and leaves the existing Owner untouched", async () => {
    const { userId } = await bootstrapFirstOwner(client, TEST_TARGET, OWNER);
    await expect(
      bootstrapFirstOwner(client, TEST_TARGET, { email: "second@example.test", name: "Second", password: "another long password!" }),
    ).rejects.toThrow("An account already exists");
    expect((await pool.query("select id from auth_users")).rows).toEqual([{ id: userId }]);
    expect(await count(pool, "select count(*) from user_access")).toBe(1);
  });

  it("refuses when any other authentication user already exists, even without access", async () => {
    await createTestUser(pool, { email: "someone@example.test", password: "some long password 1", role: null });
    await expect(bootstrapFirstOwner(client, TEST_TARGET, OWNER)).rejects.toThrow("An account already exists");
    expect(await users()).toBe(1);
    expect(await count(pool, "select count(*) from user_access")).toBe(0);
  });

  it("lets only one of several concurrent runs create an Owner", async () => {
    const clients = await Promise.all(Array.from({ length: 6 }, () => connectTestClient()));
    try {
      const results = await Promise.allSettled(
        clients.map((c, i) => bootstrapFirstOwner(c, TEST_TARGET, { ...OWNER, email: `racer${i}@example.test` })),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter((r) => r.status === "rejected")) {
        expect(String((r as PromiseRejectedResult).reason)).toContain("An account already exists");
      }
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
    expect(await users()).toBe(1);
    expect(await count(pool, "select count(*) from auth_accounts")).toBe(1);
    expect(await count(pool, "select count(*) from user_access where role = 'owner'")).toBe(1);
  });

  it("refuses a connection that PostgreSQL does not confirm as the expected database, before changing anything", async () => {
    await expect(bootstrapFirstOwner(client, DEV_TARGET, OWNER)).rejects.toThrow("Connected database is not babysunray_dev");
    expect(await users()).toBe(0);
  });

  it.each([
    ["a short password", { ...OWNER, password: "fourteen chars" }, "password must be 15 to 128"],
    ["a too long password", { ...OWNER, password: "x".repeat(129) }, "password must be 15 to 128"],
    ["an invalid email", { ...OWNER, email: "not-an-email" }, "email address is not valid"],
    ["an empty name", { ...OWNER, name: "   " }, "name must be 1 to 100"],
  ])("rejects %s without creating anything or echoing the value", async (_name, input, message) => {
    const error = await bootstrapFirstOwner(client, TEST_TARGET, input).then(
      () => "",
      (e: Error) => e.message,
    );
    expect(error).toContain(message);
    expect(error).not.toContain(input.password);
    expect(error).not.toContain(input.email);
    expect(await users()).toBe(0);
  });

  it("is never triggered by the application: requests to an empty installation create no account", async () => {
    const auth = createTestAuth(db);
    expect((await signIn(auth, OWNER.email, OWNER.password)).response.status).toBe(401);
    expect((await call(auth, "POST", "/sign-up/email", { body: OWNER })).status).toBe(404);
    expect((await call(auth, "GET", "/get-session")).status).toBe(200);
    expect(await users()).toBe(0);
  });
});

describe("npm run auth:bootstrap-owner", () => {
  let emptyDir: string;
  beforeAll(() => {
    // An empty working directory hides the real .env.local, so each case controls DATABASE_URL exactly.
    emptyDir = mkdtempSync(path.join(tmpdir(), "bsr-bootstrap-"));
  });
  afterAll(() => rmSync(emptyDir, { recursive: true, force: true }));

  function run(databaseUrl: string | undefined) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DATABASE_URL;
    if (databaseUrl !== undefined) env.DATABASE_URL = databaseUrl;
    // stdin is a pipe here, never a terminal.
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: emptyDir, env, input: "piped-s3cret\n", encoding: "utf8", timeout: 30_000 });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  }

  it.each([
    ["the test database", () => process.env.TEST_DATABASE_URL as string, "DATABASE_URL must name the babysunray_dev database."],
    ["a missing DATABASE_URL", () => undefined, "DATABASE_URL is not set."],
    ["a remote host", () => "postgresql://babysunray_dev:s3cret@db.example.com:5432/babysunray_dev", "local host"],
    ["a superuser role", () => "postgresql://postgres:s3cret@localhost:5432/babysunray_dev", "babysunray_dev role"],
  ])("refuses %s before connecting", async (_name, url, expected) => {
    const { status, output } = run(url());
    expect(status).toBe(1);
    expect(output).toContain(expected);
    expect(output).not.toContain("s3cret");
    expect(await users()).toBe(0);
  });

  it("refuses to read a password from a pipe, before connecting to any database", () => {
    // A well-formed development URL with a made-up password: the terminal check stops before any connection.
    const { status, output } = run("postgresql://babysunray_dev:s3cret@localhost:5432/babysunray_dev");
    expect(status).toBe(1);
    expect(output).toContain("interactive terminal");
    expect(output).not.toContain("s3cret");
    expect(output).not.toContain("Owner account created");
  });
});
