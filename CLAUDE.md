# BabySunray Commerce

Bilingual (Bangla/English) e-commerce website and private Owner Office for BabySunray, a single-founder baby and kidswear business in Bangladesh.

**Phase:** foundation and decisions. The Git repository is private on GitHub (`rkRashik/babysunray-commerce`, branch `main`). The Next.js app is scaffolded as an engineering base only; `src/app/page.tsx` is a status page, not the approved homepage. The catalogue and stock schema (`src/db/schema.ts`, migrations in `drizzle/`), their internal services (`src/modules/`), the authentication and authorisation foundation (`src/modules/auth`, Better Auth routes under `/api/auth`), operation-level idempotency (`src/modules/idempotency`, ADR-0005) and an Owner-only, Bearer-authenticated `/api/v1` with draft-catalogue and stock writes, body limits, no CORS and per-user rate limits (`src/api/v1`, `src/app/api/v1`, `docs/api/README.md`) exist, as does a minimal functional Owner Office at `/office` (`src/app/office`: sign-in, product search, products, variants, draft editing with optimistic versions, stock; Server Actions call the shared operations directly; not an approved design; real-browser tests in `tests/e2e`), as does a local-only Owner password reset CLI, and internal orders under the founder-approved rules in `docs/product/order-policy-decisions.md` (`src/modules/orders`: Owner-assisted orders, reservations, verification expiry, cancellation, fulfilment, COD, returns, RTO, guest tracking at `/track`; Owner API under `/api/v1/orders`; Office at `/office/orders`), and Owner operations (dashboard, reports, XLSX/CSV/JSON exports with an audit log, physical stock counts and print views: `src/modules/reports`, `src/modules/exports`, `src/modules/inventory/counts.ts`, `/office/dashboard`, `/office/reports`, `/office/exports`, `/office/stock-counts`, `/office/print`) and local encrypted backup tooling with a restore drill on fictional data (`src/db/backup.mts`, `docs/operations/runbook.md`), and structured bilingual product content with categories, a size chart, an advisory readiness checklist and Owner-only product photos in a local development folder outside the repository (`src/modules/catalogue/content.ts`, `readiness.ts`, `src/modules/media`, ADR-0006), and an Owner-only bulk import of new draft products from CSV or XLSX (create-only, previewed, all or nothing; `docs/operations/catalogue-import.md`) with a catalogue preparation overview, and an Owner-only bilingual storefront preview with a cart and a checkout simulation that records nothing (`/office/storefront-preview`, `src/modules/storefront`; prototype, not an approved design, not public), and per-installation shop identity settings with neutral defaults (`src/config/installation.ts`, `STORE_*`; `docs/operations/installation.md`), and the real shop at `/en` and `/bn` (published products only, the same First Light components as the preview) with a real guest Cash on Delivery checkout (`POST /api/shop/checkout`, transport `src/api/guest-checkout.ts`, service `src/modules/orders/guest-checkout.ts`; ADR-0007), optional customer "Continue with Google" as a separate Better Auth instance (`src/modules/customers`, `/api/customer-auth`, callback `/api/auth/callback/google`), product publish and withdraw, and founder-approved policy publication, all reachable only through founder acceptance: an Owner-started pass on the staging-marked database (`src/modules/launch/acceptance.ts`, `/office/acceptance`; ADR-0011, `docs/operations/acceptance.md`), a public launch gate that always refuses (`src/modules/launch/gate.ts`), Owner-only launch readiness, policy drafts and internal product reviews (`/office/launch-readiness`, `/office/policies`, `/office/product-reviews`; `docs/operations/launch-readiness.md`), the First Light design, chosen by the founder for implementation (mobile first, Base UI sheets, Embla gallery, self-hosted OFL fonts, the installation's logo files in `public/brand/`; one design system across the Owner-only storefront preview, the guest tracking page and every Owner Office page; `docs/design/storefront-design-system.md`; open decisions in `docs/product/storefront-launch-decisions.md`), a backup-pair recovery check and a performance benchmark on fictional data (`docs/operations/performance.md`), and hosting-compatibility foundations that nothing uses yet (settings for serverless functions and a transaction-mode pooler, a Supabase Storage photo adapter, secret-protected HTTP maintenance that is off by default, liveness and readiness probes, a published-only photo transport at `/api/public/media/{id}`, open only with the shop (503 before any data is touched); `docs/operations/infrastructure.md`, tested locally and with mocks only), and Cloudinary CDN copies of published product photos only (inactive without `CLOUDINARY_*`; ADR-0010), and a hosted database security boundary with staging-only migration, backup and verification commands (ADR-0009, `docs/operations/staging-setup.md`). The site is deployed on Netlify behind visitor protection and connected to the staging database. Public (non-acceptance) checkout, online payments, courier or messaging integrations, production account recovery, 2FA, a production scheduler, a backup schedule or off-device copy, and a production database do not exist. The local databases are created by the founder from `db/local-setup.sql`. Do not create the rest unless the current gate authorises it.

Commands (see docs/getting-started.md, section 6): `npm install`, `npm run dev`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` (unit), `npm run test:db` (PostgreSQL integration; needs `TEST_DATABASE_URL`, local `babysunray_test` database and role only), `npm run db:generate`, `npm run db:check`, `npm run db:migrate` (only the local `babysunray_dev` database; it verifies the target and refuses anything else), `npm run test:contract` (OpenAPI validity and every `/api/v1` endpoint against it), `npm run test:e2e` (Owner Office in real Chromium against `babysunray_test`; starts its own server, never stops another), `npm run test:e2e:prod` (the same against a production build behind a local TLS proxy), `npm run test:install` (rehearses a separate, rebranded installation: a clean clone of the committed HEAD in a temporary folder, offline `npm ci`, its drills, a fresh `babysunray_test` schema and every browser test against its production build), `npm run backup:drill` (backup and restore drill on fictional data; empties and restores `babysunray_test` under the test lock), `npm run backup:create`, `npm run backup:verify` and `npm run backup:restore` (interactive passphrase; the founder runs them, never on their behalf; restore only into an empty `babysunray_restore`), `npm run config:check` (reports which settings are set and valid, database reachability and migrations; prints no values, changes nothing), `npm run auth:bootstrap-owner` (creates the first Owner; interactive, for the founder to run; never run it or choose credentials on the founder's behalf), `npm run auth:reset-owner-password` (local-only Owner password reset; same rule: the founder runs it, never on their behalf), `npm run orders:expire-verification` (local verification-expiry batch, `babysunray_dev` only), `npm run media:verify` (read-only check of the photo manifest against `MEDIA_STORAGE_DIR`), `npm run media:backup`, `npm run media:backup:verify` and `npm run media:restore` (encrypted photo backups; interactive passphrase; the founder runs them, never on their behalf; restore only into an empty folder), `npm run media:drill` (photo backup and restore drill on fictional photos in `babysunray_test`), `npm run recovery:check` (read-only check that a restored `babysunray_restore` matches a photo backup; interactive passphrases; the founder runs it, never on their behalf), `npm run perf:bench` (performance benchmark on fictional data in `babysunray_test` only), `npm run staging:preflight` (no network; which staging settings are missing, no values), `npm run staging:setup` (repairs `.env.staging.local` URL encoding and derives the project URL; hidden prompt for the Supabase keys; prints names only, no network), `npm run migrations:review [-- --after <n>]` (text-only check of drizzle/*.sql for non-additive statements; connects to nothing), `npm run backup:status -- --dir <folder> --max-age-hours <n>` (backup freshness from headers; no passphrase, deletes nothing), `npm run netlify:env -- --out <file> --url <https origin>` (writes the application's Netlify variables from the staging file as an importable .env: no administrator connection; prints names only; the founder deletes the file after import), `npm run db:migrate:staging`, `npm run auth:bootstrap-owner:staging`, `npm run backup:create:staging`, `npm run media:verify:staging`, `npm run media:backup:staging` and `npm run test:staging` (a hosted Supabase STAGING project only, marked by the founder; interactive or founder-configured; the founder runs them, never on their behalf; never read `.env.staging.local`; `docs/operations/staging-setup.md`). Never point tests at a development, shared or hosted database. Run migrations only through `npm run db:migrate`, never `drizzle-kit push`, `drizzle-kit migrate` or `auth migrate` (the project config refuses the drizzle-kit ones).

## Project goals (founder-confirmed; requirements B-8 to B-13)

A complete production-minded system for the founder's real business, delivered in phases and not yet feature-complete; a portfolio-quality full-stack project; an API-driven backend that future web, Windows and Android clients can share; a codebase reusable for a separate client business without BabySunray data. Never describe a capability as implemented until its code and tests exist.

## Authoritative documents

Read the relevant one before working on a subject. They override anything here.

- `docs/product/requirements.md`: what the product must do. Basis labels: **F** founder-stated, **P** proposed (not approved), **F + P** founder-stated core with a proposed detail (only the F part is approved), **Q** open. Never treat P, Q or the P part of F + P as approved, unless the document records the founder's implementation approval for that specific item (for example open decision 18, Gate G.3).
- `docs/adr/0001-application-stack.md`: confirmed stack and unresolved choices.
- `docs/adr/0002-drizzle-and-inventory-foundation.md`: Drizzle, catalogue, stock ledger and money decisions, and what they do not cover.
- `docs/adr/0003-authentication-foundation.md`: Better Auth, sessions, Owner bootstrap, permissions and user actors, and what they do not cover.
- `docs/adr/0004-api-v1-and-bearer-transport.md` and `docs/api/README.md`: the `/api/v1` foundation, Bearer transport, errors, pagination, body limits, CORS, rate limits and compatibility rules.
- `docs/adr/0005-operation-idempotency.md`: operation-level idempotency for writes.
- `docs/adr/0006-product-media-storage.md`: product photo storage (local development folder, manifest).
- `docs/adr/0007-guest-checkout-foundation.md` and `docs/operations/launch-readiness.md`: the inactive guest checkout, the launch gate, policy drafts and product reviews.

When a document and the code disagree, stop and report it. Do not silently reconcile.

## Decision ownership and gates

The founder owns every product, business, budget and architecture decision. Work proceeds in gates (A, B, C, ...). Each gate is approved explicitly and authorises only the work it names.

- Finish the current gate, report, and stop. Never start the next gate on your own.
- When a choice is needed that the documents leave open, ask. Do not pick a default and present it as decided.
- Never invent business rules, policies, prices, delivery charges, fabric claims or KPIs.

## Stack

Confirmed: Next.js (App Router), React, TypeScript, Node.js, PostgreSQL, Tailwind CSS with a custom design system, one modular monolith with no separate backend server, Drizzle ORM with reviewed SQL migrations (`docs/adr/0002-drizzle-and-inventory-foundation.md`), Better Auth with email and password and database browser sessions (`docs/adr/0003-authentication-foundation.md`).

Built: `/api/v1` with Bearer only (never cookies) and OpenAPI 3.1 (ADR-0004), Owner-only writes through the idempotent operations in `src/modules/*/operations.ts` (ADR-0005). Every new write must use those operations (or `runOnce`) and `apiPost`. Do not add CORS origins, public endpoints (the only anonymous ones are guest tracking, the probes, the maintenance call and the shop's acceptance-gated routes) or public checkout without a gate. Never make the launch gate return open, let founder acceptance run on a database that is not marked staging, or route the guest checkout anywhere else, without an explicit founder gate. Unresolved, do not choose: account recovery, 2FA, native apps and token storage, the versioning policy's approval, production hosting, database hosting, final UI design (colours, typography, layout), business rules O-9 to O-14, RPO/RTO.

The logo and its three colours are a brand reference only. They are not the website palette.

## Module boundaries

- Route files (`app/`) handle HTTP, rendering and input parsing. They call domain modules; they do not query the database directly.
- Business rules live in domain modules (catalogue, inventory, orders, customers, reports, auth), not in components.
- Database access stays inside the modules and the database layer.
- Server-only code never ships to the browser.
- One set of domain and application services serves the website and any future API client. Do not duplicate pricing, stock, order or authorisation rules per client, and do not have the website call its own HTTP endpoints when it can call the services directly. No separate backend server, microservices, monorepo or API gateway.

## Security and privacy (summary; see `.claude/rules/security.md`)

- Authenticate and authorise every Owner Office page, server action and API on the server.
- Customer names, phones and addresses never go into logs, URLs, analytics, error reports, commits or test fixtures. Use fictional data.
- Never read, print or commit secrets. `.env.example` holds variable names only.
- Do not claim something is secure, backed up or restorable without a test that shows it.

## Quality

- Smallest change that fully meets the requirement. No speculative features, options or abstractions.
- Add a dependency only when it clearly beats a few lines of code, and say why.
- Business logic that touches money, stock, orders, exports or access gets automated tests.
- Update the relevant document in the same change as the code it describes.

## Before saying "done"

Run the checks that exist (`npm run typecheck`, `npm run lint`, `npm run build`; tests once added) and report the real output, including failures. If a check does not exist yet or was not run, say so. Do not report unverified work as complete.

## Never without explicit founder approval

- Purchases, trials, billing details, paid services, or connecting external accounts.
- Deployment or publishing of any kind.
- `git init`, commits, pushes, or history rewrites.
- Installing or removing packages, plugins, skills, hooks or MCP servers.
- Deleting, moving or overwriting files you did not create in this task.
- Database creation, migrations against shared data, or anything touching real customer data.
- Changes to confirmed stack choices or the module structure.

## Language

Documents and code: English. Reports to the founder: concise Bangla with English technical terms.
