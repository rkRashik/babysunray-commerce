# BabySunray Commerce

The website and private Owner Office for BabySunray, a Bangladesh-focused baby and kidswear business. The site will be bilingual (Bangla and English), mobile-first, with guest cash-on-delivery checkout and assisted orders from Messenger and WhatsApp. The Owner Office covers products, stock, orders, reports, exports and backup and recovery.

## Status

**Foundation and decisions phase.** The Next.js application is scaffolded as an engineering base only. `src/app/page.tsx` is a development-status page that proves the framework renders; it is not the approved homepage. There are no storefront or Owner Office features, application database schema, authentication or deployment. Local PostgreSQL tooling for development and integration tests is in place (see below). The two local databases are created by the founder with `db/local-setup.sql`; no business tables exist. The Git repository is private on GitHub (`rkRashik/babysunray-commerce`).

Requirements and the stack decision are drafts under founder review.

## Development

Requires Node.js 20.9 or newer (Next.js minimum). Verified on Node.js 24.19.0 and npm 11.17.0; `.nvmrc` records major version 24.

```
npm install        # install dependencies from package-lock.json
npm run dev        # development server at http://localhost:3000
npm run typecheck  # TypeScript strict check
npm run lint       # ESLint
npm run build      # production build
npm start          # serve the production build
npm test           # unit tests (Vitest); no database needed
npm run test:db    # database integration tests; needs PostgreSQL and TEST_DATABASE_URL
```

`npm run test:db` fails, rather than skipping, when `TEST_DATABASE_URL` is missing, PostgreSQL is unreachable, or the URL does not point at a local database whose name ends in `_test`.

Version constraints (checked 2026-11-14): TypeScript is held at 6.0.x because `typescript-eslint` supports TypeScript below 6.1. ESLint is held at 9.x because `eslint-config-next` depends on plugins that do not yet declare ESLint 10 support. Revisit both when the plugins update.

## Local PostgreSQL

Development uses a local PostgreSQL 18 server. Hosting and the ORM are undecided; the tests use the plain `pg` driver. The setup creates two isolated databases, each with its own non-superuser role that cannot connect to the other database:

| Database | Role | Purpose |
|---|---|---|
| `babysunray_dev` | `babysunray_dev` | local development |
| `babysunray_test` | `babysunray_test` | integration tests |

One-time setup, run by you as a PostgreSQL superuser (it never overwrites: it stops if a role or database already exists):

```
psql -U postgres -f db/local-setup.sql
psql -U postgres -c "\password babysunray_dev"
psql -U postgres -c "\password babysunray_test"
```

`\password` prompts without echo, so no password is stored in a file or shell history. Then copy `.env.example` to `.env.local` and fill in the two connection strings (`DATABASE_URL`, `TEST_DATABASE_URL`). `.env.local` is gitignored. Connection strings are server-side only: never prefix them with `NEXT_PUBLIC_`.

The PostgreSQL service on this machine requires a password for `postgres`, so the setup above was not run by Claude Code. The same script, tests and checks were run against a temporary PostgreSQL 18.6 cluster that was deleted afterwards.

## Documentation

| Document | Purpose | Status |
|---|---|---|
| [Product requirements](docs/product/requirements.md) | What the product must do, with open decisions | Draft — Founder Review |
| [ADR-0001: Application stack](docs/adr/0001-application-stack.md) | Confirmed technology and unresolved choices | Draft — Founder Review |
| [CLAUDE.md](CLAUDE.md) | Working rules for Claude Code in this repository | Active |

## Stack

Confirmed: Next.js (App Router), React, TypeScript, Node.js, PostgreSQL, Tailwind CSS, one modular monolith.
Not yet decided: ORM, authentication, production and database hosting, final visual design.

## Data handling

Customer data, database dumps, backups, exports, secrets and private business documents never belong in this repository. See `.gitignore`.
