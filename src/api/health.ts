import "server-only";
import { sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import { hostedConfigProblems } from "@/config/hosted";
import { configuredBucketPrivate } from "@/modules/media/provider";

// Liveness and readiness for a future host (Gate H.44). Liveness: the process answers; it never touches the database,
// so a database outage cannot make a host restart a healthy process. Readiness: the configuration is valid and the
// database answers a trivial query within 2 s, and (with Supabase Storage) the photo bucket is confirmed private; it is what a load balancer or a deploy check should use. Anonymous
// callers get a status word only: no variable names, versions, hosts, timings or error text (those go to the server
// log, names only). The readiness answer is cached for 5 s and shared by concurrent callers, so probing it cannot
// become a way to load the database.

export type HealthDeps = { db: () => Db; env: Record<string, string | undefined>; now?: () => number; pingTimeoutMs?: number; bucketPrivate?: (env: Record<string, string | undefined>) => Promise<boolean> | null };

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "content-type": "application/json; charset=utf-8" };
const answer = (status: number, word: string, request: Request) =>
  new Response(request.method === "HEAD" ? null : JSON.stringify({ status: word }), { status, headers: HEADERS });
const notAllowed = () => new Response(null, { status: 405, headers: { ...HEADERS, allow: "GET, HEAD" } });
const allowed = (request: Request) => request.method === "GET" || request.method === "HEAD";

export function liveResponse(request: Request): Response {
  return allowed(request) ? answer(200, "ok", request) : notAllowed();
}

export const READY_CACHE_MS = 5_000;
let cached: { at: number; ready: boolean } | null = null;
let inFlight: Promise<boolean> | null = null;
/** For tests: forget the cached answer. */
export const resetReadinessCache = () => {
  cached = null;
  inFlight = null;
};

async function check(deps: HealthDeps): Promise<boolean> {
  const problems = hostedConfigProblems(deps.env);
  if (problems.length) {
    console.error(JSON.stringify({ level: "error", event: "not_ready", reason: "configuration", variables: problems.map((p) => p.name) }));
    return false;
  }
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), deps.pingTimeoutMs ?? 2_000);
    });
    try {
      await Promise.race([deps.db().execute(sql`select 1`), timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "not_ready", reason: "database", errorName: error instanceof Error ? error.name : typeof error }));
    return false;
  }
  // A public photo bucket would expose draft photos: not ready (Gate H.45). Checked at most once a minute (provider.ts).
  const bucket = (deps.bucketPrivate ?? configuredBucketPrivate)(deps.env);
  const bounded = bucket && Promise.race([bucket.catch(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), deps.pingTimeoutMs ?? 3_000).unref?.())]);
  if (bounded && !(await bounded)) {
    console.error(JSON.stringify({ level: "error", event: "not_ready", reason: "photo_bucket_not_private" }));
    return false;
  }
  return true;
}

export async function readyResponse(request: Request, deps: HealthDeps): Promise<Response> {
  if (!allowed(request)) return notAllowed();
  const now = (deps.now ?? Date.now)();
  if (!cached || now - cached.at >= READY_CACHE_MS) {
    inFlight ??= check(deps).finally(() => {
      inFlight = null;
    });
    cached = { at: now, ready: await inFlight };
  }
  return cached.ready ? answer(200, "ready", request) : answer(503, "not_ready", request);
}
