# Founder acceptance: setup and checklist

**Status:** Draft — Founder Review
**Purpose:** How the founder prepares the staging site once and then runs the whole commerce lifecycle on it, with the real services, before any public launch. Design: [ADR-0011](../adr/0011-founder-acceptance-and-customer-sign-in.md).

The site `https://babysunray.com` runs on Netlify, behind Netlify's visitor protection, connected to the **staging** Supabase database. Everything below writes real records to that staging database only. Use fictional customer names and phone numbers. The public shop stays closed: only a browser holding an acceptance pass started in the Admin can open it.

## 1. Before you start

- Run the commands below yourself, from this repository on your computer, in an interactive terminal. They read `.env.staging.local`; never paste its values anywhere else.
- Keep Netlify visitor protection on.
- The production database does not exist yet and is created last ([production-migration.md](production-migration.md)).

## 2. One-time setup (in this order)

| Step | What | How |
|---|---|---|
| 1 | Get the new code | `git pull` |
| 2 | Back up staging, then apply database update 0020 | `npm run backup:create:staging`, then `npm run db:migrate:staging -- --backup <that file> --report <a new file outside the repository>` ([staging-setup.md](staging-setup.md)). Update 0020 only adds tables; nothing existing changes. |
| 3 | An Owner account on staging (only if you cannot sign in at `https://babysunray.com/admin/login` yet) | `npm run auth:bootstrap-owner:staging`. It asks for your email, name and password; it refuses if an active Owner already exists. |
| 4 | Google OAuth client "BabySunRay Production" (Google Cloud project BabySunRay-Commerce) | Authorised JavaScript origin `https://babysunray.com`; authorised redirect URI exactly `https://babysunray.com/api/auth/callback/google` (already set). Consent screen scopes: `openid`, `email`, `profile` only. In "Testing" mode add your own Google account as a test user. |
| 5 | Netlify environment variables | The list in section 3. Then **Deploys → Trigger deploy** so the functions read them. |
| 6 | Check | Open `https://babysunray.com/admin/acceptance`: "Database: Marked as the staging database", "Database update 0020: Applied", "Continue with Google: Offered to shoppers", "Per-client checkout limit: On". |

## 3. Netlify environment variables (one list)

Site configuration → Environment variables. Mark keys and secrets as **secret**. Never use the `NEXT_PUBLIC_` prefix. Do not change `BETTER_AUTH_SECRET` (it would sign everyone out and end every pass).

| Variable | Value | State |
|---|---|---|
| `DATABASE_URL` | Staging transaction-pooler URL for the `babysunray_app` role (from `npm run netlify:env`) | Already set; keep |
| `DATABASE_RUNTIME` / `DATABASE_POOLER` / `DATABASE_SSL` | `serverless` / `transaction` / `require` | Already set; keep |
| `BETTER_AUTH_SECRET` | Unchanged | Already set; keep |
| `BETTER_AUTH_URL` | `https://babysunray.com` exactly (no trailing slash). Checkout, sign-in and Google all use it | Check |
| `MEDIA_STORAGE_PROVIDER` / `SUPABASE_URL` / `SUPABASE_STORAGE_BUCKET` / `SUPABASE_SERVICE_ROLE_KEY` | `supabase` and the staging values | Already set; keep |
| `GOOGLE_CLIENT_ID` | The client ID of "BabySunRay Production" | **New** |
| `GOOGLE_CLIENT_SECRET` | Its client secret (secret) | **New** |
| `TRUSTED_PROXY` | `netlify` | **New** |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Your Cloudinary account's values (secret for the last two); optional `CLOUDINARY_FOLDER` | Optional: without them published photos are served by the site itself |
| `STORE_NAME`, `STORE_LINE_EN`, `STORE_LINE_BN`, `STORE_CONTACT_PHONE`, `STORE_CONTACT_EMAIL` | The shop's real name, line and contact, when you have approved them | Optional; nothing is shown without them |

Not needed now: `MAINTENANCE_SECRET` (no scheduler can reach the site through visitor protection; see [infrastructure.md](infrastructure.md)).

## 4. Founder Acceptance Checklist

Use a normal window for the Admin and a private window as the customer.

| # | Do this | Where | Expect |
|---|---|---|---|
| 1 | Sign in | `https://babysunray.com/admin/login` | The dashboard |
| 2 | Set both delivery charges | `https://babysunray.com/admin/settings/delivery` | Dhaka City and Outside Dhaka active |
| 3 | Create a product: names, descriptions, fabric (confirm it), care, category | `https://babysunray.com/admin/products/new` | A draft |
| 4 | Add sizes, colours and prices (variants), the size chart in cm, photos with descriptions in both languages | The product page | Every readiness item met |
| 5 | Receive stock for each variant | `https://babysunray.com/admin/skus/<SKU>` | On hand as received |
| 6 | Mark the content as reviewed, then **Publish to the shop** | The product page, "Publication" | "Published"; the rule shown is the proposed one (acceptance only) |
| 7 | Optional: write, review and publish the delivery, return and privacy policies (only wording you approve) | `https://babysunray.com/admin/policies` | Footer and checkout link to them |
| 8 | In the private window: sign in, **Start acceptance in this browser**, then sign out of the Admin | `https://babysunray.com/admin/acceptance` | "Holds an acceptance pass"; shop links |
| 9 | Shop: browse, search, open the product, choose size and colour, add to the bag | `https://babysunray.com/en` (or `/bn`) | Real prices and stock; the acceptance strip on top |
| 10 | Optional: **Continue with Google** | `https://babysunray.com/en/order` | Signed in as your Google name; no Admin access |
| 11 | Check out: name, phone, address, delivery area, **Place order** | `https://babysunray.com/en/checkout` | "Order received", an order number and a private tracking link shown once: copy it |
| 12 | Find the same order | `https://babysunray.com/admin/orders` | Pending verification, the same number and total; stock reserved on the SKU page |
| 13 | Confirm (after "verifying" with yourself), Mark packed, Dispatch, Mark delivered | The order page | Each step in the history; "Mark delivered" is your own record (no courier is connected) |
| 14 | Record the cash: Courier collected, then Settled to me | The order page, "Cash on delivery" | Payment "Settled" |
| 15 | Check stock, history, reports | The SKU page, `https://babysunray.com/admin/reports`, `https://babysunray.com/admin/dashboard` | On hand reduced once; totals agree |
| 16 | Track as the customer | The tracking link from step 11 | The same order, Confirmed and Delivered |
| 17 | Try failure and recovery: a second order then cancel it from the tracking page; place an order larger than the stock; press Place order twice | Shop and tracking page | Cancelled with stock released; "not placed" message; one order only |
| 18 | Withdraw the product | The product page | Gone from the shop at once |
| 19 | Read the remaining blockers | `https://babysunray.com/admin/launch-readiness` | The public launch gate closed, with its reasons |

The system is not "100% verified" until you have completed this list on the staging site.

## 5. Ending, and what never reaches production

- **End acceptance in this browser** on the acceptance page, or let the pass expire (8 hours).
- Rehearsal orders, customers, tracking links, money records and test policies stay in the staging database. The production database is a new, empty project; acceptance can never run there (it is not marked staging). Real catalogue data is moved only by the controlled procedure in [production-migration.md](production-migration.md), section 7.

## 6. Not verified before your run

Google's real sign-in, Cloudinary uploads from the live site, Netlify's client address header and the per-client limits under real traffic, and the live site's photo upload size limit (about 6 MB per request on Netlify; keep photos below 5 MB). Report anything that does not behave as described.
