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
  /** COD money (collected, settled, deducted), return refunds, and manual advance payments (ADR-0013), each kept apart. */
  money: { collected: Bucket; settled: Bucket; deducted: Bucket; refunded: Bucket; advanceReceived: Bucket; advanceReversed: Bucket; advanceRefunded: Bucket };
  costs: { rtoCharges: Bucket; returnShippingBusiness: Bucket; returnShippingCustomer: Bucket };
  stock: { receipts: Bucket; dispatches: Bucket; adjustmentsIn: Bucket; adjustmentsOut: Bucket; returnRestocks: Bucket };
  outstanding: Outstanding;
};

export type Outstanding = {
  /** Verified (confirmed) orders not dispatched yet: their totals are expected COD, not money. */
  verifiedNotDispatched: Bucket;
  /** Dispatched or delivered confirmed orders: total minus collected and minus verified advance payments. */
  awaitingCollection: Bucket;
  /** Cancelled or returned (RTO) orders holding verified advance money not yet paid back (a manual refund is due). */
  advanceRefundDue: Bucket;
  /** Collected by the courier and not yet accounted for: collected minus settled minus deducted, every order. */
  heldByCourier: Bucket;
  /** All-time sums of the payment entries, and the same sums from the orders' running totals. */
  ledger: { collectedPaisa: number; settledPaisa: number; deductedPaisa: number; refundedPaisa: number; advanceReceivedPaisa: number; advanceRefundedPaisa: number };
  orderTotals: { collectedPaisa: number; settledPaisa: number; deductedPaisa: number; refundedPaisa: number; advanceReceivedPaisa: number; advanceRefundedPaisa: number };
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

export async function getOutstanding(tx: Db): Promise<Outstanding> {
  const { rows } = await tx.execute<Record<string, string>>(sql`
    select
      count(*) filter (where order_status = 'confirmed' and fulfilment_status in ('unfulfilled', 'packed')) as vnd_count,
      coalesce(sum(total_paisa) filter (where order_status = 'confirmed' and fulfilment_status in ('unfulfilled', 'packed')), 0) as vnd_amount,
      count(*) filter (where order_status = 'confirmed' and fulfilment_status in ('dispatched', 'delivered') and cod_collected_paisa + advance_received_paisa < total_paisa) as ac_count,
      coalesce(sum(total_paisa - cod_collected_paisa - advance_received_paisa) filter (where order_status = 'confirmed' and fulfilment_status in ('dispatched', 'delivered')), 0) as ac_amount,
      count(*) filter (where (order_status = 'cancelled' or (order_status = 'confirmed' and fulfilment_status = 'rto_received')) and advance_received_paisa > advance_refunded_paisa) as rd_count,
      coalesce(sum(advance_received_paisa - advance_refunded_paisa) filter (where order_status = 'cancelled' or (order_status = 'confirmed' and fulfilment_status = 'rto_received')), 0) as rd_amount,
      count(*) filter (where cod_settled_paisa + cod_deducted_paisa < cod_collected_paisa) as held_count,
      coalesce(sum(cod_collected_paisa - cod_settled_paisa - cod_deducted_paisa), 0) as held_amount,
      coalesce(sum(cod_collected_paisa), 0) as o_collected,
      coalesce(sum(cod_settled_paisa), 0) as o_settled,
      coalesce(sum(cod_deducted_paisa), 0) as o_deducted,
      coalesce(sum(refunded_paisa), 0) as o_refunded,
      coalesce(sum(advance_received_paisa), 0) as o_advance,
      coalesce(sum(advance_refunded_paisa), 0) as o_advance_refunded,
      (select coalesce(sum(amount_paisa) filter (where kind = 'advance_received'), 0) - coalesce(sum(amount_paisa) filter (where kind = 'advance_reversed'), 0) from payment_entries) as l_advance,
      (select coalesce(sum(amount_paisa) filter (where kind = 'advance_refunded'), 0) from payment_entries) as l_advance_refunded,
      (select coalesce(sum(amount_paisa) filter (where kind = 'collected'), 0) from payment_entries) as l_collected,
      (select coalesce(sum(amount_paisa) filter (where kind = 'settled'), 0) from payment_entries) as l_settled,
      (select coalesce(sum(amount_paisa) filter (where kind = 'deducted'), 0) from payment_entries) as l_deducted,
      (select coalesce(sum(amount_paisa) filter (where kind = 'refunded'), 0) from payment_entries) as l_refunded
    from orders`);
  const r = rows[0];
  const ledger = {
    collectedPaisa: exactInteger(r.l_collected),
    settledPaisa: exactInteger(r.l_settled),
    deductedPaisa: exactInteger(r.l_deducted),
    refundedPaisa: exactInteger(r.l_refunded),
    advanceReceivedPaisa: exactInteger(r.l_advance),
    advanceRefundedPaisa: exactInteger(r.l_advance_refunded),
  };
  const orderTotals = {
    collectedPaisa: exactInteger(r.o_collected),
    settledPaisa: exactInteger(r.o_settled),
    deductedPaisa: exactInteger(r.o_deducted),
    refundedPaisa: exactInteger(r.o_refunded),
    advanceReceivedPaisa: exactInteger(r.o_advance),
    advanceRefundedPaisa: exactInteger(r.o_advance_refunded),
  };
  return {
    verifiedNotDispatched: bucket({ count: r.vnd_count, amount: r.vnd_amount }),
    awaitingCollection: bucket({ count: r.ac_count, amount: r.ac_amount }),
    heldByCourier: bucket({ count: r.held_count, amount: r.held_amount }),
    advanceRefundDue: bucket({ count: r.rd_count, amount: r.rd_amount }),
    ledger,
    orderTotals,
    reconciled:
      ledger.collectedPaisa === orderTotals.collectedPaisa &&
      ledger.settledPaisa === orderTotals.settledPaisa &&
      ledger.deductedPaisa === orderTotals.deductedPaisa &&
      ledger.refundedPaisa === orderTotals.refundedPaisa &&
      ledger.advanceReceivedPaisa === orderTotals.advanceReceivedPaisa &&
      ledger.advanceRefundedPaisa === orderTotals.advanceRefundedPaisa &&
      exactInteger(r.held_amount) === ledger.collectedPaisa - ledger.settledPaisa - ledger.deductedPaisa,
  };
}

const SNAPSHOT = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

/**
 * Three statements, whatever the range: the orders received (total and the four breakdowns, one UNION ALL), the money,
 * costs and stock movements (one UNION ALL), and the outstanding state. A hosted database costs a round trip per
 * statement, so fewer statements is what makes the page fast.
 */
export async function getPeriodReport(db: Db, range: DateRange): Promise<PeriodReport> {
  const { start, end } = rangeInstants(range);
  return db.transaction(async (tx) => {
    const inRange = sql`created_at >= ${start} and created_at < ${end}`;
    const by = (dim: string, column: string) =>
      sql`select ${dim}::text as dim, ${sql.identifier(column)}::text as key, count(*) as count, coalesce(sum(total_paisa), 0) as amount, null::timestamptz as now from orders where ${inRange} group by 2`;
    const { rows: received } = await tx.execute<{ dim: string; key: string | null; count: string; amount: string; now: string | null }>(sql`
      select 'total'::text as dim, null::text as key, count(*) as count, coalesce(sum(total_paisa), 0) as amount, now() as now from orders where ${inRange}
      union all ${by("source", "source")}
      union all ${by("order_status", "order_status")}
      union all ${by("fulfilment_status", "fulfilment_status")}
      union all ${by("payment_status", "payment_status")}
      order by 1, 2`);
    const breakdown = (dim: string) => Object.fromEntries(received.filter((r) => r.dim === dim).map((r) => [r.key as string, bucket(r)]));
    const totalRow = received.find((r) => r.dim === "total");
    // An RTO charge can be corrected; the order's current charge counts in the range of its latest recording.
    const { rows: recorded } = await tx.execute<{ section: string; kind: string; count: string; amount: string }>(sql`
      select 'money'::text as section, kind::text as kind, count(*) as count, coalesce(sum(amount_paisa), 0) as amount from payment_entries
       where occurred_on between ${range.from}::date and ${range.to}::date group by kind
      union all
      select 'rto', 'rto', count(*), coalesce(sum(o.rto_charge_paisa), 0) from orders o
       where o.rto_charge_paisa is not null
         and (select max(e.created_at) from order_events e where e.order_id = o.id and e.event = 'rto_charge_recorded') >= ${start}
         and (select max(e.created_at) from order_events e where e.order_id = o.id and e.event = 'rto_charge_recorded') < ${end}
      union all
      select 'shipping', shipping_paid_by::text, count(*), coalesce(sum(return_shipping_cost_paisa), 0) from returns
       where return_shipping_cost_paisa is not null and received_at >= ${start} and received_at < ${end} group by shipping_paid_by
      union all
      select 'stock', case when movement_type = 'adjustment' then (case when quantity_delta > 0 then 'adjustment_in' else 'adjustment_out' end) else movement_type::text end,
             count(*), coalesce(sum(quantity_delta), 0)
        from stock_movements where created_at >= ${start} and created_at < ${end} group by 2`);
    const pick = (section: string, kind: string) => bucket(recorded.find((r) => r.section === section && r.kind === kind));
    return {
      range,
      start,
      end,
      generatedAt: new Date(totalRow?.now as string),
      received: {
        total: bucket(totalRow),
        bySource: breakdown("source"),
        byOrderStatus: breakdown("order_status"),
        byFulfilmentStatus: breakdown("fulfilment_status"),
        byPaymentStatus: breakdown("payment_status"),
      },
      money: {
        collected: pick("money", "collected"),
        settled: pick("money", "settled"),
        deducted: pick("money", "deducted"),
        refunded: pick("money", "refunded"),
        advanceReceived: pick("money", "advance_received"),
        advanceReversed: pick("money", "advance_reversed"),
        advanceRefunded: pick("money", "advance_refunded"),
      },
      costs: {
        rtoCharges: pick("rto", "rto"),
        returnShippingBusiness: pick("shipping", "business"),
        returnShippingCustomer: pick("shipping", "customer"),
      },
      // amountPaisa here is units, not money (the Bucket shape is shared).
      stock: {
        receipts: pick("stock", "receipt"),
        dispatches: pick("stock", "dispatch"),
        adjustmentsIn: pick("stock", "adjustment_in"),
        adjustmentsOut: pick("stock", "adjustment_out"),
        returnRestocks: pick("stock", "return_restock"),
      },
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
