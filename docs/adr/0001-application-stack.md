# ADR-0001: Application stack

**Status:** Draft — Founder Review (revision A.2)
**Date:** 2026-11-14
**Deciders:** Founder
**Related:** [Product requirements](../product/requirements.md)

**In short:** The stack choices in "Decision" are **confirmed by the founder**. Hosting, database host, ORM, authentication, the API contract style and the final UI design are **unresolved**. Revision A.2 clarifies that future Windows and Android clients use the same backend capabilities inside the same monolith; it adds no new technology.

## Context

BabySunray needs a bilingual (Bangla and English) e-commerce website and a private Owner Office for a single-founder baby and kidswear business in Bangladesh. Website infrastructure and software budget is BDT 0 by default. Data ownership, exports and verified backup and restore are launch-critical.

Earlier work explored a Cloudflare Workers plus D1 direction, a framework-agnostic design prototype, and a Cloudflare-based proof-of-concept plan. The founder has restarted from a clean foundation and confirmed a different technology direction. This ADR records that direction and what remains open.

## Decision (founder-approved)

| Area | Choice |
|---|---|
| Framework | Next.js, App Router |
| UI library | React |
| Language | TypeScript |
| Runtime | Node.js |
| Database | PostgreSQL |
| Styling | Tailwind CSS with a custom, professional design system |
| Architecture | One **modular monolith**. No separate backend server initially. |
| Experience | Premium, product-first, bilingual, Bangladesh-focused e-commerce |
| Office | Private Owner Office with reporting, exports, backups and recovery |
| Cost | Zero-cost infrastructure requirement (requirements C-1 to C-5) |

### Expected consequences

These follow from the decision. They are expectations, not additional approvals.

- Storefront, Owner Office and server logic live in one Next.js application, split into domain modules with explicit boundaries rather than into services.
- PostgreSQL is the system of record. Consistency rules (stock holds, idempotent orders) are enforced by database transactions, not by client code. The rules themselves are business decisions (requirements O-9 to O-14).
- The website and any future API clients (web, Windows, Android; requirements B-11, API-1) use the same server-side domain services. The API is part of the monolith: no separate backend server, Express, microservices, monorepo or API gateway is introduced.
- Standard PostgreSQL logical dumps keep data portable between hosts.
- Next.js with PostgreSQL narrows the realistic **free hosting** options. This is the main risk.

## Unresolved

None of these is decided. None may be treated as chosen until the founder approves it.

| # | Item | State | What is needed | Recorded in |
|---|---|---|---|---|
| 1 | **Production hosting** | Open | A zero-cost option that permits commercial use and runs Next.js. A Bangladesh-hosted plan under BDT 1,500 per year may be evaluated as an alternative. Purchase needs separate founder approval. | ADR |
| 2 | **Database host** | Open | PostgreSQL hosting with backups and a restore procedure that fit the budget and the approved RPO and RTO (requirement K-9). | ADR (with item 1 if they share a decision) |
| 3 | **ORM** | Drizzle proposed (Gate G.2 review) and founder-endorsed; Prisma is the alternative. **Explicit implementation approval pending.** | Founder approval to implement. Nothing is installed or configured until then. | ADR |
| 4 | **Authentication** | Open | An established solution, not a custom protocol. Sessions, CSRF protection, lost-device recovery, and a credential strategy for future native clients (requirement API-10). | ADR |
| 5 | **Final UI design** | Open | Colours, typography, layout and components need design research and founder approval. The logo is a brand reference only. | Design documents |
| 6 | Internationalisation, test tooling, CI, image handling, XLSX library | Open | Chosen when the work reaches them. | `docs/development.md` or the pull request. An ADR only if the choice turns out to be material. |
| 7 | **API contract** | Proposed, not approved | A versioned REST API (for example under `/api/v1`) implemented with Next.js Route Handlers and described in OpenAPI, over the same domain services the website calls directly. Endpoint paths, versioning policy and native-client authentication are decided in later gates (requirements API-1 to API-12). | ADR |

## Known risks

**Zero-cost production hosting for Next.js with PostgreSQL is not proven.** Earlier research noted the following. They must be re-verified against current official terms before any decision, because terms change:

- Vercel Hobby restricts commercial use.
- Supabase Free pauses inactive projects and does not include automatic database backups.
- Neon Free offers a short restore window.
- GitHub Pages does not permit e-commerce.

The hosting decision must record, for the chosen host: commercial-use permission, limits, pause or suspension behaviour, backup and restore capability, and what happens when limits are exceeded.

Other risks:

- Server-rendering every page on a free tier can exhaust request or CPU limits. Catalogue pages should stay cacheable or static where possible.
- Card data is not collected on a free-tier host unless that host's terms and the founder's approval permit it. The launch payment method is cash on delivery.
- A free tier can change or be withdrawn. Standard PostgreSQL and a documented restore keep the application able to move host.

## Development and deployment boundaries

- **Local development** with a local PostgreSQL instance, including schema work and automated tests, does **not** wait for hosting. It may begin after separate founder approval. Schema and logic that depend on undefined business rules still wait for those rules (requirements G-10).
- **Production deployment** requires validated hosting, working backups and restore, and confirmed commercial-use terms (requirements G-8).
- No paid service, trial or purchase happens without separate founder approval.

## ADR policy

ADRs are for **material architectural decisions**: choices that are costly to reverse or that shape the system, such as hosting and database, ORM and authentication. Minor implementation choices are recorded in development documentation or in the pull request that makes them. An approved ADR is not edited; a change supersedes it with a new ADR.

## Superseded and discarded

| Item | Status |
|---|---|
| Cloudflare Workers, static assets and D1 as the preferred stack | **Superseded** by this ADR. Its platform-specific details are not carried forward. |
| Framework-agnostic design prototype (`design-proof/`) | **Discarded.** Its colours, layouts and typography are not approved and are not a foundation for the new application. |
| Earlier recommendation of a paid monthly architecture | Never approved. |

Stack-independent acceptance criteria from earlier reviews (atomic stock, idempotency, exports, restore drills) are carried into the requirements document, section 9.
