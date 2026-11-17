# ADR-0009: Hosted database security boundary and serverless connection design

**Status:** Draft — Founder Review
**Purpose:** How the application's data is kept out of Supabase's Data API, which database roles exist and what each may do, how many connections a serverless deployment opens, and how a hosted staging database is migrated and verified. Gate H.45; nothing is deployed and no hosting is chosen (open decision 1).

## Context

The application talks to PostgreSQL directly (Drizzle over node-postgres) and authenticates with Better Auth ([ADR-0003](0003-authentication-foundation.md)). It does not use Supabase Auth or Supabase's Data API (PostgREST, GraphQL). On Supabase, however, tables created in the `public` schema have been granted by default to the API roles `anon`, `authenticated` and `service_role`, and `public` is exposed by the Data API. Supabase changed this default on 2026-04-28 (opt-out for new projects from 2026-05-30, applied to all projects on 2026-10-30), but tables that existed before keep their grants ([changelog](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically), [hardening guide](https://supabase.com/docs/guides/database/hardening-data-api); read 2026-11-17). Without a boundary, every order, customer address and password hash could be readable through the API with a public key.

Enabling row-level security on every table would also block the application unless it bypassed RLS or every table had policies; neither is needed when the application is the only client.

## Decision (proposed)

1. **Two walls against the Data API.** The founder switches the Data API off (Dashboard: Integrations → Data API → "Enable Data API"); and `db/hosted/privileges.sql` revokes every privilege of `anon`, `authenticated` and `service_role` on the application's tables, sequences and functions in `public` and `drizzle`, and removes the default privileges that would grant them new objects. Either wall alone keeps the data private; the staging suite checks both from outside.
2. **Roles.**
   - `postgres` (Supabase's administrator) runs migrations and backups only, over a direct connection, from the founder's machine (`STAGING_MIGRATION_DATABASE_URL`). It owns the schema objects.
   - `babysunray_app` (created by the founder: LOGIN, no other attribute) is the application's role, through the transaction pooler. It may select, insert, update and delete rows; it may not create objects, truncate, reference or trigger; it may not update or delete the ten append-only tables (their triggers already refuse; privileges refuse too); it has no access to the migration history. Not the owner of anything, so grants bind it.
   - RLS is not enabled on application tables: no API role can reach them, and the application role's grants define its access. If a table is ever exposed through the Data API, it needs RLS first (a later, reviewed decision).
3. **Verification is code.** `src/db/hosted-security.mts` audits the catalogs (read-only) and reports any API-role privilege, PUBLIC function execution, risky role attribute, ownership, CREATE right, missing grant or append-only write right. The staging migration runs it after every migration; the staging suite fails on any finding.
4. **Connections.**
   - Serverless default: 2 connections per function instance (`DATABASE_POOL_MAX` 1 to 20).
   - Below 5, `/api/auth` keeps its own bulkhead of 1 and anonymous reads and checkout share one of max(1, P − 2): a connection stays free for the Owner's pages at 3 and 4; at 2 and 1 nothing is reserved and Owner pages queue briefly (never refused).
   - No code path holds a connection while waiting for another. The maintenance run's lock transaction, which did, was removed; its jobs were already safe concurrently. Tested by running the main paths on a pool of one connection.
5. **Hosted migrations are separate and deliberate.** `npm run db:migrate:staging` accepts only a database whose schema `babysunray_target` carries the comment `babysunray:staging`. It also requires:
   - a direct TLS connection, the typed host name, and a migration history that is a prefix of the checkout's;
   - a backup of that database from the last 24 hours.

   It runs the privilege script first (so tables the migrations create are never granted to the API roles, even briefly or if the run fails), then all pending migrations in one transaction under the migration lock, then the privilege script again and the audit, and writes a report. The required backup must record the same host (every Supabase database is named `postgres`). Next.js never migrates on start. No production command exists.

## Consequences

- The application cannot be served through Supabase's Data API at all; any future client uses `/api/v1` ([ADR-0004](0004-api-v1-and-bearer-transport.md)).
- After a migration, privileges must be re-applied (the command does it); default privileges make new tables usable at once in the meantime.
- Supabase's own schemas (`auth`, `storage`, ...) are not touched or backed up by this project; Storage holds only photo objects.

## Not verified

The whole boundary was tested on local PostgreSQL only (the audit's detection, the script's syntax inside a rolled-back transaction). The application role's grants could not be exercised locally (the test role may not create roles, as intended); the staging suite checks them, including that refusals are privilege errors (SQLSTATE 42501) and not only trigger errors. It has not run on a Supabase project. Whether a role-level `statement_timeout` applies through Supabase's transaction pooler, Supavisor's queue time-outs, and the pooler's real behaviour with `babysunray_app.<project-ref>` are checked by `npm run test:staging` once the founder has a staging project.
