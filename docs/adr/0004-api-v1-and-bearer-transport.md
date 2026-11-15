# ADR-0004: Versioned API foundation and Bearer transport

**Status:** Draft — Founder Review
**Date:** 2026-11-15
**Deciders:** Founder
**Related:** [ADR-0001](0001-application-stack.md) (item 7), [ADR-0003](0003-authentication-foundation.md), [API guide](../api/README.md), [Product requirements](../product/requirements.md) (API-1 to API-12, open decision 17)

**In short:** The founder approved the versioned REST direction (`/api/v1`, OpenAPI) in Gate H.2 and authorised, in batch H.2a + H.3 (2026-11-15), Better Auth's Bearer plugin for Owner-only read endpoints if it could be shown safe. This ADR records what was built: four read-only endpoints, a Bearer-only API transport kept strictly apart from the browser cookie, and the contract tooling. Batch H.4–H.6 (2026-11-15) added Owner-only write endpoints for stock and the draft catalogue, request-body limits, a no-CORS origin policy and per-user rate limits (section "Writes and limits"); idempotency is in [ADR-0005](0005-operation-idempotency.md). Batch H.7–H.9 added `PATCH` edits of draft products and active variants with optimistic versions, and Owner product search (API guide, Editing and Search). Native apps are **not** built.

## Context

API-2 to API-12 ask for a versioned API over the same domain services, with server-side authorisation, one error format and an OpenAPI description. API-10 allows browser and native clients to use different credentials. Browser cookies are the wrong credential for an API: a browser attaches them automatically, which brings CSRF into every endpoint. Better Auth's Bearer plugin is the library's own mechanism for non-cookie clients, but its defaults needed checking before use (below).

## Decision

| Area | Decision |
|---|---|
| Transport | `/api/v1` accepts only `Authorization: Bearer <token>`. `getBearerPrincipal` passes nothing but that header to Better Auth; cookies on the request are ignored, so a browser session never authenticates an API call. `getPrincipal` (browser code) passes nothing but the cookie, so a Bearer token never authenticates browser code. |
| Token | Better Auth's Bearer plugin (`better-auth/plugins`, same 1.7.25 package) with **`requireSignature: true`**. The token is the signed session token (`<token>.<HMAC>`), so it is the session: same table, same expiry, revoked by sign-out, `revoke-session`, or losing access. No new token type, no JWT. |
| Issuing | A non-browser client signs in at `POST /api/auth/sign-in/email` and reads the `set-auth-token` response header. A small project plugin (`browser-token-guard` in `src/modules/auth/auth.ts`), placed after the Bearer plugin, removes that header from any request carrying a cookie, an `Origin` or a `Sec-Fetch-*` header, which browsers always send and scripts cannot remove. |
| Why those two settings | Two library behaviours were found while reviewing the source (Gate H.2a audit). (1) With the default `requireSignature: false`, the plugin re-signs a raw token on the server, and the raw token is returned in the JSON of sign-in, `get-session` and `list-sessions`. Any script on the page could turn it into a credential. (2) The plugin adds `set-auth-token` to every response that sets the session cookie, including a browser's daily session refresh. Without the guard, page scripts could read a long-lived credential that the HttpOnly cookie is meant to hide. Both are covered by tests that fail when either setting is removed. |
| Routes | Next.js Route Handlers under `src/app/api/v1/`, Node.js runtime, dynamic. Each is a few lines: a permission, input schemas, a domain service call, a DTO mapper. HTTP plumbing (problem responses, validation, request ids, headers) is in `src/api/v1/http.ts`. |
| Endpoints | `GET /products`, `GET /products/{productId}` (`catalog:read`); `GET /skus/{sku}/stock`, `GET /skus/{sku}/movements` (`stock:read`). Owner-only; nothing public, because publication rules (I-6) are open. |
| Validation | `zod` 4.6.7 (pinned; already present through Better Auth). Query objects are strict (unknown parameters are errors), repeated parameters are errors, values are bounded. Error entries name the parameter and use fixed messages; values are never echoed. |
| Errors | RFC 9457 `application/problem+json` with a stable `code`, `requestId` (also `X-Request-Id`), optional fixed `detail` and field `errors`. Unexpected errors return a generic 500 and log only the request id, error name and SQLSTATE (Drizzle messages contain query parameters). |
| Pagination | Keyset with opaque cursors. Products: `(created_at, id)`, with the timestamp carried at PostgreSQL's microsecond precision; movements: the identity id. `limit` 1–100, default 25. |
| Caching | `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` on every response. |
| OpenAPI | 3.1, served at `/api/v1/openapi.json` (public; no data). Component schemas are generated from the same zod schemas the handlers use (`z.toJSONSchema`, a dedicated registry); paths are written out. Tests validate the document against the official OAS 3.1 schema (`@seriousme/openapi-schema-validator` 2.11.0, dev only) and every real response in the integration tests against it (`ajv` 8.20.0 and `ajv-formats` 3.0.1, dev only). |
| Versioning | `/api/v1` changes only compatibly; see the [API guide](../api/README.md). |

## Writes and limits (batch H.4–H.6)

The Bearer integration was reviewed again before writes were exposed (browser token leakage, cookie and Bearer separation, revoked and disabled sessions, origin and CSRF, forged principals and actors, role spoofing, cross-user replay). No critical or high issue was found; the existing tests for each were kept and write-path tests added.

| Area | Decision |
|---|---|
| Endpoints | `POST /products`, `/products/{productId}/variants`, `/products/{productId}/archive`, `/variants/{variantId}/deactivate` (`catalog:write`); `POST /stock-receipts` (`stock:receive`), `/stock-adjustments` (`stock:adjust`). Each calls a shared operation in `src/modules/*/operations.ts`, the same one the Owner Office uses; no SQL in routes. |
| Wrapper | `apiPost` next to `apiGet` in `src/api/v1/http.ts`, one pipeline: origin policy → Bearer principal → rate limit → permission → `Idempotency-Key` → body. |
| Bodies | At most 64 KiB, checked against `Content-Length` before reading and counted while streaming (a missing or false length does not help). `application/json` with UTF-8 only (415 otherwise); malformed JSON or invalid UTF-8 is 400 `MALFORMED_JSON`; strict zod schemas (unknown fields, also nested, are 400). |
| Actor | Always `actorFor(principal)` of the Bearer token's user; the body cannot carry an actor, user id or role. |
| CORS | No CORS: no `Access-Control-*` header on any response, `OPTIONS` answered 405, and a request with an `Origin` other than `BETTER_AUTH_URL` refused (403 `ORIGIN_NOT_ALLOWED`) on reads and writes. No wildcard, no allow-list. |
| Rate limits | PostgreSQL table `api_rate_limits` (migration `0006`): one fixed one-minute window per user and category (`read`, `write`), counted by one atomic upsert after authentication. Defaults 300 reads and 60 writes per minute, configurable by environment (`src/modules/rate-limit/service.ts`). 429 with `Retry-After`. No client IP or forwarded header is used. |
| Contract | OpenAPI `info.version` 1.3.0 (1.3.0 added the Owner order, COD, return, RTO, tracking-link and delivery-zone endpoints in Gate H.10–H.12; 1.1.0 for batch H.4–H.6; 1.2.0 added draft editing with PATCH and an optional `version` check, and product search with `q`, in batch H.7–H.9). Writes document the `Idempotency-Key` parameter, request schemas, `Idempotent-Replayed` header and 400, 401, 403, 404, 405, 409, 413, 415, 422, 429 and 500 as implemented; reads gained 403 `ORIGIN_NOT_ALLOWED` and 429. A test checks that the documented operations are exactly the implemented ones. |

## Consequences

- Unauthenticated requests are not rate limited by `/api/v1` (they cost one session lookup each and are refused). Limiting them needs a trusted client address, which waits for the hosting and proxy decision.
- Each API request writes its user's counter row, one small write per request.
- A native client holds a session credential that lasts as long as a browser session (7 days, extended while in use) and must store it in the platform's secure storage. Nothing here stores it; no app exists.
- The Bearer plugin also lets that client call Better Auth's own endpoints with the token (sign-out, revoke-session). That is intended. CSRF does not apply: a browser never attaches an Authorization header on its own, and no CORS policy allows cross-origin calls.
- Better Auth's limiter covers sign-in, where credentials are guessed; `/api/v1` has its own per-user limit (above). Unsupported methods answer 405 with a problem body and never read the body.

## Not decided or not built

- Orders, reservations, selling, checkout, public catalogue.
- Native apps, token storage guidance per platform, a separate token lifetime for native clients, refresh-token rotation.
- A per-client limit for unauthenticated traffic (hosting), and client SDK generation.

## Alternatives considered

- Accept the browser cookie on `/api/v1` as well: rejected; it brings CSRF into the API and mixes the two credentials.
- Read the token from the `Set-Cookie` header in native clients and verify it in project code: same result as the plugin, but a hand-written path; rejected in favour of the supported plugin.
- A project-issued JWT or API key: rejected (no custom protocol; revocation would need its own store).
