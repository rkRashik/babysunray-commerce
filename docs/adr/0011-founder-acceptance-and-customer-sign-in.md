# ADR-0011: Founder acceptance, the real shop, and optional customer sign-in

**Status:** Draft — Founder Review
**Purpose:** How the real shop, checkout, publication, policy publication and Google sign-in run for the founder only, on the staging database only, while the public launch gate stays closed.
**Date:** 2026-11-19
**Deciders:** Founder
**Related:** [ADR-0007](0007-guest-checkout-foundation.md) (guest checkout), [ADR-0008](0008-customer-identity-recovery-and-mfa.md) (customer identity proposal), [ADR-0010](0010-hosting-and-image-delivery.md) (Netlify, Supabase, Cloudinary), [launch readiness](../operations/launch-readiness.md), [acceptance runbook](../operations/acceptance.md)

**In short:** The founder asked (19 Nov 2026) to run the whole commerce lifecycle with the real services before the public launch, on the staging Supabase database, behind Netlify's visitor protection. The shop, its checkout and customer sign-in are now routed, but every request is decided by one server-side check with three answers: **public** (the launch gate, still literally closed), **acceptance** (a founder pass on the staging database), **closed** (everything else, answered before any database work).

## 1. Two distinct states

| | A. Founder acceptance (built) | B. Public commerce (not open) |
|---|---|---|
| Who | A browser holding an acceptance pass that a signed-in Owner started | Anyone |
| Where | Only a database that carries the staging marker (schema `babysunray_target`, comment `babysunray:staging`) | Any database, once opened |
| Opened by | "Start acceptance in this browser" in the Admin (`/admin/acceptance`, permission `acceptance:run`) | A reviewed code change to `src/modules/launch/gate.ts` after the founder's launch approval |
| Services | The same catalogue, checkout, order, stock, tracking and publication services | The same |
| Publication rule | The proposed I-6 rule (`i6-proposed-acceptance`, recorded with each publication) | Only an approved rule (`APPROVED_PUBLICATION_RULE`, null today) |

There is no query parameter, header, environment variable or setting that opens either state. The gate module reads nothing; the acceptance module reads no environment variable (unit tests check both).

## 2. The acceptance pass

- An HttpOnly, `SameSite=Lax` cookie (`bsr_acceptance`, `Secure` on https), valid for 8 hours: `v1.<owner id>.<expiry>.<random>.<HMAC>`. The HMAC key is derived from `BETTER_AUTH_SECRET` for this purpose only, so a pass can never stand in for a session cookie or the reverse.
- Verified on every shop page, Server Action and route: a missing, forged, altered or expired pass is "closed" **before any database work**. A valid pass also needs the pass's Owner to still have active access and the connected database to carry the staging marker (read from PostgreSQL, cached for one minute per process).
- It is independent of the Owner's session, so the founder can sign out of the Admin and shop as a separate customer in the same browser, or in a private window.
- Closed, the shop answers like a page that does not exist (404); the checkout answers 503 `checkout_closed`; customer sign-in answers 404; product photos answer 503.

**After the switch to production:** the production database is not marked staging, so no pass can open acceptance there, and staging orders, customers and tracking links stay in the staging database. Real catalogue data is moved by a separate, controlled procedure ([production-migration.md](../operations/production-migration.md), section 7); rehearsal orders, customers, tracking links and money records are never moved.

## 3. The shop

- Pages at `/en` and `/bn` reuse the First Light storefront components of the Owner's preview through one "surface" parameter (`preview` or `shop`): the same markup, a different scope (drafts versus published products only), different photo URLs (Owner-only route versus CDN or the gated public photo route) and different Server Actions. The preview and the shop keep separate carts in the browser.
- Prices, stock, delivery charges and totals always come from the server. The last checkout step posts the order with the prices the server just showed and one idempotency key per checkout to `POST /api/shop/checkout` (the existing transport, ADR-0007). "Order received" appears only after the server answered 200 or 201; without an answer the page says the outcome is unknown and that pressing the button again is safe (same key, same order).
- Headers: never framed, `noindex` while not public, same-origin referrer. The tracking link is shown once on the confirmation.

## 4. Optional customer sign-in (Google)

Implements the first option of ADR-0008 section 1, which the founder chose on 19 Nov 2026 (S-14), with migration 0020:

- A second Better Auth instance (`src/modules/customers/auth.ts`) with its own tables (`customer_users`, `customer_sessions`, `customer_accounts`, `customer_verifications`, `customer_rate_limits`), cookie prefix `bsr-customer`, base path `/api/customer-auth` and a derived secret. `user_access` references only `auth_users`, and the Admin and `/api/v1` verify only the Owner instance, so a customer can never hold an Admin permission (a database test inserts the Owner's own email as a customer and shows `user_access` refuses it).
- Google only, scopes `openid email profile` (the provider's defaults), `prompt=select_account`, no ID-token sign-in, **no account linking** (a different Google account with an existing address is refused, never merged), only an address Google reports as verified creates an account, and no OAuth token is stored (dropped before every write; a database check refuses them).
- Only three endpoints are reachable, each behind the shop access check: `POST /api/customer-auth/sign-in/social`, `POST /api/customer-auth/sign-out`, and the callback. The redirect URI registered with Google is `https://babysunray.com/api/auth/callback/google`; that path is a dedicated route that hands the request to the customer instance (the Owner instance keeps refusing every social path).
- Guest checkout is unchanged. A signed-in customer's order is linked to their account in the order's own transaction (`customer_orders`, from the verified session, never from the body), and "My order" lists those orders.
- Settings: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (both or neither; server only). Without them nothing is offered.

## 5. Publication

- Product: Publish and Withdraw on the product page (`catalog:publish`). Publishing names the content digest the page showed; a change since is refused. Cloudinary copies are made after the commit and removed after a withdrawal (ADR-0010, unchanged).
- Policies: a reviewed draft version is published only by the Owner (`policies:publish`) with an explicit approval box; the exact text, its digests, who and when are copied into the append-only `policy_publications`. Customers see only the newest publication of a kind; a withdrawal hides it. No placeholder is ever shown as a policy.

## 6. Abuse protection

- Behind Netlify, `TRUSTED_PROXY=netlify` trusts Netlify's own `x-nf-client-connection-ip` (set by its edge, replacing any client value). The address is never stored: limits key on an HMAC of it. Without the setting, no address header is trusted.
- Checkout: the storewide limit (20 per minute) plus 10 per client per hour; both before any order work. Sign-in (Owner and customer): Better Auth's per-client limits use the same header.
- 24-hour verification expiry: every checkout, order and stock operation releases overdue holds first, so an expired order never blocks stock anyone wants. A scheduled batch stays a launch item: a Netlify scheduled function cannot call the site through visitor protection.

## 7. Consequences

- Founder actions are needed on the host: the staging migration 0020 (after a staging backup), and the settings in [acceptance.md](../operations/acceptance.md). Until migration 0020 is applied on staging, pages that read the new tables fail there; the Owner sign-in, orders and catalogue do not use them.
- Not verified here: Google's real sign-in, Cloudinary uploads, Netlify's client-address header and limits under real traffic. They are checked during the founder's acceptance run.
- Opening the public shop remains a founder decision and a code change; this ADR does not make it.
