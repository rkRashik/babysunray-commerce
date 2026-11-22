# Founder acceptance: walkthrough and setup

**Status:** Draft — Founder Review
**Purpose:** How the founder runs the whole shop on the staging site, step by step in a browser, before any public launch. Part 1 is for the founder and needs no technical knowledge. Part 2 is the one-time technical setup, for whoever runs the commands. Design: [ADR-0011](../adr/0011-founder-acceptance-and-customer-sign-in.md).

The site `https://babysunray.com` runs on Netlify behind visitor protection and is connected to the **staging** database. Everything below writes real records to that staging database only, never to a real shop. **Use made-up customer names and phone numbers.** The public shop stays closed: only a browser holding an acceptance pass started in the Admin can open it.

## What has been proven, and what has not

| Area | State |
|---|---|
| The whole order journey (publish, shop as a customer, place an order, confirm, pack, dispatch, deliver, record cash, track) | **Verified in tests** on an isolated test database (`tests/e2e/acceptance.spec.ts`). **Not yet done by you on staging.** That is this walkthrough. |
| Duplicate submissions, the last unit sold twice, a price or stock change during checkout, a lost answer retried, cancelling | **Verified in tests** (`tests/db/guest-checkout.integration.test.ts`, `tests/e2e/orders.spec.ts`). Steps 17 and 18 below repeat the visible ones on staging. |
| Returns, inspection and restocking | **Verified in tests**. Not part of the original 19 steps; step 20 is optional. |
| Staging is staging-marked, Google sign-in is offered, the per-client checkout limit is on, the image CDN is configured, both delivery areas have a charge, 0 products published | **Verified on protected staging** (read-only, 22 Nov 2026) on the Shop acceptance and Launch readiness pages. |
| Customer email accounts | **Configured** (Store settings says the email service is set up). Whether an email actually arrives is **not verified**: step 10 checks it. |
| Photo upload from the live site, Google's real sign-in, the per-client limits under real traffic | **Not yet verified.** Steps 4, 10 and 17. |
| Database updates 0022 (an index) and 0023 (the Facebook and Instagram fields) | **Not applied on staging.** See section "Database updates" below. Social links stay uneditable until then; everything else works. |
| The public launch gate | **Closed**, by design. Nothing in this walkthrough opens it. |

The system is not "verified" until you have completed this list on the staging site.

---

# Part 1. The walkthrough

Use **two browser windows**: a normal one for the Admin (the shop's back office) and a **private (incognito) window** as the customer. Open the links below in the right one. Every link needs you to be signed in to Netlify first; that is the visitor protection working.

**Test or real?** Everything here is **test only**, except where a step says *real setting*. Name your test product something obvious, like "ACCEPTANCE TEST Romper", so you can tell it from anything real. Never type a real customer's details.

**Made-up details to use:** customer name `Test Customer`, phone `01711000070`, address `House 70, Road 7, Test Area, Dhaka`.

**If something goes wrong in any step:** do not repeat it more than once. Take a screenshot, note the step number and what the page said, and stop; then tell me. Nothing you do here can affect a real customer.

| # | Do this | Where | You should see | If it does not work |
|---|---|---|---|---|
| 1 | **Sign in** to the Admin. | [Admin login](https://babysunray.com/admin/login) | The Dashboard. | Check the address is `babysunray.com` and that you are signed in to Netlify. |
| 2 | **Check the delivery charges.** *Real setting.* Do not invent amounts. If both areas already show a charge, leave them. If one is missing, enter your real charge (or a clearly fake one such as 1 taka, and change it back later). | [Delivery charges](https://babysunray.com/admin/settings/delivery) | Dhaka City and Outside Dhaka both active, each with a charge. | An area without a charge cannot take orders: the checkout says so. |
| 3 | **Create a test product.** Name in English and Bangla, a short description in both, fabric (write only what is true, tick the confirmation), care instructions, a category. | [New product](https://babysunray.com/admin/products/new) | A draft product page. | The page names the missing field in red. |
| 4 | **Complete it.** Add two sizes (for example 0-3M and 3-6M) with one colour and a price each; the size chart in cm; a photo you own (under 5 MB) with a short description in both languages. | The product page (the buttons under the overview jump to each part) | The yellow "missing" list on the product shrinks until everything is met. | If the photo will not upload, note the exact message: photo upload from the live site is not yet verified. |
| 5 | **Receive stock** for each size. Give one size 5 units and the other 1 unit. | The size's page (select its code in *Variants and stock*) | On hand shows what you received. | |
| 6 | **Mark the content as reviewed**, then **Publish to the shop**. | The product page, *Publishing* | "Published". The page says the *proposed* rule applied (acceptance only). | The card lists what is still missing. |
| 7 | **Optional:** write, review and publish a policy. Only wording you approve; nothing is made up for you. | [Policies](https://babysunray.com/admin/policies) | The shop footer and checkout then link to it. | |
| 8 | **Start acceptance in the customer window.** In the private window: sign in to the Admin, open Shop acceptance, press **Start acceptance in this browser**, then sign out of the Admin in that window. | [Shop acceptance](https://babysunray.com/admin/acceptance) | "Holds an acceptance pass". | Without a pass the shop shows "not found": that is correct. |
| 9 | **Shop as the customer.** English and Bangla. Browse, search, **sort** by price, **filter** by size, open your product, open the **size guide**, choose a size and colour, **Add to Bag**, change the quantity. Check the sold-out size cannot be bought. | [Shop, English](https://babysunray.com/en) · [Shop, Bangla](https://babysunray.com/bn) | Real prices and stock; a strip at the top saying this is acceptance. The button says "Select a size" until you choose, and "Sold out" for the size with no stock. | |
| 10 | **Optional:** make a customer account with an email address you own (and/or **Continue with Google**). | [My order](https://babysunray.com/en/order) | A verification email arrives (check spam). Google shows your name and gives no Admin access. | If no email arrives, email delivery is not working: note it. Ordering never needs an account. |
| 11 | **Check out.** In the Bag choose the delivery area, press **Checkout**. The area should already be selected and the total unchanged. Enter the made-up details and **Place order**. | [Bag](https://babysunray.com/en/cart) | "Order received", an order number, and a **private tracking link shown once**. Copy it into a private note, not a chat. | A red message says what to fix. If the connection drops, press the button again: it never makes two orders. |
| 12 | **Find the order.** | [Orders](https://babysunray.com/admin/orders) | "Pending verification" with the same number and total. The size's *reserved* count has gone up. | |
| 13 | **Process it.** *Confirm* (pretend you phoned them), *Mark packed*, *Dispatch*, *Record delivery*. | The order page | Each step appears in *History*. Dispatch takes the item out of stock; delivery is your own record, no courier is connected. | |
| 14 | **Record the cash.** In *Cash on delivery*: **Courier collected**, then **Settled to me**. Use the order's own total. | The order page | Payment shows "Settled". Delivered did not count as collected until you recorded it. | |
| 15 | **Check the numbers.** Stock on hand dropped once; history is complete; reports agree. | [Reports](https://babysunray.com/admin/reports) · [Dashboard](https://babysunray.com/admin/dashboard) | COD collected and settled equal the order total. The reconciliation check says passed. | A red reconciliation message means the money records disagree: stop and tell me. |
| 16 | **Track as the customer.** Paste the link from step 11 in the private window. | (your saved link) | The same order, Confirmed then Delivered. | |
| 17 | **Failure and recovery.** (a) Order 2 of the size with 1 unit in stock. (b) Press **Place order** twice quickly on another order. (c) Cancel a pending order from its tracking page. | The shop and the tracking page | (a) a clear "not enough stock" message and nothing created; (b) one order only; (c) "Cancelled" and the stock released. | |
| 18 | **Withdraw the test product.** | The product page | It is gone from the shop at once. | |
| 19 | **Read what still blocks launch.** | [Launch readiness](https://babysunray.com/admin/launch-readiness) | The public gate closed, with each reason and its next step. | |
| 20 | **Optional: a return.** On a delivered test order, *Returns and exchanges, Record a return or exchange*, then *Goods received: send to inspection*, then *Passed: back to stock*. Use a clearly fake refund amount; recording a refund moves no money. | The order page | Returned goods wait in *Inspection* and are not for sale until you pass them. | |

When you are done, press **End acceptance in this browser** on the Shop acceptance page (or wait 8 hours). Test orders and money records stay in the staging database; they never reach a real shop.

---

# Part 2. Setup (for the person who runs the commands)

Run these yourself in an interactive terminal from this repository. They read `.env.staging.local`; never paste its values anywhere. Keep Netlify visitor protection on. The production database does not exist yet and is created last ([production-migration.md](production-migration.md)).

## Database updates (migrations)

The repository has migrations 0000 to 0023. The newest staging migration report on this computer (19 Nov) shows 22 applied (0000 to 0021), so two are pending. 0023 is confirmed pending by the live Social links card; 0022 cannot be seen from the site, and the migration command's own `before` count settles it:

| Migration | What it does | If it is missing |
|---|---|---|
| 0022 `order_phone_search` | One index on the order's phone number. No data changes. | Order search by phone works, slower on a large table. |
| 0023 `store_social_links` | Two optional text columns for the Facebook and Instagram links and a length check. No data changes. | The Social links card says the update is needed; nothing else is affected. |

Both are additive (`npm run migrations:review -- --after 21` reports "additive", nothing destructive). The procedure, in this order (the migration command refuses without a fresh backup of the same database):

1. `npm run staging:preflight`: lists missing settings, connects to nothing.
2. `npm run backup:create:staging -- --out D:\BabySunray-staging`: an encrypted copy of the database (passphrase asked twice). The newest backup on this computer is from 19 Nov, older than the 24 hours the migration accepts. Optional but sensible: `npm run media:backup:staging -- --out D:\BabySunray-staging` for the photos.
3. `npm run db:migrate:staging -- --backup <that file> --report D:\BabySunray-staging\migrate-<date>.json`: shows the host and asks you to type it back; applies the migrations in one transaction; audits the privileges. The report's `after` must read 24 applied (`before` 22, or 23 if 0022 was already applied), with `privilegeFindings` empty (the `privilegeWarnings` about Supabase's own role are known and expected).
4. After it: open [Store settings](https://babysunray.com/admin/settings/store). The Social links card should now be editable and all other details unchanged. Add a Facebook and an Instagram link (full `https://` addresses; empty ones stay hidden), then open the [shop preview](https://babysunray.com/admin/storefront-preview/en) and look at the footer.

The row "Database update 0020" on the Shop acceptance page only proves the acceptance tables exist; it does not report the newer updates. The Social links card is the live sign for 0023.

## One-time setup

| Step | What | How |
|---|---|---|
| 1 | Get the new code | `git pull` |
| 2 | Back up staging, then apply pending database updates | Section above. |
| 3 | An Owner account on staging (only if you cannot sign in) | Set `ADMIN_SETUP_TOKEN` (below), redeploy, open `https://babysunray.com/admin/setup`. Emergency alternative: `npm run auth:bootstrap-owner:staging`. |
| 4 | Google OAuth client "BabySunRay Production" (Google Cloud project BabySunRay-Commerce) | Authorised JavaScript origin `https://babysunray.com`; redirect URI exactly `https://babysunray.com/api/auth/callback/google`. Scopes `openid`, `email`, `profile` only. In "Testing" mode add your own Google account as a test user. |
| 5 | Netlify environment variables | The list below. Then **Deploys → Trigger deploy** so the functions read them. |
| 6 | Check | Open `https://babysunray.com/admin/acceptance` (technical details): staging marked, Continue with Google offered, per-client limit on. |

## Netlify environment variables (one list)

Site configuration → Environment variables. Mark keys and secrets as **secret**. Never use the `NEXT_PUBLIC_` prefix. Do not change `BETTER_AUTH_SECRET` (it would sign everyone out and end every pass).

| Variable | Value | State |
|---|---|---|
| `DATABASE_URL` | Staging transaction-pooler URL for the `babysunray_app` role (from `npm run netlify:env`) | Set; keep |
| `DATABASE_RUNTIME` / `DATABASE_POOLER` / `DATABASE_SSL` | `serverless` / `transaction` / `require` | Set; keep |
| `BETTER_AUTH_SECRET` | Unchanged | Set; keep |
| `BETTER_AUTH_URL` | `https://babysunray.com` exactly (no trailing slash) | Check |
| `MEDIA_STORAGE_PROVIDER` / `SUPABASE_URL` / `SUPABASE_STORAGE_BUCKET` / `SUPABASE_SERVICE_ROLE_KEY` | `supabase` and the staging values | Set per the earlier setup; confirmed by step 4 of the walkthrough |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | The OAuth client's values (secret) | Set (Google is offered) |
| `TRUSTED_PROXY` | `netlify` | Set (the limit shows On) |
| `RESEND_API_KEY`, `EMAIL_FROM` | Resend key (secret) and a sender on your verified domain | Set (ADR-0012) |
| `ADMIN_SETUP_TOKEN` | Only if staging has no Owner: 32+ random characters, typed once at `/admin/setup` | Optional |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Your Cloudinary values; optional `CLOUDINARY_FOLDER` | Configured (the CDN shows configured) |
| `STORE_NAME`, `STORE_LINE_EN`, `STORE_LINE_BN`, `STORE_CONTACT_PHONE`, `STORE_CONTACT_EMAIL` | Defaults only; Store settings overrides them | Optional |

Not needed now: `MAINTENANCE_SECRET` (no scheduler can reach the site through visitor protection; see [infrastructure.md](infrastructure.md)).

## Ending, and what never reaches production

- **End acceptance in this browser** on the acceptance page, or let the pass expire (8 hours).
- Rehearsal orders, customers, tracking links, money records and test policies stay in the staging database. The production database is a new, empty project; acceptance can never run there (it is not marked staging). Real catalogue data is moved only by the controlled procedure in [production-migration.md](production-migration.md), section 7.

## Not verified before your run

Google's real sign-in, an email actually arriving, photo upload from the live site (about 6 MB per request on Netlify; keep photos below 5 MB), Cloudinary copies of published photos, Netlify's client address header and the per-client limits under real traffic. Report anything that does not behave as described.
