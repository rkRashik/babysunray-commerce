import { describe, expect, it } from "vitest";
import { configChecks, configReady } from "../../src/config/readiness";
import { AuthConfigError, authSettingProblems, readAuthSettings } from "../../src/modules/auth/settings";

// The configuration check names variables and rules, never values (fictional values only).
const SECRET = "fictional-Secret-For-Tests-0123456789-abcdefXYZ";
const GOOD = {
  DATABASE_URL: "postgresql://babysunray_dev:fictional-pw-1@localhost:5432/babysunray_dev",
  TEST_DATABASE_URL: "postgresql://babysunray_test:fictional-pw-2@localhost:5432/babysunray_test",
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: "http://localhost:3000",
};
const status = (env: Record<string, string | undefined>) => Object.fromEntries(configChecks(env).map((c) => [c.name, c.status]));

describe("authSettingProblems", () => {
  it("is empty for a valid environment and names each problem without its value", () => {
    expect(authSettingProblems(GOOD)).toEqual([]);
    const problems = authSettingProblems({ BETTER_AUTH_SECRET: "CHANGE_ME", BETTER_AUTH_URL: "http://shop.example", BETTER_AUTH_TELEMETRY: "1" });
    expect(problems.map((p) => p.name)).toEqual(["BETTER_AUTH_TELEMETRY", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"]);
    expect(authSettingProblems({}).map((p) => p.problem)).toEqual(["BETTER_AUTH_SECRET is not set.", "BETTER_AUTH_URL is not set."]);
    for (const p of authSettingProblems({ BETTER_AUTH_SECRET: "short-secret-value", BETTER_AUTH_URL: "ftp://x.example/path" })) {
      expect(p.problem).not.toContain("short-secret-value");
      expect(p.problem).not.toContain("x.example");
    }
  });

  it("matches what the application refuses at start-up, with a distinct error type", () => {
    expect(() => readAuthSettings({})).toThrow(AuthConfigError);
    expect(readAuthSettings(GOOD).baseURL).toBe("http://localhost:3000");
  });
});

describe("configChecks", () => {
  it("reports a complete local setup as ready; optional variables may be missing", () => {
    expect(status(GOOD)).toMatchObject({ DATABASE_URL: "ok", BETTER_AUTH_SECRET: "ok", BETTER_AUTH_URL: "ok", TEST_DATABASE_URL: "ok", RESTORE_DATABASE_URL: "missing" });
    expect(configReady(configChecks(GOOD))).toBe(true);
  });

  it("is not ready with a missing secret, a wrong database or an invalid optional value", () => {
    expect(configReady(configChecks({ ...GOOD, BETTER_AUTH_SECRET: undefined }))).toBe(false);
    expect(status({ ...GOOD, DATABASE_URL: "postgresql://babysunray_dev:pw@db.example:5432/babysunray_dev" }).DATABASE_URL).toBe("invalid");
    expect(status({ ...GOOD, TEST_DATABASE_URL: GOOD.DATABASE_URL }).TEST_DATABASE_URL).toBe("invalid");
    const limits = { ...GOOD, API_RATE_LIMIT_READS_PER_MINUTE: "many" };
    expect(status(limits).API_RATE_LIMIT_READS_PER_MINUTE).toBe("invalid");
    expect(configReady(configChecks(limits))).toBe(false);
  });

  it("never includes a value in its output", () => {
    const text = JSON.stringify([...configChecks(GOOD), ...configChecks({ ...GOOD, BETTER_AUTH_SECRET: "CHANGE_ME", DATABASE_URL: "postgres://other:pw-x@localhost/elsewhere" })]);
    for (const secret of [SECRET, "fictional-pw-1", "fictional-pw-2", "pw-x", "elsewhere"]) expect(text).not.toContain(secret);
  });
});
