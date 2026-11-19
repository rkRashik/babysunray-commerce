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
| [ADR-0008: Customer identity, recovery and 2FA](adr/0008-customer-identity-recovery-and-mfa.md) | Proposal only: separate customer identity, Owner recovery options, an evaluation of Better Auth's two-factor plugin, staff permissions |
| [ADR-0009: Hosted database security boundary](adr/0009-hosted-database-security-boundary.md) | Hosted database security boundary (Data API, roles, privileges) and serverless connection design (Draft) |
| [ADR-0010: Hosting and image delivery](adr/0010-hosting-and-image-delivery.md) | Confirmed hosting target (Netlify, Supabase, Cloudinary), Cloudinary delivery of published photos only, and the Netlify compatibility review |
| [ADR-0011: Founder acceptance and customer sign-in](adr/0011-founder-acceptance-and-customer-sign-in.md) | The real shop and checkout for founder acceptance only (staging database), product and policy publication, optional Google sign-in for customers, per-client limits on Netlify (Draft) |
| [Backend handoff](architecture/backend-handoff.md) | One page for the next client developer: architecture, Owner API, closed public services, settings, blockers, decisions, verification limits |
| [Backend completeness](architecture/backend-completeness.md) | Feature by feature: implemented, tested, production readiness, what blocks it, remaining work |

## API

| Document | What it covers |
|---|---|
| [API guide](api/README.md) | Endpoints, Bearer authentication, writes and idempotency, errors, pagination, limits, versioning and compatibility |
| [Customer-facing API](api/public-api.md) | The dormant public catalogue, quote and checkout handlers and the live tracking endpoints: contract, visibility rule, abuse limits, what must happen before they open |

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
| [Courier statement check](operations/courier-statements.md) | The statement template and the read-only comparison with recorded COD money |

## Testing

| Document | What it covers |
|---|---|
| [Testing](testing.md) | The suites, the database safeguards, browser tests, test-only dependencies |
| [Performance findings](operations/performance.md) | The benchmark on fictional data and what it showed |

## Operations and recovery

| Document | What it covers |
|---|---|
| [Operations runbook](operations/runbook.md) | Running, settings, checks, exports, stock counts, photos, backup and restore, outage procedure |
| [Infrastructure compatibility](operations/infrastructure.md) | Hosted settings (persistent server, serverless, Supabase pooler), photo store, HTTP maintenance, health probes, what is and is not verified, founder setup |
| [Production migration](operations/production-migration.md) | Plan and read-only preflight for a future production migration (nothing can migrate production today) |
| [Staging setup](operations/staging-setup.md) | For the founder: a separate Supabase staging project, locked down, migrated and verified with the staging commands |
| [Founder acceptance](operations/acceptance.md) | For the founder: one-time staging setup, the one Netlify variable list, and the acceptance checklist with exact URLs |
| [Offline sheets](operations/offline-templates.md) | Blank order, stock, COD and courier sheets for an outage |

## Project records (private: review before any public release)

These record the business's own requirements, decisions and plans. They are not technical documentation and are **not** cleared for publication; see [the privacy audit](private/public-release-privacy-audit.md) before sharing the repository.

| Document | What it covers |
|---|---|
| [Product requirements](product/requirements.md) | What the product must do, open decisions, implementation status |
| [Order policy decisions](product/order-policy-decisions.md) | The approved order rules, lifecycle states and engineering defaults |
| [Storefront launch decisions](product/storefront-launch-decisions.md) | Every decision still needed before the public storefront opens: approved, recommended, open |
| [Launch readiness](operations/launch-readiness.md) | The launch gate, readiness page, policy drafting, product reviews, guest checkout contract |
| [First Light design system](design/storefront-design-system.md) | The design of the storefront, the tracking page and the Owner Office (chosen by the founder for implementation): direction, libraries, tokens, components, motion, accessibility |
| [Storefront concepts](design/storefront-concepts.md) | The earlier (rejected) design concepts, customer wording awaiting approval, customer sign-in options |
| [Public-release privacy audit](private/public-release-privacy-audit.md) | What must be reviewed before any part of this repository is made public |
