import "server-only";
import { and, asc, eq, ne, type SQL, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { Db } from "@/db/database";
import { deliveryZones, inventoryBalances, orders, products, quarantineItems, returns, variants } from "@/db/schema";
import { invalidInput } from "../domain-error";
import { ORDER_QUEUES, type OrderQueue, queueCondition } from "../orders/queries";
import { DELIVERY_ZONES, type DeliveryZone } from "../orders/rules";

// The Owner's daily dashboard (requirement OF-2): counts and the oldest items of each work queue, from the
// database as it is now. No targets, KPIs or derived "sales": a pending order is not a sale and a delivered
// order is not money received. Every figure is read in one read-only REPEATABLE READ transaction, so the
// numbers on the page all describe the same moment (`generatedAt`, the database clock).

const PREVIEW = 10;
const STOCK_PREVIEW = 25;
/** Upper bound for the Owner-chosen "low stock" threshold; the threshold itself is the Owner's choice. */
export const MAX_LOW_STOCK_THRESHOLD = 100_000;

export type QueueOrder = Pick<
  typeof orders.$inferSelect,
  "id" | "number" | "createdAt" | "orderStatus" | "fulfilmentStatus" | "paymentStatus" | "totalPaisa" | "codCollectedPaisa" | "codSettledPaisa" | "codDeductedPaisa" | "verificationExpiresAt"
>;
export type QuarantineRow = { id: string; orderId: string; orderNumber: number; sku: string; quantity: number; receivedAt: Date };
export type StockRow = { variantId: string; sku: string; nameEn: string | null; nameBn: string | null; size: string | null; colour: string | null; onHand: number; reserved: number; available: number };

export type Dashboard = {
  generatedAt: Date;
  queues: { queue: OrderQueue; label: string; count: number; oldest: QueueOrder[] }[];
  quarantine: Record<"return" | "rto", { count: number; units: number; oldest: QuarantineRow[] }>;
  returns: { awaitingParcel: number; awaitingDecision: number; approvedOpen: number };
  stock: { zeroAvailable: { count: number; items: StockRow[] }; low: { threshold: number; count: number; items: StockRow[] } | null };
  unconfiguredZones: DeliveryZone[];
};

/** A whole number from 1 to MAX_LOW_STOCK_THRESHOLD, or null when the Owner left it empty. */
export function parseLowStockThreshold(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  if (!/^[0-9]{1,6}$/.test(raw.trim()) || Number(raw) < 1 || Number(raw) > MAX_LOW_STOCK_THRESHOLD) {
    throw invalidInput("threshold", `must be a whole number from 1 to ${MAX_LOW_STOCK_THRESHOLD}`);
  }
  return Number(raw);
}

const QUEUE_COLUMNS = {
  id: orders.id,
  number: orders.number,
  createdAt: orders.createdAt,
  orderStatus: orders.orderStatus,
  fulfilmentStatus: orders.fulfilmentStatus,
  paymentStatus: orders.paymentStatus,
  totalPaisa: orders.totalPaisa,
  codCollectedPaisa: orders.codCollectedPaisa,
  codSettledPaisa: orders.codSettledPaisa,
  codDeductedPaisa: orders.codDeductedPaisa,
  verificationExpiresAt: orders.verificationExpiresAt,
};

// Sellable catalogue only: active variants of products that are not archived.
const available = sql<number>`${inventoryBalances.onHand} - ${inventoryBalances.reserved}`.mapWith(Number);
const sellable = and(eq(variants.status, "active"), ne(products.status, "archived"));

/** The first rows of a stock list and its full count, in one query (the window count is taken before the limit). */
async function stockList(tx: Db, maxAvailable: number) {
  const rows = await tx
    .select({
      variantId: variants.id,
      sku: variants.sku,
      nameEn: products.nameEn,
      nameBn: products.nameBn,
      size: variants.size,
      colour: variants.colour,
      onHand: inventoryBalances.onHand,
      reserved: inventoryBalances.reserved,
      available,
      total: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .innerJoin(inventoryBalances, eq(inventoryBalances.variantId, variants.id))
    .where(and(sellable, sql`${inventoryBalances.onHand} - ${inventoryBalances.reserved} <= ${maxAvailable}`))
    .orderBy(asc(available), asc(variants.sku))
    .limit(STOCK_PREVIEW);
  return { count: rows[0]?.total ?? 0, items: rows.map((r) => ({ variantId: r.variantId, sku: r.sku, nameEn: r.nameEn, nameBn: r.nameBn, size: r.size, colour: r.colour, onHand: r.onHand, reserved: r.reserved, available: r.available })) };
}

/** Runs one or more bounded selects as a single UNION ALL statement: one round trip whatever their number. */
// The selects all have the same columns; the casts only bridge drizzle's set-operator generics.
async function together<T>(selects: Promise<T[]>[]): Promise<T[]> {
  if (selects.length === 0) return [];
  if (selects.length === 1) return selects[0];
  const [a, b, ...rest] = selects;
  return unionAll(a as never, b as never, ...(rest as never[])) as unknown as Promise<T[]>;
}

const quarantineOldest = (tx: Db, source: "return" | "rto") =>
  tx
    .select({
      source: sql<"return" | "rto">`${source}::text`.as("source"),
      id: quarantineItems.id,
      orderId: quarantineItems.orderId,
      orderNumber: orders.number,
      sku: variants.sku,
      quantity: quarantineItems.quantity,
      receivedAt: quarantineItems.receivedAt,
    })
    .from(quarantineItems)
    .innerJoin(orders, eq(orders.id, quarantineItems.orderId))
    .innerJoin(variants, eq(variants.id, quarantineItems.variantId))
    .where(and(eq(quarantineItems.status, "awaiting_inspection"), eq(quarantineItems.source, source)))
    .orderBy(asc(quarantineItems.receivedAt), asc(quarantineItems.id))
    .limit(PREVIEW);

/**
 * Three to five statements whatever the number of queues: every count in one, the previews of the non-empty queues in
 * one UNION ALL, the quarantine previews in one, and each stock list with its count. Each round trip to a hosted
 * database costs tens of milliseconds, so the page's wait is the number of statements, not their size.
 */
export async function getDashboard(db: Db, options: { lowStockThreshold?: number | null } = {}): Promise<Dashboard> {
  const threshold = options.lowStockThreshold ?? null;
  return db.transaction(
    async (tx) => {
      const queueNames = Object.keys(ORDER_QUEUES) as OrderQueue[];
      const waiting = (source: "return" | "rto", value: SQL) =>
        sql`(select ${value} from ${quarantineItems} where ${quarantineItems.status} = 'awaiting_inspection' and ${quarantineItems.source} = ${source})`;
      const returnCount = (status: string) => sql`(select count(*) from ${returns} where ${returns.status} = ${status})`;
      const counted = await tx.execute<Record<string, string | null>>(
        sql`select now() as generated_at,
          ${sql.join(
            queueNames.map((q) => sql`count(*) filter (where ${queueCondition(q)}) as ${sql.identifier(q)}`),
            sql`, `,
          )},
          ${returnCount("requested")} as ret_requested, ${returnCount("received")} as ret_received, ${returnCount("approved")} as ret_approved,
          ${waiting("return", sql`count(*)`)} as q_return_count, ${waiting("return", sql`coalesce(sum(${quarantineItems.quantity}), 0)`)} as q_return_units,
          ${waiting("rto", sql`count(*)`)} as q_rto_count, ${waiting("rto", sql`coalesce(sum(${quarantineItems.quantity}), 0)`)} as q_rto_units,
          (select string_agg(${deliveryZones.code}, ',') from ${deliveryZones} where ${deliveryZones.active}) as active_zones
        from ${orders}`,
      );
      const row = counted.rows[0];
      const count = (key: string) => Number(row[key] ?? 0);
      const busy = queueNames.filter((q) => count(q) > 0);
      const previews = await together(
        busy.map((q) =>
          tx
            .select({ queue: sql<OrderQueue>`${q}::text`.as("queue"), ...QUEUE_COLUMNS })
            .from(orders)
            .where(queueCondition(q))
            .orderBy(asc(orders.createdAt), asc(orders.id))
            .limit(PREVIEW),
        ),
      );
      const sources = (["return", "rto"] as const).filter((s) => count(`q_${s}_count`) > 0);
      const held = await together(sources.map((s) => quarantineOldest(tx, s)));
      const quarantine = (source: "return" | "rto") => ({
        count: count(`q_${source}_count`),
        units: count(`q_${source}_units`),
        oldest: held.filter((h) => h.source === source).map((h) => ({ id: h.id, orderId: h.orderId, orderNumber: h.orderNumber, sku: h.sku, quantity: h.quantity, receivedAt: h.receivedAt })),
      });
      const active = new Set((row.active_zones ?? "").split(",").filter(Boolean));
      return {
        generatedAt: new Date(row.generated_at as string),
        queues: queueNames.map((queue) => ({
          queue,
          label: ORDER_QUEUES[queue],
          count: count(queue),
          oldest: previews.filter((p) => p.queue === queue).map((p) => Object.fromEntries(Object.keys(QUEUE_COLUMNS).map((k) => [k, p[k as keyof typeof QUEUE_COLUMNS]])) as QueueOrder),
        })),
        quarantine: { return: quarantine("return"), rto: quarantine("rto") },
        returns: { awaitingParcel: count("ret_requested"), awaitingDecision: count("ret_received"), approvedOpen: count("ret_approved") },
        stock: {
          zeroAvailable: await stockList(tx, 0),
          low: threshold === null ? null : { threshold, ...(await stockList(tx, threshold)) },
        },
        unconfiguredZones: DELIVERY_ZONES.filter((z) => !active.has(z)),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
