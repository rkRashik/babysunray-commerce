import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maintenanceResponse } from "../../src/api/maintenance";
import type { Db } from "../../src/db/database";
import type { MaintenanceReport } from "../../src/modules/maintenance/jobs";
import { bearerMatches, maintenanceSecret, maintenanceSecretProblem } from "../../src/modules/maintenance/secret";

// The maintenance endpoint's access rules (Gate H.44), with the jobs replaced: who may call it, how, and what it says.
// What the jobs do is tested against PostgreSQL in tests/db/maintenance-run.integration.test.ts.

const SECRET = "Zq8LmW3xT9vB2nR7kD5pC1hY4gF6sJ0aEoUi";
const ENV = { MAINTENANCE_SECRET: SECRET, BETTER_AUTH_SECRET: "k7Qm2Zp9Xv4Rt8Ws3Yb6Nc1Ld5Hf0Gj_aB" };
const ok: MaintenanceReport = { status: "ok", jobs: [{ job: "verification_expiry", ok: true, count: 0 }], integrityProblems: 0, health: null, skipped: [] };
const call = (init: { method?: string; headers?: Record<string, string> } = {}) =>
  new Request("http://localhost:3000/api/internal/maintenance", { method: init.method ?? "POST", headers: init.headers });
const bearer = (secret = SECRET) => ({ authorization: `Bearer ${secret}` });
const deps = (run: () => Promise<MaintenanceReport>, env: Record<string, string | undefined> = ENV) => ({ db: (() => ({})) as unknown as () => Db, env, run });

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("the endpoint is off unless a strong secret is configured", () => {
  it("answers 404 and never runs a job, whatever the caller sends", async () => {
    const run = vi.fn(async () => ok);
    for (const env of [{}, { MAINTENANCE_SECRET: "" }, { MAINTENANCE_SECRET: "short" }, { MAINTENANCE_SECRET: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, { MAINTENANCE_SECRET: "CHANGE_ME_CHANGE_ME_CHANGE_ME_CHANGE_ME" }, { MAINTENANCE_SECRET: ENV.BETTER_AUTH_SECRET, BETTER_AUTH_SECRET: ENV.BETTER_AUTH_SECRET }]) {
      const response = await maintenanceResponse(call({ headers: bearer(env.MAINTENANCE_SECRET || "x") }), deps(run, env));
      expect(response.status).toBe(404);
    }
    expect(run).not.toHaveBeenCalled();
  });
  it("explains an unusable secret to config:check by variable name only", () => {
    expect(maintenanceSecretProblem({})).toBeNull();
    expect(maintenanceSecretProblem(ENV)).toBeNull();
    expect(maintenanceSecretProblem({ MAINTENANCE_SECRET: "short" })).toMatch(/MAINTENANCE_SECRET/);
    expect(maintenanceSecret({ MAINTENANCE_SECRET: "short" })).toBeNull();
  });
});

describe("unauthorised callers", () => {
  it.each([
    ["no credentials", {}],
    ["a wrong secret", bearer("Zq8LmW3xT9vB2nR7kD5pC1hY4gF6sJ0aEoUj")],
    ["a prefix of the secret", bearer(SECRET.slice(0, -1))],
    ["the secret with extra characters", bearer(`${SECRET}x`)],
    ["another scheme", { authorization: `Basic ${SECRET}` }],
    ["the secret without a scheme", { authorization: SECRET }],
    ["an empty bearer", { authorization: "Bearer " }],
    ["the secret in another header", { "x-api-key": SECRET }],
  ])("%s: 401, no job runs, nothing about the secret is revealed", async (_name, headers) => {
    const run = vi.fn(async () => ok);
    const response = await maintenanceResponse(call({ headers }), deps(run));
    expect([response.status, await response.json()]).toEqual([401, { error: "unauthorized" }]);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(run).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(SECRET);
  });
  it("a request from a browser page (Origin header) is refused even with the secret", async () => {
    const run = vi.fn(async () => ok);
    const response = await maintenanceResponse(call({ headers: { ...bearer(), origin: "https://elsewhere.example" } }), deps(run));
    expect(response.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });
  it("only POST: GET and others are refused before the credentials are even looked at", async () => {
    const run = vi.fn(async () => ok);
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) expect((await maintenanceResponse(call({ method, headers: bearer() }), deps(run))).status).toBe(405);
    expect(run).not.toHaveBeenCalled();
  });
  it("compares in constant time over digests (the helper agrees with equality)", () => {
    expect(bearerMatches(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(bearerMatches(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(bearerMatches(null, SECRET)).toBe(false);
  });
  it("a large body is refused", async () => {
    const response = await maintenanceResponse(call({ headers: { ...bearer(), "content-length": "5000" } }), deps(async () => ok));
    expect(response.status).toBe(413);
  });
});

describe("an authorised call", () => {
  it("runs once and answers counts and class names only", async () => {
    const run = vi.fn(async () => ok);
    const response = await maintenanceResponse(call({ headers: bearer() }), deps(run));
    expect([response.status, response.headers.get("cache-control")]).toEqual([200, "no-store"]);
    expect(await response.json()).toEqual({ status: "ok", jobs: ok.status === "ok" ? ok.jobs : [], skipped: [], integrityProblems: 0 });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("a failed job or an integrity problem is a 500, so a scheduler can alert", async () => {
    const failed: MaintenanceReport = { status: "failed", jobs: [{ job: "expired_sessions", ok: false, error: "Error 57014" }], integrityProblems: 2, health: null, skipped: ["stale_rate_limit_windows"] };
    const response = await maintenanceResponse(call({ headers: bearer() }), deps(async () => failed));
    expect([response.status, (await response.json()).integrityProblems]).toEqual([500, 2]);
  });
  it("an unexpected error is a generic 500; the log has the class name, never the message, the secret or a URL", async () => {
    const response = await maintenanceResponse(call({ headers: bearer() }), deps(async () => Promise.reject(new Error(`Failed query: select ${SECRET} postgresql://u:p@h/db`))));
    expect([response.status, await response.json()]).toEqual([500, { status: "failed", error: "internal" }]);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/Failed query|postgresql|Zq8L/);
  });
});
