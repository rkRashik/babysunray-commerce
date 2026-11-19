# Installing a separate copy

**Status:** Draft — Founder Review. **Purpose:** How to set up this codebase as a separate, local installation for another business, using fictional data only (requirements B-12, RU-1 to RU-6, gate G-14). Not a hosting guide: no production hosting is chosen.

Multi-tenant use is out of scope (section 11 of the requirements): each business gets its own checkout of the code, database, secrets, photo folder and settings (RU-2). One installation is one business. The procedure below has been rehearsed automatically on this machine (section 5); a rehearsal on a second machine with its own PostgreSQL server has not been done, so G-14 is **not met**.

## 1. What a copy must never contain

BabySunray's data never goes into another installation or its repository history (RU-3): no database dump or backup (`*.bsbackup`), no photo backup (`*.bsmedia`), no export file, no photo folder, no `.env.local`, no customer, supplier or order data, no copy of the founder's documents. Start from a clean Git checkout and an empty database.

## 2. Set up

Steps 1 to 4 are the same as for BabySunray, described once in [getting-started.md](../getting-started.md) (tools, local PostgreSQL, configuration, migrations, the first admin account).

1. Node.js 24 and PostgreSQL 18 on the machine; `npm ci` (the locked versions).
2. Create the local databases and roles with `db/local-setup.sql`, as a PostgreSQL superuser.
3. Copy `.env.example` to `.env.local` and fill it in. Generate a new `BETTER_AUTH_SECRET` (`openssl rand -base64 32`); never reuse another installation's. Set the shop identity (section 3). Check with `npm run config:check`, which prints no values.
4. `npm run db:migrate`, then `npm run auth:bootstrap-owner` (the new business's own Owner, chosen by them).
5. Photos (optional): create a folder outside the project, set `MEDIA_STORAGE_DIR`, restart, run `npm run config:check` again.
6. Prove the copy works without any real data: `npm test`, `npm run test:db`, `npm run test:e2e`, `npm run backup:drill` and `npm run media:drill` use only fictional data in the test database.

## 3. Shop identity settings

**Implemented and Tested** (`src/config/installation.ts`, `tests/modules/installation.test.ts`, `tests/install`). All optional. Without them the storefront preview shows the neutral name "Storefront", no description and no contact, so a fresh copy shows nothing of another business. They are read on the server when a page renders; restart after changing them. `npm run config:check` reports each problem by setting name and rule, never the value.

| Setting | Shown | Rule |
|---|---|---|
| `STORE_NAME` | Preview header and home page, the development status page and its title | At most 60 characters, no line breaks or control characters. |
| `STORE_LINE_EN`, `STORE_LINE_BN` | A one-line description on the preview home page and footer, in that language (the other language if one is missing, marked with its `lang`) | At most 200 characters each. |
| `STORE_CONTACT_PHONE`, `STORE_CONTACT_EMAIL` | The preview footer, only when set | Digits, spaces, hyphens and an optional leading `+`; an email address. |
| `STORE_THEME_INK`, `STORE_THEME_ACCENT`, `STORE_THEME_PAPER` | Storefront text colour, action colour (buttons, the current tab) and page colour (defaults: First Light, the approved logo colours `#332923`, `#c28b56`, `#f9f6f1`; [design system](../design/storefront-design-system.md)) | `#rrggbb`. Refused, with the defaults kept, unless text stays readable: ink on paper at least 7:1; ink on the action colour, the fixed secondary text and error colours on paper, and paper and the light footer tone on ink at least 4.5:1 (WCAG contrast). |

Logo: each installation has its own `logo.png` (the wordmark) and `mark.png` (the compact mark) in `public/brand/`, served from the site's own origin. BabySunray's approved logo (Direction A, background removed, never redrawn) is committed there, so a Git-based deployment such as Netlify ships it; the repository is private. **A copy for another business must delete or replace both files before handover** (the rehearsal does this in its clean clone). Without the files, the storefront, the tracking page and the Office show the shop's name as text (`src/app/_design/brand.tsx`). Product photos never go into the repository.

**Not settings,** because they are business decisions an installation makes in code and policy, never values a user can change:

| What | Where | Note |
|---|---|---|
| Order rules (verification window, return window, tracking lifetime, COD, cancellation) | `src/modules/orders/rules.ts`, [order-policy-decisions.md](../product/order-policy-decisions.md) | BabySunray's founder-approved rules. Another business must decide its own. |
| Delivery zones | Schema and order rules; charges in Owner Office → Delivery charges | Two zones (Dhaka City, Outside Dhaka). Other zones are a code and migration change. |
| Interface wording | `src/modules/storefront/i18n.ts` | Generic, English and Bangla (a unit test compares the keys). The shop's own words are the settings above. |
| Local database and role names | `db/local-setup.sql`, `src/db/connection-guard.mts` | The guards accept only `babysunray_dev`, `babysunray_test` and `babysunray_restore` on the local machine. A copy can keep these local names, or change both files together (the guard tests cover them). |
| File format markers | `src/db/backup.mts`, `src/modules/media/backup.ts` | Identify the backup formats only; not shown to customers. |

The API's OpenAPI document is brand-neutral (a test checks it contains no brand or installation data).

## 4. Moving a copy's data

Database: `npm run backup:create` on one installation, `npm run backup:restore` into an empty `babysunray_restore` on the other ([runbook](runbook.md)). Photos: `npm run media:backup` and `npm run media:restore` into an empty folder. Restore both from the same moment. Never move BabySunray's backups into another business's installation (RU-3).

## 5. Rehearsal of a separate installation

`npm run test:install` (`tests/install/setup.ts`, `playwright.install.config.ts`) does automatically what a new installation does, with a fictional business ("Rehearsal Kids Shop", `tests/install/identity.ts`):

1. `git clone` of the committed HEAD into a new temporary folder outside the project: no working-tree changes, no `.env` file, no `node_modules`, no photos, no build output. It stops if the clone is not exactly that commit.
2. `npm ci --offline --ignore-scripts` in the clone: the locked versions from the local npm cache, with no network and no install scripts.
3. The clone's own `npm run backup:drill` and `npm run media:drill` (database and photo backup, verify, restore on fictional data), given only `TEST_DATABASE_URL`.
4. `babysunray_test` reset and migrated from the clone's migrations; one fictional Owner with a new random password; a new random auth secret; a new empty photo folder; the fictional identity and colours.
5. The clone's `next build` and `next start` (`NODE_ENV=production`, behind the local TLS proxy of `test:e2e:prod`), with proof that it signs in against `babysunray_test`.
6. Every browser test of `tests/e2e` and `tests/e2e-prod` against that copy (sign-in, catalogue, import, stock, assisted orders, COD, returns, photos and photo health, reports, exports, the preview in both languages, accessibility, a phone screen), then `tests/install/rehearsal.spec.ts`: the configured name, description, contact and colours in both languages; no page, title or template of the copy mentions BabySunray; the only account is the fictional Owner; no row of any table mentions BabySunray.

The clone, photo folder and certificate are deleted at the end. The founder's `.env.local`, development database, Owner account and photo folder are never read or used (only `TEST_DATABASE_URL` is taken from the project's environment files).

**Result (2026-11-16, commit `f04a193`):** passed. Clean clone 1 s; offline `npm ci` 40 s (452 packages); the clone's `backup:drill` 9 s and `media:drill` 9 s; `next build` 29 s; 53 of 53 browser tests passed in 3.3 minutes (51 from `tests/e2e` and `tests/e2e-prod`, 2 from `tests/install`); no rehearsal folder was left behind.

**What it does not show (so G-14 stays open):** an independent PostgreSQL server (the database guards accept only the local `babysunray_test` database and role, on the same server as the founder's development database), a second machine or operating-system user, an online `npm ci` (packages came from this machine's cache), the founder-run commands `auth:bootstrap-owner`, `db:migrate` and the interactive backup commands (the drills exercise the same code), and a licence review (section 6).

## 6. Licence inventory (RU-5)

Exact versions from `package-lock.json` on 2026-11-16, with the licence each package declares. This is an inventory, not a legal review: nobody has checked the licences' obligations for a handover or sale, and transitive packages are not listed one by one (`npm ls --all` shows them).

| Component | Version | Declared licence | Shipped with the application |
|---|---|---|---|
| Next.js (`next`, `@next/swc-*`) | 16.4.6 | MIT | Yes |
| React, React DOM | 19.3.1 | MIT | Yes |
| Better Auth (`better-auth`, `@better-auth/core`) | 1.7.25 | MIT | Yes |
| Drizzle ORM | 0.45.4 | Apache-2.0 | Yes |
| `pg` | 8.23.1 | MIT | Yes |
| Zod | 4.6.7 | MIT | Yes |
| `server-only` | 0.0.1 | MIT | Yes |
| `sharp` | 0.35.5 | Apache-2.0 | Yes |
| libvips and its libraries (prebuilt `@img/sharp-win32-x64` 0.35.5; `@img/sharp-libvips-*` 1.3.4 on Linux) | libvips 8.18.7 | LGPL-3.0-or-later (the Windows package declares Apache-2.0 AND LGPL-3.0-or-later) | Yes, as a native library. LGPL obligations (for example letting a recipient replace the library) need review before any handover. |
| Tailwind CSS, `@tailwindcss/postcss` | 4.3.5 | MIT | Build tool; its generated CSS ships |
| PostCSS | 8.5.33 | MIT | Build only |
| TypeScript | 6.0.3 | Apache-2.0 | Build only |
| Drizzle Kit | 0.31.11 | MIT | Development only |
| ESLint, `eslint-config-next` | 9.39.5, 16.4.6 | MIT | Development only |
| Vitest | 5.1.0 | MIT | Development only |
| Playwright (`@playwright/test`, `playwright`, `playwright-core`) | 1.64.1 | Apache-2.0 | Development only; the Chromium it downloads has its own licences |
| `@axe-core/playwright` | 4.14.0 | MPL-2.0 | Development only |
| `read-excel-file` | 9.3.14 | MIT | Development only (tests read the XLSX exports with it). The application reads and writes XLSX with its own code. |
| `ajv`, `ajv-formats`, `@seriousme/openapi-schema-validator` | 8.20.0, 3.0.1, 2.11.0 | MIT | Development only |
| Fonts | Fraunces, Figtree, Tiro Bangla, Hind Siliguri (`@fontsource` 5.3, self-hosted) | SIL Open Font License 1.1 | Bundled from the packages at build time; nothing is fetched from another site. |
| Logo and photos | the logo files are in `public/brand/`; photos are not in the repository | — | BabySunray's logo is deleted or replaced in a copy for another business; its photos are never part of a copy. |
| PostgreSQL 18 and its `pg_dump` / `pg_restore` | installed separately | PostgreSQL Licence | Not shipped; each installation installs its own. |
