# API guide (`/api/v1`)

**Status:** Draft — Founder Review
**Purpose:** How to call the versioned API that exists today, and the rules for changing it. Decisions and their reasons are in [ADR-0004](../adr/0004-api-v1-and-bearer-transport.md) (transport, limits, CORS) and [ADR-0005](../adr/0005-operation-idempotency.md) (idempotency).

The contract itself is `GET /api/v1/openapi.json` (OpenAPI 3.1, generated from `src/api/v1/`). This page does not repeat it.

## What exists

Owner-only endpoints for the draft catalogue and physical stock. There are no public endpoints, no order, reservation or selling endpoints, and nothing publishes a product.

| Endpoint | Permission | Does |
|---|---|---|
| `GET /api/v1/products` | `catalog:read` | Products, oldest first; `status`, `limit`, `cursor` |
| `POST /api/v1/products` | `catalog:write` | Create a draft product (201) |
| `GET /api/v1/products/{productId}` | `catalog:read` | One product with its variants |
| `POST /api/v1/products/{productId}/variants` | `catalog:write` | Add a variant (SKU) with a zero stock balance (201) |
| `POST /api/v1/products/{productId}/archive` | `catalog:write` | Archive a product (200); nothing is deleted |
| `POST /api/v1/variants/{variantId}/deactivate` | `catalog:write` | Mark a variant inactive (200); it keeps stock and history |
| `POST /api/v1/stock-receipts` | `stock:receive` | Add received units to a SKU (201); inactive SKUs included |
| `POST /api/v1/stock-adjustments` | `stock:adjust` | Change a SKU's stock up or down with a required reason (201); never below zero |
| `GET /api/v1/skus/{sku}/stock` | `stock:read` | On-hand stock of a SKU |
| `GET /api/v1/skus/{sku}/movements` | `stock:read` | The SKU's stock ledger, oldest first; `limit`, `cursor` |

The actor of every stock movement is the signed-in user. A request cannot name an actor, user or role; such fields are refused as unknown.

## Authentication

Every endpoint needs `Authorization: Bearer <token>`. Browser cookies are not accepted.

1. Sign in from a non-browser client (no `Origin`, cookie or `Sec-Fetch-*` headers):
   `POST /api/auth/sign-in/email` with JSON `{"email": "...", "password": "..."}`.
2. Read the token from the `set-auth-token` response header. (The `token` field in the JSON body is the unsigned value and does **not** work as a Bearer token.)
3. Send it on each call. Sign out with `POST /api/auth/sign-out` and the same header.

The token is a session: it expires with it, and sign-out, `revoke-session` or disabling the user ends it. Browsers never receive it. Keep it in the platform's secure storage, never in a URL or log.

## Writes

- **Idempotency-Key** (required on every POST): a new value per operation, 16 to 128 characters of `A-Z a-z 0-9 _ . : -` (a UUID fits), plain or in double quotes. Generate it before the first attempt and reuse it only to retry that same request.
  - Same key, same body: the operation runs once. A retry gets the first result, same status, with `Idempotent-Replayed: true`. This covers a lost response.
  - Same key, different body or endpoint: `422 IDEMPOTENCY_KEY_REUSED`; nothing runs.
  - A failed request (validation, conflict, server error) records nothing; the key can be retried.
  - Keys belong to the signed-in user: another user's identical key is a separate operation.
  - Records are kept; no key expires yet (retention is a pending founder decision).
- **Body:** JSON (`Content-Type: application/json`, UTF-8), at most 64 KiB. Unknown fields are errors. Archive and deactivate take no body or `{}`.
- **Money** is integer paisa (`pricePaisa`, 1 BDT = 100 paisa). **Times** are UTC, ISO 8601.

## Responses

- Success: `{"data": ...}`; lists add `"page": {"limit", "nextCursor"}`. Pass `nextCursor` as `cursor` until it is `null`. Cursors are opaque.
- Errors: `application/problem+json` with `status`, `code` (stable, listed in the document under `x-problem-codes`), `requestId` and sometimes `errors` (`location` = `query`, `path` or `body`; `name`; `message`). Branch on `code`, not on text. Values you sent are never echoed.

| Status | Codes |
|---|---|
| 400 | `VALIDATION_FAILED`, `MALFORMED_JSON`, `IDEMPOTENCY_KEY_REQUIRED` |
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN`, `ORIGIN_NOT_ALLOWED` |
| 404 | `PRODUCT_NOT_FOUND`, `VARIANT_NOT_FOUND`, `ROUTE_NOT_FOUND` |
| 405 | `METHOD_NOT_ALLOWED` |
| 409 | `SLUG_TAKEN`, `SKU_TAKEN`, `INSUFFICIENT_STOCK`, `STOCK_LIMIT_EXCEEDED` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 422 | `IDEMPOTENCY_KEY_REUSED` |
| 429 | `RATE_LIMITED` (with `Retry-After` in seconds) |
| 500 | `INTERNAL_ERROR` |

- Every response has `X-Request-Id` and `Cache-Control: no-store`.
- Checks run in this order: origin, authentication, rate limit, permission, then (writes) Idempotency-Key and body. An unauthenticated caller learns nothing about its input.

## Limits and browsers

- **Rate limits:** per signed-in user and one-minute window, separately for reads (default 300) and writes (default 60). Set with `API_RATE_LIMIT_READS_PER_MINUTE` and `API_RATE_LIMIT_WRITES_PER_MINUTE`; these are technical limits, not business policy. Requests without a valid token are rejected before counting, so they cannot use up a user's quota. Windows are fixed, so up to twice the limit can pass around a window boundary.
- **CORS:** none. No response carries `Access-Control-*` headers, a preflight (`OPTIONS`) is answered 405, and a request whose `Origin` is not the site's own origin is refused with `403 ORIGIN_NOT_ALLOWED`. Native clients send no `Origin` and are unaffected.

## Versioning and compatibility

Within `/api/v1`, only compatible changes are made:

- **Compatible:** a new endpoint; a new optional query parameter or body field; a new response field; a new problem code on an existing status; a new enum value only where the document says the list may grow.
- **Breaking (needs `/api/v2`):** removing or renaming an endpoint, parameter or field; changing a type, unit or meaning; making an optional input required; changing the order of a list; changing authentication.
- Clients must ignore response fields they do not know. The published schemas list today's fields exactly (`additionalProperties: false`) so tests catch accidental fields; each compatible addition updates the document and its `info.version` minor number.
- A new major version runs alongside the old one. The old one is retired only after its clients have moved; the timing is a founder decision.

Version 1.1.0 added the write endpoints, problem codes, the `body` error location, and the 403 `ORIGIN_NOT_ALLOWED` and 429 responses on the existing read endpoints. No client existed for 1.0.0. From now on, clients should be prepared for 429 on any endpoint and for new values of `errors[].location`.

## Testing

```
npm run test:contract   # OpenAPI validity, plus every endpoint against the document (needs TEST_DATABASE_URL)
```

`tests/api/openapi.test.ts` checks the document against the official OpenAPI 3.1 schema. `tests/db/api.integration.test.ts` (reads) and `tests/db/api-write.integration.test.ts` (writes, limits, origin policy) call each route handler against PostgreSQL and validate every response's status, content type and body against the document; the write test also checks that the documented operations are exactly the implemented ones.

## Not available yet

Public catalogue, orders, reservations, selling, returns, client SDKs and native apps. Retention of idempotency records. A per-client (IP) limit for unauthenticated traffic waits for the hosting and proxy decision.
