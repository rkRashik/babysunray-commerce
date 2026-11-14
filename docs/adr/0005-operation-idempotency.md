# ADR-0005: Operation-level idempotency

**Status:** Draft — Founder Review
**Date:** 2026-11-15
**Deciders:** Founder
**Related:** [ADR-0002](0002-drizzle-and-inventory-foundation.md) (Not decided: idempotency), [ADR-0004](0004-api-v1-and-bearer-transport.md), [API guide](../api/README.md), [Product requirements](../product/requirements.md) (O-3, API-8)

**In short:** The founder authorised operation-level idempotency in batch H.4–H.6 (2026-11-15). A client-generated key, scoped to the verified user, makes one business operation however often the request is retried. The record lives in PostgreSQL and commits in the same transaction as the operation. It is used by the stock and draft-catalogue writes (API and Owner Office). Retention and expiry of records are **not** decided.

## Context

ADR-0002 deferred idempotency because a unique key on each ledger row would suit a single-SKU receipt but not an operation that changes several SKUs (a future order). Write endpoints and Office forms need retry safety now: a lost response or a double-click must not record a receipt twice (API-8).

## Decision

| Area | Decision |
|---|---|
| Unit | One record per **operation**, not per ledger row: table `idempotency_records` (migration `0006`), primary key `(user_id, idempotency_key)`. The operation may change any number of rows. |
| Scope | The verified user id from the session (`Principal.userId`). No tenant. The same key from two users is two operations; one user can never replay another's. A key reused for a different operation is refused. |
| Stored | User id, key, operation name (`stock.receive`, `catalog.product.create`, ...), SHA-256 fingerprint of the canonical request (sorted-key JSON of the normalised input, including path ids), a result reference (for example `{movementId, onHand}` or `{productId}`), creation time. No request body, header, credential or personal data. |
| Algorithm | `runOnce` (`src/modules/idempotency/service.ts`), in one transaction: `INSERT ... ON CONFLICT DO NOTHING` claims the key; the business operation runs; the result reference is stored in the claimed row; commit. A concurrent transaction with the same key waits on the primary key until the first commits (then it reads the committed row) or rolls back (then it claims the key itself). No process-local lock. |
| Replay | Same key, same operation and fingerprint: the result is loaded again from the reference and returned as a replay (HTTP header `Idempotent-Replayed: true`). Ledger rows never change, and the stored `onHand` is the value the operation produced, so a stock replay equals the first answer. Catalogue replays return the resource's current state. Different fingerprint or operation: `IDEMPOTENCY_KEY_REUSED`, nothing runs. |
| Failure | A failed operation rolls back its claim, so failures are never recorded and a retry with the same key runs afresh. |
| Order of checks | Authentication and permission are checked before `runOnce` (in `src/modules/*/operations.ts`), so no stored result reaches a caller who could not run the operation. |
| Composition | The services' own `db.transaction` becomes a savepoint when they are given a transaction (`Db` now covers both). Several operations can therefore share one outer transaction and commit together (tested). |
| Key format | 16 to 128 characters of `A-Z a-z 0-9 _ . : -` (a UUID fits), checked in code and by a CHECK constraint. |

## Consequences

- Every write costs one extra row and two extra statements in its transaction.
- **Storage:** records are kept indefinitely. Each is roughly 200 bytes plus index; 100,000 operations are about 30 MB. An expiry or clean-up policy (and whether an expired key may be reused) needs a founder decision; until then nothing deletes or reuses records. Deleting a user deletes that user's records (`ON DELETE CASCADE`); users referenced by the ledger cannot be deleted anyway.
- A request that waits on a concurrent same-key request holds a database connection until the first finishes. No lock timeout is set; operations are short.
- The guarantees are tested against real PostgreSQL with independent connections and forced overlap (`tests/db/operations.integration.test.ts`): sequential and concurrent same-key retries, changed payloads, other users, rollback after the balance update and after the ledger insert, lost-response retry, concurrent last-unit decrements, and agreement of balance, ledger and records.

## Not decided

- Retention, expiry and key reuse after expiry.
- Order submission (O-3) will use the same mechanism when orders exist; nothing for orders is built.

## Alternatives considered

- Unique key per ledger row (ADR-0002): rejected, does not cover multi-SKU operations.
- PostgreSQL advisory locks on a hash of the key: works, but adds hash collisions and a second mechanism next to the record that must exist anyway.
- Store the full response body for replay: rejected; a reference re-reads immutable ledger rows and keeps request content out of the table.
- Redis or an in-process lock: not available to every process (and Redis is an unapproved service).
