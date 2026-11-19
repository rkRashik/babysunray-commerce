# ADR-0012: Browser installation, store setup and customer accounts

**Status:** Draft — Founder Review
**Purpose:** How a fresh installation becomes a running store through the browser: the first Owner, account recovery, store settings, publication requirements, customer email accounts and transactional email.
**Date:** 2026-11-19
**Related:** [ADR-0003](0003-authentication-foundation.md), [ADR-0008](0008-customer-identity-recovery-and-mfa.md), [ADR-0011](0011-founder-acceptance-and-customer-sign-in.md), [installation-production.md](../operations/installation-production.md)

## 1. First-time Admin setup (`/admin/setup`)

- Open only while no Owner has active access; once one exists it refuses server-side, whatever is sent.
- **Setup grant:** `ADMIN_SETUP_TOKEN`, at least 32 random characters, set by the founder out of band in the host's environment settings and typed into the form (POST body only; never in a URL, browser storage or a log). Netlify visitor protection is not treated as proof of ownership.
- With email set up, a 6-digit code is sent to the Owner's address (15 minutes, stored as a SHA-256 digest) and must be entered; without email the account is created with an unverified address and the page says so.
- Creation is one transaction under exclusive locks on `auth_users` and `user_access`: concurrent or repeated attempts create at most one Owner (tested with three parallel attempts). It never changes or removes an existing account. It writes the user, the Better Auth password credential (Better Auth's scrypt), `user_access` (owner) and an `owner_created` audit row (`transport: browser`).
- Ten **recovery codes** are created with the Owner, shown once and stored as digests (`owner_recovery_codes`, migration 0021). `/admin/recover` redeems one with the Owner's email and a new password: the code is spent, the password replaced and every session ended, in one transaction, with an `owner_password_reset` audit row. Codes can be regenerated in Account security. Both operations are rate limited (10 attempts a minute, storewide).
- The CLI commands (`auth:bootstrap-owner`, `auth:bootstrap-owner:staging`, `auth:reset-owner-password`) stay as emergency tools.

## 2. Store setup (`/admin/onboarding`) and settings

- A checklist computed from the store's own data (nothing stored), linking to the normal pages: store name and description, logo, contact channels, delivery charges, categories, policies, publication requirements, first product, stock, a published product, email. Optional steps never block the dashboard; the dashboard shows what is left.
- **Store settings** (`store_settings`, one row): name, short description (English and Bangla), phone, email, WhatsApp, Messenger link and the logo (re-encoded, at most 1200 px, kept in the database, served at `/brand/logo`). Empty fields use the installation defaults (`STORE_*`), so there is one source per value.
- **Publication requirements (I-6):** the Owner ticks which readiness items every product needs (the founder-stated ones are always included) and approves them; the approval is recorded with who and when and becomes the rule `publishProductOnce` applies. The launch gate's `publication_rule` blocker clears once approved; the gate itself stays closed.

## 3. Customer accounts

The customer Better Auth instance (ADR-0011) gains email and password when email is set up:

- Sign-up requires a confirmed address (`requireEmailVerification`); sign-up with an existing address answers like a new one (no enumeration) and creates nothing. Password reset by email (one hour, sessions revoked); change password and name when signed in; sign out. Minimum 10 characters.
- No account linking: an address registered with a password cannot be taken over by Google sign-in or the reverse. Google accounts open only with a Google-verified address. No OAuth token is stored (a database check refuses them); a password hash only on the email account.
- Customers never become Owners (separate tables; a test shows a customer session is not a principal).
- An account does not claim older guest orders; orders placed while signed in are listed for the customer.
- Endpoints reachable: the allowlist in `CUSTOMER_AUTH_ROUTES`, behind the shop access check.

## 4. Transactional email

Resend's HTTPS API (`RESEND_API_KEY`, `EMAIL_FROM` on a domain verified in Resend), one POST, no SDK. Without both settings nothing is sent and the features that need email are not offered. Failures log the HTTP status only.

## 5. Production installation

`npm run db:migrate:production -- --first-time --report <file>` installs the schema into a new, empty production database marked `babysunray:production` (the staging command's guards, typed host confirmation, privileges and audit). The founder then sets the host's settings, opens `/admin/setup` and creates the Owner. Steps: [installation-production.md](../operations/installation-production.md).

## Not decided or not built

A production backup command (needed before any later production migration); 2FA (ADR-0008); staff roles; data export or deletion for customer accounts (no retention rule is approved).
