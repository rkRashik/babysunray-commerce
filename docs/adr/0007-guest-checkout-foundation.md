# ADR-0007: Guest checkout foundation (inactive)

**Status:** Draft — Founder Review
**Date:** 2026-11-16
**Deciders:** Founder
**Related:** [Product requirements](../product/requirements.md) (S-3, S-4, S-7, S-8, S-9, S-12, S-17, O-3, G-1, G-2, G-7), [order policy](../product/order-policy-decisions.md), [ADR-0005](0005-operation-idempotency.md), [launch readiness](../operations/launch-readiness.md)

**Update (19 Nov 2026):** the service is now routed at `POST /api/shop/checkout`, but only for founder acceptance on the staging database; the public launch gate is unchanged ([ADR-0011](0011-founder-acceptance-and-customer-sign-in.md)).

**In short:** Batch H.25–H.28 authorised a guest checkout backend that is built and tested but **not reachable**. An anonymous customer's order goes through the same order domain as an Owner-assisted one, with its own idempotency record, a customer audit actor and a tracking link delivered once. No route, page or Server Action calls it; public checkout stays disabled until S-17 and G-7 are met (`src/modules/launch/gate.ts`).

## Context

The Owner-assisted order operations require a verified Owner principal and record the Owner as actor; their idempotency records are keyed by the user id (ADR-0005). A customer has neither. Reusing the Owner's identity for guests would make every guest order look like the Owner's and would let a public request act with Owner permissions.

## Decision

| Area | Decision |
|---|---|
| Layers | 1. Shared domain: `submitOrder` (`src/modules/orders/service.ts`) unchanged in its rules, now accepting a customer actor. 2. Owner-assisted: `submitOrderOnce` (unchanged). 3. Guest application service: `placeGuestOrder` (`src/modules/orders/guest-checkout.ts`). 4. Public transport: `guestCheckoutResponse` (`src/api/guest-checkout.ts`), with no route file. |
| Actor | The order's events name `actor_type = 'customer'`, `actor_ref = 'guest-checkout'`; `created_by_user_id` stays empty. The service imports nothing from the authentication module and the Owner operations (a unit test reads its imports), so it cannot obtain a principal or a user actor. The request schema is strict: an `actor`, `role`, user id or `source` field is refused, and the source is always `website`. Historical rows are unchanged; the existing `customer` actor type and its check constraint already allow this. |
| Idempotency | Table `guest_checkout_submissions` (migration 0013): primary key = SHA-256 of a client-generated key (32 to 128 characters of `A-Z a-z 0-9 _ -`; a UUID fits), `request_mac` = HMAC-SHA256 of the canonical, normalised request keyed by that same key, and the order id. No plaintext name, phone or address, and nothing a reader of the table could test guesses against without the key. Claimed by `INSERT ... ON CONFLICT DO NOTHING` in the transaction that creates the order, exactly like `runOnce`: a concurrent same-key request waits, then replays; a failure rolls the claim back. A trigger refuses any change except naming the order once, and every delete. |
| Prices | The request carries the unit prices, delivery charge and total the customer was shown. The server computes them itself (`submitOrder`); any difference refuses the order with `QUOTE_CHANGED` and nothing is created. |
| Products | Only active SKUs of published products can be ordered (`src/modules/catalogue/visibility.ts`, since Gate H.32; until then a current internal review was enough); the products are locked `FOR SHARE` meanwhile. Unknown and unpublished SKUs are refused alike. Nothing can be published while no publication rule (I-6) is approved, so today no SKU qualifies. |
| Tracking link | Created in the same transaction (`createTrackingLink`, unchanged model: 256 random bits, digest only) and returned in the first answer only. A replay creates no link (which would revoke the first) and returns `trackingToken: null`. |
| Lost first answer | The plaintext token cannot be shown again: only its digest exists. The replay still tells the customer the order was received (reference, items, totals). Recovery: the Owner verifies every order by hand (rule B) and can issue a new link in the Office, which revokes any earlier one. Considered and rejected: deriving the token from the idempotency key (its strength would depend on the client) and keeping an encrypted copy (a retrievable credential). |
| Transport | Order of checks: launch gate (answered before reading anything), same origin only, JSON media type, `Idempotency-Key` header, 64 KiB body counted while streaming, JSON, then (since Gate H.33) a storewide limit of 20 well-formed submissions per minute (`GUEST_CHECKOUTS_PER_MINUTE`, 429 with `Retry-After`), then the service. Every answer carries `X-Request-Id`, which the error log names too. Fixed messages; field errors name fields and codes only. `no-store`, `no-referrer`, `noindex`, no CORS. 500 says the order was not recorded and logs the error name and SQL state only. |
| Retention | Submission rows are kept. No expiry or clean-up job: retention of idempotency history is not decided (ADR-0005). |

## Consequences

- Guest and Owner-assisted orders share every stock, price, expiry and lifecycle rule; only identity, idempotency scope and the price check differ.
- The guarantees are tested against PostgreSQL with independent connections and proven lock waits (`tests/db/guest-checkout.integration.test.ts`): last unit, multi-SKU shortfall, lost response, retry during the first transaction, changed payload, malformed keys, price, stock and charge changes, unconfigured zone, duplicate SKUs, phone and quantity validation, oversize, injected database failure, forged actor fields, no account created, and the transport's refusals.
- A customer who loses the first answer depends on the Owner for a tracking link. The Owner contacts every customer anyway to verify the order.

## Not decided or not built

- The public endpoint itself, and abuse protection for it: an anonymous order holds stock for 24 hours, so a per-client limit (which needs a trusted proxy, decision 1) or another control must exist before checkout opens.
- A public, published-only catalogue and quote (needs a publication rule, I-6).
- Customer accounts, Google or phone sign-in, OTP (S-14).
- Retention of submission records.
