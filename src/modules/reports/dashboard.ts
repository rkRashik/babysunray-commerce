import "server-only";
import { and, asc, eq, ne, sql } from "drizzle-orm";
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
export type StockRow = { variantId: string; sku: string; nameEn: string | null; nameBn: string | null; onHand: number; reserved: number; available: number };

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

async function stockList(tx: Db, maxAvailable: number) {
  const where = and(sellable, sql`${inventoryBalances.onHand} - ${inventoryBalances.reserved} <= ${maxAvailable}`);
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .innerJoin(inventoryBalances, eq(inventoryBalances.variantId, variants.id))
    .where(where);
  const items = await tx
    .select({ variantId: variants.id, sku: variants.sku, nameEn: products.nameEn, nameBn: products.nameBn, onHand: inventoryBalances.onHand, reserved: inventoryBalances.reserved, available })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .innerJoin(inventoryBalances, eq(inventoryBalances.variantId, variants.id))
    .where(where)
    .orderBy(asc(available), asc(variants.sku))
    .limit(STOCK_PREVIEW);
  return { count: n, items };
}

async function quarantineQueue(tx: Db, source: "return" | "rto") {
  const where = and(eq(quarantineItems.status, "awaiting_inspection"), eq(quarantineItems.source, source));
  const [totals] = await tx
    .select({ count: sql<number>`count(*)`.mapWith(Number), units: sql<number>`coalesce(sum(${quarantineItems.quantity}), 0)`.mapWith(Number) })
    .from(quarantineItems)
    .where(where);
  const oldest = await tx
    .select({ id: quarantineItems.id, orderId: quarantineItems.orderId, orderNumber: orders.number, sku: variants.sku, quantity: quarantineItems.quantity, receivedAt: quarantineItems.receivedAt })
    .from(quarantineItems)
    .innerJoin(orders, eq(orders.id, quarantineItems.orderId))
    .innerJoin(variants, eq(variants.id, quarantineItems.variantId))
    .where(where)
    .orderBy(asc(quarantineItems.receivedAt), asc(quarantineItems.id))
    .limit(PREVIEW);
  return { ...totals, oldest };
}

export async function getDashboard(db: Db, options: { lowStockThreshold?: number | null } = {}): Promise<Dashboard> {
  const threshold = options.lowStockThreshold ?? null;
  return db.transaction(
    async (tx) => {
      const queueNames = Object.keys(ORDER_QUEUES) as OrderQueue[];
      const counted = await tx.execute<Record<string, string>>(
        sql`select now() as generated_at, ${sql.join(
          queueNames.map((q) => sql`count(*) filter (where ${queueCondition(q)}) as ${sql.identifier(q)}`),
          sql`, `,
        )} from ${orders}`,
      );
      const row = counted.rows[0];
      const queues = [];
      for (const queue of queueNames) {
        const oldest = await tx.select(QUEUE_COLUMNS).from(orders).where(queueCondition(queue)).orderBy(asc(orders.createdAt), asc(orders.id)).limit(PREVIEW);
        queues.push({ queue, label: ORDER_QUEUES[queue], count: Number(row[queue]), oldest });
      }
      const [ret] = await tx
        .select({
          awaitingParcel: sql<number>`count(*) filter (where ${returns.status} = 'requested')`.mapWith(Number),
          awaitingDecision: sql<number>`count(*) filter (where ${returns.status} = 'received')`.mapWith(Number),
          approvedOpen: sql<number>`count(*) filter (where ${returns.status} = 'approved')`.mapWith(Number),
        })
        .from(returns);
      const zones = await tx.select({ code: deliveryZones.code }).from(deliveryZones).where(eq(deliveryZones.active, true));
      const active = new Set(zones.map((z) => z.code));
      return {
        generatedAt: new Date(row.generated_at),
        queues,
        quarantine: { return: await quarantineQueue(tx, "return"), rto: await quarantineQueue(tx, "rto") },
        returns: ret,
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
