# Backend completeness

**Status:** Draft — Founder Review
**Purpose:** Feature by feature: what the backend implements, how it is verified, what is built but inactive, what is missing, and what blocks it. As of Gate H.55 (2026-11-18).

**Summary.** The backend is feature-complete for the scope the founder has approved: the internal business system and every customer-facing foundation that needs no further decision exist and are tested against PostgreSQL. It is **not production-ready**: production needs founder decisions (publication rule, published policies, recovery objectives, account recovery) and infrastructure (hosting, a trusted proxy, a scheduler, durable photo storage, an off-device backup). Nothing is deployed, and only guest tracking is reachable by customers.

**Two different questions.** *Backend implementation completeness* asks whether every approved capability exists in code and is tested locally. *Production readiness* asks whether it can safely serve real customers; that also needs decisions, infrastructure and a real staging run. This backend is the first, and not the second.

## Completion matrix

| State | What belongs here |
|---|---|
| **Fully implemented and locally verified** | Everything in section 1 that is not marked "not run on Supabase": Owner system, catalogue, stock, orders, COD, reports and exports, `/api/v1`, tracking, auth and audit, local backups and drills, maintenance and its backlog report, backup freshness check (`backup:status`), hosted-backup logic against mocks |
| **Implemented, awaiting real staging verification** | Supabase pool behaviour, `babysunray_app` grants and the privilege audit on Supabase, the Storage adapter and the staging photo commands against a real bucket, the staging migration and backup commands, Data API refusal, role-level statement timeout through the pooler. **REAL SUPABASE STAGING: NOT RUN — AWAITING FOUNDER CONFIGURATION** |
| **Implemented but intentionally disabled** | Product publication (`APPROVED_PUBLICATION_RULE` is `null`), published-only catalogue, quote and guest checkout (unrouted), the public photo route (routed, answers `503` before touching data), Supabase as photo store, HTTP maintenance (off without a secret), hosted photo restore (function only, no command) |
| **Still missing technical implementation** | An executable production migration and backup procedure (the design and its read-only checks exist, [production-migration.md](../operations/production-migration.md)), a bucket restore command (blocked below), per-client limits, a caching policy for photos, Admin screens for the audit and statement check |
| **Blocked by founder decisions** | Section 4 |
| **Blocked by production infrastructure** | Section 5 |

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
| Anonymous-load protection: bulkheads per process (anonymous reads, checkout, `/api/auth`), storewide checkout limit, streamed body limits | `src/modules/rate-limit` (Gate H.40; `/api/auth` added after the H.42 review) | bulkhead and auth-route unit tests; saturation tests per transport |
| Database resilience: connection and statement limits, dropped idle connections, locked migrations | `src/db/client.ts`, `migrate-verified.mts` (Gate H.41) | connection and migrate-verified tests (each fails without its fix) |
| Maintenance: expiry, expired sessions (audited), stale rate-limit windows, integrity checks | `npm run maintenance:run` | `maintenance.integration.test.ts`: concurrent runs, target guard |
| Hosting compatibility, tested locally only: pool settings for a persistent server, serverless functions (default 2 connections, 1 to 20) and a transaction-mode pooler (TLS rules, no URL overrides, bulkheads sized from the pool, separate sign-in bulkhead and one shared anonymous bulkhead below 5), hosted configuration checks | `src/db/pool-settings.ts`, `src/db/client.ts`, `src/config/hosted.ts` (Gates H.44, H.45), [infrastructure.md](../operations/infrastructure.md) | pool-settings, hosted-config, `hosting-infrastructure` and `pool-one` integration tests: the last unit goes to one of eight simultaneous orders under the serverless and pooler settings; the main paths complete on a pool of ONE connection (no nested connection use; a control proves the check works). Not tested against Supabase or Vercel |
| Maintenance over HTTP (off unless `MAINTENANCE_SECRET`; Bearer only, concurrent calls safe, one connection at a time, bounded, replay-safe) and liveness and readiness probes (readiness also requires a private photo bucket) | `src/api/maintenance.ts`, `runMaintenance`, `src/api/health.ts` | maintenance-http, health and integration tests: unauthorised, wrong-method, browser-origin, skipped, failed, replayed and concurrent calls; no scheduler exists. A `GET` adapter for hosts that cannot `POST` (`MAINTENANCE_ALLOW_GET=true`, same Bearer secret, off by default) is tested with the jobs replaced |
| Staging readiness without a project: one settings loader for every staging command (honours `STAGING_ENV_FILE`, so tests never read the founder's file), `npm run staging:preflight` (which settings are missing or wrong, no network, no values), report files created exclusively (never overwritten) and only outside the project | `scripts/staging-env.mts`, `src/db/staging-preflight.mts`, `src/db/hosted-report.mts` (Gate H.46B) | `staging-preflight` and `hosted-report` unit tests; refusals with no connection. Fixes a defect: two commands ignored `STAGING_ENV_FILE` |
| Photo backup, verification and restore for a hosted bucket: `media:verify:staging` and `media:backup:staging` (read the staging database and bucket, change neither), the same encrypted `.bsmedia` format, one photo in memory at a time, refusal of missing, changed, damaged or truncated data; a restore function that needs an empty store and a repeated target label | `scripts/media-staging.mts`, `src/modules/media/backup.ts` (Gate H.47) | `media-hosted-backup` integration test against a mocked Storage and fictional records: backup reads only, restore into a second bucket matches, non-empty and unconfirmed targets refused, a mid-restore collision never overwrites, transient download failures retried. **No real bucket used** |
| Backup monitoring from headers: freshness, database and photo pairing, unreadable and unfinished files, no passphrase, no deletion | `npm run backup:status`, `src/db/backup-status.mts` (Gate H.48C) | `backup-status` unit tests per failure class. Does not verify content (`backup:verify` does). Header reads no longer load a whole backup into memory |
| A database connection lost while a transaction holds it fails only that request and is logged by name (node-postgres's pool does not listen for errors on a checked-out connection, so a socket reset used to be an uncaught exception that stops Node; found and fixed in Gate H.52) | `src/db/client.ts` | `pool-settings.test.ts` (fails without the fix); `concurrency-review.integration.test.ts`: a backend killed mid-order leaves nothing half-written and the same key then works once |
| Owner-assisted order against guest checkout for the last unit; maintenance overlapping traffic on a pool of two | `tests/db/concurrency-review.integration.test.ts` | exactly one order wins and the ledger agrees; one expiry event; no deadlock |
| Non-additive migration check (`npm run migrations:review`, text only) | `src/db/migration-review.mts`, [production-migration.md](../operations/production-migration.md) | `migration-review.test.ts`; the committed history has one reviewed deletion and no drop, rename, truncate or type change |
| Maintenance reports the work already overdue when it started (verifications, expired sessions), so a late or missed scheduler is visible; no claim that a scheduled call runs on time | `src/modules/maintenance/jobs.ts` (Gate H.48B) | `hosting-infrastructure` integration test |
| Photo store interface with a Supabase Storage adapter (contracts checked against Supabase Storage's source: strict answers, missing bucket is an error, bounded streamed downloads, key-type headers, uploads only into a confirmed-private bucket) and published-only photo lookup | `src/modules/media/supabase-store.ts`, `provider.ts`, `public.ts` | supabase-store unit tests against a contract-following fake, and photo operations on it (replace, remove, manifest check, failed upload). No real bucket was used |
| Hosted database security boundary: privilege script (no access for Supabase's API roles, least-privilege `babysunray_app`), read-only privilege audit, staging guards (marker, TLS, no local or production target, migration-history check, backup check) | `db/hosted/privileges.sql`, `src/db/hosted-security.mts`, `src/db/hosted-target.mts`, [ADR-0009](../adr/0009-hosted-database-security-boundary.md) | hosted-target unit and integration tests on local PostgreSQL (the audit detects an owner role, the script runs and is rolled back, a production marker and a changed migration are refused). Not run on Supabase |
| Staging commands and suite: `db:migrate:staging`, `backup:create:staging`, `test:staging` (12 checks against a real staging project) | `scripts/migrate-staging.mts`, `scripts/backup-staging.mts`, `scripts/staging-test.mts`, `tests/staging`, [staging-setup.md](../operations/staging-setup.md) | refusals tested locally (NOT RUN with exit 2 without settings; no connection without a target). **The suite itself has not run:** the founder has created the Supabase staging project and its private bucket, but no staging setting is configured on this machine, so nothing has connected to them (`REAL SUPABASE STAGING: NOT RUN`) |
| Backup and restore of the database and photos (local) | `backup:*`, `media:*`, `recovery:check` | `backup:drill`, `media:drill` on fictional data, new audit tables included |
| Separate, rebranded installation | `npm run test:install` | clean clone of HEAD, offline install, drills, every browser test |

## 2. Technically implemented but inactive

| Capability | Why inactive | What activates it |
|---|---|---|
| Product publication (publish, withdraw, append-only history) | No publication rule (I-6) is approved: `APPROVED_PUBLICATION_RULE` is `null` and the operation refuses | Founder approves I-6; a gate puts the rule in code and adds the endpoints |
| Published-only catalogue, filters, product page, cart quote | Launch gate closed; nothing is published; not routed | The gate that opens the shop routes `src/api/public-catalogue.ts` |
| Published-only photo serving for customers (`GET /api/public/media/{id}`, `src/api/public-media.ts`: only photos of published products, no signed URLs) | **Routed but closed** (Gate H.49): the real launch gate answers `503` with no body before the database or storage is touched (`public-media-route` test, mocks that throw if reached). No product can be published | The founder-approved gate that opens the shop; a caching policy needs hosting |
| Supabase Storage as the photo store (`MEDIA_STORAGE_PROVIDER=supabase`) | No hosting or bucket exists; not verified against a real bucket | Founder chooses hosting (decision 1, 14); a staging check |
| Guest checkout (atomic order, reservation, one-time tracking link, anonymous idempotency) | S-17 and G-7 (policies not published), launch gate closed; not routed | Published policies, hosting with per-client limits, then a gate |

## 3. Missing implementation

Built nowhere yet, and not blocked only by a decision:

- A caching policy for published photos (depends on hosting).
- An executable production migration and backup procedure (the staging commands refuse production by design). Built: the plan and preflight design ([production-migration.md](../operations/production-migration.md)), `npm run migrations:review` (text-only check for non-additive SQL), and shared path and report helpers. No production command exists, by design; what remains needs hosting and founder decisions (that document, section 6).
- A command to restore photos into a hosted bucket: the function exists and is tested on a mock, but no command calls it until the founder approves a recovery action (and a bucket restore needs a real-bucket check first).
- A passing run of `npm run test:staging` on a real staging project.
- Per-client rate limits (needs a trusted client address from the proxy, decision 1).
- A scheduler that calls the maintenance endpoint (none is activated). The `GET` adapter exists, off by default; no host scheduler has been configured or tried.
- Admin screens for the audit and the statement check (the API and the exports serve them; screens are frontend work).

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

Production hosting and database host (decision 1, G-8), a trusted reverse proxy (per-client limits, real client addresses in the audit), a scheduler for `maintenance:run` (the HTTP endpoint accepts `POST` with a Bearer secret, and `GET` with the same secret when `MAINTENANCE_ALLOW_GET=true`), durable photo storage and serving, secret management and rotation, connection pool sizing measured on the host, an off-device backup target. No deployment exists.

## Dependency map for a frontend team

The backend does not depend on the current screens; any new storefront, admin panel or app uses the same services.

| Need | Use | State |
|---|---|---|
| Owner screens (web, Windows, Android) | `/api/v1` with a Bearer token ([API guide](../api/README.md); contract at `/api/v1/openapi.json`); server-rendered pages in this application may call `src/modules/*/operations.ts` directly | Ready |
| Product listing, search, filters, product page, cart | `src/modules/storefront/public-catalogue.ts` through `src/api/public-catalogue.ts` ([public-api.md](../api/public-api.md)) | Built; answers `503 shop_closed` once routed until the launch gate opens |
| Checkout | `src/api/guest-checkout.ts` | Built; closed (S-17, G-7) |
| Order tracking | `POST /api/track`, `POST /api/track/cancel` | Live |
| Product images | `GET /api/public/media/{id}` (published products only) | Routed; answers `503` while the launch gate is closed (decision 14) |
| Customer accounts | none | Not built (S-14) |
| Shop identity (name, contact, colours) | `src/config/installation.ts` (`STORE_*`) | Ready |

Rules for any client: money is integer paisa; times are UTC (show Asia/Dhaka); text is `{ en, bn }`; phone numbers are text; branch on error codes, never on messages; never compute prices, totals or stock in the client.
