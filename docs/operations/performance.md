# Performance findings

**Status:** Draft — Founder Review
**Purpose:** What the benchmark on fictional data measured, where the time goes, and what was deliberately not changed.

## How it was measured

`npm run perf:bench` (`tests/perf/benchmark.perf.ts`) resets `babysunray_test` under the test lock and fills it with fictional data: 5,000 draft products in 20 categories, 15,000 SKUs, 30,000 size-chart rows, 20,000 orders spread over a year (60 % delivered and closed with COD collected and settled, 20 % dispatched, 20 % cancelled) with their items and 24,000 COD entries. Each scenario runs once to warm up, then five times through the real services; the median and the slowest are recorded, with `EXPLAIN (ANALYZE, BUFFERS)` for the heaviest reads. Results are written to `test-results/perf-benchmark.json` (git-ignored). It never touches `babysunray_dev`.

Machine: a laptop (Intel Core i7-9750H, 32 GB), Node.js 24, local PostgreSQL 18, 2026-11-16. These are observations on this machine, not a promise for any host.

## Results (median, milliseconds)

| Scenario | ms | Notes |
|---|---:|---|
| Office product list, first page / keyset page 2 | 1.5 / 3.1 | index `products_created_at_id_idx` |
| Office search by name / by SKU | 29 / 30 | `ILIKE` over every product: a sequential scan of 5,000 rows (22 ms in the plan) |
| Office filters: category, missing fabric, in stock | 1.4–1.8 | |
| Catalogue preparation overview | 152 | ten counts over every draft product, one query |
| Preview product list, page 1 / page 50 | 13 / 20 | offset paging; four queries per page |
| Preview search, size and in-stock filters | 29–30 | |
| Preview facets / product page / 20-line cart quote | 17 / 4 / 2.5 | |
| Review state of 50 products | 5 | |
| Launch readiness page | 603 | digests of all 5,000 products' content (360 ms) and the integrity checks |
| Orders list: first page / page 4,000 (keyset) / by number | 1.3 / 1.2 / 0.7 | |
| Orders "needs attention" filter | 65 | walks the whole `orders_created_at_idx` when few orders match (see below) |
| Dashboard | 112 | |
| Period report over 365 days | 79 | |
| One guest submission (inactive service) | 44 | includes the overdue sweep, reservation and tracking link |
| Orders export, 20,000 rows: CSV / XLSX | 1,017 / 1,547 | 5.4 MiB CSV; rows read from a server-side cursor in batches of 500 |
| Bulk import preview, 1,000 rows | 53 | |
| Normalising a 3000 × 4000 JPEG upload / a 640-pixel copy | 80 / 31 | |

## Findings

- **No index was added.** Every list that pages uses an index already. The remaining sequential scans read 5,000 product rows in a few milliseconds; an index would not change what a person notices.
- **Text search** (`ILIKE '%term%'`) cannot use a B-tree index and scans every product (about 30 ms at 5,000). A trigram index needs the `pg_trgm` extension. Worth it only if the catalogue grows well beyond this or customer search is approved (S-14).
- **"Needs attention" orders** combine conditions with `OR` and an `EXISTS`, so PostgreSQL walks the orders index newest first until it finds 26 matches; when almost nothing needs attention, that is every order (65 ms at 20,000). It grows with the order history. If it becomes slow, split it into one indexed query per condition. Not changed now.
- **Launch readiness** computes a content digest for every draft product on each visit (about 0.4 s at 5,000). Acceptable for a page the Owner opens occasionally; storing the digest would add an update on every content change, which was not worth it at this size.
- **Exports** do not hold the file: rows come from a cursor 500 at a time inside one snapshot and are encoded as they arrive. The heap measured during a 20,000-row CSV grew by up to 68 MiB, which includes garbage not yet collected; it was not measured with forced collection, so it is an upper bound, not the working set.
- **No N+1 pattern** was found in the measured paths: list pages, the review queue (one readiness query and one review query per page) and the cart quote use a fixed number of queries.
- Not measured: many users at once, a slow network, a remote database, cold disk caches, the browser side (page weight, rendering on a mid-range Android phone).
