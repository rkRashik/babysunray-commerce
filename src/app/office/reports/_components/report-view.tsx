import Link from "next/link";
import { formatOrderNumber } from "@/modules/orders/rules";
import type { Bucket, CodRow, Outstanding, PeriodReport } from "@/modules/reports/summary";
import { bdt, label } from "../../orders/_components/labels";

// Report sections shared by the Reports page and its printed version. Each heading says what the figures are
// based on; amounts are BDT from integer paisa.

const TABLE = "w-full text-left text-sm [&_td]:py-1 [&_td]:pr-3 [&_th]:py-1 [&_th]:pr-3";

function Rows({ rows, money = true }: { rows: [string, Bucket][]; money?: boolean }) {
  return (
    <tbody className="divide-y divide-gray-200">
      {rows.map(([name, b]) => (
        <tr key={name}>
          <th scope="row" className="font-normal">
            {name}
          </th>
          <td className="text-right tabular-nums">{b.count}</td>
          <td className="text-right tabular-nums">{money ? bdt(b.amountPaisa) : b.amountPaisa}</td>
        </tr>
      ))}
    </tbody>
  );
}

function Table({ caption, rows, amount = "Amount", money = true }: { caption: string; rows: [string, Bucket][]; amount?: string; money?: boolean }) {
  return (
    <table className={TABLE}>
      <caption className="text-left text-sm font-medium">{caption}</caption>
      <thead className="border-b border-gray-300 text-gray-600">
        <tr>
          <th scope="col"> </th>
          <th scope="col" className="text-right">
            Count
          </th>
          <th scope="col" className="text-right">
            {amount}
          </th>
        </tr>
      </thead>
      <Rows rows={rows} money={money} />
    </table>
  );
}

const byKey = (record: Record<string, Bucket>) => Object.entries(record).map(([k, b]) => [label(k), b] as [string, Bucket]);

export function OutstandingView({ o }: { o: Outstanding }) {
  return (
    <div className="space-y-2" data-testid="outstanding">
      <Table
        caption="COD outstanding now (every order, not limited to the dates above)"
        rows={[
          ["Verified, not dispatched yet (expected, not money)", o.verifiedNotDispatched],
          ["Dispatched or delivered: still to be collected", o.awaitingCollection],
          ["Collected by the courier, not settled to you", o.heldByCourier],
        ]}
      />
      <p className="text-sm">
        All recorded entries: collected {bdt(o.ledger.collectedPaisa)} − settled {bdt(o.ledger.settledPaisa)} = held by the courier{" "}
        {bdt(o.ledger.collectedPaisa - o.ledger.settledPaisa)}. Refunds recorded: {bdt(o.ledger.refundedPaisa)} (paid by you, separate from collection
        and settlement).
      </p>
      <p className={`text-sm ${o.reconciled ? "text-green-900" : "font-semibold text-red-800"}`} data-testid="reconciled">
        {o.reconciled
          ? "Check passed: the payment entries agree with every order's running totals."
          : "Check failed: the payment entries and the orders' running totals disagree. Do not rely on these figures; report this."}
      </p>
    </div>
  );
}

export function PeriodReportView({ r }: { r: PeriodReport }) {
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Table caption="Orders received (by submission time), with their status now" rows={[["All orders received", r.received.total]]} amount="Order totals" />
        <p className="text-xs text-gray-600">Order totals include cancelled and unverified orders. They are not sales, revenue or profit.</p>
        <div className="grid gap-4 md:grid-cols-2">
          <Table caption="By source" rows={byKey(r.received.bySource)} amount="Order totals" />
          <Table caption="By order status (now)" rows={byKey(r.received.byOrderStatus)} amount="Order totals" />
          <Table caption="By fulfilment status (now)" rows={byKey(r.received.byFulfilmentStatus)} amount="Order totals" />
          <Table caption="By payment status (now)" rows={byKey(r.received.byPaymentStatus)} amount="Order totals" />
        </div>
      </div>
      <div className="space-y-2">
        <Table
          caption="COD money recorded (by the date entered for each payment)"
          rows={[
            ["Collected by the courier", r.money.collected],
            ["Settled to you", r.money.settled],
            ["Refunded to customers", r.money.refunded],
          ]}
        />
        <p className="text-xs text-gray-600">Courier fees, deductions and statement reconciliation are not recorded by the system yet.</p>
      </div>
      <Table
        caption="Costs recorded"
        rows={[
          ["RTO charges (by when last recorded)", r.costs.rtoCharges],
          ["Return shipping paid by the business (by receipt)", r.costs.returnShippingBusiness],
          ["Return shipping paid by the customer (by receipt)", r.costs.returnShippingCustomer],
        ]}
      />
      <Table
        caption="Stock movements (by time recorded)"
        amount="Units"
        money={false}
        rows={[
          ["Received", r.stock.receipts],
          ["Dispatched", r.stock.dispatches],
          ["Adjusted up", r.stock.adjustmentsIn],
          ["Adjusted down", r.stock.adjustmentsOut],
          ["Restocked after inspection", r.stock.returnRestocks],
        ]}
      />
    </div>
  );
}

export function CodTable({ rows, links = true }: { rows: CodRow[]; links?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className={`${TABLE} border-collapse`} data-testid="cod-table">
        <caption className="text-left text-sm font-medium">Orders with COD still open (oldest first)</caption>
        <thead className="border-b border-gray-300 text-gray-600">
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Fulfilment</th>
            <th scope="col" className="text-right">
              Total
            </th>
            <th scope="col" className="text-right">
              Collected
            </th>
            <th scope="col" className="text-right">
              Settled
            </th>
            <th scope="col" className="text-right">
              To collect
            </th>
            <th scope="col" className="text-right">
              Held by courier
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{links ? <Link href={`/office/orders/${r.id}`} className="underline">{formatOrderNumber(r.number)}</Link> : formatOrderNumber(r.number)}</td>
              <td>{label(r.fulfilmentStatus)}</td>
              <td className="text-right tabular-nums">{bdt(r.totalPaisa)}</td>
              <td className="text-right tabular-nums">{bdt(r.collectedPaisa)}</td>
              <td className="text-right tabular-nums">{bdt(r.settledPaisa)}</td>
              <td className="text-right tabular-nums">{bdt(r.awaitingCollectionPaisa)}</td>
              <td className="text-right tabular-nums">{bdt(r.heldByCourierPaisa)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
