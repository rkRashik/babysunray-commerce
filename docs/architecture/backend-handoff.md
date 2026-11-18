# Backend handoff

**Status:** Draft — Founder Review
**Purpose:** One page for whoever builds the storefront, the Windows client or the Android client next: what the backend is, how to connect to it, what is switched off, and what is not yet proven. Details live in the linked documents; this page does not repeat them. As of Gate H.55 (2026-11-18).

## 1. Architecture

One Next.js modular monolith (App Router, TypeScript) with PostgreSQL through Drizzle and reviewed SQL migrations, Better Auth for Owner sign-in, no separate backend server. Business rules (catalogue, stock, orders, COD, returns, reports, exports) live in `src/modules/*`; the Owner Office pages, `/api/v1` and every future client call the same operations, so pricing, stock and authorisation are written once. Stock is an append-only ledger; orders reserve stock inside one transaction; writes are idempotent per user and key. See [ADR-0001](../adr/0001-application-stack.md) to [ADR-0009](../adr/0009-hosted-database-security-boundary.md) and [backend-completeness.md](backend-completeness.md) (feature by feature, with the verification of each).

## 2. The Owner API

`/api/v1`, Owner-only, Bearer tokens (never cookies), OpenAPI 3.1 at `GET /api/v1/openapi.json`, cursor pagination, problem-style errors, per-user rate limits, no CORS, bodies limited. Draft catalogue, stock, internal orders, COD and returns, delivery charges and the courier statement check. Endpoint list and rules: [api/README.md](../api/README.md). A contract test checks that the documented operations are exactly the implemented ones.

## 3. Public services (all closed except tracking)

| Service | State |
|---|---|
| Guest order tracking (`/track`, `/api/track*`) | Live; capability-token link, masked data, no-store, no referrer |
| Liveness and readiness probes (`/api/health/live`, `/api/health/ready`) | Live; anonymous answers carry a status word only |
| Maintenance call (`/api/internal/maintenance`) | Off (404) unless `MAINTENANCE_SECRET` is set; `POST`, or `GET` when `MAINTENANCE_ALLOW_GET=true`; Bearer secret |
| Published-photo route (`/api/public/media/{id}`) | Routed; answers `503` before any database or storage access while the launch gate is closed |
| Public catalogue, quote, guest checkout | Built and tested, **not routed**; the launch gate (`src/modules/launch/gate.ts`) always refuses |
| Product publication | Blocked: `APPROVED_PUBLICATION_RULE` is `null` until the founder approves rule I-6 |
| Customer registration, Google sign-in, payments, courier and messaging | Do not exist; sign-up is refused by Better Auth itself |

Customer-facing API design: [api/public-api.md](../api/public-api.md).

## 4. How a future storefront connects

Server-rendered pages call the same domain modules directly (the Owner Office does this today); they do not call their own HTTP endpoints. The storefront reads only published products through `src/modules/storefront/public-catalogue.ts` and places orders through the guest checkout service (`src/modules/orders/guest-checkout.ts`, transport `src/api/guest-checkout.ts`). Both are unrouted: routing them is a gate for the founder, after published policies (S-17, G-7), a publication rule (I-6) and a host that can give a trusted client address (open decision 1). The storefront preview in the Office (`/office/storefront-preview`) is a prototype, not a design.

## 5. Windows and Android clients

They use `/api/v1` as native clients: sign in at the Better Auth endpoint to receive a signed Bearer token, send it as `Authorization: Bearer ...`, send an `Idempotency-Key` header on every write, and handle the problem responses. Cookies are never accepted on that path and the signed token is never sent to a browser sign-in. Token storage on a device, offline behaviour and the versioning policy are **unresolved founder decisions**; no native client exists. See [ADR-0003](../adr/0003-authentication-foundation.md) and [ADR-0004](../adr/0004-api-v1-and-bearer-transport.md).

## 6. Settings

Names only; the meaning of each is in `.env.example` and [operations/infrastructure.md](../operations/infrastructure.md). Check with `npm run config:check` (prints no values).

`DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `API_RATE_LIMIT_READS_PER_MINUTE`, `API_RATE_LIMIT_WRITES_PER_MINUTE`, `DATABASE_RUNTIME`, `DATABASE_POOLER`, `DATABASE_POOL_MAX`, `DATABASE_SSL`, `DATABASE_SSL_CA`, `DIRECT_DATABASE_URL`, `MEDIA_STORAGE_PROVIDER`, `MEDIA_STORAGE_DIR`, `MEDIA_LOCAL_STORAGE_IN_PRODUCTION`, `SUPABASE_URL`, `SUPABASE_STORAGE_BUCKET`, `SUPABASE_SERVICE_ROLE_KEY`, `MAINTENANCE_SECRET`, `MAINTENANCE_ALLOW_GET`, `STORE_NAME`, `STORE_LINE_EN`, `STORE_LINE_BN`, `STORE_CONTACT_PHONE`, `STORE_CONTACT_EMAIL`, `STORE_THEME_INK`, `STORE_THEME_ACCENT`, `STORE_THEME_PAPER`. Tests and drills: `TEST_DATABASE_URL`, `RESTORE_DATABASE_URL`. Staging only (in `.env.staging.local`, see [staging-setup.md](../operations/staging-setup.md)). No setting starts with `NEXT_PUBLIC_`; a test enforces that.

## 7. Database and photos

Create the databases from `db/local-setup.sql`; apply migrations only with `npm run db:migrate` (local) or `npm run db:migrate:staging` (a hosted staging database); the application never migrates on start. Photos live in a local folder outside the repository, or in a private Supabase Storage bucket (`MEDIA_STORAGE_PROVIDER`); records and files are checked against each other with `npm run media:verify`. Backups: `backup:*` and `media:backup*` (encrypted, founder-run), `backup:status` (freshness from headers only, not a content check), and a restore drill. Procedures: [operations/runbook.md](../operations/runbook.md).

## 8. What blocks production

No deployment exists. Open: hosting and database host, an off-device backup target with RPO and RTO, a trusted proxy for per-client limits, a scheduler, secret management, an executable production migration procedure ([operations/production-migration.md](../operations/production-migration.md)), a passing run of the real Supabase staging suite (`REAL SUPABASE STAGING: NOT RUN`), and the founder decisions below.

## 9. Pending founder decisions

Product publication rule I-6; customer policies S-17 and G-7; delivery charges beyond the two configured zones; customer sign-up and recovery, Owner recovery and 2FA (ADR-0008); native token storage and the API versioning policy; data retention; hosting; RPO and RTO; final UI design. The full list, with what each unlocks, is section 4 of [backend-completeness.md](backend-completeness.md) and [product/storefront-launch-decisions.md](../product/storefront-launch-decisions.md).

## 10. Verification evidence and its limits

See [testing.md](../testing.md) for every suite and how to run it. The counts of the last full run are in its section 5. Everything was run on one Windows machine against local PostgreSQL databases, fictional data, mocked Supabase Storage and a mocked scheduler. Not verified: any Supabase service, any hosting, real photos, real customers, real couriers, load beyond the local benchmark ([operations/performance.md](../operations/performance.md)), restore time on real data.
