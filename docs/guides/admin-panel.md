# Admin panel

**Status:** Draft — Founder Review
**Purpose:** The screens of the private admin panel, their permissions, and how every page and form is protected.

A functional internal area at `/office` (`src/app/office`), built with the Next.js App Router and Tailwind CSS. In the code it is called the Owner Office and its single role is `owner`. It wears the First Light design ([design system](../design/storefront-design-system.md)): a cocoa sidebar grouped by the work it serves (on a phone, the same links in a row that scrolls sideways), status words in toned pills, the main action of a page or form in amber.

| Screen | Does | Permission |
|---|---|---|
| `/office/login` | Email and password sign-in | none |
| `/office` | Products (draft, archived), oldest first, 25 per page; search by English or Bangla name, slug or SKU; filters for status, category, stock and what is still missing; readiness indicators; all kept in the URL | `catalog:read` |
| `/office/products/new` | Create a draft product (English and Bangla fields) | `catalog:write` |
| `/office/products/{id}` | Content with missing languages, the readiness checklist, internal review, size chart, photos, variants with price (BDT) and on-hand stock; add or deactivate a variant, archive the product (both ask for confirmation first) | `catalog:read`, `stock:read`; changes `catalog:write`, review `catalog:review` |
| `/office/products/{id}/edit`, `.../measurements`, `.../photos` | Edit names, descriptions, fabric (with confirmation), care, size guidance, category and featured flag; the size chart in cm; upload, describe, reorder, replace and remove photos | `catalog:read`, `catalog:write` |
| `/office/variants/{id}/edit` | Edit an active variant's size, colour and price in Taka; shows its stock, which the edit never changes | `catalog:read`, `catalog:write`, `stock:read` |
| `/office/categories` | Create categories (slug, English and Bangla names) and rename them | `catalog:read`, `catalog:write` |
| `/office/import` | Bulk import of new draft products: templates, check (preview, nothing saved), problem list, import, recent imports | `catalog:read`, `catalog:write` |
| `/office/catalogue-preparation` | How many drafts still need each checklist item; each count links to the matching list | `catalog:read` |
| `/office/product-reviews` | Review queue: every draft with what it still lacks, its review state (not reviewed, current, outdated) and its customer preview; search | `catalog:read` |
| `/office/skus/{sku}` | Current stock, receive stock, adjust with a reason; movement history with who made each change (times in Asia/Dhaka) | `stock:read`; changes `stock:receive` / `stock:adjust` |
| `/office/stock-counts`, `/office/stock-counts/{id}` | Physical stock counts: start, resume, review, apply or discard; history | `stock:read`, `stock:adjust` |
| `/office/orders`, `/office/orders/new`, `/office/orders/{id}` | Orders newest first with filters; an assisted order (up to 5 SKU lines, stock reserved at once); one order's statuses, lifecycle actions, cancellation requests, COD entries, RTO charge, returns, inspection, tracking link (shown once) and history | `orders:read`; changes `orders:write`, `payments:record`, `stock:receive` |
| `/office/settings/delivery` | Charge and active flag for each delivery zone | `orders:read`, `settings:write` |
| `/office/dashboard` | Work queues from the database now (pending, past the verification window, to pack, to dispatch, in transit, cancellation requests, returns, COD to collect and held by the courier), stock alerts, unconfigured zones | `reports:read`, `orders:read`, `stock:read` |
| `/office/reports` | Period report (orders by source and status, COD collected, settled and refunded, RTO and return costs, stock movements) and COD reconciliation | `reports:read` |
| `/office/exports` | XLSX, CSV and JSON exports, complete or filtered, and the export audit list ([exports.md](../operations/exports.md)) | `exports:create` |
| `/office/print/...` | A4 print views: picking list, COD summary, stock count sheet (no contact details), one order's packing and shipping document | `orders:read`, `reports:read` or `stock:read` |
| `/office/media-health` | Photo folder against the photo records ([product-photos.md](product-photos.md)) | `catalog:read` |
| `/office/storefront-preview` | The private storefront preview and its two design concepts ([storefront-preview.md](storefront-preview.md)) | `storefront:preview` |
| `/office/policies` | Private policy drafts in English and Bangla; never shown to customers ([launch-readiness.md](../operations/launch-readiness.md), section 3) | `policies:read`; changes `policies:write` |
| `/office/launch-readiness` | What blocks a public shop, with live checks ([launch-readiness.md](../operations/launch-readiness.md), section 2) | `launch:read` |

## How it is protected

- Sign-in and sign-out call Better Auth's own `/api/auth` endpoints from the browser, so its origin check and sign-in rate limit apply. The session is the HttpOnly cookie; page scripts never see a token, and a Bearer token does not open the admin panel.
- Every page and every Server Action checks the session and permission on the server itself (`src/app/office/_lib/session.ts`); a layout check alone is never relied on. Server Actions call the same idempotent operations as the API directly, never `/api/v1`. The actor is always the signed-in user; form fields cannot name one. Next.js checks the origin of Server Action requests.
- Each form carries a server-generated idempotency key, so a double-click or resubmission records one change; the submit button is disabled while saving. Edit forms carry the version they were loaded from, so a stale second tab gets a "reload" message and keeps what was typed. Prices are typed in Taka (up to two decimals) and stored exactly as integer paisa (`src/modules/money.ts`).
- Errors shown are the services' safe messages or a generic one; raw errors and SQL never reach the page.
- Every `/office` response sends `Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Robots-Tag: noindex, nofollow`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin` (`next.config.ts`); pages are dynamic, so they are not cached.

Not built: changing a slug or SKU, reactivating a variant, un-archiving a product, publication, a photo API, expenses and supplier records, courier statement reconciliation, and export endpoints in `/api/v1`. Tested with fictional accounts: integration tests of the Server Actions and real-browser tests of sign-in, access control, the catalogue, stock, order and preview flows, stale edits, double submission, lost responses, keyboard use and phone-sized screens ([testing.md](../testing.md)).
