# Export formats

**Status:** Draft — Founder Review. **Purpose:** What the Owner Office exports contain and how to read them (requirements D-1 to D-8), for the Owner and for a future client that imports them.

Code: `src/modules/exports` (datasets in `datasets.ts`, encoders in `formats.ts`, the service in `service.ts`); route `POST /office/exports/download`. There is no API endpoint for exports yet.

## Request and security

- Owner Office only, permission `exports:create`, session cookie, a POST from this site's own origin. Signed out, another origin, or a missing permission: no file.
- Each request is written to `export_requests` (append-only) **before** any data is read: user id, time, dataset, format, complete or filtered, and the filters (dates and status values only).
- The file is generated while it downloads and is never stored on the server; there is no download link to share or reuse. Responses are `Cache-Control: no-store`, `X-Robots-Tag: noindex`, `Content-Disposition: attachment`.
- Never exported: passwords or their hashes, sessions, tracking tokens or their digests, idempotency records, rate-limit counters.
- All rows of one file come from one database snapshot (a read-only REPEATABLE READ transaction with a server-side cursor), so a change made while it downloads is not half in the file.
- Limits: 100,000 rows per file (a larger request is refused before it starts), a date range of at most 366 days, 120 seconds per database statement.

## Scope and filters

A request without filters is a **complete** export; with any filter it is a **filtered** export. The file name says which: `<dataset>-<complete|filtered>-<UTC time>.<format>`. JSON has `scope` and `filters`; XLSX has an "About" sheet.

| Filter | Meaning |
|---|---|
| `from`, `to` | Dhaka calendar dates, both included (both or neither). Applies to the dataset's own date column below. |
| `source`, `orderStatus`, `fulfilmentStatus`, `paymentStatus` | Applied to the order each row belongs to. Only for order datasets. |

A filter a dataset does not support is refused, never ignored.

## Datasets

| Dataset | One row per | Date filter on | Order filters | Contact details |
|---|---|---|---|---|
| `products_variants` | variant, with its product | none | no | no |
| `product_content` | product: category, featured, names, descriptions, fabric (with confirmation time), care and size guidance in both languages | none | no | no |
| `product_measurements` | size and measuring point, in whole millimetres | none | no | no |
| `product_media` | photo record (the media manifest): product, position, storage key, type, size, SHA-256, alt text | none | no | no |
| `stock` | variant: on hand, reserved, available, awaiting inspection | none | no | no |
| `stock_movements` | ledger row | when recorded | no | no |
| `orders` | order, with item totals read in the same snapshot | submission time | yes | **yes** (name, phone, address, note) |
| `order_items` | order line (price snapshot) | order submission | yes | no |
| `order_events` | order history row | when recorded | yes | no |
| `payments` | COD collection, settlement or refund entry | the payment date entered | yes | no |
| `returns` | return or exchange, with value and refunds | request time | yes | no |
| `quarantine` | returned or RTO line in inspection | received time | yes | no |
| `delivery_zones` | zone | none | no | no |
| `stock_counts` | counted SKU line, with its count | count start | no | no |
| `policy_drafts` | saved policy draft kind: status (empty, drafted, reviewed; never published), version, English and Bangla text, who saved and reviewed (Gate H.26) | none | no | no |
| `product_reviews` | internal product review: when, by whom, product, content digest, items still open (not publication) | review time | no | no |
| `export_requests` | export audit row | request time | no | no |

Column names, types and short descriptions are listed in every JSON file (`columns`) and defined in `src/modules/exports/datasets.ts`.

## Values

| Type | JSON | XLSX | CSV |
|---|---|---|---|
| Text (names, phone numbers, SKUs, `ORD-000042`, ids) | string | text cell | text; see formulas below |
| Integer (amounts in paisa, quantities, ids of ledger rows) | number | number cell | digits |
| Timestamp | ISO 8601 UTC (`...Z`) | `YYYY-MM-DD HH:MM:SS` Bangladesh time, column name ends in `_dhaka` | same as XLSX |
| Date (`occurred_on`) | `YYYY-MM-DD` | text | text |
| Boolean | `true` / `false` | boolean cell | `true` / `false` |
| JSON (`detail`, `filters`) | object | compact JSON text | compact JSON text |

- Money is always integer **paisa** (100 paisa = 1 BDT), never a decimal. Every amount fits exactly in a JavaScript number and in an Excel number cell (Excel shows 15 significant digits; real amounts are far below that).
- Ids are UUID text; `order_reference` is `ORD-` and six or more digits. Relations: `order_id`, `variant_id`, `return_id`, `movement_id` and similar columns name rows in other datasets.
- Order totals are expected cash on delivery, not sales, revenue or profit.

## Spreadsheet safety and Excel

- **XLSX** stores text as inline strings and never writes a formula, so a value such as `=HYPERLINK(...)` stays plain text. Phone numbers keep their leading zero. Bangla is stored as Unicode.
- **CSV** is UTF-8 with a byte-order mark (so Windows Excel shows Bangla) and CRLF line ends, RFC 4180 quoting. CSV has no cell types: Excel guesses. Opening a CSV by double-click in Excel therefore **drops the leading zero of phone numbers** and may change long numbers or dates. Use XLSX for Excel, or import the CSV with Data → From Text/CSV and set those columns to Text.
- Quoting does not stop formulas. A CSV text value that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is written with a leading apostrophe (`'=...`). That apostrophe is part of the CSV value and is visible; JSON and XLSX keep the exact text.

## JSON layout (schema version 1)

```json
{
  "schemaVersion": 1,
  "dataset": "orders",
  "title": "Orders (with customer contact details)",
  "scope": "filtered",
  "filters": { "from": "2026-11-01", "to": "2026-11-15", "source": "whatsapp" },
  "createdAt": "2026-11-15T08:00:00.000Z",
  "timeZone": "Asia/Dhaka",
  "exportRequestId": 12,
  "amounts": "integer paisa (100 paisa = 1 BDT)",
  "timestamps": "ISO 8601 in UTC",
  "columns": [{ "name": "order_id", "type": "text" }],
  "records": [{ "order_id": "..." }]
}
```

`timeZone` is the zone the Owner works in and the date filters use; timestamps in `records` are UTC. A change that removes or renames a column, or changes a type, increases `schemaVersion`.
