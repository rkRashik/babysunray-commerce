# Authentication and authorisation

**Status:** Draft — Founder Review
**Purpose:** Sign-in, sessions, permissions, Bearer tokens for API clients, and the local account commands.

Implemented with Better Auth ([ADR-0003](../adr/0003-authentication-foundation.md)): email and password, sessions stored in PostgreSQL and sent as an HttpOnly cookie, and role-based permissions in `src/modules/auth`. The only role today is `owner` (the admin), which holds every permission; permission checks are written so further roles can be added. There is no public sign-up. The API's Bearer transport is in [ADR-0004](../adr/0004-api-v1-and-bearer-transport.md).

| Capability | Where |
|---|---|
| Sign-in, sign-out, session listing and revocation, password change | Better Auth's endpoints under `/api/auth` (`src/app/api/auth/[...all]/route.ts`). All other Better Auth endpoints, including public sign-up, answer 404. |
| Verified principal and permission checks for server code | `getPrincipal`, `requirePrincipal`, `requirePermission` in `src/modules/auth/principal.ts`; roles and permissions in `permissions.ts`. The role is read from PostgreSQL on every request. |
| Audit actor for an authenticated user | `actorFor(principal)`; ledger rows and order events then record the user's id. No other code path creates a user actor, and no request field can name one. |
| Losing access | Disabling a user (`user_access.disabled_at`) or removing the access row deletes all of that user's sessions at once (migration `0005`). |
| Bearer tokens for non-browser clients | Only on `/api/v1` and Better Auth's own endpoints; never accepted by browser-side code, never sent to a browser. |
| First admin account | `npm run auth:bootstrap-owner` (below). |
| Lost admin password, local installation | `npm run auth:reset-owner-password` (below). Not a production recovery path. |
| Security audit (Gate H.39) | `auth_events` (migration `0017`, append-only; `src/modules/auth/audit.ts`). Recorded through Better Auth's documented hooks: every sign-in (user, session id, browser or native client), every failed sign-in (anonymous; only a keyed HMAC of the address tried, so attempts on one address can be grouped but the address is not stored), every ended session once (sign-out, revocation, password change, expiry; two concurrent "sign out everywhere" requests still give one row per session) and every password change. The local commands record `owner_created` and `owner_password_reset` in their own transactions, and a trigger records every `user_access` change (grant, disable, enable, removal) with the number of open sessions. No password, token, cookie or address is stored, and no actor, user or role is taken from a request. A sign-in that cannot be recorded is refused and its new session deleted; a sign-out or revocation always takes effect and a failed audit write is logged (names only). The Owner reads it through the "Sign-in and access audit" export (audited like every export). Rows are kept: no retention period is approved. Growth from failed sign-ins is bounded by the sign-in rate limit (requests refused by the limiter are not recorded). Changing `BETTER_AUTH_SECRET` changes the digests of later failed attempts (the digest key is derived from it with HKDF). The replacement session a password change creates when it revokes the others is recorded as a `sign_in` (`via: password_change`) and refused the same way if it cannot be. A session found expired by any endpoint is recorded as `expired`. Known gaps: `transport` (browser or native) is what the request's headers suggest, not a proof; sessions deleted by the access trigger or the local reset are counted in their own rows, not one row each; a session created in the instant between Better Auth listing the sessions to revoke and deleting them is deleted without its own row. `/api/auth` runs in its own bulkhead (2 at once, then a short queue, then `503`), so a sign-in flood slows sign-in but not the rest of the Admin. |

## Creating the first admin account

```
npm run auth:bootstrap-owner
```

It works only in an interactive terminal, only against the local `babysunray_dev` database (the same checks as `db:migrate`), and only while no account exists. It asks for the email and display name, then the password twice without showing it (15 to 128 characters). Nothing is passed on the command line or written to a log. Creates the user, its credential and the `owner` access row in one transaction under an exclusive lock, so concurrent runs create at most one account.

## Resetting a lost password on a local installation

```
npm run auth:reset-owner-password
```

The same restrictions as the bootstrap apply: interactive terminal only, local `babysunray_dev` only, no value on the command line. Before asking anything it checks that the installation has exactly one active admin account; it then asks for that account's email and the new password twice without showing it. In one transaction, under locks that also serialise a concurrent reset or bootstrap, it replaces that credential's hash (Better Auth's scrypt) and deletes every session of the account, so all signed-in browsers and Bearer tokens stop working at once. Any failure rolls the whole change back. It prints only how many sessions were signed out. **Limits:** whoever can run it against the database can take over the account; that is already true of anyone with write access to the authentication tables, so local database and operator access is the trust boundary. There is no HTTP or email reset.

## Known limits

- No production account recovery: password reset over HTTP, email verification and any email sending are disabled. No 2FA.
- No native app exists. A non-browser client can obtain a Bearer token; it lasts as long as a browser session.
- Sign-in rate limiting is stored in PostgreSQL (3 attempts per 10 seconds per client). No client header is trusted for the client address, so locally every request counts as one client, and in production all clients would share the limit until a proxy setup is chosen with hosting.
- Tested locally only. Production cookie, proxy, secret rotation and database-role settings wait for the hosting decision.
