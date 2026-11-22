# Founder acceptance: walkthrough and setup

**Status:** Draft — Founder Review
**Purpose:** The one comprehensive session in which the founder tries the whole shop and Admin on the staging site before any public launch: products, stock, customers (including Google), cash on delivery and manual advance payments, cancellations and refunds, staff roles, reports and tracking. Part 1 is for the founder and needs no technical knowledge. Part 2 is the one-time technical setup, for whoever runs the commands. Design: [ADR-0011](../adr/0011-founder-acceptance-and-customer-sign-in.md), [ADR-0013](../adr/0013-staff-access-and-manual-payments.md).

The site `https://babysunray.com` runs on Netlify behind visitor protection and is connected to the **staging** database. Everything below writes records to that staging database only, never to a real shop. **Use made-up names, phone numbers and transaction IDs, and never send real money.** The public shop stays closed: only a browser holding an acceptance pass started in the Admin can open it.

## What has been proven, and what has not

"Verified in tests" means automated tests passed on an isolated test database with fictional data. It is not the same as working on the live staging site; that is what this session checks.

| Area | State |
|---|---|
| Order journey: publish, shop, order, confirm, pack, dispatch, deliver, record cash, track | **Verified in tests** (`tests/e2e/acceptance.spec.ts`). Not yet done by you on staging. |
| Staff: invite, accept, sign in, each role's allowed and refused actions (pages, actions, API), role change, disable, sign out everywhere, set-password link, audit names the person | **Verified in tests** (`tests/db/staff.integration.test.ts`, `tests/e2e/staff-payments.spec.ts`). Not yet done by you. |
| Manual payments: off by default, setup checks, checkout choice, instructions with the exact amount, transaction ID, "awaiting verification", Owner verification, duplicate and over-payment refused, partial payment, reject, undo, late payment after expiry, paid cancellation and refund, reports reconcile | **Verified in tests** (`tests/db/manual-payments.integration.test.ts`, `tests/e2e/staff-payments.spec.ts`). Not yet done by you. |
| Google sign-in: start at Google, return only to this site, server-side state, no Admin access from a customer session | **Verified in tests** without Google (`tests/db/customer-google.integration.test.ts`). **A real Google sign-in has never been done**: step C2. |
| Customer email accounts and staff invitation emails | Email is configured on staging. Whether an email actually arrives is **not verified**: steps C1 and F1. |
| Photo upload from the live site, the per-client limits under real traffic | **Not verified.** Steps A2 and J. |
| Database updates 0022 to 0025 | **Not applied on staging yet.** They must be applied (Part 2) before this session: 0024 and 0025 are needed by staff access and payments. |
| The public launch gate | **Closed**, by design. Nothing in this session opens it. |

---

# Part 1. The session

**About two hours.** Do it in one sitting, in order. If a step fails, do not repeat it more than once: take a screenshot, note the step (for example "E3") and what the page said, and carry on with the next part if you can. Tell me afterwards.

**Three browser windows**, because each keeps its own sign-in:

| Window | Use it as | How |
|---|---|---|
| **Owner** | You, in the Admin | Your normal browser window |
| **Customer** | A shopper | A private (incognito) window of the same browser |
| **Staff** | Your test employees | A different browser (for example Edge if you use Chrome), or a separate browser profile |

Every link needs you to be signed in to Netlify first in that window; that is the visitor protection working.

**Made-up details to use**

| What | Use |
|---|---|
| Customers | `Test Customer One`, `01711000071`, `House 71, Road 7, Test Area, Dhaka`; `Test Customer Two`, `01711000072`, `House 72, Road 7, Test Area, Dhaka` |
| Email addresses (customers and staff) | Addresses you own. With Gmail add a tag: `yourname+cust1@gmail.com`, `yourname+orders@gmail.com`, `yourname+manager@gmail.com` all arrive in your inbox |
| Test bKash receiving details | Account name `TEST ONLY Shop`, number `01300000001` (not a real account: no money is ever sent) |
| Transaction IDs | `TESTTRX0001`, `TESTTRX0002`, … (made up) |

## A. Products and stock (Owner window)

| # | Do this | Where | You should see |
|---|---|---|---|
| A1 | Sign in. Check both delivery charges are set (real setting: change nothing that is already right). | [Admin](https://babysunray.com/admin/login), [Delivery charges](https://babysunray.com/admin/settings/delivery) | Both areas active with a charge. |
| A2 | Create **4 test products** named so you recognise them (`ACCEPTANCE TEST Romper`, `… Frock`, `… Set`, `… Cap`): English and Bangla names and descriptions, fabric (true wording only, tick the confirmation), care, a category, a size chart. Give them **several sizes and colours** with **different prices**. Upload **three photos** to one product and one photo to the others (your own photos, under 5 MB). | [New product](https://babysunray.com/admin/products/new) | The yellow "missing" list shrinks to nothing. The three photos show in order and can be reordered. If an upload fails, note the exact message. |
| A3 | **Receive stock** on each size: most 5 units, one size **only 1 unit**, one size **0**. | Each size's page under *Variants and stock* | On hand shows exactly what you received; the stock movement list names you. |
| A4 | **Review and publish** all four. | Each product, *Publishing* | "Published". |

## B. Payment methods (Owner window)

| # | Do this | Where | You should see |
|---|---|---|---|
| B1 | Open Payment methods. | [Payment methods](https://babysunray.com/admin/settings/payments) | Cash on delivery "Always offered"; bKash, Nagad and Bank transfer **Not set up**. |
| B2 | bKash → **Set up**: the test details above, *Merchant*, tick **Offer bKash to customers** but **not** the confirmation, **Save**. | | Refused: "confirm that this account may receive …". What you typed is still there. |
| B3 | Tick the confirmation, **Save**. | | "Offered to customers", with the details as customers will see them. |

## C. Customers (Customer window)

| # | Do this | Where | You should see |
|---|---|---|---|
| C0 | **Start acceptance** in this window: sign in to the Admin, open Shop acceptance, **Start acceptance in this browser**, then sign out of the Admin here. | [Shop acceptance](https://babysunray.com/admin/acceptance) | "Holds an acceptance pass". |
| C1 | Create a customer account with **email and password** (`yourname+cust1@gmail.com`), confirm it from the email. | [Account](https://babysunray.com/en/account) | A confirmation email arrives (check spam), then you are signed in. If nothing arrives, note it. |
| C2 | Sign out, then **Continue with Google** with your Google account. | [My order](https://babysunray.com/en/order) | Google asks you to choose an account, then you come back to *My order*, signed in with your Google name. This is the first real Google sign-in: if it fails, note the exact page and message. |
| C3 | Open `https://babysunray.com/admin` in this window while signed in as a customer. | | The Admin sign-in page: a customer account never opens the Admin. |

## D. Cash on delivery orders (Customer, then Owner)

| # | Do this | Where | You should see |
|---|---|---|---|
| D1 | Signed in with Google: put two items in the Bag (two products, one with 2 units), choose the delivery area, **Checkout**, *Test Customer One*, keep **Cash on Delivery**, **Place order**. Save the tracking link in a private note. | [Shop](https://babysunray.com/en) | "Order received", a number, the tracking link **shown once**. *My order* lists the order. |
| D2 | Owner window: open the order. | [Orders](https://babysunray.com/admin/orders) | *Pending verification*, payment **Nothing received**, paid by **cash on delivery**. On each item's size page, *reserved* went up. |
| D3 | **Confirm**, **Mark packed**, **Dispatch**, **Record delivery**. | The order page | Each step in *History* with your name. Dispatch lowers on hand and reserved once. |
| D4 | **Record a payment**: *Courier collected* the total, then *Settled to me* the total. | *Cash on delivery* card | Payment **Settled**. |
| D5 | Customer window: open the tracking link. | Your saved link | The same order, Delivered, no full name, phone or address shown. |
| D6 | As a guest (sign out first): order the size with **1 unit** but ask for 2. Then press **Place order** twice quickly on a normal order. | Shop | "Not enough stock" and nothing created; then one order only. |
| D7 | From that order's tracking link: **Cancel order**. | Tracking page | "Cancelled"; in the Owner window its stock is released (reserved down, on hand unchanged). |

## E. Advance payment orders (Customer, then Owner)

| # | Do this | Where | You should see |
|---|---|---|---|
| E1 | Guest, *Test Customer Two*: order one item, and at the last step choose **Pay in advance by bKash**, **Place order**. | Checkout | The payment card: bKash, `01300000001`, the **exact total**, "This is not an online payment". The tracking link. **Send no money.** |
| E2 | Open the tracking link. Type `TESTTRX0001`, **Send transaction ID**. | Tracking page | "Transaction ID received: awaiting the shop's verification". Nothing says paid. |
| E3 | Owner window: Orders → **Payments to verify**, open the order. | [Orders](https://babysunray.com/admin/orders?queue=payment_to_verify) | *Manual payment* shows `TESTTRX0001`, *Verified as received* ৳ 0, payment **Nothing received**. |
| E4 | **Verify: money received** with the full amount (pretend you saw it in the account). | *Manual payment* | *Verified as received* = the total, *Still due* ৳ 0, payment **Settled**; the order is still *Pending verification* (verifying money does not confirm the order). Tracking page: "Payment verified by the shop". |
| E5 | **Confirm**, **Mark packed**, **Dispatch**, **Record delivery**. | | The *Cash on delivery* card expects ৳ 0: nothing for the courier to collect. |
| E6 | A second advance order. Send `TESTTRX0002`. Verify only **half** the total. Confirm and pack it, then try **Dispatch**. | | *Partly paid*, *Still due* the other half; the tracking page says part is verified. There is **no Dispatch button**: the page says dispatch waits until the full amount is verified. |
| E7 | A third advance order. Send `TESTTRX0003`; in the Owner window **Reject reference** ("No such transfer"). | | Tracking page: "There is a problem with your payment. Please contact the shop." and it can send another ID. |
| E8 | On another order, send `TESTTRX0001` again (already verified on E1's order) and try to verify it. | | Refused: "already verified … one transfer counts once". |

## F. Staff (Owner window, then Staff window)

| # | Do this | Where | You should see |
|---|---|---|---|
| F1 | Invite `yourname+orders@gmail.com` as **Orders Staff** and `yourname+manager@gmail.com` as **Store Manager**. | [Staff & access](https://babysunray.com/admin/staff) | "Invitation emailed". Read *What each role can do*. (If email were off, the page would show the link once instead.) |
| F2 | Staff window: open the Orders Staff email's link, enter a name and a password, **Create my account**, sign in. | Email link | Signed in; under the shop name it says **Orders Staff**. The menu has no Dashboard, Reports, Exports, Payment methods, Store settings or Staff & access. |
| F3 | As Orders Staff: confirm and pack one of your test orders. | Orders | Works; *History* shows the staff member's name. The order page shows no *Verify*, *Record a payment* or refund buttons, and says only the Owner can verify payments. |
| F4 | As Orders Staff, type these addresses: `/admin/staff`, `/admin/settings/payments`, `/admin/exports`, `/admin/reports`. | Address bar | Each: "This page could not be shown". |
| F5 | As Orders Staff: try to cancel the advance order verified in E4 (if not dispatched) or E6. | Order page | No cancel button for a paid order ("only the Owner can cancel it"). |
| F6 | Sign out, accept the Manager invitation, sign in as **Store Manager**. Open Reports, edit a product's description, start a stock count and apply it. | | Allowed. No Staff & access, Payment methods, Exports or Publish button. |
| F7 | Owner window: change Orders Staff to **Catalogue Staff**. Staff window (signed in as that person): reload Orders. | Staff & access | Orders are no longer available; Products are. |
| F8 | Owner: **Disable access** for one staff account. Staff window: reload. | | Signed out at once; signing in again fails. *Access history* lists every change with your name. |
| F9 | Owner: **Re-enable access**, then **Email a set-password link**. Use it in the Staff window. | | The old password stops working; the new one works. |

## G. Cancellations and refunds (Owner window)

| # | Do this | Where | You should see |
|---|---|---|---|
| G1 | A new **advance** order, not paid: **Cancel order**. | Order page | Cancelled, stock released, no refund due. |
| G2 | A new **advance** order: send `TESTTRX0004`, verify the full amount, then **Cancel order**. | | Cancelled, stock released, a red **Refund due** box. Orders → **Refunds due** lists it; the Dashboard's *Needs attention* too. The tracking page says the shop will contact them. |
| G3 | **Record the advance refund**: try one taka more than due, then the exact amount (bKash, today, reference `TESTREFUND1`). Pay nothing for real. | *Manual payment* | One taka more is refused; then *Refunded* shows the amount and the order leaves *Refunds due*. |
| G4 | Optional: on a delivered test order, record a return, receive it, pass inspection, approve and record a fake refund. | *Returns and exchanges* | Returned goods wait in *Inspection* until passed; then back in stock. |

## H. Numbers, history and privacy (Owner window)

| # | Do this | Where | You should see |
|---|---|---|---|
| H1 | Look at each test size's page. | Size pages | On hand fell once per dispatched unit; reserved is 0 for finished or cancelled orders. |
| H2 | Dashboard and Reports for today. | [Dashboard](https://babysunray.com/admin/dashboard), [Reports](https://babysunray.com/admin/reports) | COD and advance money in separate figures; *Advance payments verified* matches what you verified; the reconciliation check **passed**. |
| H3 | Each order's *History*. | Order pages | Every step with who did it (you, a staff name, the customer or the system). |
| H4 | Export orders and payments. | [Exports](https://babysunray.com/admin/exports) | The files have the payment method and advance columns. Delete the files afterwards. |
| H5 | Check what customers can see. | Tracking pages | Masked name and phone, no address, no other customer's orders. |

## I. Close down

| # | Do this | Where |
|---|---|---|
| I1 | **Withdraw** the four test products. | Each product page |
| I2 | Payment methods: untick **Offer bKash to customers** (the test number must never be shown to a real customer), or replace it with your real, approved details. | [Payment methods](https://babysunray.com/admin/settings/payments) |
| I3 | Disable the test staff accounts. | [Staff & access](https://babysunray.com/admin/staff) |
| I4 | **End acceptance in this browser** in the Customer window, and read Launch readiness. | [Shop acceptance](https://babysunray.com/admin/acceptance), [Launch readiness](https://babysunray.com/admin/launch-readiness) |

Test orders, customers, staff accounts and money records stay in the staging database; they never reach a real shop.

## J. Not checked by this session

Per-client limits under real traffic, Cloudinary copies of published photos, and the decisions in the [decision register](../product/storefront-launch-decisions.md) (role permissions, refunds for prepaid orders, whether advance orders must be paid before dispatch).

---

# Part 2. Setup (for the person who runs the commands)

Run these yourself in an interactive terminal from this repository. They read `.env.staging.local`; never paste its values anywhere. Keep Netlify visitor protection on. The production database does not exist yet and is created last ([production-migration.md](production-migration.md)).

## Database updates (migrations) and the release order

The repository has migrations 0000 to 0025. The newest staging migration report on this computer (19 Nov) shows 22 applied (0000 to 0021), so up to four are pending:

| Migration | What it does | If it is missing |
|---|---|---|
| 0022 `order_phone_search` | One index on the order's phone number. No data changes. | Order search by phone works, slower on a large table. |
| 0023 `store_social_links` | Two optional text columns for the Facebook and Instagram links and a length check. No data changes. | The Social links card says the update is needed. |
| 0024 `staff_access` | The staff invitation table; the role, audit-event and rate-limit checks accept the new values. No data changes. | **Needed by the new code:** Staff & access and invitations fail. |
| 0025 `manual_payments` | The payment methods and advance payment tables; three order columns with defaults (every existing order stays cash on delivery); money checks re-created to count verified advance money (same result for every existing order). | **Needed by the new code:** orders, checkout and reports fail. |

All four are additive (`npm run migrations:review -- --after 21`: nothing destructive; each dropped check is re-created in the same migration, only wider). The old code keeps working on the new schema, so migrate **before** deploying. The order, each step only after the previous one succeeded (the migration command refuses without a fresh backup of the same database):

1. `npm run staging:preflight`: lists missing settings, connects to nothing.
2. `npm run backup:create:staging -- --out D:\BabySunray-staging`: an encrypted copy of the database (passphrase asked twice). Optional but sensible: `npm run media:backup:staging -- --out D:\BabySunray-staging` for the photos.
3. `npm run db:migrate:staging -- --backup <that file> --report D:\BabySunray-staging\migrate-<date>.json`: shows the host and asks you to type it back; applies the pending migrations in one transaction; audits the privileges (the new tables get the application role's grants and row-level-security policy automatically). The report's `after` must read 26 applied, with `privilegeFindings` empty (the `privilegeWarnings` about Supabase's own role are known and expected).
4. Push the reviewed commits to `main` (`git push origin main`). Netlify builds and deploys `main` only; visitor protection stays on (check that the site still asks for the Netlify sign-in in a private window).
5. After the deploy: sign in, open [Staff & access](https://babysunray.com/admin/staff) and [Payment methods](https://babysunray.com/admin/settings/payments) (both load; every method "Not set up"), [Store settings](https://babysunray.com/admin/settings/store) (Social links editable) and [Launch readiness](https://babysunray.com/admin/launch-readiness) (public gate closed).

If step 3 fails, nothing was changed (one transaction) and the old site keeps working; send me the report. Never deploy the new code to a database without 0024 and 0025.

The row "Database update 0020" on the Shop acceptance page only proves the acceptance tables exist; it does not report the newer updates.

## One-time setup

| Step | What | How |
|---|---|---|
| 1 | Get the new code | `git pull` |
| 2 | Back up staging, apply pending database updates, then deploy | Section above, steps 1 to 5. |
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

Google's real sign-in, an email actually arriving (customer confirmation and staff invitations), staff access and manual payments on the live site, photo upload from the live site (about 6 MB per request on Netlify; keep photos below 5 MB), Cloudinary copies of published photos, Netlify's client address header and the per-client limits under real traffic. Report anything that does not behave as described.
