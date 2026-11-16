# ADR-0003: Authentication and authorisation foundation

**Status:** Draft — Founder Review
**Date:** 2026-11-15
**Deciders:** Founder
**Related:** [ADR-0001](0001-application-stack.md) (item 4), [ADR-0002](0002-drizzle-and-inventory-foundation.md) (actors), [Product requirements](../product/requirements.md) (OF-4 to OF-10, API-10, open decision 3)

**In short:** The founder approved Better Auth with email and password, database-backed browser sessions, no public registration, a local Owner bootstrap, Owner-first named permissions and truthful user actors for implementation in Gate H.2 (2026-11-15). This ADR records what was built and what was not. Account recovery, 2FA, native-client credentials, business APIs, login screens and production readiness are **not** decided or built here.

## Context

ADR-0001 left authentication open (item 4): an established solution, sessions, CSRF protection, lost-device recovery and a credential strategy for native clients (OF-5, OF-10, API-10). The Gate H.1 review recommended Better Auth with its Drizzle adapter. The stock ledger could only record `system` actors until real users existed (OF-9).

## Decision (founder-approved for Gate H.2)

| Area | Decision |
|---|---|
| Library | `better-auth` **1.7.25**, exact pin, no prerelease. It bundles `@better-auth/drizzle-adapter` 1.7.25 (imported as `better-auth/adapters/drizzle`). No admin, OAuth, 2FA or API-key plugin. The Bearer plugin was added later for `/api/v1` ([ADR-0004](0004-api-v1-and-bearer-transport.md)). Peer ranges cover Next.js 16, React 19, `drizzle-orm` 0.45.4, `drizzle-kit` 0.31.11, `pg` 8 and Vitest 5. Every published GitHub advisory for the core, email-and-password and Drizzle-adapter paths is fixed at or before 1.7.7 (checked 2026-11-15). |
| Sign-in | Email and password only. Passwords hashed by Better Auth (scrypt, Node `crypto`); no project hashing code. Length 15 to 128 characters (15 follows NIST SP 800-63B-4 for a single-factor password; no composition rules). |
| Registration | Public sign-up is refused twice: `disableSignUp` (Better Auth answers `EMAIL_PASSWORD_SIGN_UP_DISABLED`, also for direct `auth.api` calls) and `/sign-up/email` in `disabledPaths` (HTTP 404). |
| HTTP surface | Better Auth's handler at `/api/auth/*` (`src/app/api/auth/[...all]/route.ts`). Ten endpoints stay enabled: sign-in, sign-out, get-session, list/revoke sessions, change-password, ok, error. Every other registered endpoint is disabled (`src/modules/auth/auth.ts`); a test fails if a library upgrade adds an endpoint that is in neither list. These are authentication routes, not the business API. |
| Sessions | Opaque session tokens in the `auth_sessions` table, sent as a signed, HttpOnly, SameSite=Lax cookie; Secure with the `__Secure-` prefix when the site runs on https. Cookie cache **off**, so every request reads the session row: sign-out, revocation and expiry take effect at once. Better Auth's default lifetime (7 days, extended once a day while in use) is kept. |
| CSRF and origin | Better Auth's origin and Fetch Metadata checks, with `trustedOrigins` left at the base URL only. Both checks are switched on explicitly because Better Auth turns them off when `NODE_ENV=test` or `TEST` is set. |
| Configuration | `BETTER_AUTH_SECRET` (at least 32 characters and about 120 bits by Better Auth's own estimate) and `BETTER_AUTH_URL` (an origin; plain http only for localhost outside production), validated at start-up. `BETTER_AUTH_TRUSTED_ORIGINS`, `BETTER_AUTH_SECRETS` and `BETTER_AUTH_TELEMETRY`, which Better Auth would apply behind that validation, are refused. Telemetry off. |
| Rate limiting | Better Auth's limiter with PostgreSQL storage (`auth_rate_limits`), on in every environment. Built-in rule: 3 sign-in attempts per 10 seconds per client and path; 100 requests per 10 seconds elsewhere. No client header is trusted for the client address (see Consequences). |
| Schema | Five tables from Better Auth's official Drizzle schema for this configuration, with UUID ids, `timestamptz` and project names: `auth_users`, `auth_sessions`, `auth_accounts`, `auth_verifications` (required by the core schema, unused), `auth_rate_limits` (migration `0003`). The Drizzle adapter maps Better Auth's model names to them. Applied only through `npm run db:migrate`; `auth migrate` and `drizzle-kit push` are not used. |
| Authorisation | A project-owned `user_access` table (one row per user: role, `disabled_at`). No Better Auth endpoint can write it. Roles map to named permissions in `src/modules/auth/permissions.ts`; the only role is `owner`, which holds all of them (`catalog:read`, `catalog:write`, `stock:read`, `stock:receive`, `stock:adjust`, `users:manage`, and since Gate H.10–H.12 `orders:read`, `orders:write`, `payments:record`, `settings:write`). `getPrincipal` verifies the session cookie, then reads the role from PostgreSQL on every call. A user with no row or a disabled row has no principal and cannot start a session (a session-creation hook answers like a wrong password). Disabling a user or removing the row also deletes all of that user's sessions (trigger `user_access_revoke_sessions`, migration `0005`, added in the Gate H.2a audit), so Better Auth's own self-service endpoints refuse them too. No role or user id from a request is ever used. |
| First Owner | `npm run auth:bootstrap-owner` (`scripts/bootstrap-owner.mts`): local CLI only, `babysunray_dev` only (same URL and PostgreSQL identity checks as `db:migrate`), interactive terminal only (password read without echo, twice). It refuses if any authentication user or access row exists, and creates user, credential account and owner access in one transaction under an exclusive table lock, so concurrent runs create at most one Owner. It hashes with `better-auth/crypto` and writes Better Auth's credential-account shape (`provider_id = 'credential'`, `account_id = user id`); tests prove the result by signing in over HTTP. No HTTP route, server action or start-up code creates an Owner. Better Auth offers no supported server-side way to create a password user while sign-up is disabled without the admin plugin, which was not approved. |
| Audit actors | `stock_movements` accepts `actor_type = 'user'` (migration `0004`, forward-only): `actor_ref` holds the user's UUID and the new `actor_user_id` column the same id, with a foreign key (`ON DELETE RESTRICT`) and a check that they agree. System rows must leave `actor_user_id` empty, so every historical row stays valid. The append-only trigger is unchanged. In code, a user actor exists only as an object issued by `actorFor(principal)` for a principal verified in `src/modules/auth/principal.ts`; a look-alike object is refused (`validateActor`). Since the Gate H.2a audit no exported function turns a user id into an actor. This is a guarantee about code paths inside one process, not a sandbox: code with database access can still write ledger rows. |
| Migration bypass | `drizzle.config.ts` now refuses every `drizzle-kit` command except `generate` and `check`, including `migrate`, and carries no credentials. |

## Consequences

- Each request to a protected operation costs two indexed reads (session, access). This is deliberate: no cached role or session can outlive a revocation, a disable or a role change.
- Better Auth stores the session token in plain text in `auth_sessions` (its design); anyone who can read that table can use a live session. Database access must stay restricted.
- **Client address:** with no trusted proxy configured, local requests count as `127.0.0.1`, and in production every client would share one bucket per path. That resists header spoofing but lets anyone exhaust the sign-in limit for everyone. A per-client limit needs the hosting decision (which proxy sets which header) and a matching `trustedProxies` setting.
- `auth.api` calls made from server code skip rate limiting and origin checks (Better Auth documents this). The HTTP tests go through the real handler; future server actions must check authorisation through `requirePermission` and rely on Next.js's own server-action origin protection.
- Users referenced by ledger rows cannot be deleted. Deactivation is the `disabled_at` column.
- Because `better-auth` lists `drizzle-kit` and `vitest` as optional peers, npm no longer marks them `dev` in the lockfile, and `npm audit --omit=dev` reports the existing `drizzle-kit` → `esbuild` development-server advisory (moderate). A production install procedure must exclude them explicitly; this waits for the hosting decision.

## Not decided or not built

- Account recovery (password reset or another lost-device path), email delivery and email verification: the endpoints are disabled. OF-5's recovery requirement is **not met**. Since batch H.7–H.9 a local operator command, `npm run auth:reset-owner-password` (`src/modules/auth/owner-password-reset.mts`), replaces the manual database procedure on a development installation: same target checks and terminal rules as the bootstrap, exactly one active Owner, only its credential hash changed, all its sessions deleted in the same transaction. Its trust boundary is local database access; it is not a production recovery mechanism (docs/guides/authentication.md).
- TOTP or other 2FA, backup codes, break-glass access.
- Native-client apps and their token storage (API-10, API-12). The Bearer transport itself is in [ADR-0004](0004-api-v1-and-bearer-transport.md).
- Business API endpoints (`/api/v1`), OpenAPI, login or Owner Office screens, staff or admin roles and their management. Since built, except roles: the API in [ADR-0004](0004-api-v1-and-bearer-transport.md); the sign-in page and a functional Owner Office in batch H.4–H.6 (docs/guides/admin-panel.md). The Office signs in and out through Better Auth's HTTP endpoints from the browser (not `auth.api` from server code), so the origin check and sign-in rate limit above apply; its pages and Server Actions use `getPrincipal` (cookie only) and check permissions themselves.
- Session lifetime policy beyond the library default, production cookie domain, secret rotation, separate migration and runtime database roles, and the production proxy and IP strategy. All wait for hosting or a founder decision.
- Creating the founder's real Owner account. That is an operator action (docs/guides/authentication.md).

## Alternatives considered

- Better Auth's admin plugin for Owner creation: adds HTTP user-management endpoints and an admin role model that were not approved.
- Temporarily enabling sign-up to create the first Owner: rejected; it opens public registration.
- Role as a Better Auth `additionalFields` column with `input: false`: rejected in favour of a table no Better Auth endpoint can write.
- `auth migrate` (Kysely only) or `drizzle-kit push`: not compatible with the reviewed-migration workflow (ADR-0002).
