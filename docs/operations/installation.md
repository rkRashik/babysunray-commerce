# Installing a separate copy

**Status:** Draft — Founder Review. **Purpose:** How to set up this codebase as a separate, local installation for another business, using fictional data only (requirements B-12, RU-1 to RU-6, gate G-14). Not a hosting guide: no production hosting is chosen.

Multi-tenant use is out of scope (section 11 of the requirements): each business gets its own checkout of the code, database, secrets, photo folder and deployment (RU-2). Nothing in this procedure has been rehearsed end to end on a second machine yet; G-14 is not met.

## 1. What a copy must never contain

BabySunray's data never goes into another installation or its repository history (RU-3): no database dump or backup (`*.bsbackup`), no export file, no photo folder, no `.env.local`, no customer, supplier or order data, no copy of the founder's documents. Start from a clean Git checkout and an empty database.

## 2. Set up

Steps 1 to 4 are the same as for BabySunray, described once in the [README](../../README.md) (Development, Local PostgreSQL, Database migrations, Authentication).

1. Node.js 24 and PostgreSQL 18 on the machine; `npm install`.
2. Create the local databases and roles with `db/local-setup.sql`, as a PostgreSQL superuser.
3. Copy `.env.example` to `.env.local` and fill it in. Generate a new `BETTER_AUTH_SECRET` (`openssl rand -base64 32`); never reuse another installation's. Check with `npm run config:check`, which prints no values.
4. `npm run db:migrate`, then `npm run auth:bootstrap-owner` (the new business's own Owner, chosen by them).
5. Photos (optional): create a folder outside the project, set `MEDIA_STORAGE_DIR`, restart, run `npm run config:check` again.
6. Prove the copy works without any real data: `npm test`, `npm run test:db`, `npm run test:e2e` and `npm run backup:drill` use only fictional data in the test database.

## 3. Business-specific settings to change

| What | Where | Note |
|---|---|---|
| Shop name | `src/config/brand.ts` | Shown in the storefront preview. |
| Interface wording, including the store line ("delivered across Bangladesh from Dhaka") | `src/modules/storefront/i18n.ts` | English and Bangla. Rewrite for the new business; keep both languages complete (a unit test compares the keys). |
| Delivery zones | Owner Office → Delivery charges | The two zones (Dhaka City, Outside Dhaka) are in the order rules and the schema; other zones are a code and migration change. |
| Order rules (verification window, return window, tracking lifetime) | `src/modules/orders/rules.ts`, [order-policy-decisions.md](../product/order-policy-decisions.md) | BabySunray's founder-approved rules. Another business must decide its own. |
| Local database and role names | `db/local-setup.sql`, `src/db/connection-guard.mts` | The guards accept only `babysunray_dev`, `babysunray_test` and `babysunray_restore` on the local machine. A copy can keep these local names, or change both files together (the guard tests cover them). |
| Backup file marker | `src/db/backup.mts` (`format: "babysunray-backup"`) | Only identifies the file format; harmless to keep. |
| Development status page title | `src/app/layout.tsx`, `src/app/page.tsx` | Development build only. |

The API's OpenAPI document is brand-neutral (a test checks it contains no brand or installation data).

## 4. Licences to review before handing over a copy (RU-5)

| Component | Licence | Note |
|---|---|---|
| `sharp` 0.35.5 | Apache-2.0 | Its prebuilt libvips binaries are LGPL-3.0-or-later. |
| Next.js, React, Drizzle ORM, Better Auth, Zod, `pg` | MIT or similar | Check the exact versions in `package-lock.json`. |
| `@axe-core/playwright`, `read-excel-file`, Playwright | MPL-2.0, MIT, Apache-2.0 | Development only; not shipped to customers. |
| Fonts | none bundled | The storefront preview uses the device's own fonts. |
| Logo and photos | not in the repository | BabySunray's logo and photos are never part of a copy. |

This table is a starting point, not a completed licence review.
