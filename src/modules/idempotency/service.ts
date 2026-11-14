import "server-only";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/database";
import { idempotencyRecords } from "@/db/schema";
import { DomainError, invalidInput } from "../domain-error";

// Operation-level idempotency: one client-generated key per user makes one business operation, however many
// times the request is retried and whatever it changes (one ledger row today, several SKUs in a later
// order). The record is written in the same PostgreSQL transaction as the operation, so they commit or roll
// back together. Callers check authentication and permission before calling runOnce, so a stored result is
// never replayed to a caller who may not run the operation; the key is scoped to the verified user id, so
// one user can never replay another user's operation.

/** What runOnce stores about a committed operation: ids and numbers to find the result again. No personal data. */
export type ResultRef = Record<string, string | number>;
export type Once<T> = { value: T; replayed: boolean };

const KEY = /^[A-Za-z0-9_.:-]{16,128}$/;

/** A client-generated key: 16 to 128 characters of A-Z, a-z, 0-9, `_ . : -` (a UUID fits). */
export function validateIdempotencyKey(raw: unknown): string {
  if (typeof raw !== "string" || !KEY.test(raw)) {
    throw invalidInput("Idempotency-Key", "must be 16 to 128 characters: letters, digits, _ . : -");
  }
  return raw;
}

/** JSON with object keys sorted at every level, so equal requests have equal text. Plain data only. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new Error("canonicalJson: only plain JSON data can be fingerprinted.");
}

/** SHA-256 of the operation name and its canonical request. The request itself is never stored. */
export function requestFingerprint(operation: string, request: unknown): string {
  return createHash("sha256").update(canonicalJson({ operation, request })).digest("hex");
}

/**
 * Runs `execute` at most once per (user, key). In one transaction:
 * 1. claim the key with INSERT ... ON CONFLICT DO NOTHING. A concurrent transaction holding the same key
 *    makes this INSERT wait on the primary key until that transaction commits or rolls back;
 * 2a. claimed: run the business operation, then store its result reference in the claimed row;
 * 2b. already taken: the committed row is read. Same operation and fingerprint: its result is loaded again
 *     and returned with `replayed: true`. Anything else: IDEMPOTENCY_KEY_REUSED, and nothing runs.
 * A failed operation rolls back its claim too, so a failure is never recorded and a retry runs afresh.
 * Given a transaction as `db`, this becomes a savepoint inside it (several operations can share one commit).
 */
export async function runOnce<R extends ResultRef, T>(
  db: Db,
  op: { userId: string; operation: string; key: string; request: unknown },
  execute: (tx: Db) => Promise<R>,
  load: (db: Db, ref: R) => Promise<T>,
): Promise<Once<T>> {
  const key = validateIdempotencyKey(op.key);
  const fingerprint = requestFingerprint(op.operation, op.request);
  const where = and(eq(idempotencyRecords.userId, op.userId), eq(idempotencyRecords.idempotencyKey, key));

  return db.transaction(async (tx) => {
    const claimed = await tx
      .insert(idempotencyRecords)
      .values({ userId: op.userId, idempotencyKey: key, operation: op.operation, requestFingerprint: fingerprint })
      .onConflictDoNothing()
      .returning({ userId: idempotencyRecords.userId });

    if (claimed.length === 0) {
      // READ COMMITTED: this statement sees the row the conflicting transaction committed.
      const [existing] = await tx.select().from(idempotencyRecords).where(where);
      if (!existing || existing.result === null) throw new Error("Idempotency record is missing or incomplete.");
      if (existing.operation !== op.operation || existing.requestFingerprint !== fingerprint) {
        throw new DomainError("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for a different request.");
      }
      return { value: await load(tx, existing.result as R), replayed: true };
    }

    const ref = await execute(tx);
    const stored = await tx.update(idempotencyRecords).set({ result: ref }).where(where).returning({ userId: idempotencyRecords.userId });
    if (stored.length !== 1) throw new Error("Idempotency record was not updated.");
    return { value: await load(tx, ref), replayed: false };
  });
}
