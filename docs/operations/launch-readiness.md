# Launch readiness, policy drafts and product reviews

**Status:** Draft — Founder Review
**Purpose:** How the launch-preparation tools work (Gate H.25–H.28, extended by ADR-0011), what they do not do, and what still blocks a public shop.

Nothing described here is public. The real shop and its checkout exist (`/en`, `/bn`, `POST /api/shop/checkout`) but answer only a browser holding a founder acceptance pass on the staging database ([ADR-0011](../adr/0011-founder-acceptance-and-customer-sign-in.md), [acceptance.md](acceptance.md)). Public checkout stays disabled until the founder approves and publishes the delivery, return/exchange and privacy policies ([requirements](../product/requirements.md) S-17, G-7) and opens the launch gate.

## 1. The activation barrier

`src/modules/launch/gate.ts` is the one place that answers "may the PUBLIC shop open?". In this version the answer is always **no**: `open` is the literal `false`, the module reads no environment variable, setting or database, and no Admin action changes it (unit tests check all three). Founder acceptance (`src/modules/launch/acceptance.ts`) is separate and never opens it. The gate lists the reasons. Some depend on data (an empty or unpublished policy, unconfigured delivery charges, no reviewed product) and disappear when the data is there; the rest are unconditional because they need decisions this system cannot record:

| Blocker | Rests on |
|---|---|
| The delivery, return and exchange, or privacy policy is not **published** (data) | S-17, G-7 |
| No publication rule approved for the public (the proposed rule applies only to acceptance) | I-6, decision 4 |
| Abuse protection not verified on the live site (per-client limits need `TRUSTED_PROXY=netlify`) | S-15, API-11 |
| The production database does not exist yet | G-8, ADR-0010 |
| No RPO and RTO, so no backup schedule or off-device copy | K-9, G-6, decision 6 |
| The founder has not approved the public launch | S-17 |

Opening the shop is a founder-approved code change, not a setting.

## 2. Launch readiness page

`/admin/launch-readiness` (permission `launch:read`) shows the blockers above and four sections: catalogue, commerce, policies, operations. Each row has a status, the evidence, what happens next and the requirement it rests on. No score or percentage.

| Status | Meaning |
|---|---|
| Ready | The system checked it against live data, or it is built and tested for internal use. |
| Incomplete | Data or work is missing (for example drafts without Bangla names). |
| Requires founder approval | Waits for a decision only the founder can make. A reviewed policy draft stays here: a draft is never "ready" for customers. |
| Not verified | Built, but not proven where it matters (for example no server scheduler, no test with real people). |
| Not applicable | Reserved; no row uses it today. |

Live checks: catalogue counts over draft products (the readiness checklist, available stock, current reviews), delivery charges for both zones, and an integrity check that every stock balance matches its ledger and its active holds, no cancelled, expired or dispatched order holds stock, and every confirmed, undispatched order holds its stock. If the integrity row is not Ready, stop taking orders and investigate after taking a backup.

## 3. Policy drafts

`/admin/policies` (read `policies:read`, write `policies:write`, publish `policies:publish`) holds one draft per kind: delivery, return and exchange, privacy, checkout notices.

- Write the real wording yourself, in English and Bangla. Nothing is generated, translated or filled in.
- Beside each editor, "Questions to answer" lists what is already decided (with the rule or requirement) and what is still open. It is guidance, never inserted into the draft (`src/modules/policies/checklist.ts`).
- The editor says "Unsaved changes" until you save and asks before you leave the page with them. Each save names the version you opened; a stale tab gets a "changed after you opened it" message and keeps what you typed.
- States: **empty**, **drafted**, **reviewed** (you marked this exact version; both languages needed; any later edit clears it).
- **Publish** (a reviewed version only, with the box "I am the founder and I approve this exact wording"): the exact text, its digests, who and when are copied into the append-only `policy_publications`. Customers see the newest publication of a kind in the shop footer, the product page and checkout (`/en/policies/<kind>`); editing the draft changes nothing they see until you publish again. **Withdraw** hides it. An unpublished kind is not shown at all, never as placeholder text.
- Every save and review mark is recorded in `policy_draft_events` (append-only): who, when, version and the SHA-256 of each language's text.
- Drafts are shown as plain text only; pasted markup is displayed, never run.
- For an external reviewer: "Copy both languages", or export the "Customer policy drafts" dataset (Exports page, Owner only and audited). Database backups include the drafts.

"Reviewed" is your own mark, not legal advice or compliance; publishing is your approval of the wording for customers.

## 4. Product release preparation

The product page has **Publish to the shop** and **Withdraw from the shop** (`catalog:publish`). Publishing needs a publication rule: none is approved for the public (I-6), so on the development or a production database it refuses; on the staging-marked database the PROPOSED rule applies for founder acceptance, and each publication records it. The readiness page flags a product found published on any other database as a change to investigate.

1. **Prepare** each product until the readiness checklist is met (`/admin/catalogue-preparation`, the product page).
2. **Check** how it would look in the customer preview (`/admin/storefront-preview`).
3. **Review** it: `/admin/product-reviews` lists every draft with what is missing (each item links to where it is fixed) and its review state. On the product page, "Mark the current content as reviewed" records a review (permission `catalog:review`) in `product_reviews` (append-only): who, when, what was still open, and the SHA-256 of the reviewable content.
4. A review is **current** only while the content still has that digest. Any change to names, descriptions, fabric (or its confirmation), care, size guidance, category, a SKU's size, colour, price or status, a new SKU, the size chart or a photo (file, description or order) makes it **outdated**. Stock, the featured flag and category names do not.
5. A review needs the founder-stated items (both names, both descriptions, an active priced SKU). It is refused if the content changed after the page was loaded.

A review grants no visibility. Publishing requires a current review of exactly what is published. The guest checkout accepts only active SKUs of **published** products, the same rule as the shop's catalogue. Unknown, draft, withdrawn, archived and inactive SKUs get the same answer.

## 5. Guest checkout

Routed at `POST /api/shop/checkout` behind the shop access check (founder acceptance only until the launch); design in [ADR-0007](../adr/0007-guest-checkout-foundation.md) and [ADR-0011](../adr/0011-founder-acceptance-and-customer-sign-in.md). Service contract (`placeGuestOrder(db, key, request)` in `src/modules/orders/guest-checkout.ts`):

| Input | Rule |
|---|---|
| key | 32 to 128 characters of `A-Z a-z 0-9 _ -`, generated by the client per checkout (a UUID fits) |
| `customer` | `name` (1–100), `phone` (Bangladesh mobile, English or Bangla digits), `address` (1–500, line breaks allowed) |
| `deliveryZone` | `dhaka_city` or `outside_dhaka`, with an active charge |
| `items` | 1 to 20 lines of `sku`, `quantity` (1–1,000), `unitPricePaisa` as shown; each SKU once |
| `deliveryChargePaisa`, `totalPaisa` | as shown to the customer |

Any other field is refused. Result: `{ replayed, order: { reference, orderStatus, placedAt, deliveryZone, items, subtotalPaisa, deliveryChargePaisa, totalPaisa }, trackingToken }` with no contact data; `trackingToken` only in the first answer. Errors: `INVALID_INPUT` (with field names and codes), `INSUFFICIENT_STOCK`, `VARIANT_NOT_FOUND`, `VARIANT_NOT_ORDERABLE`, `DELIVERY_ZONE_UNAVAILABLE`, `QUOTE_CHANGED`, `IDEMPOTENCY_KEY_REUSED`; none creates anything.

Over HTTP at most 20 well-formed submissions a minute are accepted from all customers together (the 21st gets `429 rate_limited`), and, behind Netlify with `TRUSTED_PROXY=netlify`, at most 10 an hour from one client address. A signed-in customer's order is linked to their account in the same transaction. The full customer-facing contract, with the published-only catalogue and quote: [public-api.md](../api/public-api.md).

If a customer's first answer is lost, a retry with the same key shows the order as received but cannot show the tracking link again (only its digest is stored). The Owner, who verifies every order by phone, Messenger or WhatsApp anyway, creates a new link on the order page; that revokes any earlier one.

## 6. Founder decisions this depends on

Policies' final text and their publication (decision 7); approving the publication rule (I-6); the production database and the switch to it (ADR-0010, [production-migration.md](production-migration.md) section 7); the expiry scheduler after the launch; RPO and RTO (decision 6) and the off-device backup place (decision 15); account recovery (OF-5); delivery charge amounts and Dhaka City's area (decision 8); a usability test with people (G-9); and the public launch itself. Decided: hosting (Netlify, Supabase, Cloudinary; ADR-0010), the visual design (First Light), optional Google sign-in for customers (S-14, ADR-0011).
