# Backend completeness

**Status:** Draft — Founder Review
**Purpose:** Feature by feature: what the backend implements, how it is verified, what is built but inactive, what is missing, and what blocks it. As of batch H.39–H.42 (2026-11-17).

**Summary.** The backend is feature-complete for the scope the founder has approved: the internal business system and every customer-facing foundation that needs no further decision exist and are tested against PostgreSQL. It is **not production-ready**: production needs founder decisions (publication rule, published policies, recovery objectives, account recovery) and infrastructure (hosting, a trusted proxy, a scheduler, durable photo storage, an off-device backup). Nothing is deployed, and only guest tracking is reachable by customers.

"Verified" means automated tests in this repository ([testing.md](../testing.md)); no test covers production hosting, real data or real users.

## 1. Implemented and verified

| Capability | Where | Verified by |
|---|---|---|
| Owner sign-in, cookie and Bearer sessions, permissions, truthful actors | `src/modules/auth`, ADR-0003 | `auth-*` integration tests over Better Auth's HTTP handler; e2e |
| Sign-in and access audit (sign-in, failed sign-in, ended sessions, password change, Owner commands, every access change) | `auth_events`, `src/modules/auth/audit.ts` (Gate H.39) | `auth-events.integration.test.ts`: forged fields, identical failure answers, fail-closed sign-in, concurrent revocation exactly once, append-only |
| Catalogue: products, categories, variants, prices, content, size charts, review, bulk import | `src/modules/catalogue` | catalogue, edit, content, import, preparation tests |
| Stock: receipts, adjustments, append-only ledger, reservations, physical counts | `src/modules/inventory` | inventory, operations, counts tests with proven lock waits |
| Owner-assisted orders, lifecycle, verification expiry, cancellation, returns, exchanges, RTO, inspection | `src/modules/orders` | `orders.integration.test.ts`: last unit, multi-SKU, races, dispatch once, concurrent expiry batches |
| COD: expected, collected, settled, courier deductions, refunds, closing | `aftercare.ts`, migration 0016 | orders and owner-operations tests: limits, replay, database checks |
| Courier statement check (read-only matching, audited) | `src/modules/orders/statements.ts`, `POST /api/v1/cod/statement-checks` (Gate H.41) | contract tests for every row status, no writes, idempotent replay |
| Reports, dashboard, print views, exports (XLSX, CSV, JSON) with audit | `src/modules/reports`, `src/modules/exports` | owner-operations tests, independent XLSX reader |
| Owner API `/api/v1` (OpenAPI 1.6.0), idempotency, body limits, per-user rate limits, no CORS | `src/api/v1` | `npm run test:contract`: every response against the document; documented equals implemented |
| Guest tracking and cancellation (live) | `/api/track` | tracking tests: limits, bulkhead, no token in logs |
| Anonymous-load protection: bulkhead per process, storewide checkout limit, streamed body limits | `src/modules/rate-limit` (Gate H.40) | bulkhead unit tests; saturation tests per transport |
| Database resilience: connection and statement limits, dropped idle connections, locked migrations | `src/db/client.ts`, `migrate-verified.mts` (Gate H.41) | connection and migrate-verified tests (each fails without its fix) |
| Maintenance: expiry, expired sessions (audited), stale rate-limit windows, integrity checks | `npm run maintenance:run` | `maintenance.integration.test.ts`: concurrent runs, target guard |
| Backup and restore of the database and photos (local) | `backup:*`, `media:*`, `recovery:check` | `backup:drill`, `media:drill` on fictional data, new audit tables included |
| Separate, rebranded installation | `npm run test:install` | clean clone of HEAD, offline install, drills, every browser test |

## 2. Technically implemented but inactive

| Capability | Why inactive | What activates it |
|---|---|---|
| Product publication (publish, withdraw, append-only history) | No publication rule (I-6) is approved: `APPROVED_PUBLICATION_RULE` is `null` and the operation refuses | Founder approves I-6; a gate puts the rule in code and adds the endpoints |
| Published-only catalogue, filters, product page, cart quote | Launch gate closed; nothing is published; not routed | The gate that opens the shop routes `src/api/public-catalogue.ts` |
| Guest checkout (atomic order, reservation, one-time tracking link, anonymous idempotency) | S-17 and G-7 (policies not published), launch gate closed; not routed | Published policies, hosting with per-client limits, then a gate |

## 3. Missing implementation

Built nowhere yet, and not blocked only by a decision:

- An image route that serves published product photos (storage depends on decision 14).
- Per-client rate limits (needs a trusted client address from the proxy, decision 1).
- Health and readiness probes in the shape the chosen host expects.
- Office screens for the audit and the statement check (the API and the exports serve them; screens are frontend work).

## 4. Blocked by founder approval

| Decision | Blocks |
|---|---|
| Publication rule (I-6) | Publishing anything |
| Final, published delivery, return and exchange, and privacy policies (decision 7, S-17, G-7) | Public checkout |
| Customer accounts and search at launch (S-14) | Any customer sign-in ([ADR-0008](../adr/0008-customer-identity-recovery-and-mfa.md)) |
| Owner account recovery method and 2FA (OF-5, decision 3) | A production recovery path ([ADR-0008](../adr/0008-customer-identity-recovery-and-mfa.md)) |
| RPO and RTO (decision 6), off-device backup place (decision 15) | A backup schedule and verified recovery (G-6) |
| Delivery charge amounts and the Dhaka City definition (decision 8) | Real delivery charges |
| Courier statement process (OF-8, P) | Recording payments from a statement |
| Exchange execution (O-13), refund working-day calendar | Automating those steps |
| Retention of idempotency records, audit rows and personal data | Any clean-up beyond dead sessions and counters |
| Whether customers may infer exact stock through quotes | Changing what a quote reveals |

## 5. Blocked by production infrastructure

Production hosting and database host (decision 1, G-8), a trusted reverse proxy (per-client limits, real client addresses in the audit), a scheduler for `maintenance:run`, durable photo storage and serving, secret management and rotation, connection pool sizing measured on the host, an off-device backup target. No deployment exists.

## Dependency map for a frontend team

The backend does not depend on the current screens; any new storefront, admin panel or app uses the same services.

| Need | Use | State |
|---|---|---|
| Owner screens (web, Windows, Android) | `/api/v1` with a Bearer token ([API guide](../api/README.md); contract at `/api/v1/openapi.json`); server-rendered pages in this application may call `src/modules/*/operations.ts` directly | Ready |
| Product listing, search, filters, product page, cart | `src/modules/storefront/public-catalogue.ts` through `src/api/public-catalogue.ts` ([public-api.md](../api/public-api.md)) | Built; answers `503 shop_closed` once routed until the launch gate opens |
| Checkout | `src/api/guest-checkout.ts` | Built; closed (S-17, G-7) |
| Order tracking | `POST /api/track`, `POST /api/track/cancel` | Live |
| Product images | none yet | Missing (decision 14) |
| Customer accounts | none | Not built (S-14) |
| Shop identity (name, contact, colours) | `src/config/installation.ts` (`STORE_*`) | Ready |

Rules for any client: money is integer paisa; times are UTC (show Asia/Dhaka); text is `{ en, bn }`; phone numbers are text; branch on error codes, never on messages; never compute prices, totals or stock in the client.
