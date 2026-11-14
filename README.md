# BabySunray Commerce

The website and private Owner Office for BabySunray, a Bangladesh-focused baby and kidswear business. The site will be bilingual (Bangla and English), mobile-first, with guest cash-on-delivery checkout and assisted orders from Messenger and WhatsApp. The Owner Office covers products, stock, orders, reports, exports and backup and recovery.

## Status

**Foundation and decisions phase.** The Next.js application is scaffolded as an engineering base only. `src/app/page.tsx` is a development-status page that proves the framework renders; it is not the approved homepage. There are no storefront or Owner Office features, database, authentication, tests or deployment. A local Git repository exists (branch `main`, no remote).

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
```

No automated test script exists yet.

Version constraints (checked 2026-11-14): TypeScript is held at 6.0.x because `typescript-eslint` supports TypeScript below 6.1. ESLint is held at 9.x because `eslint-config-next` depends on plugins that do not yet declare ESLint 10 support. Revisit both when the plugins update.

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
