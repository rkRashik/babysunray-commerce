import "server-only";
import type { Db } from "@/db/database";
import { actorFor, assertPermission, type Principal } from "../auth/principal";
import { normalizeSku } from "../catalogue/rules";
import { type Once, runOnce } from "../idempotency/service";
import { releaseOverdue } from "../orders/operations";
import { applyStockCount, type CountDetail, type CountEntry, discardStockCount, getStockCount, parseSkuList, recordCounts, startStockCount } from "./counts";
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
  // Holds of orders past their verification deadline are released first, so they never block a correction.
  await releaseOverdue(db);
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

// Physical stock counts (src/modules/inventory/counts.ts). Every step is an idempotent operation with the
// verified user as the actor; applying also releases overdue reservations first, like an adjustment.
const loadCount = (db: Db, ref: { countId: string }) => getStockCount(db, ref.countId);

export async function startStockCountOnce(db: Db, principal: Principal, key: string, input: { scope: "all" | "selected"; skus?: string[] }): Promise<Once<CountDetail>> {
  const user = assertPermission(principal, "stock:adjust");
  const request = { scope: input.scope, skus: input.scope === "selected" ? parseSkuList((input.skus ?? []).join("\n")) : [] };
  return runOnce(
    db,
    { userId: user.userId, operation: "stock.count.start", key, request },
    async (tx) => ({ countId: (await startStockCount(tx, request, actorFor(user))).id }),
    loadCount,
  );
}

export async function recordCountsOnce(db: Db, principal: Principal, key: string, input: { countId: string; expectedVersion: number; entries: CountEntry[] }): Promise<Once<CountDetail>> {
  const user = assertPermission(principal, "stock:adjust");
  const request = { countId: input.countId, expectedVersion: input.expectedVersion, entries: input.entries.map((e) => ({ variantId: e.variantId, counted: e.counted, recounted: Boolean(e.recounted) })) };
  return runOnce(
    db,
    { userId: user.userId, operation: "stock.count.record", key, request },
    async (tx) => ({ countId: (await recordCounts(tx, request.countId, request.expectedVersion, request.entries, actorFor(user))).id }),
    loadCount,
  );
}

export async function applyStockCountOnce(db: Db, principal: Principal, key: string, input: { countId: string; expectedVersion: number; reason: string | null }): Promise<Once<CountDetail>> {
  const user = assertPermission(principal, "stock:adjust");
  await releaseOverdue(db);
  const request = { countId: input.countId, expectedVersion: input.expectedVersion, reason: input.reason };
  return runOnce(
    db,
    { userId: user.userId, operation: "stock.count.apply", key, request },
    async (tx) => ({ countId: (await applyStockCount(tx, request.countId, request.expectedVersion, request.reason, actorFor(user))).id }),
    loadCount,
  );
}

export async function discardStockCountOnce(db: Db, principal: Principal, key: string, input: { countId: string; expectedVersion: number }): Promise<Once<CountDetail>> {
  const user = assertPermission(principal, "stock:adjust");
  const request = { countId: input.countId, expectedVersion: input.expectedVersion };
  return runOnce(
    db,
    { userId: user.userId, operation: "stock.count.discard", key, request },
    async (tx) => ({ countId: (await discardStockCount(tx, request.countId, request.expectedVersion, actorFor(user))).id }),
    loadCount,
  );
}
