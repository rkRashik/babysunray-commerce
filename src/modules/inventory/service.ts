import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { type Db, PG_NUMERIC_OUT_OF_RANGE, pgErrorCode } from "@/db/database";
import { inventoryBalances, stockMovements, variants } from "@/db/schema";
import { type Actor, validateActor } from "../actor";
import { normalizeSku } from "../catalogue/rules";
import { DomainError } from "../domain-error";
import { validateAdjustmentDelta, validateReason, validateReceiptQuantity } from "./rules";

export type StockMovement = typeof stockMovements.$inferSelect;
export type StockChange = { onHand: number; movement: StockMovement };

export type StockReceipt = { sku: string; quantity: number; reason?: string | null; actor: Actor };
export type StockAdjustment = { sku: string; quantityDelta: number; reason: string; actor: Actor };

/** Adds received units to a SKU's on-hand stock and records the receipt. */
export async function receiveStock(db: Db, input: StockReceipt): Promise<StockChange> {
  return recordMovement(db, {
    sku: normalizeSku(input.sku),
    movementType: "receipt",
    quantityDelta: validateReceiptQuantity(input.quantity),
    reason: validateReason(input.reason, false),
    actor: validateActor(input.actor),
  });
}

/** Corrects a SKU's on-hand stock up or down with a required reason. Never takes stock below zero. */
export async function adjustStock(db: Db, input: StockAdjustment): Promise<StockChange> {
  return recordMovement(db, {
    sku: normalizeSku(input.sku),
    movementType: "adjustment",
    quantityDelta: validateAdjustmentDelta(input.quantityDelta),
    reason: validateReason(input.reason, true),
    actor: validateActor(input.actor),
  });
}

type Movement = {
  sku: string;
  movementType: StockMovement["movementType"];
  quantityDelta: number;
  reason: string | null;
  actor: Actor;
};

// The only write path for stock: the balance change and its ledger row commit together or not at all.
async function recordMovement(db: Db, m: Movement): Promise<StockChange> {
  try {
    return await db.transaction(async (tx) => {
      const variantId = await findVariantId(tx, m.sku);

      // Conditional atomic update. A concurrent change to the same row waits for the row lock, then
      // PostgreSQL re-checks the condition against the committed balance (READ COMMITTED).
      const [balance] = await tx
        .update(inventoryBalances)
        .set({ onHand: sql`${inventoryBalances.onHand} + ${m.quantityDelta}`, updatedAt: sql`now()` })
        .where(
          and(
            eq(inventoryBalances.variantId, variantId),
            sql`${inventoryBalances.onHand} + ${m.quantityDelta} >= 0`,
          ),
        )
        .returning({ onHand: inventoryBalances.onHand });
      // Every variant gets a balance row at creation, so a failed increase means that invariant broke.
      if (!balance && m.quantityDelta > 0) throw new Error("Inventory balance row is missing for this variant.");
      if (!balance) throw new DomainError("INSUFFICIENT_STOCK", "Not enough stock on hand for this change.");

      const [movement] = await tx
        .insert(stockMovements)
        .values({
          variantId,
          movementType: m.movementType,
          quantityDelta: m.quantityDelta,
          reason: m.reason,
          actorType: m.actor.type,
          actorRef: m.actor.ref,
        })
        .returning();
      return { onHand: balance.onHand, movement };
    });
  } catch (error) {
    if (pgErrorCode(error) === PG_NUMERIC_OUT_OF_RANGE) {
      throw new DomainError("STOCK_LIMIT_EXCEEDED", "The resulting stock quantity is too large.");
    }
    throw error;
  }
}

/** Current on-hand stock for a SKU. */
export async function getStockLevel(db: Db, rawSku: string): Promise<{ variantId: string; onHand: number }> {
  const [row] = await db
    .select({ variantId: inventoryBalances.variantId, onHand: inventoryBalances.onHand })
    .from(variants)
    .innerJoin(inventoryBalances, eq(inventoryBalances.variantId, variants.id))
    .where(eq(variants.sku, normalizeSku(rawSku)));
  if (!row) throw new DomainError("VARIANT_NOT_FOUND", "No variant has this SKU.");
  return row;
}

/** Stock movements for a SKU, oldest first. */
export async function listStockMovements(db: Db, rawSku: string): Promise<StockMovement[]> {
  const variantId = await findVariantId(db, normalizeSku(rawSku));
  return db.select().from(stockMovements).where(eq(stockMovements.variantId, variantId)).orderBy(asc(stockMovements.id));
}

async function findVariantId(db: Pick<Db, "select">, sku: string): Promise<string> {
  const [variant] = await db.select({ id: variants.id }).from(variants).where(eq(variants.sku, sku));
  if (!variant) throw new DomainError("VARIANT_NOT_FOUND", "No variant has this SKU.");
  return variant.id;
}
