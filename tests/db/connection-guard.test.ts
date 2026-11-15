import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertConnectedIdentity,
  DEV_TARGET,
  parseSafeDatabaseUrl,
  pinSearchPath,
  resolveDatabaseUrl,
  resolveEnvValue,
  RESTORE_TARGET,
  sessionConfig,
  TEST_TARGET,
} from "../../src/db/connection-guard.mts";

// Fictional values only. These tests never connect to a database.
const DEV = "postgresql://babysunray_dev:pw@localhost:5432/babysunray_dev";
const TEST = "postgresql://babysunray_test:pw@localhost:5432/babysunray_test";

function failure(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected the call to fail.");
}

describe("parseSafeDatabaseUrl (development migration target)", () => {
  it("accepts the local babysunray_dev database and role and returns explicit fields", () => {
    expect(parseSafeDatabaseUrl(DEV, DEV_TARGET)).toEqual({
      host: "localhost",
      port: 5432,
      database: "babysunray_dev",
      user: "babysunray_dev",
      password: "pw",
    });
    expect(parseSafeDatabaseUrl("postgres://babysunray_dev@127.0.0.1/babysunray_dev", DEV_TARGET)).toMatchObject({
      host: "127.0.0.1",
      port: 5432,
    });
    expect(parseSafeDatabaseUrl("postgres://babysunray_dev:p%40ss@[::1]:5432/babysunray_dev", DEV_TARGET)).toMatchObject({
      host: "::1",
      password: "p@ss",
    });
  });

  it.each([
    ["a missing value", undefined, "not set"],
    ["a malformed URL", "not a url", "valid URL"],
    ["another scheme", "mysql://babysunray_dev:pw@localhost/babysunray_dev", "scheme"],
    ["a remote host", "postgresql://babysunray_dev:pw@db.example.com/babysunray_dev", "local host"],
    ["a private network host", "postgresql://babysunray_dev:pw@192.168.1.10/babysunray_dev", "local host"],
    ["an unexpected port", "postgresql://babysunray_dev:pw@localhost:5433/babysunray_dev", "port 5432"],
    ["a query parameter that could redirect the host", `${DEV}?host=db.example.com`, "query parameters"],
    ["the wrong database name", "postgresql://babysunray_dev:pw@localhost/postgres", "babysunray_dev database"],
    ["a database whose name only starts the same", "postgresql://babysunray_dev:pw@localhost/babysunray_dev2", "babysunray_dev database"],
    ["the test database passed as the development target", TEST, "babysunray_dev database"],
    ["the test role on the development database", "postgresql://babysunray_test:pw@localhost/babysunray_dev", "babysunray_dev role"],
    ["a superuser role", "postgresql://postgres:pw@localhost/babysunray_dev", "babysunray_dev role"],
    ["no role", "postgresql://localhost/babysunray_dev", "babysunray_dev role"],
  ])("rejects %s", (_name, url, expected) => {
    expect(failure(() => parseSafeDatabaseUrl(url, DEV_TARGET))).toContain(expected);
  });

  it("never puts the URL or the password into an error message", () => {
    for (const url of [
      "postgresql://babysunray_dev:s3cret@db.example.com/babysunray_dev",
      "postgresql://postgres:s3cret@localhost/babysunray_dev",
      "postgresql://babysunray_dev:s3cret@localhost:6543/babysunray_dev",
      "postgresql://babysunray_dev:s3cret@localhost/other",
    ]) {
      const message = failure(() => parseSafeDatabaseUrl(url, DEV_TARGET));
      expect(message).not.toContain("s3cret");
      expect(message).not.toContain("postgresql://");
    }
  });

  it("applies the same rules to the test target, with the test names", () => {
    expect(parseSafeDatabaseUrl(TEST, TEST_TARGET).database).toBe("babysunray_test");
    expect(failure(() => parseSafeDatabaseUrl(DEV, TEST_TARGET))).toContain("babysunray_test database");
  });
});

describe("assertConnectedIdentity (what PostgreSQL itself reports)", () => {
  const ok = {
    db: "babysunray_dev",
    current_role: "babysunray_dev",
    session_role: "babysunray_dev",
    is_super: "off",
    port: 5432,
    is_loopback: true,
  };
  const reporting = (row: Partial<typeof ok>) => ({
    query: async () => ({ rows: [{ ...ok, ...row }] }),
  });
  const check = (row: Partial<typeof ok>) =>
    assertConnectedIdentity(reporting(row) as never, DEV_TARGET).then(
      () => "ok",
      (error: Error) => error.message,
    );

  it("accepts the expected database, role, port and loopback server", async () => {
    expect(await check({})).toBe("ok");
  });

  it.each([
    ["a different database", { db: "babysunray_test" }, "not babysunray_dev"],
    ["a different current role", { current_role: "postgres" }, "role is not"],
    ["a different session role", { session_role: "postgres" }, "role is not"],
    ["a superuser session", { is_super: "on" }, "superuser"],
    ["a different server port", { port: 5433 }, "port 5432"],
    ["a unix socket (no port)", { port: null }, "port 5432"],
    ["a non-loopback server", { is_loopback: false }, "loopback"],
    ["an unknown server address", { is_loopback: null }, "loopback"],
  ] as const)("rejects %s", async (_name, row, expected) => {
    expect(await check(row as Partial<typeof ok>)).toContain(expected);
  });
});

describe("sessionConfig and pinSearchPath (schema resolution)", () => {
  const params = { host: "localhost", port: 5432, database: "babysunray_dev", user: "babysunray_dev", password: "pw" };

  it("passes an explicit startup search_path option, which node-postgres prefers over PGOPTIONS", () => {
    expect(sessionConfig(params)).toEqual({
      ...params,
      options: "-c search_path=public",
      connectionTimeoutMillis: 5000,
    });
  });

  const reporting = (setting: string, schemas: string[], log: string[] = []) =>
    ({
      query: async (sql: string) => {
        log.push(sql);
        return { rows: [{ setting, schemas }] };
      },
    }) as never;

  it("sets search_path on the session first, then reads the effective value back", async () => {
    const log: string[] = [];
    await pinSearchPath(reporting("public", ["public"], log));
    expect(log).toHaveLength(2);
    expect(log[0]).toBe("set search_path to public");
    expect(log[1]).toContain("current_setting('search_path')");
  });

  it.each([
    ["another schema", "probe_schema", ["probe_schema"]],
    ["public followed by another schema", "public, probe_schema", ["public", "probe_schema"]],
    ["another schema first", "probe_schema, public", ["probe_schema", "public"]],
    ["a path that resolves to nothing", "public", []],
    ["an unexpected setting text", "$user, public", ["public"]],
  ])("rejects %s", async (_name, setting, schemas) => {
    await expect(pinSearchPath(reporting(setting, schemas))).rejects.toThrow("search_path is not public");
  });
});

describe("environment variable precedence", () => {
  it("uses whichever of the shell and .env.local is set", () => {
    expect(resolveEnvValue("X", "from-shell", undefined)).toBe("from-shell");
    expect(resolveEnvValue("X", undefined, "from-file")).toBe("from-file");
    expect(resolveEnvValue("X", "", "from-file")).toBe("from-file");
    expect(resolveEnvValue("X", "same", "same")).toBe("same");
    expect(resolveEnvValue("X", undefined, undefined)).toBeUndefined();
  });

  it("stops instead of letting a stale shell value silently win, without printing either value", () => {
    const message = failure(() => resolveEnvValue("DATABASE_URL", "stale-shell-secret", "file-secret"));
    expect(message).toContain("differs");
    expect(message).not.toContain("stale-shell-secret");
    expect(message).not.toContain("file-secret");
  });

  describe("resolveDatabaseUrl", () => {
    const dirs: string[] = [];
    afterEach(() => {
      vi.unstubAllEnvs();
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });
    const envFile = (content: string) => {
      const dir = mkdtempSync(path.join(tmpdir(), "bsr-env-"));
      dirs.push(dir);
      const file = path.join(dir, ".env.local");
      writeFileSync(file, content);
      return file;
    };

    it("reads DATABASE_URL from the env file when the shell does not set it", () => {
      vi.stubEnv("DATABASE_URL", "");
      expect(resolveDatabaseUrl(envFile(`DATABASE_URL=${DEV}\n`))).toBe(DEV);
    });

    it("accepts a shell value that matches the file, and a shell value with no file", () => {
      vi.stubEnv("DATABASE_URL", DEV);
      expect(resolveDatabaseUrl(envFile(`DATABASE_URL=${DEV}\n`))).toBe(DEV);
      expect(resolveDatabaseUrl(path.join(tmpdir(), "bsr-no-such-dir", ".env.local"))).toBe(DEV);
    });

    it("rejects a shell value that differs from the file", () => {
      vi.stubEnv("DATABASE_URL", TEST);
      expect(failure(() => resolveDatabaseUrl(envFile(`DATABASE_URL=${DEV}\n`)))).toContain("differs");
    });

    it("returns nothing when neither defines it", () => {
      vi.stubEnv("DATABASE_URL", "");
      expect(resolveDatabaseUrl(path.join(tmpdir(), "bsr-no-such-dir", ".env.local"))).toBeUndefined();
    });
  });
});

describe("RESTORE_TARGET (npm run backup:restore)", () => {
  it("accepts only the local babysunray_restore database and role", () => {
    expect(parseSafeDatabaseUrl("postgresql://babysunray_restore:pw@localhost:5432/babysunray_restore", RESTORE_TARGET)).toMatchObject({ database: "babysunray_restore", user: "babysunray_restore" });
  });

  it("refuses the development and test databases and any other host", () => {
    expect(failure(() => parseSafeDatabaseUrl(DEV, RESTORE_TARGET))).toContain("babysunray_restore");
    expect(failure(() => parseSafeDatabaseUrl(TEST, RESTORE_TARGET))).toContain("babysunray_restore");
    expect(failure(() => parseSafeDatabaseUrl("postgresql://babysunray_restore:pw@db.example.test:5432/babysunray_restore", RESTORE_TARGET))).toContain("local host");
    expect(failure(() => parseSafeDatabaseUrl(undefined, RESTORE_TARGET))).toContain("RESTORE_DATABASE_URL");
  });
});
