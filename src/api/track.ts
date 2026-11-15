import "server-only";
import * as z from "zod";
import { getDb } from "@/db/client";
import { pgErrorCode } from "@/db/database";
import { getAuth } from "@/modules/auth/server";
import { DomainError } from "@/modules/domain-error";
import { consumeTrackingLimit, type GuestView, trackingLocked } from "@/modules/orders/tracking";

// Transport for the public guest-tracking endpoints (/api/track, /api/track/cancel; founder rule K, S-15).
// The token travels only in a same-origin POST body, never in a URL, so it cannot reach access logs, history
// or a Referer. It is never logged. Every failure looks the same. No CORS: another origin is refused, and a
// JSON body forces a preflight that no response answers.

const HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "content-type": "application/json; charset=utf-8",
};
const MAX_BODY = 2048;

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: HEADERS });
export const NOT_FOUND = () => answer(404, { error: "not_found", message: "This tracking link is not valid or has expired. Please contact the shop." });

/**
 * Checks origin, media type and size, applies the global limits, parses the body with `schema`, and runs
 * `run`. `run` answers null for any unusable token; that counts as a failure.
 */
export async function trackingRequest<S extends z.ZodType>(request: Request, schema: S, run: (body: z.output<S>) => Promise<GuestView | null>): Promise<Response> {
  try {
    if (request.headers.get("origin") !== getAuth().options.baseURL) return answer(403, { error: "forbidden" });
    if (!/^application\/json\s*(;\s*charset\s*=\s*"?utf-8"?\s*)?$/i.test(request.headers.get("content-type") ?? "")) return answer(415, { error: "unsupported_media_type" });
    const raw = await request.text();
    if (raw.length > MAX_BODY) return answer(413, { error: "too_large" });
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return answer(400, { error: "bad_request" });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) return answer(400, { error: "bad_request" });
    const db = getDb();
    if ((await trackingLocked(db)) || !(await consumeTrackingLimit(db, "lookup"))) {
      return answer(429, { error: "rate_limited", message: "Too many requests. Please wait a minute and try again." });
    }
    const view = await run(parsed.data);
    if (!view) {
      await consumeTrackingLimit(db, "failure");
      return NOT_FOUND();
    }
    return answer(200, { data: view });
  } catch (error) {
    if (error instanceof DomainError && error.code === "INVALID_TRANSITION") {
      return answer(409, { error: "not_allowed", message: "This order can no longer be cancelled here. Please contact the shop." });
    }
    if (error instanceof DomainError && error.code === "INVALID_INPUT") return answer(400, { error: "bad_request" });
    // Name and SQL state only: never the message (it can hold query parameters) and never the body (the token).
    console.error(JSON.stringify({ level: "error", event: "tracking_failed", errorName: error instanceof Error ? error.name : typeof error, sqlState: pgErrorCode(error) ?? null }));
    return answer(500, { error: "internal" });
  }
}

export const tokenField = z.string().max(64);
