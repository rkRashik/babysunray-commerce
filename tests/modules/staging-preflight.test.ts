import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { stagingPreflight } from "../../src/db/staging-preflight.mts";

// The staging readiness summary (Gate H.46B): judged from the settings alone, never a connection, never a value.

const dir = mkdtempSync(path.join(tmpdir(), "bs-h46b-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PW = "fictionalPw-9Zq4TxLm";
const SECRET = "sb_secret_FICTIONALsecretKEY0123456789";
const PUBLISHABLE = "sb_publishable_FICTIONALpublishable0123";
const complete = {
  STAGING_MIGRATION_DATABASE_URL: `postgresql://postgres:${PW}@db.abcdefghij.supabase.co:5432/postgres`,
  STAGING_DATABASE_URL: `postgresql://babysunray_app.abcdefghij:${PW}@aws-0-eu.pooler.supabase.com:6543/postgres`,
  STAGING_DATABASE_SSL: "require",
  STAGING_SUPABASE_URL: "https://abcdefghij.supabase.co",
  STAGING_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
  STAGING_SUPABASE_SECRET_KEY: SECRET,
  STAGING_STORAGE_BUCKET: "fictional-bucket",
};
const states = (env: Record<string, string>) => Object.fromEntries(stagingPreflight(env).settings.map((s) => [s.name, s.state]));

describe("stagingPreflight", () => {
  it("complete, consistent settings are ready; a direct and a session-pooler administrator connection are told apart", () => {
    expect(stagingPreflight(complete)).toMatchObject({ ready: true, connectionMode: "direct connection" });
    const session = { ...complete, STAGING_MIGRATION_DATABASE_URL: `postgresql://postgres.abcdefghij:${PW}@aws-0-eu.pooler.supabase.com:5432/postgres` };
    expect(stagingPreflight(session)).toMatchObject({ ready: true, connectionMode: "session pooler" });
  });
  it("names every missing setting and is not ready", () => {
    const result = stagingPreflight({});
    expect(result.ready).toBe(false);
    expect(result.settings.map((s) => s.state)).toEqual(Array(7).fill("missing"));
  });
  it("catches mistakes that would otherwise surface late: transaction pooler for migrations, administrator as application, swapped keys, two projects", () => {
    expect(states({ ...complete, STAGING_MIGRATION_DATABASE_URL: complete.STAGING_DATABASE_URL }).STAGING_MIGRATION_DATABASE_URL).toBe("invalid");
    expect(states({ ...complete, STAGING_DATABASE_URL: complete.STAGING_MIGRATION_DATABASE_URL.replace(":5432", ":6543") }).STAGING_DATABASE_URL).toBe("invalid");
    expect(states({ ...complete, STAGING_SUPABASE_SECRET_KEY: PUBLISHABLE }).STAGING_SUPABASE_SECRET_KEY).toBe("invalid");
    expect(states({ ...complete, STAGING_SUPABASE_PUBLISHABLE_KEY: SECRET }).STAGING_SUPABASE_PUBLISHABLE_KEY).toBe("invalid");
    expect(states({ ...complete, STAGING_SUPABASE_SECRET_KEY: "not-a-key" }).STAGING_SUPABASE_SECRET_KEY).toBe("invalid");
    const other = stagingPreflight({ ...complete, STAGING_SUPABASE_URL: "https://zzzzzzzzzz.supabase.co" });
    expect(other.ready).toBe(false);
    expect(other.settings.some((s) => s.name === "(project consistency)" && s.state === "invalid")).toBe(true);
    expect(states({ ...complete, STAGING_DATABASE_SSL: "disable" }).STAGING_DATABASE_SSL).toBe("invalid");
  });
  it("never returns a value, even from the notes of an invalid setting", () => {
    const bad = stagingPreflight({ ...complete, STAGING_DATABASE_URL: `postgresql://babysunray_app.abcdefghij:${PW}@localhost:6543/postgres`, STAGING_SUPABASE_SECRET_KEY: PUBLISHABLE });
    const text = JSON.stringify(bad);
    for (const value of [PW, SECRET, PUBLISHABLE, "abcdefghij", "localhost"]) expect(text).not.toContain(value);
  });
});

describe("npm run staging:preflight", () => {
  const run = (file: string) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("STAGING_") && !/DATABASE_URL$/.test(k)) env[k] = v;
    return spawnSync(process.execPath, ["scripts/staging-preflight.mts"], { env: { ...env, STAGING_ENV_FILE: file } as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 30_000 });
  };
  it("reads the file named by STAGING_ENV_FILE, exits 0 or 2, and prints no value", () => {
    const full = path.join(dir, "full.env");
    writeFileSync(full, Object.entries(complete).map(([k, v]) => `${k}=${v}`).join("\n"));
    const ok = run(full);
    expect(ok.status).toBe(0);
    for (const value of [PW, SECRET, PUBLISHABLE]) expect(ok.stdout + ok.stderr).not.toContain(value);

    const partial = path.join(dir, "partial.env");
    writeFileSync(partial, `STAGING_SUPABASE_SECRET_KEY=${SECRET}\n`);
    const notReady = run(partial);
    expect(notReady.status).toBe(2);
    expect(notReady.stdout).toContain("MISSING  STAGING_DATABASE_URL");
    expect(notReady.stdout).toContain("NOT READY");
    expect(notReady.stdout + notReady.stderr).not.toContain(SECRET);
  });
  it("db:migrate:staging refuses a report file that already exists before it reads any connection", () => {
    const report = path.join(dir, "report.json");
    writeFileSync(report, "{}");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("STAGING_") && !/DATABASE_URL$/.test(k)) env[k] = v;
    const r = spawnSync(process.execPath, ["scripts/migrate-staging.mts", "--first-time", "--report", report], { env: { ...env, STAGING_ENV_FILE: path.join(dir, "absent.env") } as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 30_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("already exists");
  });
});
