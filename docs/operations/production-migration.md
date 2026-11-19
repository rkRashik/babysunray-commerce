# Production migration: plan and preflight (no production exists)

Draft — Founder Review. Purpose: what a production migration will require, and the read-only checks that exist now (Gate H.53).

There is no production database, no hosting decision and no
command that can migrate one. `npm run db:migrate` refuses anything but the local `babysunray_dev` database,
`npm run db:migrate:staging` refuses anything not marked staging, and nothing migrates when the application starts
(Next.js never runs migrations). This document says what a production migration will require and what already exists to
build it from, so that building it later is wiring, not research. Nothing here is a founder decision about hosting.

## 1. What exists and is reused

| Need | Existing piece | Where |
|---|---|---|
| Is this statement set additive? | `npm run migrations:review [-- --after <n>]`: text only, lists drops, renames, type changes, deletes and statements that can fail on existing rows | `src/db/migration-review.mts` |
| Is the database the intended one? | A marker in the database itself (`babysunray_target`), the connection's identity read from PostgreSQL, the operator typing the host name back | `src/db/hosted-target.mts` (staging marker) |
| Is its history a prefix of this checkout's? | `migrationState`: same hashes, same order; a newer or diverged database is refused | `src/db/hosted-target.mts` |
| Is there a recent backup of exactly this database? | `assertRecentBackup` (header check, 24 h) and `npm run backup:status` (freshness, pairing with the photo backup) | `src/db/hosted-target.mts`, `src/db/backup-status.mts` |
| Is the privilege boundary intact afterwards? | `db/hosted/privileges.sql` run before and after, then `auditPrivileges` | `src/db/hosted-security.mts` |
| All-or-nothing | Drizzle's migrator applies every pending migration in one transaction under the project's advisory lock | `src/db/migrate-verified.mts` |
| A record of what happened | A JSON report created exclusively outside the repository (no values) | `src/db/hosted-report.mts` |

## 2. What a production preflight must do (a dry run changes nothing)

A production command would be the staging command with these differences, and a dry-run mode that stops after step 8:

1. Refuse unless an explicit production target is named: a different marker (`babysunray:production`, to be created by the
   founder in the database by hand, never by a script), never a value inferred from an environment name.
2. Require an interactive terminal and the operator typing the host name back; no flag, variable or CI job can skip this.
3. Connect over a direct or session connection with TLS, never the transaction pooler, never as the application role.
4. Read the identity from PostgreSQL and compare it with the marker.
5. Compare the migration history with this checkout (prefix rule); stop on divergence.
6. List the pending migrations and run `migrations:review` over exactly those files; print every finding.
7. Require a database backup of this database from the last 24 hours that `npm run backup:verify` accepted, and, when photos
   exist, a photo backup within 15 minutes of it (`backup:status`). Freshness from headers is not proof of content: the
   operator confirms the verification they ran.
8. Run the privilege audit read-only and report it.
9. Only past this point, and only without `--dry-run`: the operator types the number of pending migrations and the word
   `apply`; the migrator runs; the privilege script and audit run again; the report is written whatever the outcome.

## 3. Additive strategy

- **Expand, deploy, contract.** A release only adds (tables, nullable columns, columns with defaults, indexes). The code that
  uses the new shape ships next. Removing or renaming anything is a later migration, after no running code reads it, and
  needs a backup, a written reason and the Owner's approval. `migrations:review` marks these `destructive`.
- A statement that can fail on existing rows (`SET NOT NULL`, a `NOT NULL` column without a default, a rewriting `UPDATE`)
  is a `check`: run it first against a restore of the production backup (section 5), not against production.
- Rolling back application code must work against the newer schema; that is why the old code keeps working until the contract
  step.
- No migration runs at application start, in a build step, in a serverless function or from a scheduler.

## 4. Interrupted or failed migrations

All pending migrations run in one transaction, so a failure, a dropped connection or a killed terminal leaves none of them
applied (the staging command is tested for this; the advisory lock is released with the connection). After any interruption:
read the report if one was written, then run the dry run again. It shows the history as it is. Never edit the migration table
by hand and never re-run a half-seen migration file as plain SQL. A migration that needs a statement PostgreSQL cannot run in
a transaction (for example `CREATE INDEX CONCURRENTLY`) must be a separate, reviewed, manual procedure written for that case.

## 5. Rollback and restore (honest limits)

There are no down migrations and none will be written: they are untested code that runs only in an emergency.

- **Before applying:** restore the latest production backup into a scratch database (`npm run backup:restore`, which only restores into
  an empty `babysunray_restore`) and apply the pending migrations there. This is the rehearsal; it also times the migration.
- **If the migration failed:** nothing was applied; fix forward and run the dry run again.
- **If it applied and the application is wrong:** first try a forward fix. If data was damaged, restore the pre-migration backup into
  a new empty database, verify it (`npm run recovery:check`), and point the application at it. Orders, payments and stock written
  after the backup are lost unless they are re-entered from other records: this is the RPO, which the founder has not set.
  Restore time (RTO) is unmeasured on real data; `docs/operations/performance.md` has the figure for fictional data only.
- Stop taking orders while a migration or a restore runs (the shop is closed to the public until launch; the Owner Office is
  the only writer).

## 6. What remains before a production migration command can exist

These are decisions or facts that need hosting; none can be settled in code.

1. A database host and its connection types (direct or session for migrations; pooled for the application).
2. The production marker created by the founder, and the operator procedure for typing it.
3. A backup destination off this machine and a retention rule (RPO and RTO).
4. A dry run exercised against a restore of a real backup on that host.
5. The founder's approval of the first production migration, recorded in the report.

Until then the correct behaviour is the current one: no command can touch a production database.

## 7. Switching the site to production, and what data moves (plan, ADR-0011)

The founder creates the production database last. The site keeps running on staging until then, and acceptance can never run on production (it is not marked staging).

**Order of work**

1. The founder creates a new, empty Supabase project for production, its private photo bucket, the application role (`db/hosted/privileges.sql`) and the marker `babysunray:production` (by hand).
2. The production migration command (section 2; not built yet) applies every migration to the empty database. Until it exists, nothing touches production.
3. The founder creates the production Owner (a production variant of `auth:bootstrap-owner:staging`, not built yet).
4. The catalogue arrives as described below; stock is received from a physical count; delivery charges and policies are entered and approved again in production.
5. Netlify's variables are switched to the production values (`DATABASE_URL`, `SUPABASE_*`, a new `BETTER_AUTH_SECRET`; `GOOGLE_*`, `TRUSTED_PROXY`, `CLOUDINARY_*` stay or are replaced), and the site is redeployed, still behind visitor protection.
6. The public launch is a separate founder decision and a code change to the launch gate.

**What moves, and how**

| Data | Moves? | How |
|---|---|---|
| Categories, products (as drafts), variants, prices, size charts | Yes, if the founder wants them | Exports "Product content" and "Size charts" from the source, then the existing create-only catalogue import into production (previewed, all or nothing). Every product arrives as a draft and is reviewed and published again under the approved rule. |
| Product photos | Yes | Uploaded again in the production Office from the founder's originals (simple and checked by the upload pipeline). A bucket-to-bucket transfer tool is not built. |
| Stock | No | Received in production from a physical count (stock counts), so the ledger starts from real stock. |
| Delivery charges, store identity | No | Entered again by the founder in production. |
| Policy texts | Text only, if wanted | Copied into production drafts by the founder; published again with approval. |
| Orders, order items and history, reservations, stock movements, payments, returns, tracking links, guest submissions, customer accounts and their orders, sessions, audit and idempotency records, exports | **Never** | Rehearsal records stay in the staging database. Nothing copies them, and no tool exists to do so. |
| The local development database | Never directly | Its catalogue can go through the same export and import path. |

After the switch, staging tracking links do not resolve on the production site, and staging orders are not visible there.
