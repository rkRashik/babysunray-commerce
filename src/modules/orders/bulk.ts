import "server-only";
import { inArray } from "drizzle-orm";
import type { Db } from "@/db/database";
import { orders } from "@/db/schema";
import { assertPermission, type Principal } from "../auth/principal";
import { DomainError, invalidInput } from "../domain-error";
import { validateId } from "../catalogue/rules";
import { deliverOrderOnce, dispatchOrderOnce, packOrderOnce } from "./operations";

// Bulk order steps for the Owner's list: the same single-order operations, one order at a time, each in its own
// transaction with its own idempotency key and the version the Owner saw. One order failing (a stale version, not
// enough stock, a step that is no longer allowed) never stops or undoes the others, and nothing is "undone" in bulk:
// every result is reported per order. Only the steps that are routine and one-way-safe are allowed in bulk (never
// confirming, cancelling, money or returns, which need a decision about one order).

export const BULK_ACTIONS = {
  pack: { run: packOrderOnce, done: "Packed." },
  dispatch: { run: dispatchOrderOnce, done: "Dispatched. Its stock was deducted." },
  deliver: { run: deliverOrderOnce, done: "Marked delivered." },
} as const;
export type BulkAction = keyof typeof BULK_ACTIONS;
export const isBulkAction = (value: unknown): value is BulkAction => typeof value === "string" && Object.hasOwn(BULK_ACTIONS, value);

/** Technical bound on one batch (one page of the list is 25). */
export const MAX_BULK_ORDERS = 50;

export type BulkItem = { orderId: string; expectedVersion: number };
export type BulkResult = { orderId: string; number: number | null; ok: boolean; message: string };

/**
 * Runs `action` on each order. `batchKey` (a fresh id per submitted form) makes a resubmission of the same batch a replay,
 * not a second change. Throws only for a request that is wrong as a whole (no permission, an unknown action, too many or
 * duplicate orders); an order that cannot take the step comes back as a failed result.
 */
export async function bulkTransition(db: Db, principal: Principal, batchKey: string, action: BulkAction, items: BulkItem[]): Promise<BulkResult[]> {
  assertPermission(principal, "orders:write");
  if (!isBulkAction(action)) throw invalidInput("action", "is not available in bulk");
  if (items.length === 0) throw invalidInput("orders", "select at least one order");
  if (items.length > MAX_BULK_ORDERS) throw invalidInput("orders", `at most ${MAX_BULK_ORDERS} at a time`);
  const ids = items.map((i) => validateId(i.orderId, "orderId"));
  if (new Set(ids).size !== ids.length) throw invalidInput("orders", "an order appears twice");
  if (!/^[A-Za-z0-9_.:-]{8,64}$/.test(batchKey)) throw invalidInput("batch", "is not valid");

  const numbers = new Map((await db.select({ id: orders.id, number: orders.number }).from(orders).where(inArray(orders.id, ids))).map((r) => [r.id, r.number]));
  const results: BulkResult[] = [];
  for (const item of items) {
    const number = numbers.get(item.orderId) ?? null;
    try {
      const { value } = await BULK_ACTIONS[action].run(db, principal, `bulk:${batchKey}:${item.orderId}`, { orderId: item.orderId, expectedVersion: item.expectedVersion });
      results.push({ orderId: item.orderId, number: value.number, ok: true, message: BULK_ACTIONS[action].done });
    } catch (error) {
      if (error instanceof DomainError) results.push({ orderId: item.orderId, number, ok: false, message: error.message });
      else {
        console.error("A bulk order step failed unexpectedly.", action, (error as { code?: string })?.code ?? "");
        results.push({ orderId: item.orderId, number, ok: false, message: "This order could not be updated. Check it, then try again." });
      }
    }
  }
  return results;
}
