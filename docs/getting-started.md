# Getting started

**Status:** Draft — Founder Review
**Purpose:** Setting up a local development installation: tools, databases, configuration, migrations, the first admin account, and every npm script.

For a separate, rebranded installation see [installation.md](operations/installation.md). Tests are described in [testing.md](testing.md).

## 1. Tools

Node.js 20.9 or newer (the Next.js minimum); `npm run db:migrate` needs 22.18 or newer because it runs a TypeScript script with Node's built-in type stripping. Verified on Node.js 24.19.0 and npm 11.17.0; `.nvmrc` records major version 24. PostgreSQL 18 runs locally; `pg_dump` and `pg_restore` of the same major version are needed for backups.

```
npm install        # install dependencies from package-lock.json
npm run dev        # development server at http://localhost:3000
```

## 2. Local PostgreSQL

Development uses a local PostgreSQL 18 server, accessed through Drizzle ORM over the `pg` driver ([ADR-0002](adr/0002-drizzle-and-inventory-foundation.md)). Hosting is undecided. The setup creates two isolated databases, each with its own non-superuser role that cannot connect to the other database:

| Database | Role | Purpose |
|---|---|---|
| `babysunray_dev` | `babysunray_dev` | local development |
| `babysunray_test` | `babysunray_test` | integration and browser tests |

One-time setup, run as a PostgreSQL superuser (it never overwrites: it stops if a role or database already exists):

```
psql -U postgres -f db/local-setup.sql
psql -U postgres -c "\password babysunray_dev"
psql -U postgres -c "\password babysunray_test"
```

`\password` prompts without echo, so no password is stored in a file or shell history. A third, empty database (`babysunray_restore`) is only needed for restoring a backup; see the [runbook](operations/runbook.md), section 8.

## 3. Configuration

Copy `.env.example` to `.env.local` (git-ignored) and fill in `DATABASE_URL` and `TEST_DATABASE_URL`. Connection strings are server-side only: never prefix them with `NEXT_PUBLIC_`. Authentication needs `BETTER_AUTH_SECRET` (generate it with `openssl rand -base64 32`) and `BETTER_AUTH_URL` (a bare origin such as `http://localhost:3000`). The application refuses to start authentication with a missing, short or placeholder secret, a URL that is not a bare origin, plain http outside localhost or in production, or any of `BETTER_AUTH_TRUSTED_ORIGINS`, `BETTER_AUTH_SECRETS` and `BETTER_AUTH_TELEMETRY`.

Optional settings (photo folder, shop identity, API rate limits) are listed in the [runbook](operations/runbook.md), section 2. `npm run config:check` reports which settings are set and valid, whether the database is reachable and whether every migration is applied; it prints no values and changes nothing.

## 4. Database migrations

The schema is defined in `src/db/schema.ts`. `npm run db:generate` writes a SQL migration into `drizzle/` with its snapshot metadata; review the SQL (no unexpected `DROP`, destructive `ALTER` or privilege change) and commit it with the schema change. Triggers and other SQL that Drizzle cannot express go into the generated migration by hand or into a custom one (`npx drizzle-kit generate --custom --name=<name>`). Never edit a migration that has been applied; add a new one. `drizzle-kit push` is not used.

- **Development:** `npm run db:migrate` (`scripts/migrate-dev.mts`) applies pending migrations to the local development database and nothing else. Before the first change it requires that `DATABASE_URL` names a local host, port 5432, database `babysunray_dev` and role `babysunray_dev`, with no query parameters, and that PostgreSQL itself reports that database, that role, a non-superuser session, port 5432 and a loopback address. The migrations then run over that same verified connection. `DATABASE_URL` comes from the shell or `.env.local`; if both define it and they differ, the command stops instead of letting a stale shell variable win. Nothing prints a URL or password. Any other target (test, shared, hosted) needs its own procedure, which waits for the hosting decision.
- **Schema resolution (`search_path`):** the migration SQL uses unqualified names, so the schema it lands in depends on the session's `search_path`. The migration and the test reset connect with an explicit startup option `-c search_path=public` (node-postgres then ignores the `PGOPTIONS` variable), set `search_path` to `public` again on the connection, and read the effective value back; anything other than exactly `public` stops them (`src/db/connection-guard.mts`, `src/db/migrate-verified.mts`). The `drizzle` schema needs no entry: Drizzle always writes its history table as `drizzle.__drizzle_migrations`. Only that session changes; no role, database or server setting is touched. A migration file that itself changes `search_path` is not prevented (migrations are reviewed).
- **Direct `drizzle-kit`:** `drizzle.config.ts` allows only `generate` and `check` (no database) and refuses every other command, including `migrate` and `push`; it carries no database credentials (tested in `tests/db/drizzle-config.test.ts`). Limitation: `drizzle-kit --config <another file>` or other command-line options bypass this config. These guards catch mistakes such as a stale variable or the wrong database; they are not an operating-system or database security boundary, and they do not stop someone who can run arbitrary commands or SQL.
- **Tests:** `npm run test:db` replays all migrations into `babysunray_test` on every run ([testing.md](testing.md)). It does not use `drizzle-kit`.

What the checks cover: `db:check` checks only that the migration files and snapshots are consistent with each other. Running `db:generate` and getting "No schema changes" shows the TypeScript schema matches the committed migrations. Neither compares a live database with the schema; the migration integration test checks the tables, constraints and triggers in the freshly migrated test database.

## 5. The first admin account

No account exists until you create one, and there is no public sign-up. The admin panel's sign-in page is `/office/login`.

```
npm run auth:bootstrap-owner
```

It works only in an interactive terminal, only against the local `babysunray_dev` database (the same checks as `db:migrate`), and only while no account exists. Details, and the local password reset `npm run auth:reset-owner-password`, are in the [authentication guide](guides/authentication.md).

## 6. All npm scripts

| Script | What it does |
|---|---|
| `dev`, `build`, `start` | Development server, production build, serve the production build |
| `typecheck`, `lint` | TypeScript strict check, ESLint |
| `test` | Unit tests (Vitest); no database needed |
| `test:db` | PostgreSQL integration tests in `babysunray_test` ([testing.md](testing.md)) |
| `test:contract` | OpenAPI validity and every `/api/v1` endpoint against it |
| `test:e2e`, `test:e2e:prod` | Real-browser tests against a development server, or a production build behind local HTTPS |
| `test:install` | Rehearses a separate, rebranded installation from a clean clone ([installation.md](operations/installation.md)) |
| `db:generate`, `db:check`, `db:migrate` | Generate a migration, check migration files, apply them to `babysunray_dev` only |
| `config:check` | Which settings are set and valid; database reachability and migrations; prints no values |
| `auth:bootstrap-owner`, `auth:reset-owner-password` | Create the first admin account; reset its password on a local installation (interactive) |
| `orders:expire-verification` | Release holds of orders past their 24-hour verification deadline (`babysunray_dev` only) |
| `media:verify` | Compare the photo records with the photo folder; read-only |
| `media:backup`, `media:backup:verify`, `media:restore` | Encrypted photo backup, its check, restore into an empty folder (interactive) |
| `backup:create`, `backup:verify`, `backup:restore` | Encrypted database backup, its check, restore into an empty `babysunray_restore` (interactive) |
| `recovery:check` | Read-only check that a restored database and a photo backup belong together (interactive) |
| `backup:drill`, `media:drill` | Backup and restore rehearsals on fictional data in `babysunray_test` |
| `perf:bench` | Performance benchmark on fictional data in `babysunray_test` ([performance.md](operations/performance.md)) |

The backup, restore and account commands ask for passphrases or passwords without echo and are run by the owner of the installation; how to use them is in the [runbook](operations/runbook.md).
