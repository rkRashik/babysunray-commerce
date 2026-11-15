# Launch readiness, policy drafts and product reviews

**Status:** Draft — Founder Review
**Purpose:** How the private launch-preparation tools work (Gate H.25–H.28), what they do not do, and what still blocks a public shop.

Nothing described here is public. The shop has no public catalogue, no public checkout endpoint and no publish action. Public checkout stays disabled until the founder approves and publishes the delivery, return/exchange and privacy policies ([requirements](../product/requirements.md) S-17, G-7).

## 1. The activation barrier

`src/modules/launch/gate.ts` is the one place that answers "may the public shop open?". In this version the answer is always **no**: `open` is the literal `false`, the module reads no environment variable, setting or database, and no Office action changes it (unit tests check all three). It lists the reasons. Some depend on data (an empty policy, unconfigured delivery charges, no reviewed product) and disappear when the data is there; the rest are unconditional because they need decisions this system cannot record:

| Blocker | Rests on |
|---|---|
| No policy is founder-approved and **published**; there is no publication step | S-17, G-7 |
| No publication rule for products; no public catalogue | I-6, decision 4 |
| No abuse protection for anonymous orders (an order holds stock for 24 hours; a per-client limit needs a trusted proxy) | S-15, API-11, decision 1 |
| No production host | G-8, decision 1 |
| No RPO and RTO, so no backup schedule or off-device copy | K-9, G-6, decision 6 |
| No public checkout endpoint | S-17 |

Opening the shop is a founder-approved code change in a later gate, not a setting.

## 2. Launch readiness page

`/office/launch-readiness` (permission `launch:read`) shows the blockers above and four sections: catalogue, commerce, policies, operations. Each row has a status, the evidence, what happens next and the requirement it rests on. No score or percentage.

| Status | Meaning |
|---|---|
| Ready | The system checked it against live data, or it is built and tested for internal use. |
| Incomplete | Data or work is missing (for example drafts without Bangla names). |
| Requires founder approval | Waits for a decision only the founder can make. A reviewed policy draft stays here: a draft is never "ready" for customers. |
| Not verified | Built, but not proven where it matters (for example no server scheduler, no test with real people). |
| Not applicable | Reserved; no row uses it today. |

Live checks: catalogue counts over draft products (the readiness checklist, available stock, current reviews), delivery charges for both zones, and an integrity check that every stock balance matches its ledger and its active holds, no cancelled, expired or dispatched order holds stock, and every confirmed, undispatched order holds its stock. If the integrity row is not Ready, stop taking orders and investigate after taking a backup.

## 3. Policy drafts

`/office/policies` (read `policies:read`, write `policies:write`) holds one private draft per kind: delivery, return and exchange, privacy, checkout notices.

- Write the real wording yourself, in English and Bangla. Nothing is generated, translated or filled in.
- Beside each editor, "Questions to answer" lists what is already decided (with the rule or requirement) and what is still open. It is guidance, never inserted into the draft (`src/modules/policies/checklist.ts`).
- The editor says "Unsaved changes" until you save and asks before you leave the page with them. Each save names the version you opened; a stale tab gets a "changed after you opened it" message and keeps what you typed.
- States: **empty**, **drafted**, **reviewed** (you marked this exact version; both languages needed; any later edit clears it). There is no published state.
- Every save and review mark is recorded in `policy_draft_events` (append-only): who, when, version and the SHA-256 of each language's text.
- Drafts are shown as plain text only; pasted markup is displayed, never run.
- For an external reviewer: "Copy both languages", or export the "Customer policy drafts" dataset (Exports page, Owner only and audited). Database backups include the drafts.

"Reviewed" is your own mark. It is not legal advice, legal compliance or founder approval for publication.

## 4. Product release preparation

There is no publish action and no published state. Every product stays a draft.

1. **Prepare** each product until the readiness checklist is met (`/office/catalogue-preparation`, the product page).
2. **Check** how it would look in the customer preview (`/office/storefront-preview`).
3. **Review** it: `/office/product-reviews` lists every draft with what is missing (each item links to where it is fixed) and its review state. On the product page, "Mark the current content as reviewed" records a review (permission `catalog:review`) in `product_reviews` (append-only): who, when, what was still open, and the SHA-256 of the reviewable content.
4. A review is **current** only while the content still has that digest. Any change to names, descriptions, fabric (or its confirmation), care, size guidance, category, a SKU's size, colour, price or status, a new SKU, the size chart or a photo (file, description or order) makes it **outdated**. Stock, the featured flag and category names do not.
5. A review needs the founder-stated items (both names, both descriptions, an active priced SKU). It is refused if the content changed after the page was loaded.

A review grants no visibility. It is used in one place: the inactive guest checkout service accepts only SKUs of products with a current review (an engineering default, Draft — Founder Review, until a publication rule is approved).

## 5. Guest checkout service (inactive)

Built and tested, not reachable; design in [ADR-0007](../adr/0007-guest-checkout-foundation.md). Service contract (`placeGuestOrder(db, key, request)` in `src/modules/orders/guest-checkout.ts`):

| Input | Rule |
|---|---|
| key | 32 to 128 characters of `A-Z a-z 0-9 _ -`, generated by the client per checkout (a UUID fits) |
| `customer` | `name` (1–100), `phone` (Bangladesh mobile, English or Bangla digits), `address` (1–500, line breaks allowed) |
| `deliveryZone` | `dhaka_city` or `outside_dhaka`, with an active charge |
| `items` | 1 to 20 lines of `sku`, `quantity` (1–1,000), `unitPricePaisa` as shown; each SKU once |
| `deliveryChargePaisa`, `totalPaisa` | as shown to the customer |

Any other field is refused. Result: `{ replayed, order: { reference, orderStatus, placedAt, deliveryZone, items, subtotalPaisa, deliveryChargePaisa, totalPaisa }, trackingToken }` with no contact data; `trackingToken` only in the first answer. Errors: `INVALID_INPUT` (with field names and codes), `INSUFFICIENT_STOCK`, `VARIANT_NOT_FOUND`, `VARIANT_NOT_ORDERABLE`, `DELIVERY_ZONE_UNAVAILABLE`, `QUOTE_CHANGED`, `IDEMPOTENCY_KEY_REUSED`; none creates anything.

If a customer's first answer is lost, a retry with the same key shows the order as received but cannot show the tracking link again (only its digest is stored). The Owner, who verifies every order by phone, Messenger or WhatsApp anyway, creates a new link on the order page; that revokes any earlier one.

## 6. Founder decisions this depends on

Policies' final text and publication (decision 7); a publication rule (I-6); hosting (decision 1) and with it abuse protection, durable storage and the expiry scheduler; RPO and RTO (decision 6) and the off-device backup place (decision 15); account recovery (OF-5); delivery charge amounts and Dhaka City's area (decision 8); the final visual design (decision 4); customer accounts and sign-in (S-14); a usability test with people (G-9).
