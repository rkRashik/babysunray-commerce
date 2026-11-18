import "server-only";
import { randomUUID } from "node:crypto";
import type { Db } from "@/db/database";
import { type MaintenanceReport, runMaintenance } from "@/modules/maintenance/jobs";
import { bearerMatches, maintenanceSecret } from "@/modules/maintenance/secret";

// HTTP invocation of the maintenance jobs (Gate H.44), for a scheduler that can only call a URL. NOT a scheduler: nothing
// calls it until someone configures one. It is off unless MAINTENANCE_SECRET is set, answers 404 when off (the same as a
// route that does not exist), and when on accepts only POST (and GET when MAINTENANCE_ALLOW_GET=true) with `Authorization: Bearer <secret>` and no Origin header
// (a browser can never be made to call it). The secret is compared in constant time over SHA-256 digests. The jobs are
// safe to run concurrently and idempotent (an overlapping call or a replay finds less or nothing to do), a run uses one
// connection at a time, and it is bounded in work and time. Answers carry counts and error class names only.

export type MaintenanceDeps = { db: () => Db; env: Record<string, string | undefined>; run?: (db: Db) => Promise<MaintenanceReport> };

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "content-type": "application/json; charset=utf-8" };
const answer = (requestId: string, status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...HEADERS, "x-request-id": requestId, ...extra } });

export async function maintenanceResponse(request: Request, deps: MaintenanceDeps): Promise<Response> {
  const requestId = randomUUID();
  const secret = maintenanceSecret(deps.env);
  if (!secret) return answer(requestId, 404, { error: "not_found" });
  // GET is for hosts whose scheduler can only issue GET with the secret as a Bearer header (for example Vercel Cron with
  // CRON_SECRET set to the same value as MAINTENANCE_SECRET). Off unless MAINTENANCE_ALLOW_GET is exactly "true"; every other rule is unchanged.
  const getAllowed = deps.env.MAINTENANCE_ALLOW_GET === "true";
  if (request.method !== "POST" && !(request.method === "GET" && getAllowed)) return answer(requestId, 405, { error: "method_not_allowed" }, { allow: getAllowed ? "GET, POST" : "POST" });
  if (request.headers.get("origin") !== null) return answer(requestId, 403, { error: "forbidden" });
  if (!bearerMatches(request.headers.get("authorization"), secret)) return answer(requestId, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
  if (Number(request.headers.get("content-length") ?? 0) > 1024) return answer(requestId, 413, { error: "too_large" });
  const started = Date.now();
  try {
    const report = await (deps.run ?? runMaintenance)(deps.db());
    const log = { level: report.status === "ok" ? "info" : "error", event: "maintenance_run", requestId, status: report.status, ms: Date.now() - started };
    console[report.status === "ok" ? "log" : "error"](JSON.stringify(log));
    return answer(requestId, report.status === "ok" ? 200 : 500, { status: report.status, jobs: report.jobs, skipped: report.skipped, integrityProblems: report.integrityProblems, backlog: report.backlog });
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "maintenance_failed", requestId, errorName: error instanceof Error ? error.name : typeof error }));
    return answer(requestId, 500, { status: "failed", error: "internal" });
  }
}
