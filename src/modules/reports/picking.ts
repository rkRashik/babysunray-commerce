import "server-only";
import { asc, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import { orderItems, orders } from "@/db/schema";
import { queueCondition } from "../orders/queries";

// Picking list and packing summary for confirmed orders that are not packed yet (the "to pack" queue). No
// customer name, phone, address or free-text note (a note can hold contact details): those belong only on an
// order's own shipping document (requirement D-10).

export const PICKING_LIMIT = 100;

type Line = { sku: string; nameEn: string | null; nameBn: string | null; size: string | null; colour: string | null; quantity: number };

export type PickingList = {
  generatedAt: Date;
  /** More orders are waiting than are listed (the oldest PICKING_LIMIT are). */
  truncated: boolean;
  orders: { id: string; number: number; createdAt: Date; items: Line[] }[];
  /** Units to pick per SKU over the listed orders, and in how many of them it appears. */
  skus: (Line & { orders: number })[];
};

export async function getPickingList(db: Db): Promise<PickingList> {
  return db.transaction(
    async (tx) => {
      const { rows } = await tx.execute<{ now: string }>(sql`select now() as now`);
      const found = await tx
        .select({ id: orders.id, number: orders.number, createdAt: orders.createdAt })
        .from(orders)
        .where(queueCondition("to_pack"))
        .orderBy(asc(orders.createdAt), asc(orders.id))
        .limit(PICKING_LIMIT + 1);
      const listed = found.slice(0, PICKING_LIMIT);
      const items = listed.length
        ? await tx.select().from(orderItems).where(inArray(orderItems.orderId, listed.map((o) => o.id))).orderBy(asc(orderItems.sku))
        : [];
      const line = (i: (typeof items)[number]): Line => ({ sku: i.sku, nameEn: i.productNameEn, nameBn: i.productNameBn, size: i.size, colour: i.colour, quantity: i.quantity });
      const skus = new Map<string, Line & { orders: number }>();
      for (const i of items) {
        const entry = skus.get(i.sku) ?? { ...line(i), quantity: 0, orders: 0 };
        entry.quantity += i.quantity;
        entry.orders += 1;
        skus.set(i.sku, entry);
      }
      return {
        generatedAt: new Date(rows[0].now),
        truncated: found.length > PICKING_LIMIT,
        orders: listed.map((o) => ({ ...o, items: items.filter((i) => i.orderId === o.id).map(line) })),
        skus: [...skus.values()],
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
