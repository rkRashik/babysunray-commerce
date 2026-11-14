# BabySunray Commerce

The website and private Owner Office for BabySunray, a Bangladesh-focused baby and kidswear business. The site will be bilingual (Bangla and English), mobile-first, with guest cash-on-delivery checkout and assisted orders from Messenger and WhatsApp. The Owner Office covers products, stock, orders, reports, exports and backup and recovery.

## Status

**Foundation and decisions phase.** The application has not been scaffolded: there is no source code, package manifest, database or deployment. A local Git repository exists (branch `main`, no remote). Installation, test and run instructions will be added when the project is created.

Requirements and the stack decision are drafts under founder review.

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
