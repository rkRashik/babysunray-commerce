import "server-only";
import { randomUUID } from "node:crypto";
import * as z from "zod";
import { getDb } from "@/db/client";
import { type Db, pgErrorCode } from "@/db/database";
import { assertPermission, getBearerPrincipal, type Principal } from "@/modules/auth/principal";
import type { Permission } from "@/modules/auth/permissions";
import { getAuth } from "@/modules/auth/server";
import { DomainError } from "@/modules/domain-error";
import type { Once } from "@/modules/idempotency/service";
import { consumeRateLimit, type RateLimitBucket, readRateLimits } from "@/modules/rate-limit/service";
import { type ProblemCode, problemSchema } from "./schemas";

// HTTP plumbing shared by every /api/v1 route (docs/api/README.md). Routes stay thin: they declare a
// permission and input schemas and call a domain operation; everything here is transport.
//
// Order of checks on every request: origin policy, Bearer authentication, rate limit (per verified user),
// permission; for writes then the Idempotency-Key header and the body (size, media type, JSON, schema).
// Nothing about the input is examined for a caller who is not authenticated.

type Problem = z.infer<typeof problemSchema>;
type FieldError = NonNullable<Problem["errors"]>[number];

const COMMON_HEADERS = {
  // Responses can carry Owner data and depend on the Bearer token: never stored by any cache.
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/** Largest accepted request body. Two 5,000-character Bangla descriptions as JSON escapes fit. */
export const MAX_BODY_BYTES = 64 * 1024;

const PROBLEMS: Record<ProblemCode, [status: number, title: string]> = {
  UNAUTHENTICATED: [401, "Authentication required"],
  FORBIDDEN: [403, "Permission denied"],
  ORIGIN_NOT_ALLOWED: [403, "Origin not allowed"],
  VALIDATION_FAILED: [400, "Invalid request"],
  MALFORMED_JSON: [400, "Malformed JSON"],
  IDEMPOTENCY_KEY_REQUIRED: [400, "Idempotency-Key required"],
  PRODUCT_NOT_FOUND: [404, "Product not found"],
  VARIANT_NOT_FOUND: [404, "Variant not found"],
  ROUTE_NOT_FOUND: [404, "Not found"],
  METHOD_NOT_ALLOWED: [405, "Method not allowed"],
  SLUG_TAKEN: [409, "Slug already used"],
  SKU_TAKEN: [409, "SKU already used"],
  INSUFFICIENT_STOCK: [409, "Not enough stock"],
  STOCK_LIMIT_EXCEEDED: [409, "Stock quantity too large"],
  VERSION_CONFLICT: [409, "Changed since it was read"],
  PRODUCT_NOT_EDITABLE: [409, "Product cannot be edited"],
  VARIANT_NOT_EDITABLE: [409, "Variant cannot be edited"],
  ORDER_NOT_FOUND: [404, "Order not found"],
  RETURN_NOT_FOUND: [404, "Return not found"],
  QUARANTINE_ITEM_NOT_FOUND: [404, "Quarantined item not found"],
  INVALID_TRANSITION: [409, "Not allowed in the current state"],
  DELIVERY_ZONE_UNAVAILABLE: [409, "No active delivery charge for this zone"],
  VARIANT_NOT_ORDERABLE: [409, "SKU cannot be ordered"],
  PAYMENT_LIMIT_EXCEEDED: [409, "Amount exceeds what is allowed"],
  CATEGORY_NOT_FOUND: [404, "Category not found"],
  PAYLOAD_TOO_LARGE: [413, "Request body too large"],
  UNSUPPORTED_MEDIA_TYPE: [415, "Unsupported media type"],
  IDEMPOTENCY_KEY_REUSED: [422, "Idempotency-Key reused"],
  RATE_LIMITED: [429, "Too many requests"],
  INTERNAL_ERROR: [500, "Internal error"],
};

export function json(body: unknown, requestId: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...COMMON_HEADERS, "content-type": "application/json; charset=utf-8", "x-request-id": requestId, ...headers },
  });
}

/** An RFC 9457 problem response. `detail` and `errors` are fixed text, never echoed input or internals. */
export function problem(code: ProblemCode, requestId: string, options: { detail?: string; errors?: FieldError[]; headers?: Record<string, string> } = {}): Response {
  const [status, title] = PROBLEMS[code];
  const body: Problem = {
    type: "about:blank",
    title,
    status,
    code,
    requestId,
    ...(options.detail ? { detail: options.detail } : {}),
    ...(options.errors?.length ? { errors: options.errors } : {}),
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...COMMON_HEADERS,
      "content-type": "application/problem+json; charset=utf-8",
      "x-request-id": requestId,
      ...(code === "UNAUTHENTICATED" ? { "www-authenticate": 'Bearer realm="api"' } : {}),
      ...options.headers,
    },
  });
}

/** Thrown by input parsing; becomes a 400 problem listing the fields (names only). */
export class RequestValidationError extends Error {
  constructor(readonly errors: FieldError[]) {
    super("Invalid request.");
  }
}

/** A transport-level refusal with a fixed problem code (body too large, bad media type, ...). */
export class ApiProblem extends Error {
  constructor(
    readonly code: ProblemCode,
    readonly detail?: string,
    readonly headers?: Record<string, string>,
  ) {
    super(code);
  }
}

// A parameter name is echoed back only if it looks like one; anything else is reported generically.
const safeName = (name: string) => (/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : "(parameter)");

const MESSAGES: Partial<Record<z.core.$ZodIssue["code"], string>> = {
  invalid_type: "is required or has the wrong type",
  too_small: "is below the minimum",
  too_big: "is above the maximum",
  invalid_value: "is not an allowed value",
  invalid_format: "has an invalid format",
};

function toFieldErrors(location: FieldError["location"], error: z.ZodError): FieldError[] {
  return error.issues.flatMap((issue): FieldError[] => {
    const prefix = issue.path.length ? `${issue.path.join(".")}.` : "";
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({ location, name: safeName(`${prefix}${key}`), message: "is not a recognised parameter" }));
    }
    const name = issue.path.length ? safeName(issue.path.join(".")) : "(request)";
    return [{ location, name, message: MESSAGES[issue.code] ?? "is not valid" }];
  });
}

/** Query string → typed object. Unknown and repeated parameters are rejected, not ignored. */
export function parseQuery<S extends z.ZodType>(url: URL, schema: S): z.output<S> {
  const raw: Record<string, string> = {};
  const repeated: FieldError[] = [];
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(raw, key)) repeated.push({ location: "query", name: safeName(key), message: "must not be repeated" });
    raw[key] = value;
  }
  if (repeated.length) throw new RequestValidationError(repeated);
  const result = schema.safeParse(raw);
  if (!result.success) throw new RequestValidationError(toFieldErrors("query", result.error));
  return result.data;
}

export function parsePath<S extends z.ZodType>(params: unknown, schema: S): z.output<S> {
  const result = schema.safeParse(params);
  if (!result.success) throw new RequestValidationError(toFieldErrors("path", result.error));
  return result.data;
}

/**
 * Reads at most `maxBytes` (default MAX_BODY_BYTES). A declared Content-Length above the limit is refused before
 * reading; a body without one (or with a false one) is counted while it streams and refused as soon as it passes
 * the limit. Returns undefined for an empty body.
 */
export async function readBody(request: Request, maxBytes = MAX_BODY_BYTES): Promise<string | undefined> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > maxBytes) throw new ApiProblem("PAYLOAD_TOO_LARGE");
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new ApiProblem("PAYLOAD_TOO_LARGE");
    }
    chunks.push(value);
  }
  if (size === 0) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new ApiProblem("MALFORMED_JSON", "The request body is not valid UTF-8.");
  }
}

const JSON_MEDIA_TYPE = /^application\/json\s*(;\s*charset\s*=\s*("?)utf-8\2\s*)?$/i;

/** Body → typed object: JSON media type, well-formed JSON, then the strict schema. */
export async function parseJsonBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.output<S>> {
  const text = await readBody(request);
  let value: unknown = undefined;
  if (text !== undefined) {
    if (!JSON_MEDIA_TYPE.test(request.headers.get("content-type") ?? "")) {
      throw new ApiProblem("UNSUPPORTED_MEDIA_TYPE", "Send the body as application/json (UTF-8).");
    }
    try {
      value = JSON.parse(text);
    } catch {
      throw new ApiProblem("MALFORMED_JSON", "The request body is not valid JSON.");
    }
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new RequestValidationError(toFieldErrors("body", result.error));
  return result.data;
}

// The key as a plain token or as a quoted string (draft-ietf-httpapi-idempotency-key-header uses the latter).
const IDEMPOTENCY_KEY = /^(?:"([A-Za-z0-9_.:-]{16,128})"|([A-Za-z0-9_.:-]{16,128}))$/;

export function parseIdempotencyKey(headers: Headers): string {
  const match = IDEMPOTENCY_KEY.exec(headers.get("idempotency-key") ?? "");
  if (!match) {
    throw new ApiProblem("IDEMPOTENCY_KEY_REQUIRED", "Send an Idempotency-Key header: 16 to 128 characters of A-Z, a-z, 0-9, _ . : - (a UUID fits).");
  }
  return match[1] ?? match[2];
}

const DOMAIN_TO_PROBLEM: Partial<Record<DomainError["code"], ProblemCode>> = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  INVALID_INPUT: "VALIDATION_FAILED",
  PRODUCT_NOT_FOUND: "PRODUCT_NOT_FOUND",
  VARIANT_NOT_FOUND: "VARIANT_NOT_FOUND",
  SLUG_TAKEN: "SLUG_TAKEN",
  SKU_TAKEN: "SKU_TAKEN",
  INSUFFICIENT_STOCK: "INSUFFICIENT_STOCK",
  STOCK_LIMIT_EXCEEDED: "STOCK_LIMIT_EXCEEDED",
  IDEMPOTENCY_KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",
  VERSION_CONFLICT: "VERSION_CONFLICT",
  PRODUCT_NOT_EDITABLE: "PRODUCT_NOT_EDITABLE",
  VARIANT_NOT_EDITABLE: "VARIANT_NOT_EDITABLE",
  ORDER_NOT_FOUND: "ORDER_NOT_FOUND",
  RETURN_NOT_FOUND: "RETURN_NOT_FOUND",
  QUARANTINE_ITEM_NOT_FOUND: "QUARANTINE_ITEM_NOT_FOUND",
  INVALID_TRANSITION: "INVALID_TRANSITION",
  DELIVERY_ZONE_UNAVAILABLE: "DELIVERY_ZONE_UNAVAILABLE",
  VARIANT_NOT_ORDERABLE: "VARIANT_NOT_ORDERABLE",
  PAYMENT_LIMIT_EXCEEDED: "PAYMENT_LIMIT_EXCEEDED",
  CATEGORY_NOT_FOUND: "CATEGORY_NOT_FOUND",
};

function toProblem(error: unknown, requestId: string): Response {
  if (error instanceof RequestValidationError) return problem("VALIDATION_FAILED", requestId, { errors: error.errors });
  if (error instanceof ApiProblem) return problem(error.code, requestId, { detail: error.detail, headers: error.headers });
  if (error instanceof DomainError) {
    const code = DOMAIN_TO_PROBLEM[error.code];
    // A DomainError message is written to be safe to show (no personal data, no internals).
    if (code) return problem(code, requestId, { detail: error.message });
  }
  // Unexpected: log what helps diagnosis without the message, which for Drizzle includes query parameters.
  console.error(
    JSON.stringify({
      level: "error",
      event: "api_unexpected_error",
      requestId,
      errorName: error instanceof Error ? error.name : typeof error,
      sqlState: pgErrorCode(error) ?? null,
    }),
  );
  return problem("INTERNAL_ERROR", requestId);
}

/**
 * CORS policy: none. No response carries Access-Control-* headers, so browsers on other origins can neither
 * read responses nor pass a preflight. A request that announces another origin is refused outright as
 * well. Native clients send no Origin header and are unaffected.
 */
function assertOriginAllowed(headers: Headers): void {
  const origin = headers.get("origin");
  if (origin !== null && origin !== getAuth().options.baseURL) throw new ApiProblem("ORIGIN_NOT_ALLOWED");
}

/** Origin policy, Bearer principal, per-user rate limit, then the permission. */
async function authorise(request: Request, db: Db, bucket: RateLimitBucket, permission: Permission): Promise<Principal> {
  assertOriginAllowed(request.headers);
  const principal = await getBearerPrincipal(getAuth(), db, request.headers);
  if (!principal) throw new DomainError("UNAUTHENTICATED", "Sign in to continue.");
  const { allowed, retryAfterSeconds } = await consumeRateLimit(db, principal.userId, bucket, readRateLimits(process.env)[bucket]);
  if (!allowed) throw new ApiProblem("RATE_LIMITED", "Too many requests; retry after the time in Retry-After.", { "retry-after": String(retryAfterSeconds) });
  return assertPermission(principal, permission);
}

type Handler<P> = (input: { request: Request; url: URL; params: P; db: Db; principal: Principal }) => Promise<unknown>;

/**
 * A GET endpoint that requires a Bearer principal with `permission`. Cookies are never consulted
 * (getBearerPrincipal). The handler's return value is sent as JSON; errors become problem responses.
 */
export function apiGet<P = Record<string, never>>(permission: Permission, handler: Handler<P>) {
  return async (request: Request, context: { params: Promise<P> }): Promise<Response> => {
    const requestId = randomUUID();
    try {
      const db = getDb();
      const principal = await authorise(request, db, "read", permission);
      const body = await handler({ request, url: new URL(request.url), params: await context.params, db, principal });
      return json(body, requestId);
    } catch (error) {
      return toProblem(error, requestId);
    }
  };
}

type WriteHandler<P, B> = (input: { params: P; body: B; idempotencyKey: string; db: Db; principal: Principal }) => Promise<Once<unknown>>;

/**
 * A POST or PATCH endpoint that changes data: Bearer principal with `permission`, a mandatory Idempotency-Key and a
 * strict JSON body. The handler runs a shared operation once per key; a replay answers with the same
 * status and `Idempotent-Replayed: true`.
 */
export function apiPost<P, S extends z.ZodType>(permission: Permission, options: { body: S; status: 200 | 201 }, handler: WriteHandler<P, z.output<S>>) {
  return async (request: Request, context: { params: Promise<P> }): Promise<Response> => {
    const requestId = randomUUID();
    try {
      const db = getDb();
      const principal = await authorise(request, db, "write", permission);
      const idempotencyKey = parseIdempotencyKey(request.headers);
      const body = await parseJsonBody(request, options.body);
      const { value, replayed } = await handler({ params: await context.params, body, idempotencyKey, db, principal });
      return json({ data: value }, requestId, options.status, replayed ? { "idempotent-replayed": "true" } : {});
    } catch (error) {
      return toProblem(error, requestId);
    }
  };
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/**
 * 405 handlers for every method, to export for the ones a resource does not support (OPTIONS included, so a
 * CORS preflight is answered without any Access-Control-* header). They never read the request body.
 */
export function methodNotAllowed(allow: string): Record<(typeof METHODS)[number], () => Promise<Response>> {
  const handler = async () => problem("METHOD_NOT_ALLOWED", randomUUID(), { headers: { allow } });
  return Object.fromEntries(METHODS.map((m) => [m, handler])) as Record<(typeof METHODS)[number], () => Promise<Response>>;
}
