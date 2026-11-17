import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { APPEND_ONLY_TABLES } from "../../src/db/hosted-security.mts";
import { assertNotLocalDatabase, assertRecentBackup, backupHeaderOf, parseStagingUrl } from "../../src/db/hosted-target.mts";

// The hosted staging guards (Gate H.45), without any network: URL rules, TLS, backup headers, the privilege script's
// table list, and the commands' refusals when nothing is configured.

const dir = mkdtempSync(path.join(tmpdir(), "bs-h45-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DIRECT = "postgresql://postgres:topsecretpw@db.abcdefghij.supabase.example:5432/postgres";
const POOLED = "postgresql://babysunray_app.abcdefghij:topsecretpw@aws-0.pooler.supabase.example:6543/postgres";
const env = (extra: Record<string, string>) => ({ STAGING_DATABASE_SSL: "require", ...extra });

describe("staging URLs", () => {
  it("direct and pooled connections are told apart by port, and TLS is required", () => {
    expect(parseStagingUrl(env({ X: DIRECT }), "X", { pooled: false })).toMatchObject({ host: "db.abcdefghij.supabase.example", port: 5432, database: "postgres", user: "postgres", sslMode: "require", ssl: { rejectUnauthorized: false } });
    expect(parseStagingUrl(env({ X: POOLED }), "X", { pooled: true })).toMatchObject({ port: 6543, user: "babysunray_app.abcdefghij" });
    expect(() => parseStagingUrl(env({ X: POOLED }), "X", { pooled: false })).toThrow(/never the transaction pooler/);
    expect(() => parseStagingUrl(env({ X: DIRECT }), "X", { pooled: true })).toThrow(/transaction pooler/);
    expect(() => parseStagingUrl({ X: DIRECT }, "X", { pooled: false })).toThrow(/STAGING_DATABASE_SSL/);
    expect(() => parseStagingUrl({ X: DIRECT, STAGING_DATABASE_SSL: "disable" }, "X", { pooled: false })).toThrow(/STAGING_DATABASE_SSL/);
  });
  it("this machine, query strings and other schemes are refused; no error shows the URL or password", () => {
    for (const bad of ["postgresql://u:topsecretpw@localhost:5432/babysunray_dev", "postgresql://u:topsecretpw@127.0.0.1:5432/x", `${DIRECT}?sslmode=disable`, "http://u:topsecretpw@h:5432/d", "nonsense"]) {
      let message = "";
      try {
        parseStagingUrl(env({ X: bad }), "X", { pooled: false });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toMatch(/topsecretpw|babysunray_dev/);
    }
  });
  it("verify-full needs a readable PEM CA file", () => {
    expect(() => parseStagingUrl(env({ X: DIRECT, STAGING_DATABASE_SSL: "verify-full" }), "X", { pooled: false })).toThrow(/ROOT_CERT/);
    const bad = path.join(dir, "not-a-cert.pem");
    writeFileSync(bad, "hello");
    expect(() => parseStagingUrl(env({ X: DIRECT, STAGING_DATABASE_SSL: "verify-full", STAGING_DATABASE_SSL_ROOT_CERT: bad }), "X", { pooled: false })).toThrow(/not a PEM/);
    const good = path.join(dir, "ca.pem");
    writeFileSync(good, "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n");
    expect(parseStagingUrl(env({ X: DIRECT, STAGING_DATABASE_SSL: "verify-full", STAGING_DATABASE_SSL_ROOT_CERT: good }), "X", { pooled: false })).toMatchObject({ ssl: { rejectUnauthorized: true }, sslMode: "verify-full", sslRootCert: good });
  });
  it("the staging database may not be one of this machine's configured databases", () => {
    const conn = parseStagingUrl(env({ X: DIRECT }), "X", { pooled: false });
    expect(() => assertNotLocalDatabase(conn, { DATABASE_URL: "postgresql://u:p@db.abcdefghij.supabase.example:5432/postgres" })).toThrow(/same as DATABASE_URL/);
    expect(() => assertNotLocalDatabase(conn, { DATABASE_URL: "postgresql://u:p@localhost:5432/babysunray_dev", TEST_DATABASE_URL: "not a url" })).not.toThrow();
  });
});

describe("the backup that must precede a migration", () => {
  const backup = (header: Record<string, unknown>) => {
    const json = Buffer.from(JSON.stringify(header));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(json.length);
    const file = path.join(dir, `b-${Math.random().toString(36).slice(2)}.bsbackup`);
    writeFileSync(file, Buffer.concat([Buffer.from("BSRBAK01"), length, json, Buffer.from("encrypted records")]));
    return file;
  };
  it("is a staging backup of this host and database, at most 24 hours old", () => {
    const now = Date.parse("2026-11-17T12:00:00Z");
    const target = { host: "db.abcdefghij.supabase.example", database: "postgres" };
    const header = (extra: Record<string, unknown>) => ({ format: "babysunray-backup", database: "postgres", host: target.host, createdAt: "2026-11-17T06:00:00Z", ...extra });
    expect(assertRecentBackup(backup(header({})), target, now)).toEqual({ createdAt: "2026-11-17T06:00:00Z" });
    // Every Supabase database is called postgres: the host is what tells projects apart.
    expect(() => assertRecentBackup(backup(header({ host: "db.otherproject.supabase.example" })), target, now)).toThrow(/another database/);
    expect(() => assertRecentBackup(backup(header({ host: undefined })), target, now)).toThrow(/not a staging backup/);
    expect(() => assertRecentBackup(backup(header({ database: "other" })), target, now)).toThrow(/another database/);
    expect(() => assertRecentBackup(backup(header({ createdAt: "2026-11-15T06:00:00Z" })), target, now)).toThrow(/older than 24 hours/);
    expect(() => assertRecentBackup(backup(header({ createdAt: "2026-11-18T06:00:00Z" })), target, now)).toThrow(/future/);
  });
  it("anything else is refused", () => {
    const other = path.join(dir, "other.bin");
    writeFileSync(other, "PGDMP not ours");
    expect(() => backupHeaderOf(other)).toThrow(/not a BabySunray/);
    expect(() => backupHeaderOf(path.join(dir, "missing.bsbackup"))).toThrow(/could not be read/);
    expect(() => backupHeaderOf(backup({ format: "something" }))).toThrow(/header/);
  });
});

describe("the append-only list", () => {
  it("matches the migrations' append-only triggers and the hosted privilege script", () => {
    const migrations = readdirSync("drizzle").filter((f) => f.endsWith(".sql")).map((f) => readFileSync(path.join("drizzle", f), "utf8")).join("\n");
    const fromTriggers = [...migrations.matchAll(/BEFORE UPDATE OR DELETE OR TRUNCATE ON "([a-z_]+)"/g)].map((m) => m[1]);
    expect([...new Set(fromTriggers)].sort()).toEqual([...APPEND_ONLY_TABLES].sort());
    const script = readFileSync(path.join("db", "hosted", "privileges.sql"), "utf8");
    const listed = [...(script.match(/foreach append_only in array array\[([^\]]+)\]/)?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...APPEND_ONLY_TABLES].sort());
  });
});

describe("the staging commands refuse without settings and connect to nothing", () => {
  const scrubbed = () => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("STAGING_") && !/DATABASE_URL$/.test(k)) out[k] = v;
    return { ...out, STAGING_ENV_FILE: path.join(dir, "absent.env") };
  };
  const run = (script: string, args: string[] = []) => spawnSync(process.execPath, [script, ...args], { env: scrubbed() as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 30_000 });

  it("test:staging reports NOT RUN with exit code 2, never a pass", () => {
    const result = run("scripts/staging-test.mts");
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("NOT RUN — awaiting founder setup.");
    expect(result.stdout).toContain("STAGING_DATABASE_URL");
  });
  it("db:migrate:staging and backup:create:staging stop before connecting", () => {
    const report = path.join(dir, "report.json");
    const migrate = run("scripts/migrate-staging.mts", ["--first-time", "--report", report]);
    expect(migrate.status).toBe(1);
    expect(migrate.stderr).toContain("STAGING_MIGRATION_DATABASE_URL is not set.");
    const backup = run("scripts/backup-staging.mts", ["--out", dir]);
    expect(backup.status).toBe(1);
    expect(backup.stderr).toContain("STAGING_MIGRATION_DATABASE_URL is not set.");
  });
  it("a report or backup inside the project is refused", () => {
    const migrate = run("scripts/migrate-staging.mts", ["--first-time", "--report", path.resolve("report.json")]);
    expect(migrate.status).toBe(1);
    expect(migrate.stderr).toContain("outside the project");
  });
});
