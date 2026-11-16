# Catalogue and inventory

**Status:** Draft — Founder Review
**Purpose:** What the catalogue and stock services do, how they protect data, and their known limits.

Server-only services in `src/modules/catalogue` and `src/modules/inventory`, with idempotent, permission-checked operations (`operations.ts`) that the API and the admin panel both call. Each service takes a Drizzle handle from its caller and throws a `DomainError` with a stable code for expected failures. Decisions: [ADR-0002](../adr/0002-drizzle-and-inventory-foundation.md), [ADR-0005](../adr/0005-operation-idempotency.md).

| Capability | Notes |
|---|---|
| Create a draft product; archive it | Products are `draft` or `archived` only. Nothing is publishable: no publication rule is approved and there is no publish action. Never deleted. |
| Create a variant (SKU) with its zero stock balance; deactivate it | SKU stored as 1–64 ASCII uppercase letters, digits, hyphens and underscores (input is trimmed and a–z uppercased first), unique in PostgreSQL. Price in integer paisa, strictly positive. Never deleted. |
| Edit a draft product's content; edit an active variant's size, colour and price | `updateProduct`, `updateVariant`. Each row has a `version` (migration `0007`) that every update raises; an edit names the version it was based on and is refused with `VERSION_CONFLICT` if the row changed, under a row lock, so concurrent edits never silently overwrite each other. Slug, SKU, ids, status and stock never change here; archived products and their variants, and inactive variants, are not edited. |
| Product content (migration `0011`) | Fabric, care and optional size guidance in English and Bangla, an admin-defined category (`product_categories`), a featured flag, and a size chart per size and measuring point stored as whole millimetres and shown as centimetres with one decimal (`src/modules/catalogue/content.ts`). A fabric statement counts as confirmed only after an explicit confirmation, which records who and when; changing the fabric text clears it. Nothing is translated or generated. |
| Readiness checklist | `evaluateReadiness` (`src/modules/catalogue/readiness.ts`): an advisory, read-only checklist that separates items required by approved requirements (bilingual name and description, an active priced SKU), proposed rules still waiting for a decision (measurements, a confirmed fabric statement, care, the delivery and return explanation) and engineering recommendations (sizes, category, a photo, alt text). |
| Catalogue preparation | `src/modules/catalogue/preparation.ts`: the readiness checklist as SQL (tested to agree with `evaluateReadiness`), for counts per item and the product list's "still missing" filter. |
| Internal product review | `src/modules/catalogue/review.ts`: records that the current content was reviewed, with a SHA-256 of that content; any later change to text, claims, measurements, photos or SKUs makes the review outdated. It publishes nothing ([launch-readiness.md](../operations/launch-readiness.md), section 4). |
| Bulk import of new drafts | CSV (UTF-8) or XLSX, create-only and all or nothing, previewed with every problem by row and column before anything is saved, once per idempotency key, through the normal catalogue services; never publishes, confirms fabric or receives stock. Format and limits: [catalogue-import.md](../operations/catalogue-import.md). Audited in `catalogue_imports` (migration `0012`). |
| Search products | `listProducts` with `q`: slug, English or Bangla name, or any SKU, case-insensitive, NFC-normalised, `%` `_` `\` escaped, bound parameter, at most 100 characters. No index: it reads every product row ([performance.md](../operations/performance.md)). |
| Receive stock; adjust stock with a reason | One transaction per change: conditional balance update plus an append-only ledger row. Stock never goes below zero or below what orders hold. |
| Reservations | Orders hold stock in `stock_reservations`; `inventory_balances.reserved` always equals the active holds (see the [orders guide](orders.md)). |
| Physical stock counts | Counts with snapshots, resumable drafts, stale-count refusal and reasoned ledger adjustments (`src/modules/inventory/counts.ts`; [runbook](../operations/runbook.md), section 7). |

## Known limits

- The services themselves are not idempotent: called twice, `receiveStock` records two receipts. Clients use the idempotent operations, which run once per client-generated key and user. Idempotency records are kept indefinitely until a retention policy is approved.
- An inactive SKU can still receive physical stock; its status does not make it sellable.
- Ledger rows record a `system` actor or an authenticated `user` actor (the user's id, from a verified session; [ADR-0003](../adr/0003-authentication-foundation.md)). Changes made through the API or the admin panel record the signed-in user.
- The append-only ledger trigger can be removed by the table owner or a superuser ([ADR-0002](../adr/0002-drizzle-and-inventory-foundation.md)).
- Drizzle error messages include query parameters; they are never logged or displayed as they are.
