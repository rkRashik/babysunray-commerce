# Testing

**Status:** Draft — Founder Review
**Purpose:** The automated test suites, the safeguards that keep them away from real data, the rehearsals and the benchmark.

Every test uses fictional data. Database tests run only against the local `babysunray_test` database ([getting-started.md](getting-started.md), section 2).

## 1. Suites

| Command | What it covers |
|---|---|
| `npm test` | Unit tests (Vitest): rules, money, parsers, formats, idempotency fingerprints, the launch gate and structural checks such as which modules may import the guest checkout |
| `npm run test:db` | PostgreSQL integration tests: services and operations, transactions and rollback, concurrency with proven lock waits, idempotent retries, authorisation, the HTTP handlers of `/api/v1` and authentication, migrations |
| `npm run test:contract` | The OpenAPI document against the official OpenAPI 3.1 schema, and every `/api/v1` response against the document |
| `npm run test:e2e` | The admin panel and storefront preview in headless Chromium with Playwright, desktop and phone, including axe accessibility checks |
| `npm run test:e2e:prod` | The same browser tests plus production smoke tests against a production build behind local HTTPS |
| `npm run test:install` | A separate, rebranded installation from a clean clone of the committed HEAD ([installation.md](operations/installation.md), section 5) |
| `npm run test:staging` | Twelve checks against a real, founder-created Supabase **staging** project ([staging-setup.md](operations/staging-setup.md)); without its settings it reports NOT RUN and exits 2, never a pass. Not run yet. `npm run staging:preflight` lists missing settings without connecting |
| `npm run backup:drill`, `npm run media:drill` | Backup and restore rehearsals ([runbook](operations/runbook.md)) |
| `npm run perf:bench` | Benchmark on 5,000 fictional products and 20,000 orders ([performance.md](operations/performance.md)) |

Failure behaviour that needs a real fault is tested with real ones: an injected trigger that makes an insert fail (`withFailingInserts`), a backend terminated with `pg_terminate_backend`, a session holding a row lock while other connections are proven blocked, and two migration runs at once.

Tests that need a published product publish a fictional one under `TEST_PUBLICATION_RULE` (`tests/support/publication.ts`), a rule that exists only in the tests: the application has no approved publication rule, and a unit test checks that nothing routed can reach the publication services. Database test files share one database for the whole run and Vitest may change their order (failed and slow files first), so a test must not assume that another file has or has not run; run `npx vitest run --config vitest.integration.config.mts --sequence.shuffle.files` to check. (Tests inside one file may build on each other and run in order; `--sequence.shuffle` would also shuffle those.)

## 2. Database test safeguards

`npm run test:db` fails, rather than skipping, when `TEST_DATABASE_URL` is missing or PostgreSQL is unreachable. Before it changes anything it checks that:

- the URL names a local host, port 5432, the `babysunray_test` database and the `babysunray_test` role, and has no query parameters;
- `DATABASE_URL` does not name the same database;
- PostgreSQL itself reports that database and role, a non-superuser session and a loopback server address.

Each run then compares the database with what the migrations create (`tests/support/schema-inventory.ts`, derived from `src/db/schema.ts` plus a short manual list). If it finds an extra object or metadata of any of these kinds, it stops and changes nothing: schemas, extensions, tables and other relations, columns, constraints, triggers, functions, types, policies, rules, extended statistics, publications and their membership, event triggers, comments on what the reset would drop, privileges (table, sequence, column, function and `drizzle` schema, plus default privileges) and column defaults that differ from the ones the migrations set. Messages name objects, never values. **Not checked:** column types and nullability, the definitions behind constraint, index and trigger names, function bodies, owners, row-level-security flags, storage options and security labels. This is a guard against mistakes in `babysunray_test`, not a complete comparison with the migrations, and not protection against someone who can run arbitrary SQL. Event triggers are checked, but tests cannot create one (it needs a superuser), so that path is covered with a stubbed catalog result.

If the check passes, the reset drops only the migration-created tables, functions and migration history, schema-qualified and with `RESTRICT` (no `CASCADE`, no dropping of schemas other than `drizzle`), in the same transaction as the check. It then replays every migration from scratch over a session whose `search_path` is pinned to `public`, and runs the tests. When a migration adds an object Drizzle cannot derive (a trigger, function or sequence), add it to the manual list in `schema-inventory.ts` in the same change; when it adds or changes a column default, update the defaults list there. The reset deletes data by design, so it runs only on `babysunray_test`: both the URL and PostgreSQL's own answer must name that database and role. Test files use their own fictional fixture rows and run one at a time.

## 3. Browser tests

`npm run test:e2e` uses Playwright (`playwright.config.ts`, `tests/e2e`). Install the browser once with `npx playwright install --only-shell chromium` (into Playwright's per-user cache, not into the project). The set-up (`tests/e2e/global-setup.ts`) stops before doing anything unless:

- `TEST_DATABASE_URL` passes the same checks as `npm run test:db` and PostgreSQL confirms `babysunray_test`;
- it can take the test-run lock. `npm run test:db` takes the same PostgreSQL advisory lock for its whole run, so the two can never reset the database under each other; the second one is refused at once.

It then resets and migrates `babysunray_test`, creates one fictional admin account with a random password, and starts its own `next dev` on a free `127.0.0.1` port with the test database as `DATABASE_URL`, a random `BETTER_AUTH_SECRET` and its own output directory (`.next/e2e`, with a generated, git-ignored `tsconfig.e2e.json`), so it can run beside your own `npm run dev`. Explicit variables override `.env.local`, which is not changed. Before the first test, a sign-in through that server must create a session row in `babysunray_test`, which proves the server uses the test database. At the end it stops only the process it started and restores `next-env.d.ts`, which `next dev` rewrites. No traces, screenshots or videos are recorded; a failing test leaves a text page snapshot in the git-ignored `test-results/`.

`npm run test:e2e:prod` runs the same tests plus production smoke tests (`tests/e2e-prod`) against `next build` + `next start` with `NODE_ENV=production` (output in `.next/e2e-prod`), behind a local TLS proxy with a throwaway self-signed certificate made by `openssl` in a temporary folder (deleted afterwards). Better Auth therefore runs with its production rules, unchanged: an https base URL and Secure cookies; only the test browser is told to accept the certificate. Accessibility checks use `@axe-core/playwright` (WCAG 2.1 A and AA rules on the admin pages, WCAG 2.2 A and AA rules on the storefront preview). Both harnesses give the server a throwaway photo folder in the operating system's temporary directory (deleted afterwards), never the configured `MEDIA_STORAGE_DIR`. A passing scanner is not a usability evaluation: no test with real people has been done.

## 4. Test-only dependencies and audit notes

- Development only: Playwright, `@axe-core/playwright`, `read-excel-file` (an independent XLSX reader that checks generated exports), `ajv`, `ajv-formats` and `@seriousme/openapi-schema-validator` (contract tests). Versions are pinned in `package.json`; the licence inventory is in [installation.md](operations/installation.md), section 6.
- `better-auth` lists `drizzle-kit` and `vitest` as optional peer dependencies, so npm marks them `devOptional` in `package-lock.json` and plain `npm audit --omit=dev` still reports development tooling. `npm audit --omit=dev --omit=optional` (the production install) reports 0 vulnerabilities; a production install must use `--omit=dev --omit=optional` (waits for hosting).
- Audit of 2026-11-18 (Gate H.51): 21 findings, all in development tooling, none in `next`, `react`, `pg`, `drizzle-orm`, `better-auth`, `sharp` or `zod`. `npm audit fix` (lockfile only, no `package.json` change) moved `typescript-eslint` 8.72.2 to 8.73.0 and `minimatch` 10.2.6 to 11.0.9, which closes GHSA-g3hv-75wg-m249 (minimatch globparts amplification); 20 remain. They share two roots, neither fixable without a major or experimental upgrade, and neither is forced:
  - **picomatch ≤ 4.0.7 (GHSA-fc5q-39xc-vjpf, ReDoS in repeated single-branch extglobs).** No patched release exists (4.0.7 is the latest). It reaches `vitest`, `vite`, `tinyglobby`, `fdir`, `fast-glob`, `micromatch`, `eslint-config-next` and `typescript-eslint` (about 17 of the 20 rows). Exposure: it needs an attacker-supplied glob pattern; those tools run only on the developer machine and in CI against this repository's own patterns, nothing in the application imports them. Resolve when picomatch publishes a fix (`npm audit fix` will then pick it up).
  - **esbuild ≤ 0.24.2 development-server request exposure (GHSA-67mh-4wv8-2f99)** through `drizzle-kit` 0.31.11 → `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils` → esbuild 0.18.20. The only offered fix is a downgrade to drizzle-kit 0.18.1, which is wrong; the real fix is drizzle-kit 1.0 (still release-candidate), a migration-tooling change for the founder to approve. Nothing here starts an esbuild server (drizzle-kit's code does not import `@esbuild-kit`).
- Also checked: no `NEXT_PUBLIC_` variable exists; no tracked file holds a credential (the only tracked env file is `.env.example` with `CHANGE_ME`; test fixtures use fictional passwords); `.env*`, backups and photo backups are git-ignored; no package of this project defines an install, prepare or postinstall script (npm 11 reports `allowScripts` is unset for the `esbuild` postinstall of three esbuild copies, which are dev tooling and unchanged); `npm ci --dry-run` resolves from the lockfile alone.
- TypeScript is held at 6.0.x because `typescript-eslint` supports TypeScript below 6.1; ESLint is held at 9.x because `eslint-config-next` depends on plugins that do not yet declare ESLint 10 support. Revisit both when the plugins update.

## 5. Last full run (Gate H.55, 2026-11-18)

Run one suite at a time, in this order, on one Windows machine against the local `babysunray_test` database, with no code change after it (the HEAD of the commit that records it differs only in documentation). All exit 0:

| Suite | Result |
|---|---|
| `npm run typecheck`, `npm run lint` | clean |
| `npm test` (unit) | 37 files, 358 tests |
| `npm run db:check` | clean |
| `npm run test:db` (PostgreSQL integration) | 40 files, 563 tests |
| `npm run test:contract` | 6 unit tests, then 83 tests over 3 files |
| `npm run build` | compiled |
| `npm run test:e2e` | 56 browser tests |
| `npm run test:e2e:prod` | 59 browser tests |
| `npm run backup:drill`, `npm run media:drill` | 1 and 3 tests |
| `npm run test:install` | clean clone, offline `npm ci`, both drills, build and 61 browser tests |
| `npm run perf:bench` | 5 benchmarks on fictional data (see [performance.md](operations/performance.md)) |
| `npm audit --omit=dev --omit=optional` | 0 vulnerabilities (the production install); plain `npm audit` still reports 20 development-tooling findings, section 4 |

Not run, by design: `npm run test:staging` and every staging command (**REAL SUPABASE STAGING: NOT RUN**, no staging setting is configured on this machine), and the commands the founder runs (`auth:*`, `backup:create|verify|restore`, `media:backup*`, `recovery:check`).
