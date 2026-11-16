# API guide (`/api/v1`)

**Status:** Draft — Founder Review
**Purpose:** How to call the versioned API that exists today, and the rules for changing it. Decisions and their reasons are in [ADR-0004](../adr/0004-api-v1-and-bearer-transport.md) (transport, limits, CORS) and [ADR-0005](../adr/0005-operation-idempotency.md) (idempotency).

The contract itself is `GET /api/v1/openapi.json` (OpenAPI 3.1, generated from `src/api/v1/`). This page does not repeat it.

## What exists

Owner-only endpoints for the draft catalogue, physical stock and internal (Owner-assisted) orders. There are no public endpoints and no checkout, and nothing publishes a product.

| Endpoint | Permission | Does |
|---|---|---|
| `GET /api/v1/products` | `catalog:read` | Products, oldest first; `q` (search), `status`, `limit`, `cursor` |
| `POST /api/v1/products` | `catalog:write` | Create a draft product (201) |
| `GET /api/v1/products/{productId}` | `catalog:read` | One product with its variants |
| `PATCH /api/v1/products/{productId}` | `catalog:write` | Edit a draft product's names and descriptions (200) |
| `PATCH /api/v1/variants/{variantId}` | `catalog:write` | Edit an active variant's size, colour and price (200) |
| `POST /api/v1/products/{productId}/variants` | `catalog:write` | Add a variant (SKU) with a zero stock balance (201) |
| `POST /api/v1/products/{productId}/archive` | `catalog:write` | Archive a product (200); nothing is deleted |
| `POST /api/v1/variants/{variantId}/deactivate` | `catalog:write` | Mark a variant inactive (200); it keeps stock and history |
| `POST /api/v1/stock-receipts` | `stock:receive` | Add received units to a SKU (201); inactive SKUs included |
| `POST /api/v1/stock-adjustments` | `stock:adjust` | Change a SKU's stock up or down with a required reason (201); never below zero |
| `GET /api/v1/skus/{sku}/stock` | `stock:read` | On-hand stock of a SKU |
| `GET /api/v1/skus/{sku}/movements` | `stock:read` | The SKU's stock ledger, oldest first; `limit`, `cursor` |
| `GET /api/v1/orders`, `GET /api/v1/orders/{orderId}` | `orders:read` | Orders newest first (`status`, `attention`, `number`, `limit`, `cursor`); one order with items, holds, history, requests, returns, quarantine and money |
| `POST /api/v1/orders` | `orders:write` | Owner-assisted order (201): reserves every line or creates nothing |
| `POST /api/v1/orders/{orderId}/transitions` | `orders:write` | `confirm`, `pack`, `dispatch`, `deliver`, `mark_rto`, `receive_rto`, `cancel`, `close` |
| `POST /api/v1/orders/{orderId}/cancellation-review` | `orders:write` | Approve or reject a customer's cancellation request |
| `POST /api/v1/orders/{orderId}/payments`, `.../rto-charge` | `payments:record` | Courier collection or settlement (201); the actual RTO charge |
| `POST /api/v1/orders/{orderId}/returns`, `.../returns/{returnId}/steps` | `orders:write` (refund step: `payments:record`) | Open a return or exchange (201); receive, approve, reject, refund, complete |
| `POST /api/v1/orders/{orderId}/inspections/{quarantineItemId}` | `stock:receive` | Restock (once) or reject a returned or RTO item |
| `POST /api/v1/orders/{orderId}/tracking-link`, `.../tracking-link/revoke` | `orders:write` | New guest tracking link (201; token shown once); revoke it |
| `GET /api/v1/delivery-zones`, `PUT /api/v1/delivery-zones/{code}` | `orders:read` / `settings:write` | Configured zones; set a zone's charge and active flag |

The actor of every stock movement is the signed-in user. A request cannot name an actor, user or role; such fields are refused as unknown.

## Authentication

Every endpoint needs `Authorization: Bearer <token>`. Browser cookies are not accepted.

1. Sign in from a non-browser client (no `Origin`, cookie or `Sec-Fetch-*` headers):
   `POST /api/auth/sign-in/email` with JSON `{"email": "...", "password": "..."}`.
2. Read the token from the `set-auth-token` response header. (The `token` field in the JSON body is the unsigned value and does **not** work as a Bearer token.)
3. Send it on each call. Sign out with `POST /api/auth/sign-out` and the same header.

Do not keep cookies from the sign-in response (turn off the HTTP library's cookie jar). A request that carries the session cookie is treated as a browser request by Better Auth, and `POST /api/auth/sign-out` then answers 403 without the site's `Origin` (seen in the HTTP smoke test, `tests/e2e/api-smoke.spec.ts`). `/api/v1` itself ignores cookies.

The token is a session: it expires with it, and sign-out, `revoke-session` or disabling the user ends it. Browsers never receive it. Keep it in the platform's secure storage, never in a URL or log.

## Writes

- **Idempotency-Key** (required on every POST and PATCH): a new value per operation, 16 to 128 characters of `A-Z a-z 0-9 _ . : -` (a UUID fits), plain or in double quotes. Generate it before the first attempt and reuse it only to retry that same request.
  - Same key, same body: the operation runs once. A retry gets the first result, same status, with `Idempotent-Replayed: true`. This covers a lost response.
  - Same key, different body or endpoint: `422 IDEMPOTENCY_KEY_REUSED`; nothing runs.
  - A failed request (validation, conflict, server error) records nothing; the key can be retried.
  - Keys belong to the signed-in user: another user's identical key is a separate operation.
  - Records are kept; no key expires yet (retention is a pending founder decision).
- **Body:** JSON (`Content-Type: application/json`, UTF-8), at most 64 KiB. Unknown fields are errors. Archive and deactivate take no body or `{}`.
- **Money** is integer paisa (`pricePaisa`, 1 BDT = 100 paisa). **Times** are UTC, ISO 8601.

## Editing (PATCH)

- Products and variants carry a `version` (a whole number that grows with every change, including archive and deactivate). An edit sends the `version` it last read; if the row changed since, nothing is saved and the answer is `409 VERSION_CONFLICT`: read it again, check the values and retry with a new key. Of two edits based on the same version, exactly one wins.
- Partial update: a field left out keeps its value; `null` or `""` clears an optional text. A product must keep at least one name.
- A product can be edited only while it is a draft (`409 PRODUCT_NOT_EDITABLE` once archived; archiving is never undone here). A variant can be edited only while it is active and its product is a draft (`409 VARIANT_NOT_EDITABLE`).
- Never changed by an edit: ids, slug, SKU, status and stock. Those fields are refused as unknown.
- A retried edit with the same key and body returns the first result and does not edit again, even if the version has moved on since.

## Search

`GET /api/v1/products?q=...` finds products whose slug, English name, Bangla name or any SKU contains the text, ignoring case. The text is Unicode NFC-normalised (Bangla typed with separate vowel signs matches the same text stored precomposed), trimmed and its inner spaces collapsed; an empty `q` means no search. `%`, `_` and `\` match themselves, and the value is always a bound query parameter. At most 100 characters; control characters are refused (400). It combines with `status`, and `cursor` pages through the matches in the same order as the full list. Without an index the search reads every product row, which suits a small catalogue; an index (for example trigram) would need a reviewed migration once the catalogue grows.

## Responses

- Success: `{"data": ...}`; lists add `"page": {"limit", "nextCursor"}`. Pass `nextCursor` as `cursor` until it is `null`. Cursors are opaque.
- Errors: `application/problem+json` with `status`, `code` (stable, listed in the document under `x-problem-codes`), `requestId` and sometimes `errors` (`location` = `query`, `path` or `body`; `name`; `message`). Branch on `code`, not on text. Values you sent are never echoed.

| Status | Codes |
|---|---|
| 400 | `VALIDATION_FAILED`, `MALFORMED_JSON`, `IDEMPOTENCY_KEY_REQUIRED` |
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN`, `ORIGIN_NOT_ALLOWED` |
| 404 | `PRODUCT_NOT_FOUND`, `VARIANT_NOT_FOUND`, `ORDER_NOT_FOUND`, `RETURN_NOT_FOUND`, `QUARANTINE_ITEM_NOT_FOUND`, `ROUTE_NOT_FOUND` |
| 405 | `METHOD_NOT_ALLOWED` |
| 409 | `SLUG_TAKEN`, `SKU_TAKEN`, `INSUFFICIENT_STOCK`, `STOCK_LIMIT_EXCEEDED`, `VERSION_CONFLICT`, `PRODUCT_NOT_EDITABLE`, `VARIANT_NOT_EDITABLE`, `INVALID_TRANSITION`, `DELIVERY_ZONE_UNAVAILABLE`, `VARIANT_NOT_ORDERABLE`, `PAYMENT_LIMIT_EXCEEDED` |
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

## Orders

Rules: [order-policy-decisions.md](../product/order-policy-decisions.md) (founder-approved rules, the transition table and the engineering defaults).

- Every order change sends the order `version` it last read; a stale one gets `409 VERSION_CONFLICT`, so a stale screen never overrides a newer transition. Every change runs once per `Idempotency-Key`.
- `POST /orders` accepts no price or total: the server computes them and snapshots the zone's configured delivery charge. Every line is reserved, or nothing is created (`INSUFFICIENT_STOCK`, `DELIVERY_ZONE_UNAVAILABLE`, `VARIANT_NOT_ORDERABLE`). Only assisted sources (`messenger`, `whatsapp`, `other`) are accepted.
- `GET /skus/{sku}/stock` returns `onHand`, `reserved` and `available`.
- Money (payments, refunds) is integer paisa and never exceeds the expected COD (collection), the collected amount (settlement, refunds) or the returned goods' value (refunds).
- The tracking-link token is in the creation answer only (`token: null` on a replay). Build the link as `https://<site>/track#t=<token>`: the fragment is never sent to a server. Treat the token as a credential; it is the customer's only key to the order.
- Customer contact details appear in Owner responses but are never searchable, so they never travel in a URL.

## Versioning and compatibility

Within `/api/v1`, only compatible changes are made:

- **Compatible:** a new endpoint; a new optional query parameter or body field; a new response field; a new problem code on an existing status; a new enum value only where the document says the list may grow.
- **Breaking (needs `/api/v2`):** removing or renaming an endpoint, parameter or field; changing a type, unit or meaning; making an optional input required; changing the order of a list; changing authentication.
- Clients must ignore response fields they do not know. The published schemas list today's fields exactly (`additionalProperties: false`) so tests catch accidental fields; each compatible addition updates the document and its `info.version` minor number.
- A new major version runs alongside the old one. The old one is retired only after its clients have moved; the timing is a founder decision.

Version 1.1.0 added the write endpoints, problem codes, the `body` error location, and the 403 `ORIGIN_NOT_ALLOWED` and 429 responses on the existing read endpoints. No client existed for 1.0.0. From now on, clients should be prepared for 429 on any endpoint and for new values of `errors[].location`.

Version 1.2.0 (compatible) added `PATCH /products/{productId}`, `PATCH /variants/{variantId}`, the optional `q` search parameter, the `version` field on products and variants, and the 409 codes `VERSION_CONFLICT`, `PRODUCT_NOT_EDITABLE` and `VARIANT_NOT_EDITABLE`.

Version 1.4.0 added product content: `category`, `fabric` (with `confirmedAt`), `care`, `sizeGuidance`, `featured`, `measurements` and `photos` (metadata only) on the product, the same content fields in `PATCH /products/{productId}`, `PUT /products/{productId}/measurements`, `GET /products/{productId}/readiness` (advisory; it publishes nothing), `GET` and `POST /categories`, and the problem code `CATEGORY_NOT_FOUND`. Only fields were added; no field was removed or changed. Photo upload and viewing are Owner Office only.

Version 1.3.0 added the order and delivery-zone endpoints, `reserved` and `available` on stock levels, the movement types `dispatch` and `return_restock` (the movement `type` list is now documented as one that may grow), and the problem codes `ORDER_NOT_FOUND`, `RETURN_NOT_FOUND`, `QUARANTINE_ITEM_NOT_FOUND`, `INVALID_TRANSITION`, `DELIVERY_ZONE_UNAVAILABLE`, `VARIANT_NOT_ORDERABLE` and `PAYMENT_LIMIT_EXCEEDED`. The new movement types are a change a strict 1.2.0 client would notice; no such client exists.

## Testing

```
npm run test:contract   # OpenAPI validity, plus every endpoint against the document (needs TEST_DATABASE_URL)
```

`tests/api/openapi.test.ts` checks the document against the official OpenAPI 3.1 schema. `tests/db/api.integration.test.ts` (reads) and `tests/db/api-write.integration.test.ts` (writes, limits, origin policy) call each route handler against PostgreSQL and validate every response's status, content type and body against the document; the write test also checks that the documented operations are exactly the implemented ones.

## Not available yet

Public catalogue, public checkout and website orders, online payments, courier integrations, client SDKs and native apps. Retention of idempotency records. A per-client (IP) limit for unauthenticated traffic waits for the hosting and proxy decision.

Prepared but not routed (Gate H.25): a guest checkout transport (`src/api/guest-checkout.ts`) outside `/api/v1`, with its own JSON errors, an `Idempotency-Key` of 32 to 128 characters and the launch gate checked first. No route file uses it, so it is not part of this API or its OpenAPI document; its contract is in [launch-readiness.md](../operations/launch-readiness.md) section 5. Policy drafts, product reviews and launch readiness are Owner Office features only; their operations are shared services ready for `/api/v1` endpoints in a later gate.
