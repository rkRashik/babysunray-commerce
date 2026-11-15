import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEV_TARGET, TEST_TARGET } from "../../src/db/connection-guard.mts";
import type { Db } from "../../src/db/database";
import { resetOwnerPassword } from "../../src/modules/auth/owner-password-reset.mts";
import { getBearerPrincipal, getPrincipal } from "../../src/modules/auth/principal";
import { receiveStockOnce } from "../../src/modules/inventory/operations";
import { bearer, clearAuthState, count, createTestAuth, createTestUser, createVerifiedOwner, headersWith, signIn, signInNative } from "../support/auth";
import { createTestVariant, withFailingInserts } from "../support/fixtures";
import { connectTestClient, createTestDb } from "../support/test-database";

// The local Owner password reset: exactly one active Owner, only its credential row, every session revoked in
// the same transaction, refusal of unknown or ambiguous accounts and wrong databases, and no secret in output.

const SCRIPT = path.resolve("scripts/reset-owner-password.mts");
const EMAIL = "recover-owner@example.test";
// The ledger test's Owner is referenced by a stock movement, so it outlives clearAuthState: its own email.
const LEDGER_EMAIL = "recover-ledger-owner@example.test";
const OLD = "the old fictional owner password";
const NEW = "a brand new fictional password";

let db: Db;
let pool: Pool;
let client: Client;
let auth: ReturnType<typeof createTestAuth>;

beforeAll(async () => {
  ({ db, pool } = await createTestDb(8));
  client = await connectTestClient();
  auth = createTestAuth(db);
});

afterAll(async () => {
  await client?.end();
  await pool?.end();
});

beforeEach(async () => {
  await clearAuthState(pool);
  // Users referenced by ledger rows survive clearAuthState; take away their access so they are not active Owners.
  await pool.query("delete from user_access");
});

// Better Auth allows 3 sign-ins per 10 seconds per client; each check starts from a fresh counter.
const signInStatus = async (password: string, email = EMAIL) => {
  await pool.query("delete from auth_rate_limits");
  return (await signIn(auth, email, password)).response.status;
};
const credentialHash = async (userId: string) =>
  (await pool.query<{ password: string }>("select password from auth_accounts where user_id = $1", [userId])).rows[0].password;

describe("resetOwnerPassword", () => {
  it("replaces the password, revokes every cookie and Bearer session, and keeps identity, role and stock history", async () => {
    const { userId, cookie, principal } = await createVerifiedOwner(auth, db, pool, LEDGER_EMAIL, OLD);
    const { token } = await signInNative(auth, LEDGER_EMAIL, OLD);
    expect(await getBearerPrincipal(auth, db, bearer(token as string))).toEqual({ userId, role: "owner" });
    const { variant } = await createTestVariant(db, "recover");
    await receiveStockOnce(db, principal, randomUUID(), { sku: variant.sku, quantity: 4 });
    const ledgerBefore = (await pool.query("select * from stock_movements where actor_user_id = $1 order by id", [userId])).rows;
    const accessBefore = (await pool.query("select * from user_access")).rows;

    const logs = ["log", "info", "warn", "error", "debug"].map((m) => vi.spyOn(console, m as "log").mockImplementation(() => {}));
    const { revokedSessions } = await resetOwnerPassword(client, TEST_TARGET, { email: `  ${LEDGER_EMAIL.toUpperCase()} `, password: NEW });
    // The module itself writes nothing anywhere; the CLI prints only a count.
    for (const spy of logs) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }

    expect(revokedSessions).toBe(2);
    expect(await count(pool, "select count(*) from auth_sessions")).toBe(0);
    expect(await getPrincipal(auth, db, headersWith(cookie))).toBeNull();
    expect(await getBearerPrincipal(auth, db, bearer(token as string))).toBeNull();
    expect(await signInStatus(OLD, LEDGER_EMAIL)).toBe(401);
    expect(await signInStatus(NEW, LEDGER_EMAIL)).toBe(200);
    // Same user id, same single credential row, same role row, untouched ledger.
    expect((await pool.query("select user_id, provider_id, account_id from auth_accounts")).rows).toEqual([
      { user_id: userId, provider_id: "credential", account_id: userId },
    ]);
    expect((await pool.query("select * from user_access")).rows).toEqual(accessBefore);
    expect((await pool.query("select * from stock_movements where actor_user_id = $1 order by id", [userId])).rows).toEqual(ledgerBefore);
    expect(await credentialHash(userId)).not.toContain(NEW);
  });

  it("leaves other users' passwords and sessions alone", async () => {
    await createTestUser(pool, { email: EMAIL, password: OLD, role: "owner" });
    const otherId = await createTestUser(pool, { email: "no-access@example.test", password: "another fictional password", role: null });
    const otherHash = await credentialHash(otherId);
    await resetOwnerPassword(client, TEST_TARGET, { email: EMAIL, password: NEW });
    expect(await credentialHash(otherId)).toBe(otherHash);
  });

  it.each([
    ["no active Owner", async () => {}, EMAIL, "no active Owner"],
    [
      "two active Owners",
      async () => {
        await createTestUser(pool, { email: EMAIL, password: OLD, role: "owner" });
        await createTestUser(pool, { email: "second-owner@example.test", password: OLD, role: "owner" });
      },
      EMAIL,
      "more than one active Owner",
    ],
    ["an email that is not the Owner's", async () => void (await createTestUser(pool, { email: EMAIL, password: OLD, role: "owner" })), "someone-else@example.test", "not the active Owner"],
    [
      "a disabled Owner (no active Owner)",
      async () => {
        const id = await createTestUser(pool, { email: EMAIL, password: OLD, role: "owner" });
        await pool.query("update user_access set disabled_at = now() where user_id = $1", [id]);
      },
      EMAIL,
      "no active Owner",
    ],
    [
      "an Owner with two password credentials",
      async () => {
        const id = await createTestUser(pool, { email: EMAIL, password: OLD, role: "owner" });
        await pool.query(
          "insert into auth_accounts (account_id, provider_id, user_id, password, created_at, updated_at) select account_id, provider_id, user_id, password, now(), now() from auth_accounts where user_id = $1",
          [id],
        );
      },
      EMAIL,
      "exactly one password credential",
    ],
  ])("refuses %s and changes nothing", async (_name, arrange, email, message) => {
    await arrange();
    const before = (await pool.query("select id, password, updated_at from auth_accounts order by id")).rows;
    const error = await resetOwnerPassword(client, TEST_TARGET, { email, password: NEW }).then(
      () => "",
      (e: Error) => e.message,
    );
    expect(error).toContain(message);
    expect(error).not.toContain(NEW);
    expect(error).not.toContain(email);
    expect((await pool.query("select id, password, updated_at from auth_accounts order by id")).rows).toEqual(before);
  });

  it("refuses a connection PostgreSQL does not confirm as the target database, before changing anything", async () => {
    const userId = await createTestUser(pool, { email: EMAIL, password: OLD, role: "owner" });
    const hash = await credentialHash(userId);
    await expect(resetOwnerPassword(client, DEV_TARGET, { email: EMAIL, password: NEW })).rejects.toThrow("Connected database is not babysunray_dev");
    expect(await credentialHash(userId)).toBe(hash);
  });

  it.each([
    ["a short password", "fourteen chars"],
    ["a too long password", "x".repeat(129)],
    ["a control character", "fifteen chars ok\u001b[A"],
  ])("rejects %s before any change, without echoing it", async (_name, password) => {
    const userId = await createTestUser(pool, { email: EMAIL, password: OLD, role: "owner" });
    const hash = await credentialHash(userId);
    const error = await resetOwnerPassword(client, TEST_TARGET, { email: EMAIL, password }).then(
      () => "",
      (e: Error) => e.message,
    );
    expect(error).toMatch(/password must/);
    expect(error).not.toContain(password);
    expect(await credentialHash(userId)).toBe(hash);
  });

  it("rolls back the password change when revoking the sessions fails", async () => {
    const { userId, cookie } = await createVerifiedOwner(auth, db, pool, EMAIL, OLD);
    const hash = await credentialHash(userId);
    await expect(
      withFailingInserts(pool, "auth_sessions", () => resetOwnerPassword(client, TEST_TARGET, { email: EMAIL, password: NEW }), "delete"),
    ).rejects.toThrow("injected test failure");
    expect(await credentialHash(userId)).toBe(hash);
    expect(await getPrincipal(auth, db, headersWith(cookie))).not.toBeNull();
    expect(await signInStatus(OLD)).toBe(200);
  });

  it("serialises concurrent resets: one password wins, one credential row remains, no session survives", async () => {
    const userId = await createTestUser(pool, { email: EMAIL, password: OLD, role: "owner" });
    const passwords = ["concurrent password number one", "concurrent password number two", "concurrent password number three"];
    const gate = await connectTestClient();
    const racers = await Promise.all(passwords.map(() => connectTestClient()));
    try {
      // Hold a conflicting lock so every reset has to queue behind it, then let them all go at once.
      await gate.query("begin");
      await gate.query("lock table public.user_access in exclusive mode");
      const runs = racers.map((c, i) => resetOwnerPassword(c, TEST_TARGET, { email: EMAIL, password: passwords[i] }));
      await vi.waitFor(
        async () => {
          const waiting = await count(pool, "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and query like 'lock table public.auth_users%'");
          expect(waiting).toBe(passwords.length);
        },
        { timeout: 20_000, interval: 50 },
      );
      await gate.query("commit");
      const results = await Promise.allSettled(runs);
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    } finally {
      await gate.end();
      await Promise.all(racers.map((c) => c.end()));
    }
    expect(await count(pool, "select count(*) from auth_accounts where user_id = $1", [userId])).toBe(1);
    expect(await count(pool, "select count(*) from auth_sessions")).toBe(0);
    const working = [];
    for (const password of [OLD, ...passwords]) {
      await pool.query("delete from auth_rate_limits");
      if ((await signInStatus(password)) === 200) working.push(password);
    }
    expect(working).toHaveLength(1);
    expect(passwords).toContain(working[0]);
  });
});

describe("npm run auth:reset-owner-password", () => {
  let emptyDir: string;
  beforeAll(() => {
    // An empty working directory hides the real .env.local, so each case controls DATABASE_URL exactly.
    emptyDir = mkdtempSync(path.join(tmpdir(), "bsr-reset-"));
  });
  afterAll(() => rmSync(emptyDir, { recursive: true, force: true }));

  function run(databaseUrl: string | undefined) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DATABASE_URL;
    if (databaseUrl !== undefined) env.DATABASE_URL = databaseUrl;
    // stdin is a pipe here, never a terminal; it carries a would-be password that must never be used or shown.
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: emptyDir, env, input: `${EMAIL}\npiped-s3cret-password\npiped-s3cret-password\n`, encoding: "utf8", timeout: 30_000 });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  }

  it.each([
    ["the test database", () => process.env.TEST_DATABASE_URL as string, "DATABASE_URL must name the babysunray_dev database."],
    ["a missing DATABASE_URL", () => undefined, "DATABASE_URL is not set."],
    ["a remote host", () => "postgresql://babysunray_dev:s3cret@db.example.com:5432/babysunray_dev", "local host"],
    ["another role", () => "postgresql://babysunray_test:s3cret@localhost:5432/babysunray_dev", "babysunray_dev role"],
  ])("refuses %s before connecting, and prints no secret", async (_name, url, expected) => {
    const userId = await createTestUser(pool, { email: EMAIL, password: OLD, role: "owner" });
    const hash = await credentialHash(userId);
    const { status, output } = run(url());
    expect(status).toBe(1);
    expect(output).toContain(expected);
    expect(output).not.toMatch(/s3cret|recover-owner/);
    expect(await credentialHash(userId)).toBe(hash);
  });

  it("refuses to read a password from a pipe, before connecting to any database", () => {
    const { status, output } = run("postgresql://babysunray_dev:s3cret@localhost:5432/babysunray_dev");
    expect(status).toBe(1);
    expect(output).toContain("interactive terminal");
    expect(output).not.toMatch(/s3cret|recover-owner|password changed/i);
  });
});
