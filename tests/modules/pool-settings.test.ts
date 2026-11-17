import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { poolConfig, poolSettingsFor } from "../../src/db/client";
import { configuredPoolMax, parseDatabaseUrl, readPoolSettings } from "../../src/db/pool-settings";
import { bulkheadPlan } from "../../src/modules/rate-limit/bulkhead";

// Pool settings for local, persistent-server, serverless and transaction-pooler use (Gate H.44). No connection is made.

const LOCAL = "postgresql://app_user:s3cret%21pw@localhost:5432/app_db";
const REMOTE = "postgresql://app_user:s3cret@db.example.test:6543/app_db";
const ok = (env: Record<string, string>, host = "localhost") => {
  const result = readPoolSettings(env, host);
  if (!result.ok) throw new Error(result.problems.map((p) => p.problem).join(" "));
  return result.settings;
};

describe("defaults keep the local development behaviour", () => {
  it("10 connections, 10 s connect limit, 60 s statement limit sent at startup, TLS off", () => {
    expect(ok({})).toMatchObject({ runtime: "server", pooler: "direct", max: 10, idleTimeoutMillis: 10_000, allowExitOnIdle: false, statementTimeoutMillis: 60_000, connectionTimeoutMillis: 10_000, ssl: false });
    expect(poolConfig(LOCAL)).toMatchObject({ host: "localhost", port: 5432, database: "app_db", user: "app_user", password: "s3cret!pw", max: 10, statement_timeout: 60_000, ssl: false });
  });
});

describe("serverless and transaction pooling", () => {
  it("serverless: two connections, idle ones closed after 5 s, a 5 s connect limit, the process may end when idle", () => {
    expect(ok({ DATABASE_RUNTIME: "serverless" })).toMatchObject({ max: 2, idleTimeoutMillis: 5_000, allowExitOnIdle: true, connectionTimeoutMillis: 5_000 });
    expect(ok({ DATABASE_RUNTIME: "serverless", DATABASE_POOL_MAX: "1" }).max).toBe(1);
  });
  it("a transaction pooler gets no statement_timeout startup parameter (it must be set on the role)", () => {
    expect(poolConfig(REMOTE, ok({ DATABASE_POOLER: "transaction", DATABASE_SSL: "require" }, "db.example.test"))).not.toHaveProperty("statement_timeout");
  });
  it("the pool is 1 to 20 connections", () => {
    for (const bad of ["0", "21", "abc", "5.5", "-1", ""]) {
      const result = readPoolSettings({ DATABASE_POOL_MAX: bad });
      if (bad === "") expect(result.ok).toBe(true);
      else expect(result.ok).toBe(false);
    }
    expect(ok({ DATABASE_POOL_MAX: "20" }).max).toBe(20);
    expect(configuredPoolMax({ DATABASE_POOL_MAX: "nonsense" })).toBe(10);
  });
  it("rejects unknown runtime, pooler and TLS values by name", () => {
    const result = readPoolSettings({ DATABASE_RUNTIME: "edge", DATABASE_POOLER: "session", DATABASE_SSL: "maybe" });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? [] : result.problems.map((p) => p.name).sort()).toEqual(["DATABASE_POOLER", "DATABASE_RUNTIME", "DATABASE_SSL"]);
  });
});

describe("TLS for a database that is not on this machine", () => {
  it("must be chosen explicitly and can never be disabled", () => {
    expect(readPoolSettings({}, "db.example.test")).toMatchObject({ ok: false });
    expect(readPoolSettings({ DATABASE_SSL: "disable" }, "db.example.test")).toMatchObject({ ok: false });
    expect(ok({ DATABASE_SSL: "require" }, "db.example.test").ssl).toEqual({ rejectUnauthorized: false });
  });
  it("verify-full checks the server certificate, with the provider's CA when given", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----";
    expect(ok({ DATABASE_SSL: "verify-full" }, "db.example.test").ssl).toEqual({ rejectUnauthorized: true });
    expect(ok({ DATABASE_SSL: "verify-full", DATABASE_SSL_CA: pem }, "db.example.test").ssl).toEqual({ rejectUnauthorized: true, ca: pem });
    expect(readPoolSettings({ DATABASE_SSL: "verify-full", DATABASE_SSL_CA: "not a certificate" }, "db.example.test")).toMatchObject({ ok: false });
  });
  it("local hosts may stay without TLS", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) expect(ok({}, host).ssl).toBe(false);
  });
});

describe("the URL", () => {
  it("is reduced to explicit fields; a query string (which could override TLS or the host) is refused", () => {
    expect(parseDatabaseUrl(REMOTE)).toEqual({ host: "db.example.test", port: 6543, database: "app_db", user: "app_user", password: "s3cret" });
    expect(() => parseDatabaseUrl(`${LOCAL}?sslmode=disable`)).toThrow(/query parameters/);
    expect(() => parseDatabaseUrl(`${LOCAL}#x`)).toThrow();
    expect(parseDatabaseUrl("postgresql://u:p@[::1]:5432/d").host).toBe("::1");
  });
  it("errors never contain the URL or the password", () => {
    for (const bad of ["http://app_user:topsecret@h/db", "not a url", "postgresql://u:topsecret@/db?x=1"]) {
      try {
        parseDatabaseUrl(bad);
        throw new Error("should have refused");
      } catch (error) {
        expect(String((error as Error).message)).not.toMatch(/topsecret|app_user/);
      }
    }
    expect(() => poolSettingsFor("postgresql://u:topsecret@db.example.test:5432/d", {})).toThrow(/DATABASE_SSL/);
  });
});

describe("nothing depends on session state (safe behind a transaction-mode pooler)", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx|mts)$/.test(name) ? [full] : [];
    });
  // Excluded: the command-line tools that always use a direct connection (the migration runner and the guarded clients
  // of connection-guard.mts, which pin search_path for a session), the schema file, and this setting's own explanation.
  const direct = ["migrate-verified.mts", "connection-guard.mts", "schema.ts", "pool-settings.ts"].map((n) => path.join("src", "db", n));
  const source = files("src").filter((f) => !direct.includes(f));

  it("no session-level advisory lock, SET, LISTEN or temporary table outside the migration runner (which needs a direct or session connection)", () => {
    const pattern = /pg_advisory_lock|pg_try_advisory_lock|pg_advisory_unlock|\blisten\s+\w|create\s+temp|set_config\([^)]*false\)|\bset\s+(session\s+)?(search_path|statement_timeout|role|time zone)\b/i;
    expect(source.filter((f) => pattern.test(readFileSync(f, "utf8")))).toEqual([]);
  });
  it("no named (prepared) statement is sent to the driver", () => {
    const pattern = /\.query\(\s*\{[^}]*\bname:/;
    expect(source.filter((f) => pattern.test(readFileSync(f, "utf8")))).toEqual([]);
  });
  it("the only SET is transaction-local", () => {
    const sets = source.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/`set\s+(\w+)/gi)].map((m) => m[1].toLowerCase()));
    expect(sets.filter((s) => s !== "local")).toEqual([]);
  });
});

describe("bulkheads sized from the pool", () => {
  it("from 5 connections: separate bulkheads for reads, checkout and sign-in, together at most 80%", () => {
    expect(bulkheadPlan(10)).toEqual({ shared: false, reads: 4, checkout: 2, auth: 2 });
    for (let p = 5; p <= 20; p += 1) {
      const plan = bulkheadPlan(p);
      expect(plan.shared).toBe(false);
      expect(Math.min(plan.reads, plan.checkout, plan.auth)).toBeGreaterThanOrEqual(1);
      expect(plan.reads + plan.checkout + plan.auth).toBeLessThanOrEqual(Math.floor(p * 0.8));
    }
  });
  it("below 5: sign-in keeps its own slot; reads and checkout share max(1, P - 2); one connection stays free at 3 and 4", () => {
    expect(bulkheadPlan(4)).toEqual({ shared: true, reads: 2, checkout: 2, auth: 1 });
    expect(bulkheadPlan(3)).toEqual({ shared: true, reads: 1, checkout: 1, auth: 1 });
    expect(bulkheadPlan(2)).toEqual({ shared: true, reads: 1, checkout: 1, auth: 1 });
    expect(bulkheadPlan(1)).toEqual({ shared: true, reads: 1, checkout: 1, auth: 1 });
  });
});

describe("the bulkheads a small pool really gets", () => {
  it("at DATABASE_POOL_MAX=2, reads and checkout share one bulkhead and sign-in keeps its own", async () => {
    const { vi } = await import("vitest");
    vi.stubEnv("DATABASE_POOL_MAX", "2");
    vi.resetModules();
    try {
      const m = await import("../../src/modules/rate-limit/bulkhead");
      expect(m.anonymousCheckoutWork).toBe(m.anonymousDatabaseWork);
      expect(m.authEndpointWork).not.toBe(m.anonymousDatabaseWork);
      // A held tracking slot does not block sign-in.
      let release!: () => void;
      const held = m.anonymousDatabaseWork(() => new Promise<void>((r) => (release = r)));
      const signIn = await m.authEndpointWork(async () => "signed in");
      expect(signIn).toEqual({ ok: true, value: "signed in" });
      release();
      await held;
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
