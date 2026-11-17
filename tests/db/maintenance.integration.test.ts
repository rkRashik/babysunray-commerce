import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/database";
import { healthReport, integrityProblems, removeExpiredSessions, removeStaleRateLimitWindows } from "../../src/modules/maintenance/jobs";
import { count, createTestUser } from "../support/auth";
import { createTestVariant } from "../support/fixtures";
import { createTestDb } from "../support/test-database";

// The maintenance jobs (Gate H.41) against babysunray_test with fictional rows, and the CLI's target guard.

let db: Db;
let pool: Pool;
let userId: string;

beforeAll(async () => {
  ({ db, pool } = await createTestDb(6));
  userId = await createTestUser(pool, { email: `maintenance-${Date.now()}@example.test`, password: "maintenance long password", role: null });
});

afterAll(async () => {
  await pool?.end();
});

const session = async (expiresIn: string) =>
  (
    await pool.query<{ id: string }>(
      "insert into auth_sessions (expires_at, token, updated_at, user_id) values (now() + $1::interval, $2, now(), $3) returning id",
      [expiresIn, randomBytes(24).toString("hex"), userId],
    )
  ).rows[0].id;

describe("expired sessions", () => {
  it("are removed in bounded, concurrent-safe batches, each recorded once; live sessions stay", async () => {
    const expired = [await session("-2 days"), await session("-1 minute"), await session("-1 hour")];
    const live = await session("1 day");
    const { db: other, pool: otherPool } = await createTestDb(2);
    try {
      const removed = await Promise.all([removeExpiredSessions(db), removeExpiredSessions(other), removeExpiredSessions(db)]);
      expect(removed.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(3);
    } finally {
      await otherPool.end();
    }
    expect(await count(pool, "select count(*) from auth_sessions where id = any($1::uuid[])", [expired])).toBe(0);
    expect(await count(pool, "select count(*) from auth_sessions where id = $1", [live])).toBe(1);
    const audit = await pool.query<{ session_id: string; actor_type: string; detail: { reason: string } }>(
      "select session_id, actor_type, detail from auth_events where event = 'session_ended' and session_id = any($1::uuid[])",
      [expired],
    );
    expect(audit.rows.map((r) => r.session_id).sort()).toEqual([...expired].sort());
    expect(audit.rows.every((r) => r.actor_type === "system" && r.detail.reason === "expired")).toBe(true);
    // Idempotent: nothing more to do.
    expect(await removeExpiredSessions(db)).toBe(0);
  });
});

describe("rate-limit windows", () => {
  it("removes only windows that ended more than an hour ago", async () => {
    await pool.query("delete from tracking_rate_limits where bucket in ('failure', 'checkout')");
    await pool.query("insert into tracking_rate_limits (bucket, window_start, count) values ('failure', now() - interval '2 hours', 5), ('checkout', now(), 1)");
    await pool.query("insert into auth_rate_limits (key, count, last_request) values ($1, 3, $2), ($3, 1, $4)", [
      `maint-old-${Date.now()}`,
      Date.now() - 3 * 3_600_000,
      `maint-new-${Date.now()}`,
      Date.now(),
    ]);
    expect(await removeStaleRateLimitWindows(db)).toBeGreaterThanOrEqual(2);
    expect((await pool.query("select bucket from tracking_rate_limits where bucket in ('failure', 'checkout')")).rows).toEqual([{ bucket: "checkout" }]);
    expect(await count(pool, "select count(*) from auth_rate_limits where key like 'maint-new-%'")).toBe(1);
    expect(await count(pool, "select count(*) from auth_rate_limits where key like 'maint-old-%'")).toBe(0);
    expect(await removeStaleRateLimitWindows(db)).toBe(0);
  });
});

describe("health report", () => {
  it("finds a stock balance that disagrees with its ledger, and reports sizes without deleting anything", async () => {
    const before = await healthReport(db);
    const { variant } = await createTestVariant(db, "maint");
    await pool.query("update inventory_balances set on_hand = on_hand + 1 where variant_id = $1", [variant.id]);
    try {
      const broken = await healthReport(db);
      expect(broken.ledgerMismatch).toBe(before.ledgerMismatch + 1);
      expect(integrityProblems(broken)).toBeGreaterThan(integrityProblems(before));
    } finally {
      await pool.query("update inventory_balances set on_hand = on_hand - 1 where variant_id = $1", [variant.id]);
    }
    const after = await healthReport(db);
    expect(after.ledgerMismatch).toBe(before.ledgerMismatch);
    expect(after.idempotencyRecords).toBeGreaterThanOrEqual(before.idempotencyRecords);
  });
});

describe("npm run maintenance:run", () => {
  const SCRIPT = path.resolve("scripts/maintenance.mts");
  const LOADER = pathToFileURL(path.resolve("scripts/register-src.mts")).href;
  let emptyDir: string;
  beforeAll(() => {
    emptyDir = mkdtempSync(path.join(tmpdir(), "bsr-maint-"));
  });
  afterAll(() => rmSync(emptyDir, { recursive: true, force: true }));

  it.each([
    ["the test database", () => process.env.TEST_DATABASE_URL as string, "DATABASE_URL must name the babysunray_dev database."],
    ["a missing DATABASE_URL", () => undefined, "DATABASE_URL is not set."],
    ["a remote host", () => "postgresql://babysunray_dev:s3cret@db.example.com:5432/babysunray_dev", "local host"],
  ])("refuses %s before connecting, and prints no secret", (_name, url, expected) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DATABASE_URL;
    const value = url();
    if (value !== undefined) env.DATABASE_URL = value;
    const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings=ExperimentalWarning", "--import", LOADER, SCRIPT], { cwd: emptyDir, env, encoding: "utf8", timeout: 60_000 });
    const output = `${r.stdout}${r.stderr}`;
    expect(r.status).toBe(1);
    expect(output).toContain(expected);
    expect(output).not.toMatch(/s3cret|postgresql:\/\//);
  });
});
