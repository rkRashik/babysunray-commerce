# API guide (`/api/v1`)

**Status:** Draft — Founder Review
**Purpose:** How to call the versioned API that exists today, and the rules for changing it. Decisions and their reasons are in [ADR-0004](../adr/0004-api-v1-and-bearer-transport.md).

The contract itself is `GET /api/v1/openapi.json` (OpenAPI 3.1, generated from `src/api/v1/`). This page does not repeat it.

## What exists

Read-only, Owner-only endpoints. There are no write endpoints, no public endpoints and no order endpoints.

| Endpoint | Permission | Returns |
|---|---|---|
| `GET /api/v1/products` | `catalog:read` | Products, oldest first; `status`, `limit`, `cursor` |
| `GET /api/v1/products/{productId}` | `catalog:read` | One product with its variants |
| `GET /api/v1/skus/{sku}/stock` | `stock:read` | On-hand stock of a SKU |
| `GET /api/v1/skus/{sku}/movements` | `stock:read` | The SKU's stock ledger, oldest first; `limit`, `cursor` |

## Authentication

Every endpoint needs `Authorization: Bearer <token>`. Browser cookies are not accepted.

1. Sign in from a non-browser client (no `Origin`, cookie or `Sec-Fetch-*` headers):
   `POST /api/auth/sign-in/email` with JSON `{"email": "...", "password": "..."}`.
2. Read the token from the `set-auth-token` response header. (The `token` field in the JSON body is the unsigned value and does **not** work as a Bearer token.)
3. Send it on each call. Sign out with `POST /api/auth/sign-out` and the same header.

The token is a session: it expires with it, and sign-out, `revoke-session` or disabling the user ends it. Browsers never receive it. Keep it in the platform's secure storage, never in a URL or log.

## Responses

- Success: `{"data": ...}`; lists add `"page": {"limit", "nextCursor"}`. Pass `nextCursor` as `cursor` until it is `null`. Cursors are opaque.
- Errors: `application/problem+json` with `status`, `code` (stable, listed in the document under `x-problem-codes`), `requestId` and sometimes `errors` (`location`, `name`, `message`). Branch on `code`, not on text.
- Every response has `X-Request-Id` and `Cache-Control: no-store`.
- Money is integer paisa; times are UTC ISO 8601.

## Versioning and compatibility

Within `/api/v1`, only compatible changes are made:

- **Compatible:** a new endpoint; a new optional query parameter; a new response field; a new problem code on an existing status; a new enum value only where the document says the list may grow.
- **Breaking (needs `/api/v2`):** removing or renaming an endpoint, parameter or field; changing a type, unit or meaning; making an optional input required; changing the order of a list; changing authentication.
- Clients must ignore response fields they do not know. The published schemas list today's fields exactly (`additionalProperties: false`) so tests catch accidental fields; each compatible addition updates the document and its `info.version` minor number.
- A new major version runs alongside the old one. The old one is retired only after its clients have moved; the timing is a founder decision.

## Testing

```
npm run test:contract   # OpenAPI validity, plus every endpoint against the document (needs TEST_DATABASE_URL)
```

`tests/api/openapi.test.ts` checks the document against the official OpenAPI 3.1 schema. `tests/db/api.integration.test.ts` calls each route handler against PostgreSQL and validates every response's status, content type and body against the document.

## Not available yet

Write endpoints (stock writes wait for idempotency), CORS, API rate limiting, public catalogue, orders, client SDKs and native apps.
