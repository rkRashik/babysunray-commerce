import "server-only";
import { randomUUID } from "node:crypto";
import * as z from "zod";
import { getDb } from "@/db/client";
import { type Db, pgErrorCode } from "@/db/database";
import { assertPermission, getBearerPrincipal, type Principal } from "@/modules/auth/principal";
import type { Permission } from "@/modules/auth/permissions";
import { getAuth } from "@/modules/auth/server";
import { DomainError } from "@/modules/domain-error";
import { type ProblemCode, problemSchema } from "./schemas";

// HTTP plumbing shared by every /api/v1 route (docs/api/README.md). Routes stay thin: they declare a
// permission and input schemas and call a domain service; everything here is transport.

type Problem = z.infer<typeof problemSchema>;
type FieldError = NonNullable<Problem["errors"]>[number];

const COMMON_HEADERS = {
  // Responses can carry Owner data and depend on the Bearer token: never stored by any cache.
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

const TITLES: Record<ProblemCode, string> = {
  UNAUTHENTICATED: "Authentication required",
  FORBIDDEN: "Permission denied",
  VALIDATION_FAILED: "Invalid request",
  PRODUCT_NOT_FOUND: "Product not found",
  VARIANT_NOT_FOUND: "Variant not found",
  ROUTE_NOT_FOUND: "Not found",
  METHOD_NOT_ALLOWED: "Method not allowed",
  INTERNAL_ERROR: "Internal error",
};

const STATUS: Record<ProblemCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  VALIDATION_FAILED: 400,
  PRODUCT_NOT_FOUND: 404,
  VARIANT_NOT_FOUND: 404,
  ROUTE_NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  INTERNAL_ERROR: 500,
};

export function json(body: unknown, requestId: string, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...COMMON_HEADERS, "content-type": "application/json; charset=utf-8", "x-request-id": requestId },
  });
}

/** An RFC 9457 problem response. `detail` and `errors` are fixed text, never echoed input or internals. */
export function problem(code: ProblemCode, requestId: string, options: { detail?: string; errors?: FieldError[]; headers?: Record<string, string> } = {}): Response {
  const body: Problem = {
    type: "about:blank",
    title: TITLES[code],
    status: STATUS[code],
    code,
    requestId,
    ...(options.detail ? { detail: options.detail } : {}),
    ...(options.errors?.length ? { errors: options.errors } : {}),
  };
  return new Response(JSON.stringify(body), {
    status: body.status,
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
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({ location, name: safeName(key), message: "is not a recognised parameter" }));
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

const DOMAIN_TO_PROBLEM: Partial<Record<DomainError["code"], ProblemCode>> = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  INVALID_INPUT: "VALIDATION_FAILED",
  PRODUCT_NOT_FOUND: "PRODUCT_NOT_FOUND",
  VARIANT_NOT_FOUND: "VARIANT_NOT_FOUND",
};

function toProblem(error: unknown, requestId: string): Response {
  if (error instanceof RequestValidationError) return problem("VALIDATION_FAILED", requestId, { errors: error.errors });
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
      const principal = assertPermission(await getBearerPrincipal(getAuth(), db, request.headers), permission);
      const body = await handler({ request, url: new URL(request.url), params: await context.params, db, principal });
      return json(body, requestId);
    } catch (error) {
      return toProblem(error, requestId);
    }
  };
}

/** Handlers for the methods an /api/v1 resource does not support. They never read the request body. */
export function methodNotAllowed(allow: string) {
  const handler = async () => problem("METHOD_NOT_ALLOWED", randomUUID(), { headers: { allow } });
  return { POST: handler, PUT: handler, PATCH: handler, DELETE: handler };
}
