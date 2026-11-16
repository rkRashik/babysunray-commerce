# Documentation

**Status:** Draft — Founder Review
**Purpose:** An index of the project documentation, by topic. The [project README](../README.md) gives the overview.

Each document starts with a status line. Most are **Draft — Founder Review**: they describe what was built and tested, but the decisions behind them are not all final.

## Getting started

| Document | What it covers |
|---|---|
| [Getting started](getting-started.md) | Tools, local PostgreSQL, configuration, database migrations, the first admin account, every npm script |
| [Installing a separate copy](operations/installation.md) | A separate, rebranded installation with fictional data, shop identity settings, the installation rehearsal, the licence inventory |

## Architecture and decisions

| Document | What it covers |
|---|---|
| [ADR-0001: Application stack](adr/0001-application-stack.md) | The confirmed stack and the choices still open |
| [ADR-0002: Drizzle and inventory foundation](adr/0002-drizzle-and-inventory-foundation.md) | ORM, catalogue, stock ledger, money |
| [ADR-0003: Authentication foundation](adr/0003-authentication-foundation.md) | Better Auth, sessions, permissions, audit actors |
| [ADR-0004: API v1 and Bearer transport](adr/0004-api-v1-and-bearer-transport.md) | Versioned API, Bearer-only transport, OpenAPI, limits, CORS policy |
| [ADR-0005: Operation idempotency](adr/0005-operation-idempotency.md) | One idempotency record per user and key, committed with the operation |
| [ADR-0006: Product photo storage](adr/0006-product-media-storage.md) | Storage interface, local development folder, manifest |
| [ADR-0007: Guest checkout foundation](adr/0007-guest-checkout-foundation.md) | The inactive guest checkout: customer actor, anonymous idempotency, one-time tracking link |

## API

| Document | What it covers |
|---|---|
| [API guide](api/README.md) | Endpoints, Bearer authentication, writes and idempotency, errors, pagination, limits, versioning and compatibility |

The machine-readable contract is served by the application at `/api/v1/openapi.json`.

## Feature guides

| Document | What it covers |
|---|---|
| [Catalogue and inventory](guides/catalogue-and-inventory.md) | Products, variants, content, readiness, reviews, import, search, stock and its ledger |
| [Orders](guides/orders.md) | Submission, reservations, lifecycle, verification expiry, COD, returns, RTO, guest tracking, the inactive guest checkout |
| [Authentication and authorisation](guides/authentication.md) | Sign-in, sessions, permissions, Bearer tokens, the local account commands |
| [Admin panel](guides/admin-panel.md) | Every `/office` screen, its permissions, and how pages and forms are protected |
| [Product photos](guides/product-photos.md) | Upload checks, storage, serving, consistency and photo backups |
| [Storefront preview](guides/storefront-preview.md) | The private bilingual shop prototype, cart and checkout simulation |
| [Bulk catalogue import](operations/catalogue-import.md) | The import file format, rules and limits |
| [Export formats](operations/exports.md) | Datasets, columns, types, spreadsheet safety, JSON layout |

## Testing

| Document | What it covers |
|---|---|
| [Testing](testing.md) | The suites, the database safeguards, browser tests, test-only dependencies |
| [Performance findings](operations/performance.md) | The benchmark on fictional data and what it showed |

## Operations and recovery

| Document | What it covers |
|---|---|
| [Operations runbook](operations/runbook.md) | Running, settings, checks, exports, stock counts, photos, backup and restore, outage procedure |
| [Offline sheets](operations/offline-templates.md) | Blank order, stock, COD and courier sheets for an outage |

## Project records (private: review before any public release)

These record the business's own requirements, decisions and plans. They are not technical documentation and are **not** cleared for publication; see [the privacy audit](private/public-release-privacy-audit.md) before sharing the repository.

| Document | What it covers |
|---|---|
| [Product requirements](product/requirements.md) | What the product must do, open decisions, implementation status |
| [Order policy decisions](product/order-policy-decisions.md) | The approved order rules, lifecycle states and engineering defaults |
| [Launch readiness](operations/launch-readiness.md) | The launch gate, readiness page, policy drafting, product reviews, guest checkout contract |
| [Storefront concepts](design/storefront-concepts.md) | The two design concepts, customer wording awaiting approval, customer sign-in options |
| [Public-release privacy audit](private/public-release-privacy-audit.md) | What must be reviewed before any part of this repository is made public |
