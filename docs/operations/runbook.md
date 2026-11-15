# Operations runbook

**Status:** Draft — Founder Review. **Purpose:** How to run, check and recover the local BabySunray system today. It covers the local development installation only: no production hosting, scheduler, off-device backup or recovery objective has been chosen (requirements K-4, K-5, K-8, K-9; open decisions 1, 6 and 15).

Commands run from the project folder. Never paste passwords, passphrases, database URLs or tracking links into chats, issues, commits or screenshots.

## 1. Start and stop

| Task | Command |
|---|---|
| Start the development server | `npm run dev`, then open http://localhost:3000/office |
| Stop it | Ctrl+C in that terminal |
| Production build, locally | `npm run build`, then `npm start` (needs an https `BETTER_AUTH_URL`; see section 3) |

## 2. Environment variables (without showing values)

The application reads `.env.local` (copied from `.env.example`). To check it without printing secrets:

```
npm run config:check
```

It lists every variable as set, missing or invalid with the rule it breaks (never the value), then connects to `babysunray_dev` and reports whether it is reachable, how many migrations are applied and whether an active Owner exists. It changes nothing, and exits with an error until everything required is ready.

| Variable | Needed for | Checked by |
|---|---|---|
| `DATABASE_URL` | the app, `db:migrate`, `orders:expire-verification`, `backup:create` | must name local `babysunray_dev` and its role on port 5432 |
| `TEST_DATABASE_URL` | all tests and `backup:drill` | must name local `babysunray_test` and its role |
| `BETTER_AUTH_SECRET` | sign-in | at least 32 random characters, not the placeholder |
| `BETTER_AUTH_URL` | sign-in, origin checks | an origin only; `http://localhost:3000` allowed outside production |
| `RESTORE_DATABASE_URL` | `backup:restore` only | must name local `babysunray_restore` and its role |
| `PG_BIN` (shell, optional) | backup commands | PostgreSQL's `bin` folder if `pg_dump` is not on the PATH, e.g. `C:\Program Files\PostgreSQL\18\bin` |

## 3. Sign-in troubleshooting

| Symptom | Cause and fix |
|---|---|
| The sign-in page says "Sign-in is not set up on this server yet" and names `BETTER_AUTH_SECRET` (development), or "Sign-in is not available right now" (production) | The secret is missing or invalid in `.env.local`. Generate one (`openssl rand -base64 32`), add it, restart `npm run dev`, run `npm run config:check`. Changing the secret signs everyone out; it does not change or delete any account. |
| `BETTER_AUTH_SECRET is still the placeholder.` | Replace `CHANGE_ME` with a generated value. |
| `BETTER_AUTH_URL must use https ...` | In production mode the site must be served over https. For local work use `npm run dev` with `http://localhost:3000`. |
| "Too many attempts" on sign-in | Better Auth's sign-in rate limit (3 attempts per 10 seconds per address). Wait, then try again. |
| Password forgotten | `npm run auth:reset-owner-password` (local only, run it yourself; it signs out every session). There is no production account recovery yet. |
| Signed out unexpectedly | Sessions expire; the Owner's access can be disabled in `user_access`. Sign in again. |

## 4. Database checks

| Check | How |
|---|---|
| PostgreSQL reachable | `psql -h localhost -p 5432 -U babysunray_dev -d babysunray_dev -c "select 1"` (asks for the password) |
| Migration status | `npm run db:migrate` reports "Migrations are up to date" when nothing is pending; `npm run db:check` checks the migration files. Applied migrations: `select count(*) from drizzle.__drizzle_migrations;` (10 after migration 0009) |
| Stock consistent with the ledger | `select count(*) from inventory_balances b where b.on_hand <> coalesce((select sum(quantity_delta) from stock_movements m where m.variant_id = b.variant_id), 0);` must be 0 |
| Reservations consistent | `select count(*) from inventory_balances b where b.reserved <> coalesce((select sum(quantity) from stock_reservations r where r.variant_id = b.variant_id and r.status = 'active'), 0);` must be 0 |
| COD totals consistent | Reports → COD reconciliation shows "Check passed" (entries agree with every order's running totals) |

Only apply migrations with `npm run db:migrate`. Take a backup first (section 8) once real data exists.

## 5. Verification expiry and retries

- `npm run orders:expire-verification` releases the stock of orders still Pending Verification 24 hours after submission and marks them Verification Expired. It is safe to run any number of times, also while the app runs: each order is handled in its own short transaction and skipped if another operation holds it. Correctness never depends on it (submissions, adjustments and confirmations release overdue holds themselves). No scheduler runs it.
- A failed or interrupted action can be retried safely: every Office form and API write carries an idempotency key, so pressing the button again after a lost answer records the change once. A form refused with "changed after you loaded it" must be reloaded and checked, not forced.

## 5a. Guest tracking links

- The Owner creates a link on the order page; it is shown once. Send it to the customer as it is.
- When the customer opens it, the page reads the token, removes it from the address bar and from the tab's back and forward history, and keeps it only in memory. Reloading the page, going back to it later or opening `/track` alone shows "Open the tracking link from the shop's message"; opening the link from the message again works. The browser's own list of visited pages may still hold the link the customer opened, as for any link opened from a message.
- Revoking or regenerating the link stops the old one at once. A link stops working 30 days after the order is closed, and a delivered order can be closed only after its 7-day return window.
- Limits: 30 requests a minute per link; unknown, revoked or expired links from everyone together 30 a minute ("Too many requests", then wait a minute). Someone else's failed attempts never block a customer's live link. A deliberate flood can still slow or stop the whole site until hosting with a trusted proxy is chosen.

## 6. Exports

Owner Office → Exports. Choose a dataset, a format and optional filters; the file downloads straight away and is never stored on the server. Formats and columns: [exports.md](exports.md).

- Every export is recorded (who, when, dataset, format, filters) and listed under "Recent exports". The record cannot be edited or deleted.
- Files with customer contact details (the Orders dataset) are personal data: keep them private, do not email or upload them casually, delete copies you no longer need.
- An export is not a backup: it cannot restore the system (requirement K-10).
- Limits: 100,000 rows per file; a date range of at most 366 days.

## 7. Physical stock counts

Owner Office → Stock counts.

1. Start a count of every SKU or of a list of SKUs. The system quantities at that moment are kept as a snapshot; print the count sheet if you count on paper.
2. Count the sellable units in the shop, **including** units set aside for orders that are not dispatched yet. **Do not** count returned or RTO goods waiting for inspection: they are held apart and a count never changes them.
3. Enter the counted numbers and press Save counts. You can stop and resume later; drafts stay until applied or discarded. Leave a SKU empty if you did not count it.
4. Review the differences. If a SKU's stock moved after you counted it (a dispatch, receipt, adjustment or restock), it is marked "recount": count it again, enter the number and tick "I recounted it now".
5. Apply with a reason. Each difference becomes one stock adjustment with your name and the reason; all SKUs are corrected together or none is. A count below the units reserved for orders is refused: check those orders first.
6. Or discard the count: nothing changes.

How often to count, and what to do about missing or damaged goods (write-off rules), are business decisions not yet made (requirement I-8, open decision 9).

## 8. Backup and restore

What exists: an encrypted local backup of the development database, a verification command, a restore command into a separate empty database, and a tested drill on fictional data. What does not exist: a schedule, retention, an off-device copy, or an approved RPO/RTO. A backup that has never been restored is not verified (K-6).

### Create a backup (founder only, interactive)

```
npm run backup:create -- --out D:/Backups/babysunray
```

- The folder must exist and be outside the project folder. The file is named `babysunray_dev-<UTC time>.bsbackup`.
- You type a passphrase (at least 12 characters) twice; it is not shown and never stored. **Without it the backup cannot be read.** Keep it apart from the backup file.
- The backup contains the whole database including the Owner account (password hash, not the password) and all orders and customer details. Session tokens are not included. Treat the file as confidential.
- The command verifies the new file and prints its size and SHA-256. Take one before any migration once real data exists (K-5).

### Check a backup

```
npm run backup:verify -- D:/Backups/babysunray/babysunray_dev-....bsbackup
```

Decrypts the whole file, checks every part is unchanged, and lists the archive with `pg_restore --list`. No database is touched.

### Restore a backup

Restore never writes into `babysunray_dev` or `babysunray_test`. It needs an empty database created for the purpose, by the founder, as a PostgreSQL superuser (one time):

```sql
CREATE ROLE babysunray_restore LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '<choose one>';
CREATE DATABASE babysunray_restore OWNER babysunray_restore ENCODING 'UTF8';
REVOKE CONNECT ON DATABASE babysunray_restore FROM PUBLIC;
```

Then set `RESTORE_DATABASE_URL=postgresql://babysunray_restore:<password>@localhost:5432/babysunray_restore` in `.env.local` and run:

```
npm run backup:restore -- D:/Backups/babysunray/babysunray_dev-....bsbackup
```

It refuses a non-empty target, authenticates the whole file first, and restores in one transaction (a failure leaves the target empty). **Not yet run against a real `babysunray_restore` database** (it does not exist yet); the same restore code is what the drill below exercises. To make a restored copy the working database, point `DATABASE_URL` at it only after checking it (sign in, look at orders and stock); that switch is a founder decision.

### Restore drill (fictional data)

```
npm run backup:drill
```

Uses only `babysunray_test`, under the same lock as the tests (it refuses to run while `test:db` or `test:e2e` runs). It creates fictional products, stock, orders, COD entries, a refunded return, an RTO in quarantine, a stock count and an export record; backs up and verifies; empties the test database with the guarded reset; restores; and compares every table's contents, the sequences, constraints, triggers and the schema with what was there before. It prints a short report with the times taken. The times are observations on this machine, not an approved recovery time. Result on 2026-11-15: passed (28 tables, backup 0.5 s, verify 0.4 s, restore 1.0 s on a small data set).

## 9. Outage procedure

When the Office or the database is unavailable:

1. Do not promise delivery dates or stock you cannot check. Tell customers you will confirm shortly.
2. Write each new order on the [order sheet](offline-templates.md) with a temporary reference you make up (for example `OFF-1115-01`), never a real order number. Note stock you hand out on the stock sheet, and any cash or courier events on their sheets.
3. Keep the paper in one place. Do not copy customer details anywhere else.

When the system is back:

1. Check it first: sign in, open Dashboard and Reports (the COD check must pass).
2. Enter each offline order as an assisted order, one at a time, oldest first. Before entering one, search the order list by date and your notes to make sure it was not entered already; write the new order number next to the temporary reference on the sheet. Never enter a sheet line twice: tick it as you go.
3. If an order cannot be reserved because stock ran out meanwhile, contact the customer; do not adjust stock to make it fit.
4. Record stock receipts and adjustments from the stock sheet with the reason "Recorded after outage, sheet <date>".
5. Record COD collections and settlements from the money sheet with their real dates.
6. Finally run a stock count of the SKUs that moved, to catch anything missed.
