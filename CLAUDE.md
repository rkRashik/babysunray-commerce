# BabySunray Commerce

Bilingual (Bangla/English) e-commerce website and private Owner Office for BabySunray, a single-founder baby and kidswear business in Bangladesh.

**Phase:** foundation and decisions. The Git repository is private on GitHub (`rkRashik/babysunray-commerce`, branch `main`). The Next.js app is scaffolded as an engineering base only; `src/app/page.tsx` is a status page, not the approved homepage. The catalogue and stock schema (`src/db/schema.ts`, migrations in `drizzle/`), their internal services (`src/modules/`), the authentication and authorisation foundation (`src/modules/auth`, Better Auth routes under `/api/auth`), operation-level idempotency (`src/modules/idempotency`, ADR-0005) and an Owner-only, Bearer-authenticated `/api/v1` with draft-catalogue and stock writes, body limits, no CORS and per-user rate limits (`src/api/v1`, `src/app/api/v1`, `docs/api/README.md`) exist, as does a minimal functional Owner Office at `/office` (`src/app/office`: sign-in, products, variants, stock; Server Actions call the shared operations directly; not an approved design); orders, reservations, selling, account recovery, 2FA and deployment do not. The local databases are created by the founder from `db/local-setup.sql`. Do not create the rest unless the current gate authorises it.

Commands (see README.md): `npm install`, `npm run dev`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` (unit), `npm run test:db` (PostgreSQL integration; needs `TEST_DATABASE_URL`, local `babysunray_test` database and role only), `npm run db:generate`, `npm run db:check`, `npm run db:migrate` (only the local `babysunray_dev` database; it verifies the target and refuses anything else), `npm run test:contract` (OpenAPI validity and every `/api/v1` endpoint against it), `npm run auth:bootstrap-owner` (creates the first Owner; interactive, for the founder to run; never run it or choose credentials on the founder's behalf). Never point tests at a development, shared or hosted database. Run migrations only through `npm run db:migrate`, never `drizzle-kit push`, `drizzle-kit migrate` or `auth migrate` (the project config refuses the drizzle-kit ones).

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

When a document and the code disagree, stop and report it. Do not silently reconcile.

## Decision ownership and gates

The founder owns every product, business, budget and architecture decision. Work proceeds in gates (A, B, C, ...). Each gate is approved explicitly and authorises only the work it names.

- Finish the current gate, report, and stop. Never start the next gate on your own.
- When a choice is needed that the documents leave open, ask. Do not pick a default and present it as decided.
- Never invent business rules, policies, prices, delivery charges, fabric claims or KPIs.

## Stack

Confirmed: Next.js (App Router), React, TypeScript, Node.js, PostgreSQL, Tailwind CSS with a custom design system, one modular monolith with no separate backend server, Drizzle ORM with reviewed SQL migrations (`docs/adr/0002-drizzle-and-inventory-foundation.md`), Better Auth with email and password and database browser sessions (`docs/adr/0003-authentication-foundation.md`).

Built: `/api/v1` with Bearer only (never cookies) and OpenAPI 3.1 (ADR-0004), Owner-only writes through the idempotent operations in `src/modules/*/operations.ts` (ADR-0005). Every new write must use those operations (or `runOnce`) and `apiPost`. Do not add CORS origins, public endpoints, selling or order endpoints without a gate. Unresolved, do not choose: account recovery, 2FA, native apps and token storage, the versioning policy's approval, production hosting, database hosting, final UI design (colours, typography, layout), business rules O-9 to O-14, RPO/RTO.

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
