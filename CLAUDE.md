# BabySunray Commerce

Bilingual (Bangla/English) e-commerce website and private Owner Office for BabySunray, a single-founder baby and kidswear business in Bangladesh.

**Phase:** foundation and decisions. A local Git repository exists (branch `main`, no remote). The Next.js app is scaffolded as an engineering base only; `src/app/page.tsx` is a status page, not the approved homepage. There is no application database schema, authentication or deployment yet. Local PostgreSQL test tooling exists (the local databases are created by the founder from `db/local-setup.sql`); there are no business tables. Do not create the rest unless the current gate authorises it.

Commands (see README.md): `npm install`, `npm run dev`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` (unit), `npm run test:db` (PostgreSQL integration; needs `TEST_DATABASE_URL`, local `_test` database only). Never point tests at a development, shared or hosted database.

## Authoritative documents

Read the relevant one before working on a subject. They override anything here.

- `docs/product/requirements.md`: what the product must do. Basis labels: **F** founder-stated, **P** proposed (not approved), **F + P** founder-stated core with a proposed detail (only the F part is approved), **Q** open. Never treat P, Q or the P part of F + P as approved.
- `docs/adr/0001-application-stack.md`: confirmed stack and unresolved choices.

When a document and the code disagree, stop and report it. Do not silently reconcile.

## Decision ownership and gates

The founder owns every product, business, budget and architecture decision. Work proceeds in gates (A, B, C, ...). Each gate is approved explicitly and authorises only the work it names.

- Finish the current gate, report, and stop. Never start the next gate on your own.
- When a choice is needed that the documents leave open, ask. Do not pick a default and present it as decided.
- Never invent business rules, policies, prices, delivery charges, fabric claims or KPIs.

## Stack

Confirmed: Next.js (App Router), React, TypeScript, Node.js, PostgreSQL, Tailwind CSS with a custom design system, one modular monolith with no separate backend server.

Unresolved, do not choose: ORM (Drizzle or Prisma), authentication, production hosting, database hosting, final UI design (colours, typography, layout), business rules O-9 to O-14, RPO/RTO.

The logo and its three colours are a brand reference only. They are not the website palette.

## Module boundaries

- Route files (`app/`) handle HTTP, rendering and input parsing. They call domain modules; they do not query the database directly.
- Business rules live in domain modules (catalogue, inventory, orders, customers, reports, auth), not in components.
- Database access stays inside the modules and the database layer.
- Server-only code never ships to the browser.

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
