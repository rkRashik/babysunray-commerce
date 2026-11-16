import "server-only";
import { randomUUID } from "node:crypto";
import * as z from "zod";
import { getDb } from "@/db/client";
import { type Db, pgErrorCode } from "@/db/database";
import { getAuth } from "@/modules/auth/server";
import { DomainError } from "@/modules/domain-error";
import { consumeTrackingLimit, findLiveLink, type GuestView, wellFormedToken } from "@/modules/orders/tracking";
import { ApiProblem, readBody } from "./v1/http";

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

const LIMITED = () => answer(429, { error: "rate_limited", message: "Too many requests. Please wait a minute and try again." });

/**
 * Checks origin, media type and size, parses the body with `schema` (which has a `token`), applies the
 * layered limits of TRACKING_LIMITS and runs `run` for the order of a live link. A malformed token is answered
 * without any database work; an unknown, revoked or expired one counts as a failure.
 */
export async function trackingRequest<S extends z.ZodType<{ token: string }>>(
  request: Request,
  schema: S,
  run: (db: Db, orderId: string, body: z.output<S>) => Promise<GuestView | null>,
): Promise<Response> {
  const requestId = randomUUID();
  const response = await track(request, schema, run, requestId);
  response.headers.set("x-request-id", requestId);
  return response;
}

async function track<S extends z.ZodType<{ token: string }>>(
  request: Request,
  schema: S,
  run: (db: Db, orderId: string, body: z.output<S>) => Promise<GuestView | null>,
  requestId: string,
): Promise<Response> {
  try {
    if (request.headers.get("origin") !== getAuth().options.baseURL) return answer(403, { error: "forbidden" });
    if (!/^application\/json\s*(;\s*charset\s*=\s*"?utf-8"?\s*)?$/i.test(request.headers.get("content-type") ?? "")) return answer(415, { error: "unsupported_media_type" });
    // Bytes counted while the body streams, so an anonymous caller cannot make the server hold a large body.
    let json: unknown;
    try {
      json = JSON.parse((await readBody(request, MAX_BODY)) ?? "");
    } catch (error) {
      if (error instanceof ApiProblem && error.code === "PAYLOAD_TOO_LARGE") return answer(413, { error: "too_large" });
      return answer(400, { error: "bad_request" });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) return answer(400, { error: "bad_request" });
    if (!wellFormedToken(parsed.data.token)) return NOT_FOUND();
    const db = getDb();
    const link = await findLiveLink(db, parsed.data.token);
    if (!link) return (await consumeTrackingLimit(db, "failure")) ? NOT_FOUND() : LIMITED();
    if (!(await consumeTrackingLimit(db, `link:${link.tokenId}`))) return LIMITED();
    const view = await run(db, link.orderId, parsed.data);
    return view ? answer(200, { data: view }) : NOT_FOUND();
  } catch (error) {
    if (error instanceof DomainError && error.code === "INVALID_TRANSITION") {
      return answer(409, { error: "not_allowed", message: "This order can no longer be cancelled here. Please contact the shop." });
    }
    if (error instanceof DomainError && error.code === "INVALID_INPUT") return answer(400, { error: "bad_request" });
    // Name and SQL state only: never the message (it can hold query parameters) and never the body (the token).
    console.error(JSON.stringify({ level: "error", event: "tracking_failed", requestId, errorName: error instanceof Error ? error.name : typeof error, sqlState: pgErrorCode(error) ?? null }));
    return answer(500, { error: "internal" });
  }
}

export const tokenField = z.string().max(64);
