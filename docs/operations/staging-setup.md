# Staging setup (Supabase)

**Status:** Draft — Founder Review. **Purpose:** Step by step, how the founder creates a separate Supabase **staging** project, locks it down, and runs the staging checks. Nothing here is production, and nothing here has been done yet. Background: [infrastructure.md](infrastructure.md), [ADR-0009](../adr/0009-hosted-database-security-boundary.md).

A staging project is a throwaway copy used only to prove the system works on Supabase. **Never put real orders, customers or the real Owner account in it.** The staging tests refuse to run if they find any record they did not create.

## What you need

- A Supabase account. The Free plan is enough for staging; it is your decision, and its terms for commercial use do not matter here because staging holds no business data.
- This project on your computer (you already have it), with the PostgreSQL 18 tools that `npm run backup:create` already uses.
- No Vercel account is needed for staging.

## 1. Create the project

1. In Supabase, create a **new** project. Name it so it cannot be mistaken, for example `babysunray-staging`. Never reuse a project that has held anything else.
2. Supabase asks for a database password. Let it generate one and keep it in your password manager. This is the **administrator** password (role `postgres`).
3. Choose a region; that is your decision (a nearby one is faster).

## 2. Switch off the Data API

The application does not use Supabase's automatic REST/GraphQL API, and leaving it on would be a second door to the data.

1. Open **Integrations → Data API** and turn **Enable Data API** off.
2. If a setting **Automatically expose new tables** is shown, keep it off.

(The privilege script in step 6 also removes the API roles' access, so the data stays closed even if this switch is turned on by mistake. The staging tests check both.)

## 3. Mark the database as staging, and create the application's role

Open a terminal in the project folder and connect as the administrator with the **Direct connection** string (Dashboard → **Connect** → Direct connection). Use `psql` so the new password never appears in Supabase's saved SQL snippets:

```
psql "<direct connection string>"
```

Then type, one line at a time:

```sql
create schema babysunray_target;
comment on schema babysunray_target is 'babysunray:staging';
create role babysunray_app with login;
\password babysunray_app
alter role babysunray_app set statement_timeout = '60s';
\q
```

`\password` asks for a new password twice without showing it. Generate a long random one and keep it in your password manager. This is the **application** password.

The marker comment is what every staging command checks first. A production database would be marked differently and is refused.

## 4. Create the private photo bucket

1. Open **Storage → New bucket**.
2. Name: for example `product-photos-staging`.
3. **Public bucket: off.** This matters most: a public bucket would expose every photo, drafts included. The application refuses to upload into a bucket that is not private, and the readiness check reports it.
4. Optional but recommended: allowed types `image/jpeg, image/png, image/webp` and a size limit of 10 MB.
5. Do not add storage policies. The application uses the secret key on the server only.

## 5. Collect the settings

From **Project Settings → API Keys**: the **publishable** key, and a **secret** key (create one if none exists). From **Connect**: the Direct connection string and the **Transaction pooler** string (port 6543).

Create a file named `.env.staging.local` in the project folder. It is ignored by Git; never commit it, never paste it into a chat. Fill in:

| Name | Value |
|---|---|
| `STAGING_MIGRATION_DATABASE_URL` | the Direct connection string, user `postgres` and the administrator password |
| `STAGING_DATABASE_URL` | the Transaction pooler string with the user changed to `babysunray_app.<project-ref>` and the application password |
| `STAGING_DATABASE_SSL` | `require` (encrypted), or `verify-full` with the next line |
| `STAGING_DATABASE_SSL_ROOT_CERT` | only for `verify-full`: the full path of Supabase's CA certificate file (Database settings → SSL), saved outside the project |
| `STAGING_SUPABASE_URL` | the project URL, `https://<project-ref>.supabase.co` |
| `STAGING_SUPABASE_PUBLISHABLE_KEY` | the publishable key (used only to prove it can read nothing) |
| `STAGING_SUPABASE_SECRET_KEY` | the secret key |
| `STAGING_STORAGE_BUCKET` | the bucket name from step 4 |

A connection string must not end with `?...` options; the commands refuse that (TLS comes from `STAGING_DATABASE_SSL`).

## 6. First migration

Create a folder outside the project for reports and backups, for example `D:\BabySunray-staging`. Then:

```
npm run db:migrate:staging -- --first-time --report D:\BabySunray-staging\migrate-1.json
```

It shows the host it connected to and asks you to type the host name back. It applies the privilege script (`db/hosted/privileges.sql`), all migrations in one transaction, the privilege script again, and then audits the privileges. It should end with **no findings**. The report file holds no passwords or data.

## 7. Run the staging checks

```
npm run test:staging
```

It tests:
1. the pooler connection
2. the application role's limits
3. that the Data API reveals nothing
4. the last unit going to exactly one of several simultaneous orders
5. a multi-SKU order failing as a whole
6. sign-in and sign-out
7. a photo upload, read, list and delete
8. the private bucket
9. that photo records and objects match
10. maintenance from several instances
11. recovery from a full or broken connection
12. that nothing unpublished is visible

Without the settings it prints **NOT RUN — awaiting founder setup**: that is not a pass. It also refuses if the database settings and the Supabase URL name different projects. The fictional Owner accounts it creates get random passwords and are disabled at the end of each run. Send the summary lines (passed and failed counts, and the names of failing tests) for review. Never send the settings file.

## 8. Later migrations, backups and a restore drill

1. Back up first:

   ```
   npm run backup:create:staging -- --out D:\BabySunray-staging
   ```

   This makes an encrypted copy of the application's tables (passphrase asked twice, not shown).
2. Migrate:

   ```
   npm run db:migrate:staging -- --backup <that file> --report D:\BabySunray-staging\migrate-2.json
   ```

   The command refuses without a staging backup of this same host and database from the last 24 hours.
3. Restore drill: `npm run backup:restore` restores a staging backup into your local empty `babysunray_restore`, exactly like a local backup (runbook, section 8).

**Photos in the bucket are not in these backups.** A bucket backup command is designed (it reuses the same encrypted photo-backup format, reading from the bucket) but not built; staging photos are fictional and disposable meanwhile.

## Never share or commit

The administrator and application passwords, the secret key, the connection strings, `.env.staging.local`, backup files and their passphrases. The publishable key is less sensitive but still stays in the settings file.

## What still blocks production

- **Decisions:** hosting choice and cost (decision 1), a production photo store (decision 14), recovery objectives and an off-device backup place (K-9, decision 15), the publication rule (I-6), and published policies (S-17, G-7).
- **Engineering:** a production migration and backup procedure (the staging commands refuse production by design), a bucket backup, a trusted proxy with per-client limits, a scheduler for maintenance, and a passing staging run.
