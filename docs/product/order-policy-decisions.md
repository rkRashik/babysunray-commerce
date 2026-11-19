# Order policy decisions

**Status:** Section 1: Approved (2026-11-15), founder instruction for Gate H.10–H.12, reproduced here as given. Sections 2 to 4 (how the rules were turned into states, transitions and defaults): Draft — Founder Review.
**Purpose:** The founder-approved business rules for orders, reservations, verification, cancellation, delivery charges, COD, returns, exchanges, RTO and guest tracking, and the engineering defaults chosen to implement them.

These rules close open decision 5 (O-9 to O-14) and decide parts of open decisions 8, 9, 10 and 11 in [requirements.md](requirements.md). They authorise building the **internal** Orders system. They do **not** authorise public checkout (S-17 and G-7 still require approved, published delivery, return/exchange and privacy policy text), real delivery fee amounts, courier contracts or product claims.

## 1. Founder-approved business rules

| # | Rule | Requirement |
|---|---|---|
| A | **Reservation.** On successful submission all ordered quantities are reserved at once. Pending Verification orders hold stock. Reservation and order creation commit atomically. Never reserve more than is available. No backorders. | O-9 |
| B | **Manual verification.** Submission creates **Pending Verification**, not Confirmed. The Owner verifies personally (phone, Messenger or WhatsApp). Only an authorised Owner action confirms. No automatic confirmation and no paid messaging dependency. | O-10 |
| C | **Cancellation.** Pending Verification: the customer may cancel directly through the order's private access. Confirmed, before dispatch: the customer may submit a cancellation **request**, which the Owner accepts or rejects. Dispatched: no direct cancellation; returns or RTO apply. An effective cancellation releases any outstanding reservation exactly once. A request alone does not release a confirmed order's stock. | O-11 |
| D | **Verification expiry.** The window is 24 elapsed hours from submission. If still unverified then, the reservation is released automatically and the order becomes **Verification Expired — Owner Review**; it is **not** cancelled. A later confirmation checks availability and reserves again atomically; an expired reservation is never revived by a status change. | O-12 |
| E | **Returns and exchanges.** Requests are accepted within 7 days after delivery. Size or preference changes require unused, unwashed goods with intact tags. Wrong or defective goods are exempt from those conditions. Inspection comes before any exchange or refund decision. | O-13 |
| F | **Return shipping cost.** Wrong or defective item supplied by the business: the business pays return shipping. Size or preference change: the customer pays. Responsibility and the actual cost are recorded separately; no amount is assumed. | O-13 |
| G | **RTO.** Refused or undelivered parcels returned to the business are first received into inspection (quarantine), never straight into sellable stock. Passed inspection: an auditable restock. Failed: a non-sellable disposition. Courier or RTO charges are recorded separately. | O-14 |
| H | **Milestones.** Expected progression: Pending Verification → Confirmed → Packed → Dispatched → Delivered. Cancellation, expiry, returns, exchanges and RTO are separate flows. The four lifecycle dimensions of O-1 stay separate; order source is an attribute. | O-1, O-2 |
| I | **Delivery charges.** Two starting zones, Dhaka City and Outside Dhaka, configured by the Owner. The charge is known before submission and stored in the order's price snapshot. No amount is approved yet. Without an applicable configured rate, submission is refused. | O-8, S-7 |
| J | **COD accounting.** Expected COD, courier-collected and Owner-settled amounts are kept apart. Delivered does not imply collected or settled. The Owner records collection and settlement by hand. | OF-3, OF-8 |
| K | **Guest tracking.** No account. Each order has a long, random, opaque, private tracking credential; an order can never be found from its number or phone digits. S-15's masking, revocation, no-indexing and no-logging rules apply. | S-9, S-15 |
| L | **Stock at dispatch.** Dispatch turns the reservation into a physical deduction: reserved and on-hand fall together, atomically, recorded in the append-only ledger. A repeated dispatch never deducts twice. No partial fulfilment at launch. | I-2, O-4 |
| M | **COD refunds.** After inspection and Owner approval, a refund is paid by hand through bKash, Nagad or bank transfer within 7 working days, and its amount, method and completion are recorded. Money that was not collected is never refunded. No payment gateway. | O-13 |
| N | **Further defaults.** No backorders. Owner-entered Messenger and WhatsApp orders follow the same reservation and verification rules. Sellable inspected returns are restocked through an auditable movement; damaged ones stay out of available stock. Collection and settlement are recorded by hand. Tracking links expire 30 days after the order is closed; the Owner can revoke or regenerate them earlier. | O-11, O-14, S-16 |

Founder-confirmed invariants that continue to apply: integer paisa; UTC stored, Asia/Dhaka shown; Bangladesh phone numbers normalised as text with the leading zero; order items snapshot SKU, product name, variant details and unit price; idempotent submission, cancellation, money and stock operations; database-enforced integrity; server-verified audit actors; no public checkout before the policies are published.

## 2. Lifecycle dimensions (as implemented)

Stored as four separate columns on `orders` (O-1). Order source (`website`, `messenger`, `whatsapp`, `other`) is a fifth, independent attribute.

| Dimension | Values |
|---|---|
| Order status (commercial) | `pending_verification`, `verification_expired`, `confirmed`, `cancelled`, `closed` |
| Fulfilment status | `unfulfilled`, `packed`, `dispatched`, `delivered`, `rto` (returning to the business), `rto_received` |
| Payment status (COD) | `unpaid`, `partially_collected`, `collected` (fully collected, not fully accounted for), `settled` (every collected taka settled to the Owner or recorded as kept by the courier, since Gate H.36); always derived from the recorded amounts (a database check enforces it) |
| Return status | `none`, `requested`, `in_progress`, `resolved` |

Allowed transitions (anything else is refused with `INVALID_TRANSITION`):

| Action | From | To | Stock effect |
|---|---|---|---|
| Submit (Owner-assisted; website later) | none | pending_verification, unfulfilled | Reserves every line, or nothing at all |
| Confirm | pending_verification, before the deadline | confirmed | Keeps the reservation |
| Confirm | pending_verification after the deadline, or verification_expired | confirmed | Releases any stale reservation, then reserves again only if available |
| Expire (runner or any operation that meets it) | pending_verification at or after 24 h | verification_expired | Releases the reservation once |
| Cancel (Owner) | pending_verification, verification_expired, or confirmed with fulfilment unfulfilled or packed | cancelled | Releases any active reservation once |
| Cancel (customer, tracking link) | pending_verification | cancelled | Releases the reservation once |
| Request cancellation (customer) | confirmed, unfulfilled or packed, no open request | request `open` | None |
| Approve / reject request (Owner) | open request on a confirmed, undispatched order | cancelled / request `rejected` | Approve releases once; reject none |
| Pack | confirmed, unfulfilled | packed | None |
| Dispatch | confirmed, packed, no open cancellation request | dispatched | Reserved and on-hand fall by every line; one `dispatch` ledger row per line |
| Deliver | dispatched | delivered | None |
| Mark RTO | dispatched | rto | None |
| Receive RTO | rto | rto_received | Every line enters quarantine; nothing becomes sellable |
| Close | confirmed; fulfilment rto_received, or delivered **and its 7-day return window has ended**; everything collected is settled or recorded as a courier deduction, no open return and nothing awaiting inspection | closed | None |

Cancellation and closing set `closed_at`; the tracking link stops working 30 days later.

## 3. Engineering defaults (Draft — Founder Review)

Chosen to implement section 1 where it leaves a technical detail open. They make no customer promise and can be changed.

| Default | Choice |
|---|---|
| Verification deadline | `verification_expires_at` = submission time + 24 hours (UTC), stored on the order. |
| Enforcing expiry without a scheduler | Logical correctness does not depend on a scheduler: submission, stock adjustment and confirmation release overdue reservations first, so an expired hold never blocks a fresh order or counts as valid. Physical cleanup of all overdue orders is a repeatable batch (`expireOverdueVerifications`), run by `npm run orders:expire-verification` locally. **No scheduler runs it in production**; when hosting is chosen, the host's scheduler (or an equivalent) should run the same command every few minutes. |
| Dispatch while a cancellation request is open | Refused until the Owner decides the request. |
| Payment collection | Recorded only after dispatch, at most the expected COD in total; settlement at most what was collected; partial amounts allowed. |
| Courier deductions (Gate H.36) | What the courier kept from the money it collected (its fee or another amount on its statement) is recorded by the Owner as its own entry, `deducted`, with the statement reference; no amount or fee is assumed. Settled plus deducted never exceeds collected. A deduction is not a refund and does not change what the customer paid or the order total. Without it, an order whose courier kept a fee could never be fully accounted for or closed. Chosen to implement rule J's separate buckets; Draft — Founder Review. |
| Refunds | Only for an approved return, at most the money collected minus earlier refunds, and at most the returned items' value. Method is bKash, Nagad or bank transfer. The 7-working-day deadline is shown, not computed, because the working-day calendar (weekends, public holidays) is not defined. |
| Exchanges | Request, receipt, inspection and Owner decision are recorded. **Executing** an exchange (sending the replacement) is not automated: the Owner creates a new assisted order for the replacement, which reserves stock normally. Who pays for the replacement's delivery and how a price difference is handled are **not decided** (section 4). |
| Return window | Up to 7 × 24 hours after the recorded delivery time, that moment included. |
| Closing a delivered order (Gate H.17) | Allowed only after the return window has ended (more than 7 × 24 hours after delivery), in addition to the conditions in section 2. Before that the Admin shows when the order can be closed; a database check (`orders_closed_after_return_window`) refuses an earlier close even from a direct write. Chosen so that neither closing nor COD settlement can end the customer's right to ask for a return (rule E). It adds no return condition and no refund rule. RTO orders, which were never delivered, are unaffected. The tracking link, which expires 30 days after closing, therefore works for the whole return window. |
| Closing an order | An explicit Owner action, allowed only under the conditions in section 2. Delivered is not Closed. |
| Tracking credential | 32 random bytes (base64url); only its SHA-256 digest is stored; one active link per order; the link carries it in the URL fragment, which browsers never send to the server, and the page redeems it with a same-origin POST. The link is shown once, when created. Once the page has read the token it replaces its own history entry with plain `/track` and keeps the token in memory only, so reloading, or returning to the page later, needs the link again (Gate H.17). |
| Public tracking rate limit | No client header is trusted (Gate H.17): a malformed token is refused without a database lookup; each live link has its own limit of 30 requests per minute; unknown, revoked and expired tokens share one global limit of 30 per minute, which never blocks a live link. Guessing is defeated by the token's 256 random bits, not by the limit. Still possible without a trusted proxy or CDN (hosting decision): a flood that overloads the server or database, and someone who holds a link using up that link's minute. |
| Phone numbers | Bangladesh mobile numbers only: `01` followed by an operator digit 3–9 and 8 digits; `+880` / `880` prefixes, spaces and hyphens, and Bangla digits (০–৯, since Gate H.23), are accepted on input and stored as `01XXXXXXXXX` in ASCII digits. |
| Technical bounds (not policy) | Delivery charge 0 to BDT 10,000; order line quantity 1 to 1,000; up to 20 lines per order. |

## 4. Not decided (no customer promise is made)

- Exchange execution: replacement delivery charge and price differences.
- Working-day calendar for the 7-working-day refund deadline.
- Return inspection criteria (open decision 9) beyond pass or fail with a note.
- Delivery charge amounts, and any district-level zones (O-8).
- Public delivery, return/exchange and privacy policy text (S-17, G-7).
- Whether a delivered order may ever be closed before its 7-day return window has passed (for example when the customer says they will not return anything). The engineering default since Gate H.17 refuses it (section 3).
