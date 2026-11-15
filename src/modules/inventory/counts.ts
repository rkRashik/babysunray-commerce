import "server-only";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Db } from "@/db/database";
import { inventoryBalances, products, quarantineItems, stockCountLines, stockCounts, stockMovements, variants } from "@/db/schema";
import { type Actor, validateActor } from "../actor";
import { normalizeSku, validateId } from "../catalogue/rules";
import { DomainError, invalidInput } from "../domain-error";
import { adjustStock } from "./service";
import { MAX_STOCK_QUANTITY, validateReason } from "./rules";

// Physical stock counts (requirement I-8). A count is a snapshot, not a lock on the shop: orders, dispatches,
// receipts and adjustments go on while the Owner counts. The rules that keep it correct:
//
// 1. Counting convention: count the sellable units physically in the shop, including units reserved for orders
//    that have not been dispatched yet. Goods awaiting inspection (returns, RTO) are held apart and not counted;
//    a count never changes them, so they can never become sellable through a count.
// 2. When a counted quantity is entered, the SKU's on-hand balance and latest ledger row id are recorded with it
//    (its basis). The correction is counted - basis on-hand.
// 3. Applying locks every counted SKU's balance row. A SKU with a ledger row newer than its basis moved after it
//    was counted (dispatch, receipt, adjustment, restock): its count is stale and the whole apply is refused
//    until the Owner recounts it. A stale count is never applied as counted - old snapshot.
// 4. The correction may not take on-hand below the units reserved for orders (refused, never clipped).
// 5. Every non-zero correction is one `adjustment` ledger row with the Owner's reason and the verified actor;
//    all SKUs are corrected in one transaction or none is. A count is applied or discarded once.
// No count frequency and no automatic write-off rule exists: both are business decisions.

export type StockCount = typeof stockCounts.$inferSelect;
export const MAX_COUNT_LINES = 2000; // technical bound for one count, not a business rule
export const formatCountNumber = (n: number) => `COUNT-${String(n).padStart(6, "0")}`;

function userId(actor: Actor): string {
  const verified = validateActor(actor);
  if (verified.type !== "user") throw invalidInput("actor", "must be a signed-in user");
  return verified.ref;
}

/** SKUs typed by the Owner (one per line, or separated by commas or spaces), canonical and unique. */
export function parseSkuList(raw: string): string[] {
  const skus = [...new Set(raw.split(/[\s,;]+/).filter(Boolean).map((s) => normalizeSku(s)))];
  if (skus.length === 0) throw invalidInput("skus", "must list at least one SKU");
  if (skus.length > MAX_COUNT_LINES) throw invalidInput("skus", `must list at most ${MAX_COUNT_LINES} SKUs`);
  return skus;
}

/** Starts a draft count of every SKU, or of the listed ones, with their balances now as the snapshot. */
export async function startStockCount(tx: Db, input: { scope: "all" | "selected"; skus?: string[] }, actor: Actor): Promise<StockCount> {
  const createdBy = userId(actor);
  if (input.scope !== "all" && input.scope !== "selected") throw invalidInput("scope", "must be all or selected");
  const where = input.scope === "selected" ? inArray(variants.sku, parseSkuList((input.skus ?? []).join("\n"))) : undefined;
  const found = await tx
    .select({ variantId: variants.id, sku: variants.sku, onHand: inventoryBalances.onHand, reserved: inventoryBalances.reserved })
    .from(variants)
    .innerJoin(inventoryBalances, eq(inventoryBalances.variantId, variants.id))
    .where(where)
    .orderBy(asc(variants.sku));
  if (input.scope === "selected") {
    const known = new Set(found.map((f) => f.sku));
    const missing = (input.skus ?? []).map((s) => normalizeSku(s)).filter((s) => !known.has(s));
    if (missing.length) throw new DomainError("VARIANT_NOT_FOUND", `No variant has the SKU ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " and others" : ""}.`);
  }
  if (found.length === 0) throw invalidInput("skus", "matched no SKU");
  if (found.length > MAX_COUNT_LINES) throw invalidInput("skus", `match more than ${MAX_COUNT_LINES} SKUs; count a smaller selection`);
  const [count] = await tx.insert(stockCounts).values({ status: "draft", scope: input.scope, createdByUserId: createdBy }).returning();
  await tx.insert(stockCountLines).values(found.map((f) => ({ countId: count.id, variantId: f.variantId, snapshotOnHand: f.onHand, snapshotReserved: f.reserved })));
  return count;
}

async function lockDraft(tx: Db, countId: string, expectedVersion: number): Promise<StockCount> {
  const id = validateId(countId, "countId");
  const [count] = await tx.select().from(stockCounts).where(eq(stockCounts.id, id)).for("update");
  if (!count) throw new DomainError("STOCK_COUNT_NOT_FOUND", "Stock count not found.");
  if (count.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT", "This count was changed after you loaded it. Reload it and check the entries.");
  if (count.status !== "draft") throw new DomainError("INVALID_TRANSITION", `This count is already ${count.status}; it cannot be changed.`);
  return count;
}

const bump = (tx: Db, countId: string, set: PgUpdateSetSource<typeof stockCounts> = {}) =>
  tx.update(stockCounts).set({ ...set, version: sql`${stockCounts.version} + 1`, updatedAt: sql`now()` }).where(eq(stockCounts.id, countId)).returning();

export type CountEntry = { variantId: string; counted: number | null; recounted?: boolean };

/**
 * Saves counted quantities of a draft. A line is changed only when its value changes, or when the Owner marks
 * it as recounted: re-saving the same number never silently refreshes a stale line's basis. Blank clears it.
 */
export async function recordCounts(tx: Db, countId: string, expectedVersion: number, entries: CountEntry[], actor: Actor): Promise<StockCount> {
  userId(actor);
  const count = await lockDraft(tx, countId, expectedVersion);
  const lines = new Map((await tx.select().from(stockCountLines).where(eq(stockCountLines.countId, count.id))).map((l) => [l.variantId, l]));
  for (const entry of entries) {
    const line = lines.get(entry.variantId);
    if (!line) throw invalidInput("variantId", "is not part of this count");
    if (entry.counted !== null && (!Number.isSafeInteger(entry.counted) || entry.counted < 0 || entry.counted > MAX_STOCK_QUANTITY)) {
      throw invalidInput("counted", "must be a whole number of units, 0 or more");
    }
    const key = and(eq(stockCountLines.countId, count.id), eq(stockCountLines.variantId, entry.variantId));
    if (entry.counted === null) {
      if (line.counted !== null) await tx.update(stockCountLines).set({ counted: null, countedAt: null, basisOnHand: null, basisMovementId: null }).where(key);
      continue;
    }
    if (entry.counted === line.counted && !entry.recounted) continue;
    // One statement, one snapshot: the balance and the latest ledger row describe the same moment.
    await tx.execute(sql`
      update stock_count_lines l
         set counted = ${entry.counted}, counted_at = now(), basis_on_hand = b.on_hand,
             basis_movement_id = coalesce((select max(m.id) from stock_movements m where m.variant_id = l.variant_id), 0)
        from inventory_balances b
       where b.variant_id = l.variant_id and l.count_id = ${count.id} and l.variant_id = ${entry.variantId}`);
  }
  const [updated] = await bump(tx, count.id);
  return updated;
}

/** Discards a draft: nothing in stock changes. */
export async function discardStockCount(tx: Db, countId: string, expectedVersion: number, actor: Actor): Promise<StockCount> {
  const by = userId(actor);
  const count = await lockDraft(tx, countId, expectedVersion);
  const [updated] = await bump(tx, count.id, { status: "discarded", closedAt: sql`now()`, closedByUserId: by });
  return updated;
}

/**
 * Applies a draft (rules 3 to 5 above): all counted lines are corrected in this transaction, or nothing is.
 * Lines left blank are not part of the correction. A reason is required when any line differs.
 */
export async function applyStockCount(tx: Db, countId: string, expectedVersion: number, rawReason: string | null, actor: Actor): Promise<StockCount> {
  const by = userId(actor);
  const count = await lockDraft(tx, countId, expectedVersion);
  const counted = await tx
    .select({ line: stockCountLines, sku: variants.sku })
    .from(stockCountLines)
    .innerJoin(variants, eq(variants.id, stockCountLines.variantId))
    .where(and(eq(stockCountLines.countId, count.id), isNotNull(stockCountLines.counted)))
    .orderBy(asc(stockCountLines.variantId));
  if (counted.length === 0) throw invalidInput("counted", "is missing: enter at least one counted quantity before applying");

  // Lock the balances (variant order, as everywhere), then read each SKU's latest ledger row: no movement for
  // these SKUs can commit until this transaction ends, because every movement also updates its balance row.
  const ids = counted.map((c) => c.line.variantId);
  const balances = new Map(
    (
      await tx
        .select({ variantId: inventoryBalances.variantId, onHand: inventoryBalances.onHand, reserved: inventoryBalances.reserved })
        .from(inventoryBalances)
        .where(inArray(inventoryBalances.variantId, ids))
        .orderBy(asc(inventoryBalances.variantId))
        .for("update")
    ).map((b) => [b.variantId, b]),
  );
  const latest = new Map(
    (
      await tx
        .select({ variantId: stockMovements.variantId, id: sql<number>`max(${stockMovements.id})`.mapWith(Number) })
        .from(stockMovements)
        .where(inArray(stockMovements.variantId, ids))
        .groupBy(stockMovements.variantId)
    ).map((m) => [m.variantId, m.id]),
  );

  const stale = counted.filter((c) => (latest.get(c.line.variantId) ?? 0) !== c.line.basisMovementId || balances.get(c.line.variantId)?.onHand !== c.line.basisOnHand);
  if (stale.length) {
    throw new DomainError(
      "VERSION_CONFLICT",
      `Stock of ${stale.map((s) => s.sku).slice(0, 10).join(", ")}${stale.length > 10 ? " and others" : ""} changed after it was counted. Recount ${stale.length > 1 ? "those SKUs" : "it"} and apply again. Nothing was changed.`,
    );
  }
  const changes = counted.map((c) => ({ ...c, delta: (c.line.counted as number) - (c.line.basisOnHand as number) }));
  const belowReserved = changes.filter((c) => (c.line.counted as number) < (balances.get(c.line.variantId)?.reserved ?? 0));
  if (belowReserved.length) {
    const b = belowReserved[0];
    throw new DomainError(
      "INSUFFICIENT_STOCK",
      `${b.sku}: counted ${b.line.counted}, but ${balances.get(b.line.variantId)?.reserved} units are reserved for orders not yet dispatched. Check those orders or recount; nothing was changed.`,
    );
  }
  const differs = changes.some((c) => c.delta !== 0);
  const reason = differs ? validateReason(rawReason, true) : validateReason(rawReason, false);
  if (reason && reason.length > 400) throw invalidInput("reason", "must be at most 400 characters");

  for (const c of changes) {
    let movementId: number | null = null;
    if (c.delta !== 0) {
      const change = await adjustStock(tx, { sku: c.sku, quantityDelta: c.delta, reason: `Stock count ${formatCountNumber(count.number)}: ${reason}`, actor });
      movementId = change.movement.id;
    }
    const applied = await tx
      .update(stockCountLines)
      .set({ appliedDelta: c.delta, movementId })
      .where(and(eq(stockCountLines.countId, count.id), eq(stockCountLines.variantId, c.line.variantId), sql`${stockCountLines.appliedDelta} is null`))
      .returning({ variantId: stockCountLines.variantId });
    if (applied.length !== 1) throw new Error("Stock count line changed while it was applied.");
  }
  const [updated] = await bump(tx, count.id, { status: "applied", reason, closedAt: sql`now()`, closedByUserId: by });
  return updated;
}

export type CountLineView = {
  variantId: string;
  sku: string;
  nameEn: string | null;
  nameBn: string | null;
  size: string | null;
  colour: string | null;
  snapshotOnHand: number;
  snapshotReserved: number;
  counted: number | null;
  countedAt: Date | null;
  basisOnHand: number | null;
  appliedDelta: number | null;
  movementId: number | null;
  onHandNow: number;
  reservedNow: number;
  awaitingInspection: number;
  /** Counted minus the on-hand balance it was counted against (null when not counted). */
  variance: number | null;
  /** Counted, and the SKU moved after the count was entered (draft only). */
  stale: boolean;
};

export type CountDetail = StockCount & { lines: CountLineView[] };

/** A count with every line, the current balances and whether each counted line is still current. */
export async function getStockCount(db: Db, countId: string): Promise<CountDetail> {
  const id = validateId(countId, "countId");
  const [count] = await db.select().from(stockCounts).where(eq(stockCounts.id, id));
  if (!count) throw new DomainError("STOCK_COUNT_NOT_FOUND", "Stock count not found.");
  const rows = await db
    .select({
      line: stockCountLines,
      sku: variants.sku,
      nameEn: products.nameEn,
      nameBn: products.nameBn,
      size: variants.size,
      colour: variants.colour,
      onHandNow: inventoryBalances.onHand,
      reservedNow: inventoryBalances.reserved,
      latestMovementId: sql<number>`coalesce((select max(m.id) from ${stockMovements} m where m.variant_id = ${stockCountLines.variantId}), 0)`.mapWith(Number),
      awaitingInspection: sql<number>`coalesce((select sum(q.quantity) from ${quarantineItems} q where q.variant_id = ${stockCountLines.variantId} and q.status = 'awaiting_inspection'), 0)`.mapWith(Number),
    })
    .from(stockCountLines)
    .innerJoin(variants, eq(variants.id, stockCountLines.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .innerJoin(inventoryBalances, eq(inventoryBalances.variantId, stockCountLines.variantId))
    .where(eq(stockCountLines.countId, id))
    .orderBy(asc(variants.sku));
  return {
    ...count,
    lines: rows.map((r) => ({
      variantId: r.line.variantId,
      sku: r.sku,
      nameEn: r.nameEn,
      nameBn: r.nameBn,
      size: r.size,
      colour: r.colour,
      snapshotOnHand: r.line.snapshotOnHand,
      snapshotReserved: r.line.snapshotReserved,
      counted: r.line.counted,
      countedAt: r.line.countedAt,
      basisOnHand: r.line.basisOnHand,
      appliedDelta: r.line.appliedDelta,
      movementId: r.line.movementId,
      onHandNow: r.onHandNow,
      reservedNow: r.reservedNow,
      awaitingInspection: r.awaitingInspection,
      variance: r.line.counted === null ? null : r.line.counted - (r.line.basisOnHand as number),
      stale: count.status === "draft" && r.line.counted !== null && (r.latestMovementId !== r.line.basisMovementId || r.onHandNow !== r.line.basisOnHand),
    })),
  };
}

export type CountSummary = StockCount & { lines: number; countedLines: number; differingLines: number; netDelta: number };

/** The latest counts, newest first, with line totals (applied counts: what was corrected). */
export async function listStockCounts(db: Db, limit = 50): Promise<CountSummary[]> {
  const rows = await db
    .select({
      count: stockCounts,
      lines: sql<number>`count(${stockCountLines.variantId})`.mapWith(Number),
      countedLines: sql<number>`count(${stockCountLines.counted})`.mapWith(Number),
      differingLines: sql<number>`count(*) filter (where ${stockCountLines.counted} is not null and ${stockCountLines.counted} <> ${stockCountLines.basisOnHand})`.mapWith(Number),
      netDelta: sql<number>`coalesce(sum(${stockCountLines.appliedDelta}), 0)`.mapWith(Number),
    })
    .from(stockCounts)
    .leftJoin(stockCountLines, eq(stockCountLines.countId, stockCounts.id))
    .groupBy(stockCounts.id)
    .orderBy(desc(stockCounts.createdAt), desc(stockCounts.id))
    .limit(limit);
  return rows.map((r) => ({ ...r.count, lines: r.lines, countedLines: r.countedLines, differingLines: r.differingLines, netDelta: r.netDelta }));
}
