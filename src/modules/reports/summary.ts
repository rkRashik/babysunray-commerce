import "server-only";
import { sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import { type DateRange, rangeInstants } from "./dates";

// Period report and COD reconciliation (requirements OF-3, OF-8, D-7). Figures come from the records that
// exist; nothing is estimated. Each figure says what it is based on:
//   - "received": orders by submission time (created_at) in the range, with their status as of now;
//   - money: COD payment entries by the date the Owner recorded for them (occurred_on) in the range;
//   - "outstanding": the state of every order as of now, not limited to the range;
//   - stock: ledger rows by the time they were written (created_at) in the range.
// Order totals are not sales, revenue or profit: no cost of goods, discount or tax is recorded, and courier fees
// appear only as the deductions the Owner recorded from the courier's statements.
// Amounts are integer paisa, summed by PostgreSQL as exact integers. Everything is read in one read-only
// REPEATABLE READ transaction, so the sections are mutually consistent.

export type Bucket = { count: number; amountPaisa: number };

export type PeriodReport = {
  range: DateRange;
  start: Date;
  end: Date;
  generatedAt: Date;
  received: {
    total: Bucket;
    bySource: Record<string, Bucket>;
    byOrderStatus: Record<string, Bucket>;
    byFulfilmentStatus: Record<string, Bucket>;
    byPaymentStatus: Record<string, Bucket>;
  };
  money: { collected: Bucket; settled: Bucket; deducted: Bucket; refunded: Bucket };
  costs: { rtoCharges: Bucket; returnShippingBusiness: Bucket; returnShippingCustomer: Bucket };
  stock: { receipts: Bucket; dispatches: Bucket; adjustmentsIn: Bucket; adjustmentsOut: Bucket; returnRestocks: Bucket };
  outstanding: Outstanding;
};

export type Outstanding = {
  /** Verified (confirmed) orders not dispatched yet: their totals are expected COD, not money. */
  verifiedNotDispatched: Bucket;
  /** Dispatched or delivered confirmed orders: total minus collected. */
  awaitingCollection: Bucket;
  /** Collected by the courier and not yet accounted for: collected minus settled minus deducted, every order. */
  heldByCourier: Bucket;
  /** All-time sums of the payment entries, and the same sums from the orders' running totals. */
  ledger: { collectedPaisa: number; settledPaisa: number; deductedPaisa: number; refundedPaisa: number };
  orderTotals: { collectedPaisa: number; settledPaisa: number; deductedPaisa: number; refundedPaisa: number };
  /** True when the entries and the running totals agree (they are written in one transaction). */
  reconciled: boolean;
};

/** A bigint or numeric aggregate from PostgreSQL (text) as an exact JavaScript integer. */
export function exactInteger(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isSafeInteger(n)) throw new Error("Aggregate is not an exact integer.");
  return n;
}

const bucket = (row: { count?: unknown; amount?: unknown } | undefined): Bucket => ({ count: exactInteger(row?.count), amountPaisa: exactInteger(row?.amount) });

async function grouped(tx: Db, column: "source" | "order_status" | "fulfilment_status" | "payment_status", start: Date, end: Date) {
  const { rows } = await tx.execute<{ key: string; count: string; amount: string }>(
    sql`select ${sql.identifier(column)} as key, count(*) as count, coalesce(sum(total_paisa), 0) as amount
          from orders where created_at >= ${start} and created_at < ${end} group by 1 order by 1`,
  );
  return Object.fromEntries(rows.map((r) => [r.key, bucket(r)]));
}

export async function getOutstanding(tx: Db): Promise<Outstanding> {
  const { rows } = await tx.execute<Record<string, string>>(sql`
    select
      count(*) filter (where order_status = 'confirmed' and fulfilment_status in ('unfulfilled', 'packed')) as vnd_count,
      coalesce(sum(total_paisa) filter (where order_status = 'confirmed' and fulfilment_status in ('unfulfilled', 'packed')), 0) as vnd_amount,
      count(*) filter (where order_status = 'confirmed' and fulfilment_status in ('dispatched', 'delivered') and cod_collected_paisa < total_paisa) as ac_count,
      coalesce(sum(total_paisa - cod_collected_paisa) filter (where order_status = 'confirmed' and fulfilment_status in ('dispatched', 'delivered')), 0) as ac_amount,
      count(*) filter (where cod_settled_paisa + cod_deducted_paisa < cod_collected_paisa) as held_count,
      coalesce(sum(cod_collected_paisa - cod_settled_paisa - cod_deducted_paisa), 0) as held_amount,
      coalesce(sum(cod_collected_paisa), 0) as o_collected,
      coalesce(sum(cod_settled_paisa), 0) as o_settled,
      coalesce(sum(cod_deducted_paisa), 0) as o_deducted,
      coalesce(sum(refunded_paisa), 0) as o_refunded,
      (select coalesce(sum(amount_paisa) filter (where kind = 'collected'), 0) from payment_entries) as l_collected,
      (select coalesce(sum(amount_paisa) filter (where kind = 'settled'), 0) from payment_entries) as l_settled,
      (select coalesce(sum(amount_paisa) filter (where kind = 'deducted'), 0) from payment_entries) as l_deducted,
      (select coalesce(sum(amount_paisa) filter (where kind = 'refunded'), 0) from payment_entries) as l_refunded
    from orders`);
  const r = rows[0];
  const ledger = { collectedPaisa: exactInteger(r.l_collected), settledPaisa: exactInteger(r.l_settled), deductedPaisa: exactInteger(r.l_deducted), refundedPaisa: exactInteger(r.l_refunded) };
  const orderTotals = { collectedPaisa: exactInteger(r.o_collected), settledPaisa: exactInteger(r.o_settled), deductedPaisa: exactInteger(r.o_deducted), refundedPaisa: exactInteger(r.o_refunded) };
  return {
    verifiedNotDispatched: bucket({ count: r.vnd_count, amount: r.vnd_amount }),
    awaitingCollection: bucket({ count: r.ac_count, amount: r.ac_amount }),
    heldByCourier: bucket({ count: r.held_count, amount: r.held_amount }),
    ledger,
    orderTotals,
    reconciled:
      ledger.collectedPaisa === orderTotals.collectedPaisa &&
      ledger.settledPaisa === orderTotals.settledPaisa &&
      ledger.deductedPaisa === orderTotals.deductedPaisa &&
      ledger.refundedPaisa === orderTotals.refundedPaisa &&
      exactInteger(r.held_amount) === ledger.collectedPaisa - ledger.settledPaisa - ledger.deductedPaisa,
  };
}

const SNAPSHOT = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

export async function getPeriodReport(db: Db, range: DateRange): Promise<PeriodReport> {
  const { start, end } = rangeInstants(range);
  return db.transaction(async (tx) => {
    const { rows: now } = await tx.execute<{ now: string }>(sql`select now() as now`);
    const { rows: total } = await tx.execute<{ count: string; amount: string }>(
      sql`select count(*) as count, coalesce(sum(total_paisa), 0) as amount from orders where created_at >= ${start} and created_at < ${end}`,
    );
    const { rows: money } = await tx.execute<{ kind: string; count: string; amount: string }>(
      sql`select kind, count(*) as count, sum(amount_paisa) as amount from payment_entries
           where occurred_on between ${range.from}::date and ${range.to}::date group by kind`,
    );
    const byKind = (kind: string) => bucket(money.find((m) => m.kind === kind));
    // An RTO charge can be corrected; the order's current charge counts in the range of its latest recording.
    const { rows: rto } = await tx.execute<{ count: string; amount: string }>(sql`
      select count(*) as count, coalesce(sum(o.rto_charge_paisa), 0) as amount from orders o
       where o.rto_charge_paisa is not null
         and (select max(e.created_at) from order_events e where e.order_id = o.id and e.event = 'rto_charge_recorded') >= ${start}
         and (select max(e.created_at) from order_events e where e.order_id = o.id and e.event = 'rto_charge_recorded') < ${end}`);
    const { rows: shipping } = await tx.execute<{ paid_by: string; count: string; amount: string }>(sql`
      select shipping_paid_by as paid_by, count(*) as count, coalesce(sum(return_shipping_cost_paisa), 0) as amount from returns
       where return_shipping_cost_paisa is not null and received_at >= ${start} and received_at < ${end} group by 1`);
    const { rows: stock } = await tx.execute<{ kind: string; count: string; amount: string }>(sql`
      select case when movement_type = 'adjustment' then (case when quantity_delta > 0 then 'adjustment_in' else 'adjustment_out' end) else movement_type end as kind,
             count(*) as count, coalesce(sum(quantity_delta), 0) as amount
        from stock_movements where created_at >= ${start} and created_at < ${end} group by 1`);
    const units = (kind: string) => bucket(stock.find((s) => s.kind === kind));
    return {
      range,
      start,
      end,
      generatedAt: new Date(now[0].now),
      received: {
        total: bucket(total[0]),
        bySource: await grouped(tx, "source", start, end),
        byOrderStatus: await grouped(tx, "order_status", start, end),
        byFulfilmentStatus: await grouped(tx, "fulfilment_status", start, end),
        byPaymentStatus: await grouped(tx, "payment_status", start, end),
      },
      money: { collected: byKind("collected"), settled: byKind("settled"), deducted: byKind("deducted"), refunded: byKind("refunded") },
      costs: {
        rtoCharges: bucket(rto[0]),
        returnShippingBusiness: bucket(shipping.find((s) => s.paid_by === "business")),
        returnShippingCustomer: bucket(shipping.find((s) => s.paid_by === "customer")),
      },
      // amountPaisa here is units, not money (the Bucket shape is shared).
      stock: { receipts: units("receipt"), dispatches: units("dispatch"), adjustmentsIn: units("adjustment_in"), adjustmentsOut: units("adjustment_out"), returnRestocks: units("return_restock") },
      outstanding: await getOutstanding(tx),
    };
  }, SNAPSHOT);
}

export type CodRow = {
  id: string;
  number: number;
  createdAt: Date;
  fulfilmentStatus: string;
  paymentStatus: string;
  totalPaisa: number;
  collectedPaisa: number;
  settledPaisa: number;
  deductedPaisa: number;
  refundedPaisa: number;
  awaitingCollectionPaisa: number;
  heldByCourierPaisa: number;
};

export const COD_LIST_LIMIT = 200;

/**
 * Orders with COD money still open (awaiting collection after dispatch, or collected and neither settled nor
 * recorded as deducted: the difference to resolve with the courier), oldest
 * first, with the totals over all of them. No customer name, phone or address (routine report, D-10).
 */
export async function getCodReconciliation(db: Db): Promise<{ generatedAt: Date; rows: CodRow[]; truncated: boolean; outstanding: Outstanding }> {
  return db.transaction(async (tx) => {
    const { rows: now } = await tx.execute<{ now: string }>(sql`select now() as now`);
    const { rows } = await tx.execute<Record<string, string>>(sql`
      select id, number, created_at, fulfilment_status, payment_status, total_paisa, cod_collected_paisa, cod_settled_paisa, cod_deducted_paisa, refunded_paisa,
             case when order_status = 'confirmed' and fulfilment_status in ('dispatched', 'delivered') then total_paisa - cod_collected_paisa else 0 end as awaiting,
             cod_collected_paisa - cod_settled_paisa - cod_deducted_paisa as held
        from orders
       where (order_status = 'confirmed' and fulfilment_status in ('dispatched', 'delivered') and cod_collected_paisa < total_paisa)
          or cod_settled_paisa + cod_deducted_paisa < cod_collected_paisa
       order by created_at, id
       limit ${COD_LIST_LIMIT + 1}`);
    return {
      generatedAt: new Date(now[0].now),
      truncated: rows.length > COD_LIST_LIMIT,
      rows: rows.slice(0, COD_LIST_LIMIT).map((r) => ({
        id: r.id,
        number: exactInteger(r.number),
        createdAt: new Date(r.created_at),
        fulfilmentStatus: r.fulfilment_status,
        paymentStatus: r.payment_status,
        totalPaisa: exactInteger(r.total_paisa),
        collectedPaisa: exactInteger(r.cod_collected_paisa),
        settledPaisa: exactInteger(r.cod_settled_paisa),
        deductedPaisa: exactInteger(r.cod_deducted_paisa),
        refundedPaisa: exactInteger(r.refunded_paisa),
        awaitingCollectionPaisa: exactInteger(r.awaiting),
        heldByCourierPaisa: exactInteger(r.held),
      })),
      outstanding: await getOutstanding(tx),
    };
  }, SNAPSHOT);
}
