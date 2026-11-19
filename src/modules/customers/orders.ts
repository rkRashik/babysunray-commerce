import "server-only";
import { desc, eq } from "drizzle-orm";
import type { Db } from "@/db/database";
import { customerOrders, orders } from "@/db/schema";
import { formatOrderNumber } from "../orders/rules";

// The orders a signed-in customer placed (customer_orders, written by the checkout in the order's transaction). The caller
// passes the id of the customer its own session check returned; never an id from a request. Only what the customer may see:
// the reference, when, the order status and the total. No contact details, notes or ids.

export type CustomerOrder = { reference: string; placedAt: Date; orderStatus: string; totalPaisa: number };

export async function customerOrderList(db: Db, customerUserId: string): Promise<CustomerOrder[]> {
  const rows = await db
    .select({ number: orders.number, placedAt: orders.createdAt, orderStatus: orders.orderStatus, totalPaisa: orders.totalPaisa })
    .from(customerOrders)
    .innerJoin(orders, eq(orders.id, customerOrders.orderId))
    .where(eq(customerOrders.customerUserId, customerUserId))
    .orderBy(desc(customerOrders.createdAt))
    .limit(50);
  return rows.map((r) => ({ reference: formatOrderNumber(r.number), placedAt: r.placedAt, orderStatus: r.orderStatus, totalPaisa: r.totalPaisa }));
}
