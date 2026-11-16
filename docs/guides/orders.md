# Orders

**Status:** Draft — Founder Review
**Purpose:** How internal orders, reservations, COD, returns, RTO and guest tracking are implemented, and the inactive guest checkout.

The business rules are in [order-policy-decisions.md](../product/order-policy-decisions.md) (states, transitions and defaults). Server-only services in `src/modules/orders` (`service.ts` submission and lifecycle, `aftercare.ts` COD, returns and inspection, `delivery.ts`, `tracking.ts`, `queries.ts`), with idempotent, permission-checked operations in `operations.ts`; stock holds live in `src/modules/inventory/reservations.ts`. Migration `0008` onwards. **No public checkout:** orders are entered in the admin panel (Messenger, WhatsApp, other) or through the API.

| Capability | How |
|---|---|
| Submit | Validates contact (Bangladesh mobile normalised to `01XXXXXXXXX`), merges lines per SKU, snapshots names, variant and unit price, adds the active zone's delivery charge, computes the total, and reserves every line in the same transaction, or creates nothing. No backorders. Idempotent per key. |
| Stock | `inventory_balances.reserved` with `0 <= reserved <= on_hand`; available = on-hand − reserved. Holds are `stock_reservations` rows ending exactly once (released or consumed). Adjustments cannot take on-hand below reserved. Dispatch lowers on-hand and reserved together and writes one `dispatch` ledger row per line; a passed inspection writes one `return_restock` row. Locks: order row first, then balances in variant order. |
| Lifecycle | Four separate columns: order, fulfilment, payment (derived from the amounts; a database check enforces it), return. Every change names the order version the client saw (`VERSION_CONFLICT` for a stale screen) and appends to `order_events` (append-only, actor recorded). |
| Verification expiry | Deadline 24 hours after submission. Submissions and stock adjustments release overdue holds first, and a late confirmation reserves again only if stock is available, so correctness never depends on a scheduler. `npm run orders:expire-verification` (local `babysunray_dev` only) is the repeatable clean-up batch. **No scheduler runs it**: with production hosting, the host's scheduler should run the same operation every few minutes. |
| COD, returns, RTO | Manual collection and settlement (`payment_entries`, append-only), partial amounts, never above expected or collected; returns and exchanges within the return window, quarantine and inspection before any restock, refunds only for approved returns and never above money collected; RTO into quarantine with its charge recorded apart. |
| Guest tracking | A 256-bit random token per order, only its SHA-256 digest stored, revocable and regenerable, valid until 30 days after closing; minimal masked view; customer cancellation by stage. The link is `/track#t=<token>`: the fragment never reaches a server; the page (`src/app/track`) posts it in a same-origin JSON body to `/api/track` and `/api/track/cancel`, which refuse other origins and answer every unusable token with one generic message. After reading the token the page removes it from the address bar and the tab's history and keeps it in memory only, so a reload needs the link again. Limits (`tracking_rate_limits`): 30 requests a minute per live link, and 30 a minute for unknown, revoked or expired tokens from all clients together, which never blocks a live link; malformed tokens cost no lookup. Page and endpoints send `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex` and a same-origin-only content security policy, and load no third-party code. Links exist only when the admin creates one. |

## Guest checkout (built, not reachable)

`placeGuestOrder` (`src/modules/orders/guest-checkout.ts`) places a website order for an anonymous customer through the same `submitOrder`, with a customer audit actor (never a user), its own idempotency record (`guest_checkout_submissions`, migration `0013`: key digest and an HMAC of the request, no customer data), a refusal if any shown price or the delivery charge changed (`QUOTE_CHANGED`), only SKUs of products with a current internal review, and the tracking link created in the same transaction and returned once. Its HTTP transport (`src/api/guest-checkout.ts`) has **no route**: no page, route or Server Action imports either (a unit test checks), and the launch gate refuses. Design: [ADR-0007](../adr/0007-guest-checkout-foundation.md); contract: [launch-readiness.md](../operations/launch-readiness.md), section 5.

## Known limits

- Exchange execution is a separate order (who pays the replacement's delivery is not decided).
- The refund deadline is shown, not computed (no working-day calendar).
- A delivered order can be closed only after its return window (engineering default).
- Without a trusted proxy (hosting decision) there is no per-client tracking limit, so a flood can still overload the server.
