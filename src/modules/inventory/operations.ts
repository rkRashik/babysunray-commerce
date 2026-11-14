import "server-only";
import type { Db } from "@/db/database";
import { actorFor, assertPermission, type Principal } from "../auth/principal";
import { normalizeSku } from "../catalogue/rules";
import { type Once, runOnce } from "../idempotency/service";
import { adjustStock, getStockMovement, receiveStock, type StockMovement } from "./service";

// Stock operations for every client (the /api/v1 routes and the Owner Office). Each checks the permission
// first, records the verified user as the actor, and runs once per idempotency key (src/modules/idempotency).

export type StockOperationResult = { sku: string; variantId: string; onHand: number; movement: StockMovement };
type StockRef = { movementId: number; onHand: number };

// The on-hand value is the one this operation produced, so a replay answers exactly as the first response did.
async function loadStockResult(db: Db, ref: StockRef): Promise<StockOperationResult> {
  const { sku, movement } = await getStockMovement(db, ref.movementId);
  return { sku, variantId: movement.variantId, onHand: ref.onHand, movement };
}

export async function receiveStockOnce(
  db: Db,
  principal: Principal,
  idempotencyKey: string,
  input: { sku: string; quantity: number; reason?: string | null },
): Promise<Once<StockOperationResult>> {
  const user = assertPermission(principal, "stock:receive");
  const request = { sku: normalizeSku(input.sku), quantity: input.quantity, reason: input.reason ?? null };
  return runOnce(
    db,
    { userId: user.userId, operation: "stock.receive", key: idempotencyKey, request },
    async (tx) => {
      const change = await receiveStock(tx, { ...request, actor: actorFor(user) });
      return { movementId: change.movement.id, onHand: change.onHand };
    },
    loadStockResult,
  );
}

export async function adjustStockOnce(
  db: Db,
  principal: Principal,
  idempotencyKey: string,
  input: { sku: string; quantityDelta: number; reason: string },
): Promise<Once<StockOperationResult>> {
  const user = assertPermission(principal, "stock:adjust");
  const request = { sku: normalizeSku(input.sku), quantityDelta: input.quantityDelta, reason: input.reason };
  return runOnce(
    db,
    { userId: user.userId, operation: "stock.adjust", key: idempotencyKey, request },
    async (tx) => {
      const change = await adjustStock(tx, { ...request, actor: actorFor(user) });
      return { movementId: change.movement.id, onHand: change.onHand };
    },
    loadStockResult,
  );
}
