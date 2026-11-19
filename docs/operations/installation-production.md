# Installing a new store (production)

**Status:** Draft — Founder Review
**Purpose:** The repeatable path from an empty Supabase project to a store the Owner runs in the browser. Design: [ADR-0012](../adr/0012-installation-setup-and-customer-accounts.md).

Nothing here touches the staging or development databases. Rehearsal data (orders, customers, payments, audit history) is never copied into production ([production-migration.md](production-migration.md), section 7).

## 1. Create the production project (founder, in Supabase)

Follow [staging-setup.md](staging-setup.md) sections 1 to 5 with a **new** project, with two differences:

- the marker comment is `babysunray:production` (not staging): `comment on schema babysunray_target is 'babysunray:production';`
- the settings go in `.env.production.local` (git-ignored) with the prefix `PRODUCTION_` instead of `STAGING_`: `PRODUCTION_MIGRATION_DATABASE_URL`, `PRODUCTION_DATABASE_SSL` (and `PRODUCTION_DATABASE_SSL_ROOT_CERT` for verify-full).

Founder acceptance can never run on this database: it is not marked staging.

## 2. Install the schema (founder, once)

```
npm run db:migrate:production -- --first-time --report D:\BabySunray-production\install.json
```

It refuses unless the database is hosted, uses TLS, carries the production marker and is empty; you type the host name back; every migration applies in one transaction; then the privilege script runs and the boundary is audited. Later production migrations need a production backup command first (not built yet; see ADR-0012).

## 3. Settings on the host (Netlify)

Set these on the production site, keys and secrets as secret variables, never with the browser-public prefix:

| Variable | Value |
|---|---|
| `DATABASE_URL` | The production transaction-pooler URL for `babysunray_app` |
| `DATABASE_RUNTIME`, `DATABASE_POOLER`, `DATABASE_SSL` | `serverless`, `transaction`, `require` |
| `BETTER_AUTH_SECRET` | A new random value (32+ characters), not the staging one |
| `BETTER_AUTH_URL` | `https://babysunray.com` |
| `ADMIN_SETUP_TOKEN` | A new random value (32+ characters) you keep to type once in step 4 |
| `MEDIA_STORAGE_PROVIDER`, `SUPABASE_URL`, `SUPABASE_STORAGE_BUCKET`, `SUPABASE_SERVICE_ROLE_KEY` | `supabase` and the production project's values |
| `RESEND_API_KEY`, `EMAIL_FROM` | Your Resend key and a sender on your verified domain, for example `BabySunRay <hello@babysunray.com>` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The OAuth client (redirect URI `https://babysunray.com/api/auth/callback/google`) |
| `TRUSTED_PROXY` | `netlify` |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Optional, for the image CDN |

Switching the existing site from staging to these values is a separate founder decision, made last.

## 4. Create the Owner in the browser

Open `https://babysunray.com/admin/setup`, type the setup code (`ADMIN_SETUP_TOKEN`) and your email, enter the 6-digit code from your email, choose your name and password, and **save the ten recovery codes**. Setup then closes for good. You may remove `ADMIN_SETUP_TOKEN` afterwards (setup is closed whatever its value).

## 5. Set up the store

Sign in and open **Store setup** (`/admin/onboarding`): store name and logo, contact channels, delivery charges, categories, policies, publication requirements, then products, stock and publication. Each step is a normal Admin page you can change at any time.

## 6. Launch

The public launch stays closed until the founder approves it (the launch gate, [launch-readiness.md](launch-readiness.md)).
