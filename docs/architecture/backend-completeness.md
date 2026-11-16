# Backend completeness

**Status:** Draft — Founder Review
**Purpose:** Feature by feature: what the backend implements, how it is tested, how ready it is for production, and what still blocks it. As of batch H.31–H.38 (2026-11-16).

**Summary: backend implementation advanced; production readiness pending.** The internal business system (catalogue, stock, Owner-assisted orders, COD, returns, reports, exports, backups) is implemented and tested against PostgreSQL. Every customer-facing capability is built only as far as it can be without founder decisions, and none is reachable except guest tracking. Nothing is deployed.

Status words: **Implemented** (code and automated tests exist), **Dormant** (built and tested, deliberately not reachable), **Partial**, **Not built**. "Tested" names the suites in [testing.md](../testing.md).

## Capability matrix

| Capability | Status | Tested by | Production readiness | Waits for |
|---|---|---|---|---|
| Owner sign-in, sessions, Bearer tokens | Implemented | `auth-*` integration tests over Better Auth's HTTP handler, e2e | Local only; per-client sign-in limit needs a proxy | Hosting (1), recovery method (OF-5), 2FA (decision 3): [ADR-0008](../adr/0008-customer-identity-recovery-and-mfa.md) |
| Permissions and audit actors | Implemented (one role) | Negative tests per route and action | Ready for one Owner | Staff roles only if the founder adds them (OF-7) |
| Products, categories, variants, prices, content | Implemented | catalogue, edit, content, import tests | Ready (draft catalogue) | none |
| Product photos | Implemented (local folder) | media tests, media drill | Not ready: local development storage, no public serving | Photo workflow and storage (decision 14), hosting |
| Publication lifecycle | Dormant | `publication.integration.test.ts`: races with proven lock waits, frozen content, withdrawal, append-only history | Refuses every product: no approved rule | Publication rule (I-6) |
| Stock: receipts, adjustments, ledger, counts | Implemented | inventory, operations, counts tests, concurrency | Ready | Counting routine (I-8, process only) |
| Owner-assisted orders and reservations | Implemented | `orders.integration.test.ts`: last unit, multi-SKU, expiry, cancellation races, dispatch once | Ready; expiry batch needs a scheduler | Hosting scheduler for `orders:expire-verification` |
| Guest checkout | Dormant | `guest-checkout.integration.test.ts`: last unit, lost response, retries, quote changes, storewide limit, transport | Unreachable by design | Published policies (S-17, G-7), publication rule, hosting with per-client limits (1) |
| Public catalogue, filters, quote | Dormant | `public-catalogue.integration.test.ts`: no draft leaks through lists, search, filters, products, quotes or errors | Unreachable by design | Publication rule (I-6), image serving (14), launch gate |
| Guest tracking and cancellation | Implemented, live | office-orders and orders tests; e2e | Per-link and global limits only | Hosting proxy for per-client limits |
| Customer accounts, Google, phone codes, passkeys | Not built | none | none | Launch scope (S-14), privacy text (S-17): [ADR-0008](../adr/0008-customer-identity-recovery-and-mfa.md) |
| COD: expected, collected, settled, courier deductions | Implemented | orders, owner-operations, office-orders tests | Ready for manual recording | Courier statement import (OF-8, P; formats unknown) |
| Refunds | Implemented (manual record) | orders tests (replay, limits) | Ready | Working-day calendar for the 7-day deadline (shown, not computed) |
| Returns, exchanges, RTO, inspection | Implemented | orders tests, launch rehearsal | Ready | Exchange execution: replacement charge and price difference (O-13) |
| Reports, dashboard, print views | Implemented | owner-operations tests, e2e | Ready | none |
| Exports (XLSX, CSV, JSON) with audit | Implemented | owner-operations tests (independent XLSX reader) | G-5 not met: not opened in desktop Excel or on a phone by a person | A manual check (G-5) |
| Owner API `/api/v1` (OpenAPI 1.5.0) | Implemented | `npm run test:contract`: every endpoint against the document | Ready for a native client except token storage | Native apps and token storage (API-10), versioning policy approval (API-9) |
| Customer-facing API | Dormant (tracking live) | as the rows above | Unreachable by design | See [public-api.md](../api/public-api.md) |
| Idempotency of every write | Implemented | operations and guest tests (concurrent same-key, lost response) | Records kept forever | Retention of idempotency records (ADR-0005) |
| Audit trails | Implemented for stock, orders, money, exports, imports, reviews, policies, publication | append-only triggers tested | Ready | Account events (sign-in, password change) are **not** audited yet |
| Rate limits and body limits | Implemented | API, tracking, guest tests | No per-client anonymous limit | Hosting proxy (1) |
| Database resilience | Implemented: connection wait 10 s, statement 60 s | `connection.integration.test.ts` | Fixed values | Hosting: pool size and limits to measure there |
| Configuration and readiness checks | Implemented (`npm run config:check`) | config tests | Local | Hosting secrets and probes |
| Maintenance jobs | Partial: verification expiry batch (idempotent, concurrency-safe) | expiry tests | No scheduler | Hosting scheduler; retention decisions for any clean-up |
| Backup and restore (database, photos) | Implemented locally | `backup:drill`, `media:drill`, `recovery:check` | Local copy only | RPO and RTO (K-9), off-device place (15), schedule |
| Separate installation | Partly verified | `npm run test:install` | G-14 not met (one machine, no licence review) | Licence review (RU-5) |

## What the batch changed (H.31–H.38)

- **Fixed:** the public tracking endpoints read any body size before the 2 KiB check (memory exhaustion by anonymous requests); SKUs could be added to archived products; the connection pool waited without limit. Found by an independent review of this batch's changes and fixed with regression tests: a publication (and a review) read the content digest in the statement that waited for the product lock, so under READ COMMITTED it could miss a price or SKU change committed meanwhile (latent: nothing can publish yet); deactivating a SKU did not lock its product; invalid checkout bodies counted against the storewide limit.
- **Added:** publication mechanics refusing while no rule is approved (migration 0014); published-only reads and quote shared with the preview; a dormant public catalogue transport; a storewide guest-checkout limit and request ids on public answers (migration 0015); courier deductions, so a courier's fee no longer prevents an order from being fully accounted for and closed (migration 0016); the customer-facing contract ([public-api.md](../api/public-api.md)); the identity, recovery and 2FA evaluation ([ADR-0008](../adr/0008-customer-identity-recovery-and-mfa.md)).
- **Evaluated, not built:** customer accounts, Google and phone sign-in, passkeys, account recovery, 2FA (each needs a founder decision; ADR-0008), courier statement import (formats unknown, P), account-event audit (needs a reviewed design of Better Auth hooks).

## For a frontend developer

- One backend: every client uses the same services in `src/modules/*` through `operations.ts` (Owner) or the public services. Do not call the database or re-implement prices, stock, totals or status rules in a client.
- Owner screens and apps: `/api/v1` with a Bearer token ([API guide](../api/README.md), contract at `/api/v1/openapi.json`). Server-rendered pages in this application call the operations directly instead of HTTP (API-3).
- Customer screens: the contract in [public-api.md](../api/public-api.md). Only tracking answers today; the rest returns `503` once routed until the launch gate opens.
- Money is integer paisa, times UTC (show Asia/Dhaka), text bilingual `{ en, bn }`, phone numbers text. Branch on error codes, never on messages.

## Founder decisions that block production

1. Hosting and database host (decision 1), with a trusted proxy for per-client limits and a scheduler for the expiry batch.
2. Publication rule for products (I-6).
3. Final, published delivery, return and exchange, and privacy policies (decision 7, S-17, G-7).
4. RPO and RTO (decision 6) and the off-device backup place (decision 15).
5. Delivery charge amounts and the Dhaka City definition (decision 8).
6. Photo workflow and storage (decision 14).
7. Owner account recovery and 2FA (OF-5, decision 3).
8. Customer accounts and search at launch (S-14).
9. Exchange execution (O-13), the refund working-day calendar, retention of idempotency records and personal data.

## Remaining backend work, in order

1. Account-event audit (sign-in, password change, session revocation) through a reviewed design of Better Auth hooks.
2. A rate limit for catalogue reads and quotes before they are routed (they have none), and a founder decision on whether customers may infer exact stock through quotes.
3. After hosting: per-client limits for tracking and checkout, the expiry scheduler, pool sizing measured on the host, health probes for the host.
4. After I-6: put the approved rule in `publication.ts`, add the publish and withdraw endpoints and Office actions, and an image route for published photos.
5. After S-17 and G-7: publish policies; then a gate routes the catalogue, quote and checkout and tests them end to end in a browser.
6. Courier statement import, once a courier's statement format is known (OF-8).
7. Recovery and 2FA as chosen (ADR-0008).
