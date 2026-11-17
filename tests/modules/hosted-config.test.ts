import { describe, expect, it } from "vitest";
import { configChecks, configReady } from "../../src/config/readiness";
import { databaseProblems, directDatabaseProblem, hostedConfigProblems } from "../../src/config/hosted";

// Configuration for a hosted installation (Gate H.44): names and rules, never values, and no connection is made.

const SECRET = "k7Qm2Zp9Xv4Rt8Ws3Yb6Nc1Ld5Hf0Gj_aB";
const hosted = { NODE_ENV: "production", DATABASE_URL: "postgresql://u:topsecretpw@aws-0.pooler.example.test:6543/postgres", DATABASE_POOLER: "transaction", DATABASE_SSL: "require", DATABASE_RUNTIME: "serverless", BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: "https://shop.example.test" };

describe("hosted database settings", () => {
  it("a complete serverless setup has no problems", () => {
    expect(hostedConfigProblems(hosted)).toEqual([]);
  });
  it("port 6543 is a transaction pooler and must be declared", () => {
    expect(databaseProblems({ ...hosted, DATABASE_POOLER: undefined }).map((p) => p.name)).toEqual(["DATABASE_POOLER"]);
  });
  it("TLS is mandatory off this machine; a URL cannot switch it off or change settings with a query string", () => {
    expect(databaseProblems({ ...hosted, DATABASE_SSL: undefined }).map((p) => p.name)).toEqual(["DATABASE_SSL"]);
    expect(databaseProblems({ ...hosted, DATABASE_URL: `${hosted.DATABASE_URL}?sslmode=disable` }).map((p) => p.name)).toContain("DATABASE_URL");
  });
  it("sign-in settings are enforced: https and a real secret", () => {
    expect(hostedConfigProblems({ ...hosted, BETTER_AUTH_URL: "http://shop.example.test" }).map((p) => p.name)).toEqual(["BETTER_AUTH_URL"]);
    expect(hostedConfigProblems({ ...hosted, BETTER_AUTH_SECRET: "CHANGE_ME" }).map((p) => p.name)).toEqual(["BETTER_AUTH_SECRET"]);
  });
  it("a chosen photo store must be valid; local folders are refused in production unless allowed; unset means no photos", () => {
    expect(hostedConfigProblems({ ...hosted, MEDIA_STORAGE_PROVIDER: "supabase" }).map((p) => p.name)).toEqual(["SUPABASE_*"]);
    expect(hostedConfigProblems({ ...hosted, MEDIA_STORAGE_PROVIDER: "ftp" }).map((p) => p.name)).toEqual(["MEDIA_STORAGE_*"]);
    expect(hostedConfigProblems({ ...hosted, MEDIA_STORAGE_PROVIDER: "supabase", SUPABASE_URL: "https://p.example.test", SUPABASE_STORAGE_BUCKET: "photos", SUPABASE_SERVICE_ROLE_KEY: "fictional-service-key-0123456789" })).toEqual([]);
  });
  it("the migration and backup connection may not be the transaction pooler", () => {
    expect(directDatabaseProblem({})).toBeNull();
    expect(directDatabaseProblem({ DIRECT_DATABASE_URL: "postgresql://u:p@db.example.test:5432/postgres" })).toBeNull();
    expect(directDatabaseProblem({ DIRECT_DATABASE_URL: "postgresql://u:p@pooler.example.test:6543/postgres" })).toMatch(/transaction pooler/);
  });
  it("no message contains a password or a secret", () => {
    const all = JSON.stringify([
      hostedConfigProblems({ ...hosted, DATABASE_SSL: undefined, BETTER_AUTH_URL: "http://x", MEDIA_STORAGE_PROVIDER: "supabase", SUPABASE_SERVICE_ROLE_KEY: "short-secret-value" }),
      directDatabaseProblem({ DIRECT_DATABASE_URL: "postgresql://u:topsecretpw@h:6543/d" }),
    ]);
    expect(all).not.toMatch(/topsecretpw|short-secret-value/);
  });
});

describe("npm run config:check", () => {
  it("hosted mode judges DATABASE_URL by the hosted rules instead of the local-only development guard", () => {
    const checks = configChecks(hosted);
    expect(checks.find((c) => c.name === "DATABASE_URL")?.status).toBe("ok");
    expect(configChecks({ ...hosted, NODE_ENV: undefined }).find((c) => c.name === "DATABASE_URL")?.status).toBe("invalid");
  });
  it("reports the new optional variables by name, valid or not, without values", () => {
    const bad = configChecks({ ...hosted, MAINTENANCE_SECRET: "short", DIRECT_DATABASE_URL: "postgresql://u:topsecretpw@h:6543/d" });
    expect(bad.filter((c) => c.status === "invalid").map((c) => c.name).sort()).toEqual(["DIRECT_DATABASE_URL", "MAINTENANCE_SECRET"]);
    expect(JSON.stringify(bad)).not.toContain("topsecretpw");
    expect(configReady(bad)).toBe(false);
  });
  it("unset optional variables do not make a local setup not ready", () => {
    const local = { DATABASE_URL: "postgresql://babysunray_dev:pw@localhost:5432/babysunray_dev", BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: "http://localhost:3000" };
    expect(configReady(configChecks(local))).toBe(true);
  });
});
