import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveResponse, READY_CACHE_MS, readyResponse, resetReadinessCache } from "../../src/api/health";
import type { Db } from "../../src/db/database";

// Liveness and readiness (Gate H.44): status words only, no secrets, no database in liveness, a cached and shared database check.

const ENV = { DATABASE_URL: "postgresql://app_user:topsecret@localhost:5432/app_db", BETTER_AUTH_SECRET: "k7Qm2Zp9Xv4Rt8Ws3Yb6Nc1Ld5Hf0Gj_aB", BETTER_AUTH_URL: "http://localhost:3000" };
const get = (method = "GET") => new Request("http://localhost:3000/api/health/ready", { method });
const dbThat = (execute: () => Promise<unknown>) => (() => ({ execute }) as unknown as Db) as () => Db;

beforeEach(() => {
  resetReadinessCache();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("liveness", () => {
  it("answers ok without touching the database or reading the environment", async () => {
    const response = liveResponse(get());
    expect([response.status, await response.json()]).toEqual([200, { status: "ok" }]);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("accepts only GET and HEAD", () => {
    expect(liveResponse(get("POST")).status).toBe(405);
    expect(liveResponse(get("HEAD")).status).toBe(200);
  });
});

describe("readiness", () => {
  it("ready: valid configuration and an answering database; the body is a status word only", async () => {
    const execute = vi.fn(async () => ({ rows: [{ "?column?": 1 }] }));
    const response = await readyResponse(get(), { db: dbThat(execute), env: ENV });
    expect([response.status, await response.json()]).toEqual([200, { status: "ready" }]);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("not ready when the database fails or hangs; the answer reveals nothing and the log has no error text", async () => {
    const response = await readyResponse(get(), { db: dbThat(async () => Promise.reject(new Error("connect ECONNREFUSED postgresql://app_user:topsecret@db.internal:5432"))), env: ENV });
    const text = JSON.stringify([response.status, await response.text()]);
    expect(text).toBe('[503,"{\\"status\\":\\"not_ready\\"}"]');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/topsecret|db\.internal|ECONNREFUSED/);
    resetReadinessCache();
    const slow = await readyResponse(get(), { db: dbThat(() => new Promise(() => undefined)), env: ENV, pingTimeoutMs: 20 });
    expect(slow.status).toBe(503);
  });
  it("not ready on invalid configuration, naming nothing to the caller and no database query is made", async () => {
    const execute = vi.fn(async () => ({}));
    const response = await readyResponse(get(), { db: dbThat(execute), env: { ...ENV, BETTER_AUTH_SECRET: "CHANGE_ME" } });
    expect([response.status, await response.json()]).toEqual([503, { status: "not_ready" }]);
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain("BETTER_AUTH_SECRET");
  });
  it("a photo bucket that is not confirmed private makes the application not ready", async () => {
    const response = await readyResponse(get(), { db: dbThat(async () => ({})), env: ENV, bucketPrivate: () => Promise.resolve(false) });
    expect([response.status, await response.json()]).toEqual([503, { status: "not_ready" }]);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain("photo_bucket_not_private");
    resetReadinessCache();
    expect((await readyResponse(get(), { db: dbThat(async () => ({})), env: ENV, bucketPrivate: () => Promise.reject(new Error("down")) })).status).toBe(503);
    resetReadinessCache();
    expect((await readyResponse(get(), { db: dbThat(async () => ({})), env: ENV, bucketPrivate: () => Promise.resolve(true) })).status).toBe(200);
  });
  it("a hosted database without TLS settings is not ready", async () => {
    const response = await readyResponse(get(), { db: dbThat(async () => ({})), env: { ...ENV, DATABASE_URL: "postgresql://u:p@db.example.test:5432/d" } });
    expect(response.status).toBe(503);
  });
  it("probing is cheap: concurrent calls share one check and the answer is cached for a few seconds", async () => {
    let now = 1_000_000;
    const execute = vi.fn(async () => ({}));
    const deps = { db: dbThat(execute), env: ENV, now: () => now };
    await Promise.all(Array.from({ length: 50 }, () => readyResponse(get(), deps)));
    expect(execute).toHaveBeenCalledTimes(1);
    now += READY_CACHE_MS - 1;
    await readyResponse(get(), deps);
    expect(execute).toHaveBeenCalledTimes(1);
    now += 1;
    await readyResponse(get(), deps);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("recovers: not ready, then ready once the database answers again", async () => {
    let now = 5_000_000;
    let up = false;
    const deps = { db: dbThat(async () => (up ? {} : Promise.reject(new Error("down")))), env: ENV, now: () => now };
    expect((await readyResponse(get(), deps)).status).toBe(503);
    up = true;
    now += READY_CACHE_MS;
    expect((await readyResponse(get(), deps)).status).toBe(200);
  });
  it("accepts only GET and HEAD; HEAD has no body", async () => {
    const deps = { db: dbThat(async () => ({})), env: ENV };
    expect((await readyResponse(get("POST"), deps)).status).toBe(405);
    const head = await readyResponse(get("HEAD"), deps);
    expect([head.status, await head.text()]).toEqual([200, ""]);
  });
});
