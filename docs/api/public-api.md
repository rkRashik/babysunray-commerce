# Customer-facing API (dormant)

**Status:** Draft — Founder Review
**Purpose:** The contract of the customer-facing endpoints a future storefront (web or app) will call, which of them are live, and what must happen before the others open.

The Owner API (`/api/v1`, Bearer, RFC 9457 problems) is described in [the API guide](README.md). This page covers what an anonymous customer uses. **Only guest tracking is live.** The catalogue, the quote and the checkout are built and tested as services and HTTP handlers, but **no route serves them**: the launch gate (`src/modules/launch/gate.ts`) is closed in this version, no product can be published (no publication rule, requirement I-6, is approved), and public checkout waits for published policies (S-17, G-7). Routing them is a founder-approved code change in a later gate.

## Status

| Use | Handler | Service | Routed |
|---|---|---|---|
| Track an order, cancel or ask to cancel | `src/api/track.ts` | `src/modules/orders/tracking.ts` | **Yes**: `POST /api/track`, `POST /api/track/cancel` |
| List and search products | `publicCatalogueResponse(request, { kind: "products" }, deps)` in `src/api/public-catalogue.ts` | `listPublicProducts` (`src/modules/storefront/public-catalogue.ts`) | No |
| One product | `{ kind: "product", slug }` | `getPublicProduct` | No |
| Filter options | `{ kind: "facets" }` | `publicFacets` | No |
| Price a cart | `{ kind: "quote" }` (POST) | `quotePublicCart` | No |
| Place an order | `guestCheckoutResponse` in `src/api/guest-checkout.ts` | `placeGuestOrder` (`src/modules/orders/guest-checkout.ts`) | No |
| Product photo | `publicMediaResponse(request, mediaId, { db, store, gate })` in `src/api/public-media.ts` | `findPublicPhoto` (`src/modules/media/public.ts`) | Yes, closed: `GET /api/public/media/{id}[?w=320]` answers `503` with no body until the launch gate opens (Gate H.49) |

The handlers take `deps = { db, baseUrl, gate }`. A route file must pass the real gate (`publicCheckoutGate`); the injectable gate exists for the tests, and a route that passed an open gate would be a reviewed code change, not a setting. With the real gate, the handlers answer `503 shop_closed` (catalogue) or `503 checkout_closed` (checkout) before any database work. The tests pass an open gate to prove the behaviour behind it.

## Common rules

- **Format.** JSON (UTF-8). Success: `{ "data": ... }`, lists add `page`. Failure: `{ "error": "<stable code>", "message": "<fixed text>" }`, sometimes `errors` (field names and codes only). Input is never echoed. Branch on `error`, never on `message`. This differs on purpose from the Owner API's RFC 9457 problems; the live tracking endpoints already use it.
- **Headers.** Every answer has `X-Request-Id` (quote it when reporting a problem), `Cache-Control: no-store` (a caching policy needs hosting), `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. There is no CORS: a request from another origin is refused (`403 forbidden`), so the storefront must be served from the same origin as the API.
- **Money** is integer paisa (1 BDT = 100 paisa). **Language:** text comes as `{ "en": ..., "bn": ... }`, either side may be `null`; nothing is translated.
- **Visibility.** Only active SKUs of **published** products exist for customers (`src/modules/catalogue/visibility.ts`). An unknown, draft, withdrawn or archived product, and an inactive SKU, all get the same answer, so the API reveals nothing about products a customer cannot see.

## Catalogue (GET, not routed)

| Resource | Query | Answer `data` |
|---|---|---|
| products | `q` (≤ 100 characters), `category` (slug), `size`, `colour` (≤ 64), `inStock=true`, `page` (1–100) | `[{ slug, name, featured, pricePaisa: { min, max }, stock: "in" \| "partial" \| "out", photo }]`, featured first, then newest; `page: { number, hasMore, maxPage }`, 24 per page |
| product (by slug) | none | `{ slug, name, description, category, fabric, care, sizeGuidance, measurements: [{ size, point, valueMm }], photos: [{ id, width, height, alt }], variants: [{ sku, size, colour, pricePaisa, inStock }], deliveryZones: [{ code, chargePaisa }] }`, or `404 not_found` |
| facets | none | `{ categories: [{ slug, name }], sizes, colours }`: only what published products have |

Unknown or repeated parameters are refused (`400 bad_request`). `fabric` is `null` until the Owner confirmed the statement (S-11). Stock is shown only as in or out of stock. A client can still infer how many units are available by quoting larger quantities (any "is this quantity available" check allows that); whether that matters, and whether customers may see exact quantities, is a business decision. `deliveryZones` lists only zones with an active Owner-set charge. Photos are metadata only: **no public image URL exists**. The photo transport (`GET` a photo by id, optional `?w=320|640|1280`) is built and tested but not routed; it serves only photos of published products, answers `503` while the gate is closed, and the same refusal for unknown, draft and withdrawn photos. Storage and caching depend on hosting (decision 14; [infrastructure.md](../operations/infrastructure.md)).

## Quote (POST, not routed)

Body (≤ 8 KiB): `{ "lines": [{ "sku": "...", "quantity": 1 }], "zone": "dhaka_city" | "outside_dhaka" | null }`, at most 20 lines, quantity 1–1,000, SKUs case-insensitive.

Answer: `{ lines: [{ sku, quantity, status: "ok" | "insufficient" | "unavailable", unitPricePaisa, lineTotalPaisa, productSlug, name, size, colour }], subtotalPaisa, deliveryZone, deliveryChargePaisa, totalPaisa, ready }`. Unavailable lines carry no name or price. `ready` is true only when every line is `ok` and the zone has a charge. A quote holds nothing and promises nothing: stock is held only when an order is placed, and the checkout refuses the order if anything shown changed.

## Checkout (POST, not routed)

Contract: [launch-readiness.md](../operations/launch-readiness.md), section 5, and [ADR-0007](../adr/0007-guest-checkout-foundation.md). In short:

1. Generate an `Idempotency-Key` (32–128 characters, a UUID fits) once per checkout and keep it until you have an answer.
2. Send the customer's details, the zone, and for each line the `sku`, `quantity` and the `unitPricePaisa` from the quote, plus `deliveryChargePaisa` and `totalPaisa` as shown.
3. `201`: the order was received (Pending Verification, never "confirmed"); `data.trackingToken` is the only copy of the customer's tracking credential. Show the link `https://<site>/track#t=<token>` once with a copy button; never put the token in a URL query, log or analytics.
4. On a timeout, retry with the **same key and body**: `200` with `Idempotent-Replayed: true` is the same order, without the token (only its digest is stored; the Owner can issue a new link).
5. `409 quote_changed`: re-quote and show the new amounts; `409 out_of_stock` or `unavailable`: adjust the cart; `429 rate_limited`: wait (`Retry-After: 60`); `503 checkout_closed`: ordering online is not open; `500`: the order was **not** recorded, offer the shop's contact route (S-12).

## Tracking (live)

`POST /api/track` with `{ "token": "..." }` returns the masked order view; `POST /api/track/cancel` with `{ "token", "action": "cancel" | "request", "reason"? }`. The token travels only in a same-origin POST body. Read it from the link's fragment, remove it from the address bar, keep it in memory only (`src/app/track/track-view.tsx` does this). Limits and messages: [order policy](../product/order-policy-decisions.md), section 3.

## Abuse limits

No client address is trusted until hosting provides a trusted proxy (decision 1). What the application does on its own:

| Threat | Control |
|---|---|
| Guessing tracking links | 256-bit random tokens; unknown tokens share a 30-per-minute global limit; each live link has its own 30 per minute |
| Holding all stock with anonymous orders | At most 20 guest checkout submissions per minute from everyone together (`GUEST_CHECKOUTS_PER_MINUTE`), counted only for well-formed requests; every order still waits for the Owner's verification and expires after 24 hours (rule D) |
| Large bodies | Bytes counted while streaming: tracking 2 KiB, quote 8 KiB, checkout 64 KiB |
| Expensive searches | Search text ≤ 100 characters, bound as a parameter; at most page 100 of 24; a quote at most 20 lines |
| Flooding the database with anonymous requests | A **bulkhead** per application process (`src/modules/rate-limit/bulkhead.ts`, Gate H.40): at most 4 anonymous reads (tracking, catalogue, quote) and, separately, 2 checkout submissions use the database at once; up to 16 (checkout 8) wait at most 2 s; the rest get `503 busy` with `Retry-After: 1` at once. Invalid input is refused before it takes a slot. Better Auth's `/api/auth` endpoints, which do database work for every request including refused ones, have their own bulkhead of 2. All three together use at most 8 of the pool's 10 connections, so the Office's pages and the Owner API keep working whatever anonymous traffic does |
| Finding orders by number or phone | Not possible: an order is reachable only by its random token |
| Exhausting database connections | The bulkhead above; a request waits at most 10 s for a connection; PostgreSQL cancels a statement after 60 s ([runbook](../operations/runbook.md), section 4) |

**Per-process, not global:** in a serverless host each instance has its own bulkheads, sized from `DATABASE_POOL_MAX`, so they protect the database but do not limit the whole shop ([infrastructure.md](../operations/infrastructure.md), section 5).

**Not covered without hosting:** a per-client limit. Without a trusted client address, one client can fill the anonymous slots or use up the storewide checkout minute, and other customers then get `503 busy` or `429` until it stops; the Owner and the database are protected, other customers are not. Also missing: bot detection and flood protection in front of the application. No limit is per-minute storewide for reads, on purpose: one visitor could otherwise lock every customer out for the rest of the minute. All of these need the hosting decision and must exist before checkout opens (launch gate blocker `abuse_protection`).

## Before any of this opens

The founder decisions listed in [backend-completeness.md](../architecture/backend-completeness.md): a publication rule (I-6), published policies (S-17, G-7), hosting with a trusted proxy and per-client limits (decision 1), image serving (decision 14), then a gate that adds the route files and tests them end to end.
