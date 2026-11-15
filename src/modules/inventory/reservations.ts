import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import { inventoryBalances, stockMovements, stockReservations, variants } from "@/db/schema";
import { type Actor, validateActor } from "../actor";
import { DomainError } from "../domain-error";
import type { StockMovement } from "./service";

// Order stock holds (founder rules A, D, L, G; docs/product/order-policy-decisions.md). A reservation is not a
// physical movement: it only changes inventory_balances.reserved, together with a stock_reservations row, in
// the caller's transaction. Physical changes (dispatch, restock) also write the append-only ledger.
//
// Locking order, everywhere: the order row first (callers), then balance rows in variant_id order (here). Two
// transactions therefore never wait on each other in a cycle.

export type ReservationLine = { variantId: string; quantity: number };

async function lockBalances(tx: Db, variantIds: string[]) {
  const ids = [...new Set(variantIds)].sort();
  const rows = await tx
    .select({ variantId: inventoryBalances.variantId, onHand: inventoryBalances.onHand, reserved: inventoryBalances.reserved, sku: variants.sku })
    .from(inventoryBalances)
    .innerJoin(variants, eq(variants.id, inventoryBalances.variantId))
    .where(inArray(inventoryBalances.variantId, ids))
    .orderBy(asc(inventoryBalances.variantId))
    .for("update", { of: inventoryBalances });
  if (rows.length !== ids.length) throw new Error("Inventory balance row is missing for a reserved variant.");
  return new Map(rows.map((r) => [r.variantId, r]));
}

/** Holds every line or none: throws INSUFFICIENT_STOCK (and the caller's transaction rolls back) if any is short. */
export async function reserveStock(tx: Db, orderId: string, lines: ReservationLine[]): Promise<void> {
  const balances = await lockBalances(tx, lines.map((l) => l.variantId));
  for (const line of lines) {
    const b = balances.get(line.variantId)!;
    const available = b.onHand - b.reserved;
    if (available < line.quantity) {
      throw new DomainError("INSUFFICIENT_STOCK", `Not enough stock for ${b.sku}: ${Math.max(available, 0)} available, ${line.quantity} needed.`);
    }
  }
  for (const line of lines) {
    const updated = await tx
      .update(inventoryBalances)
      .set({ reserved: sql`${inventoryBalances.reserved} + ${line.quantity}`, updatedAt: sql`now()` })
      .where(and(eq(inventoryBalances.variantId, line.variantId), sql`${inventoryBalances.onHand} - ${inventoryBalances.reserved} >= ${line.quantity}`))
      .returning({ variantId: inventoryBalances.variantId });
    if (updated.length !== 1) throw new DomainError("INSUFFICIENT_STOCK", "Not enough stock for this order.");
  }
  await tx.insert(stockReservations).values(lines.map((l) => ({ orderId, variantId: l.variantId, quantity: l.quantity, status: "active" as const })));
}

async function activeReservations(tx: Db, orderId: string) {
  return tx
    .select()
    .from(stockReservations)
    .where(and(eq(stockReservations.orderId, orderId), eq(stockReservations.status, "active")))
    .orderBy(asc(stockReservations.variantId));
}

/** Ends every active hold of the order once; returns how many units were released (0 if none was active). */
export async function releaseReservations(tx: Db, orderId: string, reason: "cancelled" | "expired"): Promise<number> {
  const active = await activeReservations(tx, orderId);
  if (active.length === 0) return 0;
  await lockBalances(tx, active.map((r) => r.variantId));
  let units = 0;
  for (const r of active) {
    const ended = await tx
      .update(stockReservations)
      .set({ status: "released", releaseReason: reason, endedAt: sql`now()` })
      .where(and(eq(stockReservations.id, r.id), eq(stockReservations.status, "active")))
      .returning({ id: stockReservations.id });
    if (ended.length !== 1) throw new Error("Reservation changed while it was being released.");
    const updated = await tx
      .update(inventoryBalances)
      .set({ reserved: sql`${inventoryBalances.reserved} - ${r.quantity}`, updatedAt: sql`now()` })
      .where(and(eq(inventoryBalances.variantId, r.variantId), sql`${inventoryBalances.reserved} >= ${r.quantity}`))
      .returning({ variantId: inventoryBalances.variantId });
    if (updated.length !== 1) throw new Error("Reserved stock is lower than an active reservation.");
    units += r.quantity;
  }
  return units;
}

/**
 * Dispatch (founder rule L): the order's active holds must cover exactly `lines` (no partial fulfilment).
 * Each line lowers on_hand and reserved together and writes one `dispatch` ledger row; the holds become
 * consumed. Called once per order: the caller's status check refuses a second dispatch.
 */
export async function consumeReservationsForDispatch(tx: Db, orderId: string, lines: ReservationLine[], actor: Actor): Promise<StockMovement[]> {
  const verified = validateActor(actor);
  const active = await activeReservations(tx, orderId);
  const byVariant = new Map(active.map((r) => [r.variantId, r]));
  if (active.length !== lines.length || lines.some((l) => byVariant.get(l.variantId)?.quantity !== l.quantity)) {
    throw new DomainError("INSUFFICIENT_STOCK", "This order's stock is not fully reserved, so it cannot be dispatched.");
  }
  await lockBalances(tx, lines.map((l) => l.variantId));
  const movements: StockMovement[] = [];
  for (const line of [...lines].sort((a, b) => (a.variantId < b.variantId ? -1 : 1))) {
    const r = byVariant.get(line.variantId)!;
    await tx.update(stockReservations).set({ status: "consumed", endedAt: sql`now()` }).where(eq(stockReservations.id, r.id));
    const updated = await tx
      .update(inventoryBalances)
      .set({
        onHand: sql`${inventoryBalances.onHand} - ${line.quantity}`,
        reserved: sql`${inventoryBalances.reserved} - ${line.quantity}`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(inventoryBalances.variantId, line.variantId), sql`${inventoryBalances.reserved} >= ${line.quantity}`))
      .returning({ variantId: inventoryBalances.variantId });
    if (updated.length !== 1) throw new Error("Reserved stock is lower than the dispatched quantity.");
    const [movement] = await tx
      .insert(stockMovements)
      .values({
        variantId: line.variantId,
        movementType: "dispatch",
        quantityDelta: -line.quantity,
        orderId,
        actorType: verified.type,
        actorRef: verified.ref,
        actorUserId: verified.type === "user" ? verified.ref : null,
      })
      .returning();
    movements.push(movement);
  }
  return movements;
}

/** A unit that passed return or RTO inspection becomes sellable again: one `return_restock` ledger row. */
export async function restockInspected(tx: Db, input: { orderId: string; variantId: string; quantity: number; actor: Actor }): Promise<StockMovement> {
  const actor = validateActor(input.actor);
  await lockBalances(tx, [input.variantId]);
  await tx
    .update(inventoryBalances)
    .set({ onHand: sql`${inventoryBalances.onHand} + ${input.quantity}`, updatedAt: sql`now()` })
    .where(eq(inventoryBalances.variantId, input.variantId));
  const [movement] = await tx
    .insert(stockMovements)
    .values({
      variantId: input.variantId,
      movementType: "return_restock",
      quantityDelta: input.quantity,
      reason: "Passed inspection",
      orderId: input.orderId,
      actorType: actor.type,
      actorRef: actor.ref,
      actorUserId: actor.type === "user" ? actor.ref : null,
    })
    .returning();
  return movement;
}
