# ADR-0008: Customer identity, admin recovery and two-factor sign-in (proposal)

**Status:** Draft — Founder Review (proposal; nothing here is approved or built)
**Date:** 2026-11-16
**Deciders:** Founder
**Related:** [ADR-0003](0003-authentication-foundation.md), [ADR-0007](0007-guest-checkout-foundation.md), [Product requirements](../product/requirements.md) (S-3, S-9, S-14, OF-5, OF-7, OF-10, API-10, open decisions 3 and 12), [storefront concepts](../design/storefront-concepts.md) section 4

**Update (19 Nov 2026):** the founder chose optional Google sign-in for customers (S-14); section 1's proposal is built as described in [ADR-0011](0011-founder-acceptance-and-customer-sign-in.md). Sections 2 to 4 are unchanged.

**In short:** Batch H.31–H.38 asked for customer-account, recovery and MFA foundations. Each depends on an open founder decision (S-14 customer accounts, OF-5 recovery, 2FA in decision 3). Building schema or endpoints for them now would be speculative and would widen the authentication surface without an approved scope or privacy text. This ADR records what was evaluated against the installed Better Auth 1.7.25 and what is proposed. Guest checkout stays the only customer path (S-3).

## 1. Customer identity (S-14: launch scope undecided)

**Proposal, if the founder approves customer accounts:** a second Better Auth instance for customers, with its own tables (`customer_users`, `customer_sessions`, `customer_accounts`, `customer_verifications`), its own base path (for example `/api/customer-auth`) and its own cookie prefix, created in its own migration. The Owner instance and `user_access` stay unchanged.

| Requirement | How the proposal meets it |
|---|---|
| A customer never gets Owner, admin, staff or API permissions | Customer sessions live in other tables and cookies. `getPrincipal` and `getBearerPrincipal` verify only the Owner instance, and `user_access` references only `auth_users`, so a customer session cannot become a principal by construction, not only by a check |
| Admin sign-up paths stay closed | The Owner instance keeps `disableSignUp` and its path allowlist; customer sign-up is enabled only on the customer instance |
| Guest checkout stays available | `placeGuestOrder` needs no account; an account would only add an optional link to orders |
| A matching phone or email never grants ownership | Orders are not attached by contact details. Claiming a guest order needs proof of control: the order's live tracking token (already a credential), redeemed once while signed in. Without it, the Owner attaches it after their own verification |
| No account enumeration | Sign-up, sign-in and reset must answer alike whether or not the address exists; the customer instance's configuration and tests must show it (not verified for this library version yet) |
| No profile fields in logs | Same logging rules as orders: error name and SQL state only |

Considered and rejected: customers as rows in `auth_users` without a `user_access` row. It is simpler, and today such a user has no principal (tested), but one table for both means any future mistake in a role check, an endpoint allowlist or a query can mix them.

**Sign-in methods evaluated** (none activated):

| Method | Evaluation | Needs before building |
|---|---|---|
| Email and password | Built into Better Auth; recovery needs email delivery | An email provider within C-1 (none is chosen), verification and recovery wording, privacy policy text |
| Google | Better Auth's social provider; the founder has shown interest | A Google OAuth client (an external account: founder approval, C-2), consent screen, privacy disclosure, account-linking rule |
| Phone with a one-time code | Better Auth's `phone-number` plugin needs an SMS sender; S-9 forbids a required paid SMS dependency (C-1) | A free or approved delivery channel; none exists |
| Passkeys | Not among the plugins of the installed `better-auth` package (`dist/plugins`); would need an additional dependency and a stable production origin (WebAuthn binds to the domain) | Hosting and domain (decision 1), a dependency review against current documentation |

What remains before any customer account: the founder's S-14 decision, a privacy policy covering accounts (S-17), and data export and deletion rules (no retention period is approved).

## 2. Owner account recovery (OF-5: open)

Today: `npm run auth:reset-owner-password`, a local command whose trust boundary is direct database access (ADR-0003). It changes only the credential hash and deletes every session of the Owner in one transaction (tested). It cannot help an Owner who has lost access to the computer that holds the database.

Proposal, once hosting is chosen:

1. **Break-glass recovery codes** (preferred, no external service): ten single-use codes generated when the Owner asks for them, shown once, stored only as hashes (Better Auth's `hashPassword`), each redeemable once together with the Owner's email to set a new password. Redeeming one deletes every session, writes an audit row and is rate-limited like sign-in. Codes are kept offline by the founder (printed, in a safe place).
2. **Email reset** through Better Auth's `requestPasswordReset` once an email provider is approved. Its token storage, lifetime and answers for unknown addresses must be checked against the library version in use before relying on them.

Neither is built. Each adds a public endpoint that can change the Owner's credential, so it needs the founder's choice of method, a security review and negative tests (replay, expiry, wrong account, enumeration) in the same gate.

## 3. Two-factor sign-in (2FA, decision 3: open)

Evaluated in the installed `better-auth` 1.7.25 (`dist/plugins/two-factor`, `@better-auth/utils` 0.5.1), read on 2026-11-16:

| Property | Finding |
|---|---|
| TOTP | RFC 6238, 6 digits, 30-second period, codes compared in constant time |
| Accepted window | One period either side (`window = 1`), so a code is accepted for about 90 seconds |
| Replay | **No record of used codes:** the same code can be used again within its window |
| Secret storage | TOTP secret encrypted with the application secret (`symmetricEncrypt`) |
| Backup codes | Stored **encrypted, not hashed** by default (`storeBackupCodes: "encrypted"`); a custom encrypt or decrypt hook is possible |
| Brute force | Failed attempts are counted and the second factor locks after repeated failures |
| Sign-in flow | A sign-in with 2FA answers with a "two-factor required" step and a temporary cookie; the Office sign-in page, Bearer clients and the e2e tests would all need that step |
| Schema | A `twoFactor` table and a `two_factor_enabled` column on users |

Not activated. The replay window and the reversible backup codes are acceptable for many sites but fall short of the bar ADR-0003 set (no weaker credential than the password), and enabling the plugin needs a sign-in screen change, which this batch excludes. Proposal for the gate that adds 2FA: TOTP with a replay guard (store the last accepted time step per user and refuse it again), backup codes hashed through the plugin's custom hooks, re-authentication (password) before enabling, disabling or regenerating, and no automatic enrolment of the existing Owner.

## 4. Staff permissions (OF-7: roles are not built)

Reviewed `src/modules/auth/permissions.ts`: permissions are named; the only role, `owner`, holds the full list; every operation asserts one named permission on the server; `user_access.role` is a database-checked enum with only `owner`. A future role gets an explicit list, so nothing is granted by default, and `catalog:publish`, `users:manage`, `exports:create` and `payments:record` can stay Owner-only. Adding a role needs a migration (the enum and its check) and a test per permission it must not hold. No staff management, invitation or sign-up exists or is proposed here.

## Decisions requested

1. S-14: whether customer accounts are in launch scope, and with which sign-in methods.
2. OF-5: the recovery method (recovery codes, email reset or both), after hosting.
3. 2FA: whether it is required for the Owner, and when.
