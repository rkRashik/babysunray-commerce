import "server-only";
import { desc, eq, sql } from "drizzle-orm";
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

/** Whether the customer can sign in with a password (an email account), as opposed to Google only. */
export async function customerHasPassword(db: Db, customerUserId: string): Promise<boolean> {
  const { rows } = await db.execute<{ n: number }>(sql`select count(*)::int as n from customer_accounts where user_id = ${customerUserId} and provider_id = 'credential'`);
  return rows[0].n > 0;
}
