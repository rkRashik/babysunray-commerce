# BabySunray Commerce

A bilingual (English and Bangla) e-commerce platform and admin panel for a baby and kidswear shop in Bangladesh. It is built as a single Next.js application over PostgreSQL, with the business rules in server-side domain modules shared by the admin panel and a versioned REST API.

> **Status:** in active development, not production-ready and not deployed. The public storefront and checkout are **not** live: the storefront exists only as a private preview inside the admin panel, and public checkout stays disabled until the shop's policies are approved and published.

## What is implemented

- **Catalogue:** draft products with SKU-level variants, bilingual content, size charts in centimetres, categories, a photo pipeline (type detection by content, re-encoding, metadata removal) and an all-or-nothing CSV/XLSX bulk import with a full preview.
- **Inventory:** on-hand and reserved stock per SKU backed by an append-only movement ledger; database constraints keep `0 <= reserved <= on_hand`; physical stock counts become reasoned ledger adjustments.
- **Orders:** admin-entered orders that reserve every line atomically or create nothing; four separate lifecycle dimensions (order, fulfilment, payment, return); a 24-hour verification window that releases holds without depending on a scheduler; cash-on-delivery collection, settlement and courier deductions kept apart, with a read-only courier statement check; returns, refunds and returned parcels with quarantine and inspection before restocking.
- **Concurrency and idempotency:** row locks in a fixed order, conditional updates whose affected rows are checked, and one idempotency record per client key committed in the same transaction as the operation. Tests race real connections for the last unit and prove the lock waits.
- **Private order tracking:** 256-bit random links stored only as SHA-256 digests, a masked view, revocation and rate limits.
- **Admin panel** (`/office`): product, stock, order, delivery-charge and category management, a dashboard of work queues, period reports, audited XLSX/CSV/JSON exports protected against formula injection, A4 print views, a launch-readiness overview and private policy drafts.
- **REST API** (`/api/v1`): Bearer-token authentication, OpenAPI 3.1, strict input validation, RFC 9457 errors, keyset pagination, idempotency keys, per-user rate limits, request size limits and no CORS.
- **Security:** Better Auth sessions, no public sign-up, an append-only sign-in and access audit, server-side permission checks on every page, Server Action and endpoint, audit actors that only a verified session can produce, and security headers on every admin response.
- **Recovery:** encrypted database and photo backups, verification, restore into an empty target only, and restore drills on fictional data.
- **Customer-facing backend (not reachable):** published-only catalogue, filters and cart quote, a guest checkout with its own idempotency record, price checks and a storewide rate limit, and the publication mechanics, all tested against PostgreSQL but deliberately not connected to any route. No product can be published until the shop's publication rule is approved ([what is complete and what is blocked](docs/architecture/backend-completeness.md)).

## Not built yet

- A public storefront, product publication and public checkout (built, not reachable; see above)
- Online payments and courier integrations
- Customer accounts and sign-in
- Production hosting, a backup schedule and an off-device backup copy
- Account recovery for the admin beyond a local command, and two-factor authentication
- Native apps (the API is designed for them, but none exists)
- A final visual design (the admin panel and storefront preview use functional or prototype layouts)

## Technology

| Area | Choice |
|---|---|
| Application | Next.js (App Router), React, TypeScript in strict mode, Node.js 24 |
| Database | PostgreSQL 18, Drizzle ORM, reviewed SQL migrations |
| Authentication | Better Auth (email and password, database sessions; Bearer tokens for API clients) |
| Validation and contract | zod, OpenAPI 3.1 |
| Styling | Tailwind CSS |
| Images | sharp |
| Tests | Vitest, Playwright, axe-core |

## Architecture

One modular monolith; no separate backend server. Route files handle HTTP and rendering, business rules live in domain modules, and the admin panel calls the same services as the API instead of calling its own HTTP endpoints.

```
src/app       pages, Server Actions and route handlers (HTTP, input parsing, rendering)
src/api       /api/v1 plumbing: authentication, validation, errors, idempotency keys, OpenAPI
src/modules   domain modules: catalogue, inventory, orders, media, reports, exports,
              storefront, policies, launch, auth, idempotency, rate-limit
src/db        Drizzle schema, connection safeguards, backup format
drizzle/      SQL migrations (forward only)
tests/        unit, integration, contract, browser, recovery drills, benchmark
```

Money is stored as integer paisa and timestamps in UTC (shown in Asia/Dhaka). Architecture decisions are recorded in [docs/adr](docs/adr).

## Getting started

Requirements: Node.js 24 (`.nvmrc`), PostgreSQL 18, and `openssl` for the production-build browser tests.

```
npm install
psql -U postgres -f db/local-setup.sql   # creates the local dev and test databases and roles
cp .env.example .env.local               # then fill in the connection strings and auth settings
npm run db:migrate                       # applies migrations to the local development database only
npm run auth:bootstrap-owner             # creates the first admin account (interactive)
npm run dev                              # http://localhost:3000/office
```

Passwords for the database roles are set with `\password` in `psql`, never in a file. Full setup, configuration and every npm script: [docs/getting-started.md](docs/getting-started.md).

## Running tests

```
npm run typecheck && npm run lint
npm test                # unit tests, no database
npm run test:db         # PostgreSQL integration tests (local babysunray_test only)
npm run test:contract   # OpenAPI validity and every endpoint against it
npm run test:e2e        # browser tests against a development server
npm run test:e2e:prod   # the same against a production build behind local HTTPS
```

Database and browser tests refuse any database other than the local `babysunray_test`, confirm its identity with PostgreSQL, and take a lock so two runs never reset it at the same time. Details: [docs/testing.md](docs/testing.md).

## API

The OpenAPI document is served at `/api/v1/openapi.json`. Authentication, errors, idempotency, pagination, limits and the versioning rules are in the [API guide](docs/api/README.md). All endpoints are admin-only. The customer-facing contract (only order tracking is live) is in [public-api.md](docs/api/public-api.md).

## Documentation

The full index is [docs/README.md](docs/README.md). Most used:

- [Getting started](docs/getting-started.md) and [Testing](docs/testing.md)
- Feature guides: [catalogue and inventory](docs/guides/catalogue-and-inventory.md), [orders](docs/guides/orders.md), [authentication](docs/guides/authentication.md), [admin panel](docs/guides/admin-panel.md), [product photos](docs/guides/product-photos.md), [storefront preview](docs/guides/storefront-preview.md)
- [Architecture decision records](docs/adr)
- [Operations runbook](docs/operations/runbook.md): running, exports, stock counts, backup and restore

## Data handling

Customer data, database dumps, backups, exports, secrets and private business documents never belong in this repository; tests and examples use fictional data only. See `.gitignore` and `.env.example`.
