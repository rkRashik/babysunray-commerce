# Courier statement check

**Status:** Draft — Founder Review
**Purpose:** How to compare a courier's COD statement with the money recorded for each order, and what the check does not do.

Statement reconciliation (OF-8) is proposed, not approved, and no courier's statement format is known. So this is a **read-only** comparison through one generic template: it never records, settles or deducts anything. A statement is not proof that money arrived. Record each collection, settlement or deduction by hand on the order (or `POST /api/v1/orders/{orderId}/payments`) after checking it.

## Template

UTF-8 CSV, comma-separated, first row exactly:

```
order_reference,collected_taka,deducted_taka,remitted_taka
```

| Column | Meaning |
|---|---|
| `order_reference` | The order's reference as on the parcel, for example `ORD-000042` (`ord42` or `42` also work) |
| `collected_taka` | What the courier says it collected from the customer |
| `deducted_taka` | What the courier says it kept (its fee or other deduction) |
| `remitted_taka` | What the courier says it paid you |

Amounts are in Taka with at most two decimals (`850` or `850.50`), no currency sign or thousands separator. At most 1,000 rows and 60,000 characters; split a longer statement. Empty rows are ignored. Copy the numbers from the courier's statement; add no rows the statement does not have.

## What the check reports

`POST /api/v1/cod/statement-checks` with `{ "csv": "..." }` (Owner, `payments:record`, an `Idempotency-Key`). For each row:

| Status | Meaning |
|---|---|
| `matches` | Collected, deducted and remitted equal the order's recorded collected, deducted and settled amounts |
| `differs` | At least one differs; `differencePaisa` is the statement minus the record. Also flags `statement_exceeds_collected` (deducted plus remitted is more than collected) and `order_not_dispatched` |
| `order_not_found` | No order has this reference |
| `duplicate` | The reference appears more than once in the file; none of those rows is compared |
| `invalid` | The reference or an amount cannot be read (`problems` says which) |

The answer also has counts and totals in paisa. It contains order references and amounts only, no customer details.

A wrong first row or broken CSV refuses the whole file (`400`). Each check is stored with the report it showed in `courier_statement_checks` (append-only: who, when, the file's SHA-256, never its content). Retrying with the same key returns that same report.

## Not built

Recording payments from a statement (needs a real statement format and an approved process), courier-specific formats, matching by consignment number, and any check of the dates on a statement.
