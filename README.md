# BabySunray Commerce

The website and private Owner Office for BabySunray, a Bangladesh-focused baby and kidswear business. The site will be bilingual (Bangla and English), mobile-first, with guest cash-on-delivery checkout and assisted orders from Messenger and WhatsApp. The Owner Office covers products, stock, orders, reports, exports and backup and recovery.

Long-term goals (founder-confirmed; see requirements B-8 to B-13): a complete, production-minded system that runs the founder's real business; a portfolio-quality full-stack and backend project; an API-driven backend that future web, Windows and Android clients can share with the website; and a codebase that can be rebranded for a separate client business without carrying any BabySunray data. These describe the intended finished product, delivered in phases. Most of it does not exist yet.

## Status

**Foundation and decisions phase.** The Next.js application is scaffolded as an engineering base only. `src/app/page.tsx` is a development-status page that proves the framework renders; it is not the approved homepage. There is no storefront, no public checkout and no deployment; orders are internal, entered by the Owner (see Orders). The backend foundation exists: a catalogue and stock schema with services and idempotent operations, an authentication and authorisation foundation, an Owner API under `/api/v1` for the draft catalogue and physical stock, and a functional Owner Office at `/office` for the same operations, orders, a dashboard, reports, exports, physical stock counts and printable documents (see Catalogue and inventory, Orders, Authentication, API, Owner Office and Backup and recovery), with PostgreSQL integration and browser tests. Local encrypted backups and a restore drill on fictional data exist; no backup schedule, off-device copy or recovery objective is decided. The Office is functional screens only, not an approved visual design. The two local databases are created by the founder with `db/local-setup.sql`. The Git repository is private on GitHub (`rkRashik/babysunray-commerce`).

Requirements and the stack decision are drafts under founder review.

## Development

Requires Node.js 20.9 or newer (Next.js minimum); `npm run db:migrate` needs 22.18 or newer, because it runs a TypeScript script with Node's built-in type stripping. Verified on Node.js 24.19.0 and npm 11.17.0; `.nvmrc` records major version 24.

```
npm install        # install dependencies from package-lock.json
npm run dev        # development server at http://localhost:3000
npm run typecheck  # TypeScript strict check
npm run lint       # ESLint
npm run build      # production build
npm start          # serve the production build
npm test           # unit tests (Vitest); no database needed
npm run test:db    # database integration tests; needs PostgreSQL and TEST_DATABASE_URL
npm run test:contract  # OpenAPI document validity, and every /api/v1 endpoint against it (needs TEST_DATABASE_URL)
npm run test:e2e   # Owner Office in real Chromium (needs TEST_DATABASE_URL; see Browser tests)
npm run test:e2e:prod  # the same browser tests against a production build over local HTTPS (needs openssl)
npm run db:generate  # generate a SQL migration from src/db/schema.ts (review it before committing)
npm run db:check     # check the migration files and snapshots are consistent
npm run db:migrate   # apply pending migrations to the local babysunray_dev database only
npm run config:check  # which settings are set and valid, whether the database is reachable and migrated; prints no values
npm run auth:bootstrap-owner  # create the first Owner in babysunray_dev, interactively (see Authentication)
npm run media:verify  # check the photo manifest of babysunray_dev against MEDIA_STORAGE_DIR; read-only
npm run orders:expire-verification  # release holds of orders past their 24-hour verification deadline (babysunray_dev only; see Orders)
npm run backup:create -- --out <dir>  # encrypted backup of babysunray_dev, interactive (see Backup and recovery)
npm run backup:verify -- <file>       # decrypt and check a backup without touching a database
npm run backup:restore -- <file>      # restore into an empty babysunray_restore only
npm run backup:drill  # backup and restore drill on fictional data in babysunray_test
```

`npm run test:db` fails, rather than skipping, when `TEST_DATABASE_URL` is missing or PostgreSQL is unreachable. Before it changes anything it checks that:

- the URL names a local host, port 5432, the `babysunray_test` database and the `babysunray_test` role, and has no query parameters;
- `DATABASE_URL` does not name the same database;
- PostgreSQL itself reports that database and role, a non-superuser session and a loopback server address.

Each run then compares the database with what the migrations create (`tests/support/schema-inventory.ts`, derived from `src/db/schema.ts` plus a short manual list). If it finds an extra object or metadata of any of these kinds, it stops and changes nothing: schemas, extensions, tables and other relations, columns, constraints, triggers, functions, types, policies, rules, extended statistics, publications and their membership, event triggers, comments on what the reset would drop, privileges (table, sequence, column, function and `drizzle` schema, plus default privileges) and column defaults that differ from the ones the migrations set. Messages name objects, never values (a default's expression or a comment's text is not printed). **Not checked:** column types and nullability, the definitions behind constraint, index and trigger names, function bodies, owners, row-level-security flags, storage options and security labels. This is a guard against mistakes in `babysunray_test`, not a complete comparison with the migrations, and not protection against someone who can run arbitrary SQL. Event triggers are checked, but tests cannot create one (it needs a superuser), so that path is covered with a stubbed catalog result.

If the check passes, the reset drops only the migration-created tables, function and migration history, schema-qualified and with `RESTRICT` (no `CASCADE`, no dropping of schemas other than `drizzle`), in the same transaction as the check. It then replays every migration from scratch over a session whose `search_path` is pinned to `public` (see Database migrations), and runs the tests. When a migration adds an object Drizzle cannot derive (a trigger, function or sequence), add it to the manual list in `schema-inventory.ts` in the same change; when it adds or changes a column default, update the defaults list there. The reset deletes data by design, so it runs only on `babysunray_test`: both the URL and PostgreSQL's own answer must name that database and role. It never touches the development database. Test files use their own fictional fixture rows and run one at a time.

### Browser tests

`npm run test:e2e` drives the Owner Office in headless Chromium with Playwright (`@playwright/test` 1.64.1, Apache-2.0, development only; `playwright.config.ts`, `tests/e2e`). Install the browser once with `npx playwright install --only-shell chromium` (into Playwright's per-user cache, not into the project). The set-up (`tests/e2e/global-setup.ts`) stops before doing anything unless:

- `TEST_DATABASE_URL` passes the same checks as `npm run test:db` and PostgreSQL confirms `babysunray_test`;
- it can take the test-run lock. `npm run test:db` takes the same PostgreSQL advisory lock for its whole run, so the two can never reset the database under each other; the second one is refused at once.

It then resets and migrates `babysunray_test`, creates one fictional Owner with a random password, and starts its own `next dev` on a free `127.0.0.1` port with the test database as `DATABASE_URL`, a random `BETTER_AUTH_SECRET` and its own output directory (`.next/e2e`, with a generated, git-ignored `tsconfig.e2e.json`), so it can run beside your own `npm run dev`. Explicit variables override `.env.local`, which is not changed. Before the first test, a sign-in through that server must create a session row in `babysunray_test`, which proves the server uses the test database. At the end it stops only the process it started and restores `next-env.d.ts`, which `next dev` rewrites. No traces, screenshots or videos are recorded; a failing test leaves a text page snapshot in the git-ignored `test-results/`. The server runs in development mode. `npm run test:e2e:prod` runs the same tests plus production smoke tests (`tests/e2e-prod`) against `next build` + `next start` with `NODE_ENV=production` (output in `.next/e2e-prod`), behind a local TLS proxy with a throwaway self-signed certificate made by `openssl` in a temporary folder (deleted afterwards). Better Auth therefore runs with its production rules, unchanged: an https base URL and Secure cookies; only the test browser is told to accept the certificate. Same database checks and lock as `test:e2e`. Accessibility checks use `@axe-core/playwright` 4.14.0 (MPL-2.0, development only) for WCAG 2.1 A and AA rules on the newer pages.

`better-auth` lists `drizzle-kit` and `vitest` as optional peer dependencies, so npm marks them `devOptional` in `package-lock.json`, and `npm audit --omit=dev` reports four moderate findings: one advisory (GHSA-67mh-4wv8-2f99, esbuild ≤ 0.24.2 development server) along drizzle-kit → @esbuild-kit/esm-loader → @esbuild-kit/core-utils → esbuild 0.18.20. Checked 2026-11-15: drizzle-kit's code never imports @esbuild-kit, nothing starts an esbuild server, drizzle-kit is not in the Next.js build output, and `npm audit --omit=dev --omit=optional` reports 0. There is no non-breaking fix (drizzle-kit 0.31.11 is the latest stable). A production install must use `--omit=dev --omit=optional` (waits for hosting).

Test-only dependency for exports (2026-11-15): `read-excel-file` 9.3.14 (MIT), an independent XLSX reader that checks the generated files.

API dependencies (2026-11-15): `zod` 4.6.7 (runtime; already present through Better Auth). Development only: `ajv` 8.20.0, `ajv-formats` 3.0.1 and `@seriousme/openapi-schema-validator` 2.11.0, for the contract tests. All MIT.

Version constraints (checked 2026-11-14): TypeScript is held at 6.0.x because `typescript-eslint` supports TypeScript below 6.1. ESLint is held at 9.x because `eslint-config-next` depends on plugins that do not yet declare ESLint 10 support. Revisit both when the plugins update.

## Local PostgreSQL

Development uses a local PostgreSQL 18 server, accessed through Drizzle ORM over the `pg` driver ([ADR-0002](docs/adr/0002-drizzle-and-inventory-foundation.md)). Hosting is undecided. The setup creates two isolated databases, each with its own non-superuser role that cannot connect to the other database:

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

## Database migrations

The schema is defined in `src/db/schema.ts`. `npm run db:generate` writes a SQL migration into `drizzle/` with its snapshot metadata; review the SQL (no unexpected `DROP`, destructive `ALTER` or privilege change) and commit it with the schema change. Triggers and other SQL that Drizzle cannot express go into a custom migration (`npx drizzle-kit generate --custom --name=<name>`). Never edit a migration that has been applied; add a new one. `drizzle-kit push` is not used.

- **Development:** `npm run db:migrate` (`scripts/migrate-dev.mts`) applies pending migrations to the local development database and nothing else. Before the first change it requires that `DATABASE_URL` names a local host, port 5432, database `babysunray_dev` and role `babysunray_dev`, with no query parameters, and that PostgreSQL itself reports that database, that role, a non-superuser session, port 5432 and a loopback address. The migrations then run over that same verified connection. `DATABASE_URL` comes from the shell or `.env.local`; if both define it and they differ, the command stops instead of letting a stale shell variable win. Nothing prints a URL or password. It is restricted to `babysunray_dev` because that is the only database approved for it; any other target (test, shared, hosted) needs its own approved procedure, which waits for the hosting decision.
- **Schema resolution (`search_path`):** the migration SQL uses unqualified names, so the schema it lands in depends on the session's `search_path`. The migration and the test reset connect with an explicit startup option `-c search_path=public` (node-postgres then ignores the `PGOPTIONS` variable), set `search_path` to `public` again on the connection, and read the effective value back; anything other than exactly `public` stops them (`src/db/connection-guard.mts`, `src/db/migrate-verified.mts`). The `drizzle` schema needs no entry: Drizzle always writes its history table as `drizzle.__drizzle_migrations`. Only that session changes; no role, database or server setting is touched. A migration file that itself changes `search_path` is not prevented (migrations are reviewed).
- **Direct `drizzle-kit`:** `drizzle.config.ts` allows only `generate` and `check` (no database) and refuses every other command, including `migrate` and `push`; it carries no database credentials (tested in `tests/db/drizzle-config.test.ts`). Limitation: `drizzle-kit --config <another file>` or other command-line options bypass this config. These guards catch mistakes such as a stale variable or the wrong database; they are not an operating-system or database security boundary, and they do not stop someone who can run arbitrary commands or SQL.
- **Tests:** `npm run test:db` replays all migrations into `babysunray_test` on every run (see above). It does not use `drizzle-kit`.

What the checks cover: `db:check` checks only that the migration files and snapshots are consistent with each other. Running `db:generate` and getting "No schema changes" shows the TypeScript schema matches the committed migrations. Neither compares a live database with the schema; the migration integration test checks the tables, constraints and trigger in the freshly migrated test database.

## Catalogue and inventory

Implemented as server-only services in `src/modules/catalogue` and `src/modules/inventory`, with idempotent, permission-checked operations (`operations.ts`) that the API and the Owner Office both call. Each service takes a Drizzle handle from its caller and throws a `DomainError` with a stable code for expected failures.

| Capability | Notes |
|---|---|
| Create a draft product; archive it | Products are `draft` or `archived` only. Nothing is publishable until publication rules are approved. Never deleted. |
| Create a variant (SKU) with its zero stock balance; deactivate it | SKU stored as 1–64 ASCII uppercase letters, digits, hyphens and underscores (input is trimmed and a–z uppercased first), unique in PostgreSQL. Price in integer paisa, strictly positive. Never deleted. |
| Edit a draft product's names and descriptions; edit an active variant's size, colour and price | `updateProduct`, `updateVariant`. Each row has a `version` (migration `0007`) that every update raises; an edit names the version it was based on and is refused with `VERSION_CONFLICT` if the row changed, under a row lock, so concurrent edits never silently overwrite each other. Slug, SKU, ids, status and stock never change here; archived products and their variants, and inactive variants, are not edited. |
| Product content (migration `0011`) | Fabric, care and optional size guidance in English and Bangla, an Owner-defined category (`product_categories`), a featured flag, and a size chart per size and measuring point stored as whole millimetres and shown as centimetres with one decimal (`src/modules/catalogue/content.ts`). The fabric statement counts as confirmed only after the Owner ticks a confirmation, which records who and when; changing the fabric text clears it. Nothing is translated or generated. Same versions, locks and idempotent operations as other edits. |
| Publishing readiness | `evaluateReadiness` (`src/modules/catalogue/readiness.ts`): an advisory, read-only checklist that separates items required by approved requirements (S-1 bilingual name and description, an active priced SKU), proposed rules still waiting for the founder (I-6, S-6: measurements, a confirmed fabric statement, care, the delivery and return explanation) and engineering recommendations (sizes, category, a photo, alt text). **There is no publish action**: nothing makes a product public. |
| Product photos | See Product photos below. |
| Search products | `listProducts` with `q`: slug, English or Bangla name, or any SKU, case-insensitive, NFC-normalised, `%` `_` `\` escaped, bound parameter, at most 100 characters. No index: it reads every product row, fine for a small catalogue. |
| Receive stock; adjust stock with a reason | One transaction per change: conditional balance update plus ledger row. Stock never goes below zero. |
| Read a SKU's balance and movement history | For internal use and tests. |

Known limits:

- No reservations, holds, orders, cancellations, returns or RTO. Checkout overselling (G-1) is not tested because checkout does not exist.
- The services themselves are not idempotent: called twice, `receiveStock` records two receipts. Clients use the idempotent operations in `src/modules/inventory/operations.ts` and `src/modules/catalogue/operations.ts`, which run once per client-generated key and user ([ADR-0005](docs/adr/0005-operation-idempotency.md)). Idempotency records are kept indefinitely until a retention policy is approved.
- An inactive SKU can still receive physical stock; its status does not make it sellable, and nothing sells yet.
- Ledger rows record a `system` actor or an authenticated `user` actor (the user's id, from a verified session; ADR-0003). Changes made through the API or the Office record the signed-in user.
- The append-only ledger trigger can be removed by the table owner or a superuser (ADR-0002).
- Drizzle error messages include query parameters; never log or display them as is.

## Orders

Internal orders under the founder-approved rules in [order-policy-decisions.md](docs/product/order-policy-decisions.md) (states, transitions and defaults there). Server-only services in `src/modules/orders` (`service.ts` submission and lifecycle, `aftercare.ts` COD, returns and inspection, `delivery.ts`, `tracking.ts`, `queries.ts`), with idempotent, permission-checked operations in `operations.ts`; stock holds live in `src/modules/inventory/reservations.ts`. Migration `0008`. **No public checkout:** orders are entered by the Owner (Messenger, WhatsApp, other); the website source exists for later.

| Capability | How |
|---|---|
| Submit | Validates contact (Bangladesh mobile normalised to `01XXXXXXXXX`), merges lines per SKU, snapshots names, variant and unit price, adds the active zone's delivery charge, computes the total, and reserves every line in the same transaction, or creates nothing. No backorders. |
| Stock | `inventory_balances.reserved` with `0 <= reserved <= on_hand`; available = on-hand − reserved. Holds are `stock_reservations` rows ending exactly once (released or consumed). Adjustments cannot take on-hand below reserved. Dispatch lowers on-hand and reserved together and writes one `dispatch` ledger row per line; a passed inspection writes one `return_restock` row. Locks: order row first, then balances in variant order. |
| Lifecycle | Four separate columns: order, fulfilment, payment (derived from the amounts; a database check enforces it), return. Every change names the order version the client saw (`VERSION_CONFLICT` for a stale screen) and appends to `order_events` (append-only, actor recorded). |
| Verification expiry | Deadline 24 hours after submission. Submissions and stock adjustments release overdue holds first, and a late confirmation reserves again only if stock is available, so correctness never depends on a scheduler. `npm run orders:expire-verification` (local `babysunray_dev` only) is the repeatable clean-up batch. **No scheduler runs it**: with production hosting, the host's scheduler should run the same operation every few minutes. |
| COD, returns, RTO | Manual collection and settlement (`payment_entries`, append-only), partial amounts, never above expected or collected; returns and exchanges within 7 days of delivery, quarantine and inspection before any restock, refunds only for approved returns and never above money collected; RTO into quarantine with its charge recorded apart. |
| Guest tracking | A 256-bit random token per order, only its SHA-256 digest stored, revocable and regenerable, valid until 30 days after closing; minimal masked view; customer cancellation by stage. The link is `/track#t=<token>`: the fragment never reaches a server; the page (`src/app/track`) posts it in a same-origin JSON body to `/api/track` and `/api/track/cancel`, which refuse other origins and answer every unusable token with one generic message. After reading the token the page removes it from the address bar and the tab's history and keeps it in memory only, so a reload needs the link again. Limits (`tracking_rate_limits`): 30 requests a minute per live link, and 30 a minute for unknown, revoked or expired tokens from all clients together, which never blocks a live link; malformed tokens cost no lookup. Page and endpoints send `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex` and a same-origin-only content security policy, and load no third-party code. Links exist only when the Owner creates one. |

Known limits: exchange execution is a separate assisted order (who pays the replacement's delivery is not decided); the 7-working-day refund deadline is shown, not computed; a delivered order can be closed only after its 7-day return window (engineering default, Draft — Founder Review); without a trusted proxy (hosting decision) there is no per-client tracking limit, so a flood can still overload the server.

## Authentication

Implemented with Better Auth 1.7.25 ([ADR-0003](docs/adr/0003-authentication-foundation.md)): email and password, sessions stored in PostgreSQL and sent as an HttpOnly cookie, and Owner-first permissions in `src/modules/auth`. The sign-in page is `/office/login` (see Owner Office). No account exists until you create one. The API is described under API.

| Capability | Where |
|---|---|
| Sign-in, sign-out, session listing and revocation, password change | Better Auth's endpoints under `/api/auth` (`src/app/api/auth/[...all]/route.ts`). All other Better Auth endpoints, including public sign-up, answer 404. |
| Verified principal and permission checks for server code | `getPrincipal`, `requirePrincipal`, `requirePermission` in `src/modules/auth/principal.ts`; roles and permissions in `permissions.ts`. |
| Audit actor for an authenticated user | `actorFor(principal)`; stock movements then record the user's id. No other code path creates a user actor. |
| Losing access | Disabling a user (`user_access.disabled_at`) or removing the access row deletes all of that user's sessions at once (migration `0005`). |
| Bearer tokens for non-browser clients | Only on `/api/v1` and Better Auth's own endpoints; never accepted by browser-side code, never sent to a browser (ADR-0004). |
| First Owner | `npm run auth:bootstrap-owner` (below). |
| Lost Owner password, local installation | `npm run auth:reset-owner-password` (below). Not a production recovery path. |

Setup: add `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` to `.env.local` (see `.env.example`; generate the secret with `openssl rand -base64 32`), then run `npm run db:migrate`. The application refuses to start authentication with a missing, short or placeholder secret, a URL that is not a bare origin, plain http outside localhost or in production, or any of `BETTER_AUTH_TRUSTED_ORIGINS`, `BETTER_AUTH_SECRETS` and `BETTER_AUTH_TELEMETRY`.

**Creating the first Owner** (you run this yourself; never share the password):

```
npm run auth:bootstrap-owner
```

It works only in an interactive terminal, only against the local `babysunray_dev` database (the same checks as `db:migrate`), and only while no account exists. It asks for the email and display name, then the password twice without showing it (15 to 128 characters). Nothing is passed on the command line or written to a log. To start again on a development installation you would need to remove the accounts by hand; there is no command for that.

**Resetting a lost Owner password on a local installation** (you run this yourself):

```
npm run auth:reset-owner-password
```

The same restrictions as the bootstrap apply: interactive terminal only, local `babysunray_dev` only (URL checks, then PostgreSQL confirms the database, role, non-superuser session and loopback server), no value on the command line. Before asking anything it checks that the installation has exactly one active Owner; it then asks for that Owner's email and the new password twice without showing it (15 to 128 characters, the sign-in policy). In one transaction, under locks that also serialise a concurrent reset or bootstrap, it checks again that the email belongs to the one active Owner with exactly one password credential, replaces that credential's hash (Better Auth's scrypt) and deletes every session of that Owner, so all signed-in browsers and Bearer tokens stop working at once. Any failure rolls the whole change back. It never creates an account, changes a role, or touches another user, the stock ledger or the Owner's id. It prints only how many sessions were signed out. **Limits:** whoever can run it against the database can take over the Owner account; that is already true of anyone with write access to the authentication tables, so local database and operator access is the trust boundary. It is not an approved production account-recovery mechanism (OF-5 stays open), and there is no HTTP or email reset.

Known limits:

- No production account recovery: password reset over HTTP, email verification and any email sending are disabled. A lost Owner password can be reset only by an operator on a local installation (above). No 2FA.
- No native app exists. A non-browser client can obtain a Bearer token (ADR-0004); it lasts as long as a browser session.
- Rate limiting is stored in PostgreSQL (3 sign-in attempts per 10 seconds per client). No client header is trusted for the client address, so locally every request counts as one client, and in production all clients would share the limit until a proxy setup is chosen with hosting.
- Tested locally only. Production cookie, proxy, secret rotation and database-role settings wait for the hosting decision; nothing here is described as production-ready.

## Product photos

Owner Office only, development storage only (`src/modules/media`, [ADR-0006](docs/adr/0006-product-media-storage.md)). Files live in the folder named by `MEDIA_STORAGE_DIR`: an absolute path to an existing folder **outside** the project (never in Git or `public/`). Without it, photos cannot be uploaded and the Office says why. In production the local folder is refused unless `MEDIA_LOCAL_STORAGE_IN_PRODUCTION=allow` (a deployment decision for a host with a persistent, backed-up disk; no such host is chosen).

- Upload: JPEG, PNG or WebP decided by the file's bytes (never its name), at most 10 MB and 200 to 8,000 pixels a side, read with a byte limit. `sharp` 0.35.5 (Apache-2.0; its prebuilt libvips binaries are LGPL-3.0-or-later, to include in the licence review, RU-5) decodes the whole image, so damaged, truncated, animated or fake files are refused; it is re-encoded in the same format at most 2,400 pixels a side with orientation applied and all metadata removed (EXIF including GPS, XMP, comments). Only that copy is stored, under a random key. SVG, HTML and anything else are refused.
- Management: English and Bangla descriptions (alt text), order (first is shown in lists), replace in place, remove (needs a tick and a confirmation; the stored file is deleted). Every change names the product version, so a second tab is refused, and runs once per idempotency key. At most 12 photos per product (a technical bound; how many a product needs is not decided, I-5).
- Records and files stay in step: a new file is written before its record and deleted again if the record is not committed (refused, failed or a replay); a replaced or removed file is deleted after its record. `product_media` is the manifest (product, key, type, size, SHA-256, times). `npm run media:verify` lists missing, changed, unreferenced and unexpected files; the Exports page has the manifest as a dataset.
- Serving: `/office/media/{id}` for the signed-in Owner only (`401` otherwise), `private, no-cache` with an ETag, `nosniff` and a sandbox policy; `?w=320|640|1280` gives a smaller copy.
- **Database backups do not contain the photo files**: copy the folder separately ([runbook](docs/operations/runbook.md), Product photos).

## API

Owner-only endpoints under `/api/v1`, authenticated with a Bearer token only (browser cookies are refused). The contract is served at `/api/v1/openapi.json`; usage, errors, idempotency, limits, pagination and the compatibility rules are in [docs/api/README.md](docs/api/README.md), decisions in [ADR-0004](docs/adr/0004-api-v1-and-bearer-transport.md) and [ADR-0005](docs/adr/0005-operation-idempotency.md).

| Endpoint | Permission |
|---|---|
| `GET /api/v1/products`, `GET /api/v1/products/{productId}`, `GET .../products/{productId}/readiness`, `GET /api/v1/categories` | `catalog:read` |
| `POST /api/v1/products`, `POST .../products/{productId}/variants`, `.../archive`, `POST .../variants/{variantId}/deactivate`, `PATCH /api/v1/products/{productId}`, `PUT .../products/{productId}/measurements`, `PATCH /api/v1/variants/{variantId}`, `POST /api/v1/categories` | `catalog:write` |
| `POST /api/v1/stock-receipts` / `POST /api/v1/stock-adjustments` | `stock:receive` / `stock:adjust` |
| `GET /api/v1/skus/{sku}/stock` (on-hand, reserved, available), `GET /api/v1/skus/{sku}/movements` | `stock:read` |
| `GET /api/v1/orders`, `GET /api/v1/orders/{orderId}`, `GET /api/v1/delivery-zones` | `orders:read` |
| `POST /api/v1/orders`, `.../transitions`, `.../cancellation-review`, `.../returns`, `.../returns/{returnId}/steps`, `.../tracking-link`, `.../tracking-link/revoke` | `orders:write` (refunds: `payments:record`) |
| `POST .../orders/{orderId}/payments`, `.../rto-charge` | `payments:record` |
| `POST .../orders/{orderId}/inspections/{quarantineItemId}` | `stock:receive` |
| `PUT /api/v1/delivery-zones/{code}` | `settings:write` |

`GET /api/v1/products` also searches (`q`: slug, English or Bangla name, SKU). Edits carry the `version` last read, so a stale client gets `409 VERSION_CONFLICT` instead of overwriting a newer change. Every write needs an `Idempotency-Key` and a JSON body of at most 64 KiB. Requests are rate limited per signed-in user (defaults 300 reads and 60 writes per minute; `API_RATE_LIMIT_READS_PER_MINUTE`, `API_RATE_LIMIT_WRITES_PER_MINUTE`). No CORS access is granted. Not built: public catalogue, public checkout, online payments, courier integrations, and a limit for unauthenticated traffic (needs the hosting decision). Unsupported methods answer 405 and unknown paths 404, both as problem responses.

## Owner Office

A minimal, functional internal area at `/office` (`src/app/office`), built with the existing Next.js App Router and Tailwind CSS. Its neutral layout is **not** an approved design (open decision 4), and `src/app/page.tsx` is unchanged.

| Screen | Does | Permission |
|---|---|---|
| `/office/login` | Email and password sign-in | none |
| `/office` | Products (draft, archived), oldest first, 25 per page; search by English or Bangla name, slug or SKU, status filter, next and first page, all kept in the URL | `catalog:read` |
| `/office/products/new` | Create a draft product (English and Bangla fields) | `catalog:write` |
| `/office/products/{id}` | Details, variants with price (BDT) and on-hand stock; edit links, add a variant, deactivate one, archive the product (both ask for confirmation first) | `catalog:read`, `stock:read`; changes `catalog:write` |
| `/office/products/{id}` (since H.18) | Also: every content field with which languages are missing, the advisory readiness checklist, the size chart, photo thumbnails and a link to the storefront preview | as above |
| `/office/products/{id}/edit` | Edit a draft product's English and Bangla names, descriptions, fabric (with the confirmation tick), care and size guidance, its category and the featured flag (prefilled) | `catalog:read`, `catalog:write` |
| `/office/products/{id}/measurements` | Size chart in centimetres for each size on its active SKUs | `catalog:read`, `catalog:write` |
| `/office/products/{id}/photos` | Upload, describe, reorder, replace and remove photos (Product photos above) | `catalog:read`; changes `catalog:write` |
| `/office/categories` | Create categories (slug, English and Bangla names) and rename them | `catalog:read`, `catalog:write` |
| `/office/variants/{id}/edit` | Edit an active variant's size, colour and price in Taka (prefilled); shows its stock, which the edit never changes | `catalog:read`, `catalog:write`, `stock:read` |
| `/office/orders` | Orders newest first; filter by order status, "needs attention" (deadline passed, expired, open cancellation request) and order number; the four dimensions side by side | `orders:read` |
| `/office/orders/new` | Assisted order (Messenger, WhatsApp, other): customer, Bangladesh phone, address, configured zone, up to 5 SKU lines; stock reserved at once | `orders:write` |
| `/office/orders/{id}` | Statuses, 24-hour verification deadline or expired review, items as ordered with what is still reserved, lifecycle buttons (confirmations before dispatch, close and cancel), cancellation request review, COD expected / collected / settled / refunded with manual entries, RTO charge, returns and exchanges, inspection, the tracking link (shown once) and history | `orders:read`; changes `orders:write`, `payments:record`, `stock:receive` |
| `/office/settings/delivery` | Charge and active flag for Dhaka City and Outside Dhaka | `orders:read`, `settings:write` |
| `/office/dashboard` | Work queues from the database now (pending, past the 24-hour window, to pack, to dispatch, in transit, cancellation requests, RTO returning, COD to collect, COD held by the courier), returns and quarantine, SKUs with no units available and an Owner-chosen low-stock view, unconfigured zones; each queue links to the full order list (`/office/orders?queue=...`) | `reports:read`, `orders:read`, `stock:read` |
| `/office/reports` | Period report for Dhaka dates (orders received by source and status, COD collected / settled / refunded, RTO and return shipping costs, stock movements) and COD reconciliation with its check | `reports:read` |
| `/office/exports` | XLSX, CSV and JSON exports, complete or filtered, and the export audit list ([exports.md](docs/operations/exports.md)) | `exports:create` |
| `/office/stock-counts`, `/office/stock-counts/{id}` | Physical stock counts: start, resume, review, apply or discard; history ([runbook](docs/operations/runbook.md), section 7) | `stock:read`, `stock:adjust` |
| `/office/print/...` | A4 print views: picking list and packing summary, COD reconciliation summary, stock count sheet and reconciliation summary (no contact details), and one order's packing and shipping document (with them) | `orders:read`, `reports:read` or `stock:read` |
| `/office/skus/{sku}` | Current stock, receive stock, adjust with an explicit Add or Remove choice, a number of units and a reason, with the current stock beside each form; movement history with who made each change (times in Asia/Dhaka) | `stock:read`; changes `stock:receive` / `stock:adjust` |

How it works:

- Sign-in and sign-out call Better Auth's own `/api/auth` endpoints from the browser, so its origin check and sign-in rate limit apply. The session is the HttpOnly cookie; page scripts never see a token, and a Bearer token does not open the Office. Signing in needs JavaScript.
- Every page and every Server Action checks the session and permission on the server itself (`src/app/office/_lib/session.ts`). Server Actions call the same idempotent operations as the API directly, never `/api/v1`. The actor is always the signed-in user; form fields cannot name one. Next.js checks the origin of Server Action requests.
- Each form carries a server-generated idempotency key, so a double-click or resubmission records one change; the submit button is disabled while saving. Prices are typed in Taka (up to two decimals) and stored exactly as integer paisa (`src/modules/money.ts`).
- Errors shown are the services' safe messages or a generic one; raw errors and SQL never reach the page.
- Every `/office` response also sends `Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Robots-Tag: noindex, nofollow`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin` (`next.config.ts`); pages are dynamic, so they are not cached.

Not built: changing a slug or SKU, reactivating a variant, un-archiving a product, publication, a photo API, expenses and supplier records, courier statement reconciliation, and export endpoints in `/api/v1`. Edit forms carry the version they were loaded from; saving after another tab or client changed the record shows a "reload" message and keeps what was typed. While a form saves, its fields and button are disabled. The first Owner of an installation is created with `npm run auth:bootstrap-owner`. Tested with fictional accounts against `babysunray_test`: integration tests of every Server Action, and real-browser tests (`npm run test:e2e`) of sign-in, sign-out, access control, the catalogue and stock flows, editing (including a stale second tab), search, filter and paging, the archive and deactivate confirmations, double submission, a lost response and its retry, error messages, keyboard use and a phone-sized screen.

## Backup and recovery

Local tooling only (`src/db/backup.mts`, `scripts/backup-*.mts`); how to use it is in the [runbook](docs/operations/runbook.md), section 8. A backup is a `pg_dump` custom-format archive (schema, data, sequences, triggers, migration history) streamed into chunked AES-256-GCM encryption with a scrypt key from an interactive passphrase, so no plaintext dump is written to disk; session, verification and rate-limit table data are left out. Changed, reordered or cut-short files and wrong passphrases are refused before any data is used (unit tests). `npm run backup:drill` proves a full backup, verify and restore on fictional data in `babysunray_test` (every table, sequence, constraint and trigger compared). **Not decided, so not built:** a schedule, retention, an off-device copy, and the RPO and RTO (K-4, K-5, K-8, K-9). Product photo files are **not** in these backups; only their records are (Product photos). `backup:restore` has not yet been run against a real `babysunray_restore` database. An export is not a backup.

## Documentation

| Document | Purpose | Status |
|---|---|---|
| [Product requirements](docs/product/requirements.md) | What the product must do, with open decisions | Draft — Founder Review |
| [Order policy decisions](docs/product/order-policy-decisions.md) | Founder-approved order rules (O-9 to O-14), lifecycle states, transitions and engineering defaults | Rules approved (2026-11-15); derived design Draft — Founder Review |
| [ADR-0001: Application stack](docs/adr/0001-application-stack.md) | Confirmed technology and unresolved choices | Draft — Founder Review |
| [ADR-0002: Drizzle and inventory foundation](docs/adr/0002-drizzle-and-inventory-foundation.md) | ORM, catalogue, stock ledger and money decisions | Draft — Founder Review (decisions founder-approved) |
| [ADR-0003: Authentication foundation](docs/adr/0003-authentication-foundation.md) | Better Auth, sessions, Owner bootstrap, permissions, user actors | Draft — Founder Review (decisions founder-approved) |
| [ADR-0004: API v1 and Bearer transport](docs/adr/0004-api-v1-and-bearer-transport.md) | Versioned API, Bearer-only transport, OpenAPI, body limits, CORS policy, rate limits | Draft — Founder Review |
| [ADR-0005: Operation idempotency](docs/adr/0005-operation-idempotency.md) | One key per user and operation, committed with the operation | Draft — Founder Review |
| [ADR-0006: Product photo storage](docs/adr/0006-product-media-storage.md) | A storage interface with a local development folder outside the repository, a manifest, fail-closed in production | Draft — Founder Review |
| [API guide](docs/api/README.md) | Calling `/api/v1`, errors, pagination, compatibility rules | Draft — Founder Review |
| [Operations runbook](docs/operations/runbook.md) | Running, checking, exports, stock counts, backup and restore, outage procedure | Draft — Founder Review |
| [Export formats](docs/operations/exports.md) | Datasets, columns, types, spreadsheet safety, JSON layout | Draft — Founder Review |
| [Offline sheets](docs/operations/offline-templates.md) | Blank order, stock, COD and courier sheets for an outage | Draft — Founder Review |
| [CLAUDE.md](CLAUDE.md) | Working rules for Claude Code in this repository | Active |

## Stack

Confirmed: Next.js (App Router), React, TypeScript, Node.js, PostgreSQL, Tailwind CSS, one modular monolith, Drizzle ORM (ADR-0002), Better Auth (ADR-0003).
Built: a versioned REST API under `/api/v1` with OpenAPI 3.1 (ADR-0004), with idempotent writes (ADR-0005). Not yet decided: production and database hosting, final visual design, native apps, idempotency-record retention. See ADR-0001.

## Data handling

Customer data, database dumps, backups, exports, secrets and private business documents never belong in this repository. See `.gitignore`.
