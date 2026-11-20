import Link from "next/link";
import { formatOrderNumber } from "@/modules/orders/rules";
import type { Bucket, CodRow, Outstanding, PeriodReport } from "@/modules/reports/summary";
import { bdt, label } from "../../orders/_components/labels";

// Report sections shared by the Reports page and its printed version. Each heading says what the figures are
// based on; amounts are BDT from integer paisa.

const CAPTION = "caption-top pb-2 text-left text-sm font-semibold text-gray-900";

function Rows({ rows, money = true }: { rows: [string, Bucket][]; money?: boolean }) {
  return (
    <tbody>
      {rows.length === 0 ? (
        <tr>
          <td colSpan={3} className="text-gray-600">
            None in this period.
          </td>
        </tr>
      ) : null}
      {rows.map(([name, b]) => (
        <tr key={name}>
          <th scope="row" className="font-normal">
            {name}
          </th>
          <td className="num">{b.count}</td>
          <td className="num">{money ? bdt(b.amountPaisa) : b.amountPaisa}</td>
        </tr>
      ))}
    </tbody>
  );
}

function Table({ caption, rows, amount = "Amount", money = true }: { caption: string; rows: [string, Bucket][]; amount?: string; money?: boolean }) {
  return (
    <table className="of-table">
      <caption className={CAPTION}>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">
            <span className="sr-only">Item</span>
          </th>
          <th scope="col" className="num w-20">
            Count
          </th>
          <th scope="col" className="num w-36">
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
          ["Collected by the courier, not settled to you or recorded as kept by it", o.heldByCourier],
        ]}
      />
      <table className="of-table">
        <caption className={CAPTION}>All recorded COD entries (every date)</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Entry</span>
            </th>
            <th scope="col" className="num w-36">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" className="font-normal">
              Collected by the courier
            </th>
            <td className="num">{bdt(o.ledger.collectedPaisa)}</td>
          </tr>
          <tr>
            <th scope="row" className="font-normal">
              − Settled to you
            </th>
            <td className="num">{bdt(o.ledger.settledPaisa)}</td>
          </tr>
          <tr>
            <th scope="row" className="font-normal">
              − Kept by the courier (recorded deductions)
            </th>
            <td className="num">{bdt(o.ledger.deductedPaisa)}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className="text-left">
              = Held by the courier
            </th>
            <td className="num">{bdt(o.ledger.collectedPaisa - o.ledger.settledPaisa - o.ledger.deductedPaisa)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="text-xs text-gray-600">Refunds recorded: {bdt(o.ledger.refundedPaisa)}. Refunds are paid by you and are separate from collection and settlement.</p>
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
    <div className="space-y-6">
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-5" data-testid="report-kpis">
        <div className="of-stat">
          <dt>Orders placed</dt>
          <dd>{r.received.total.count}</dd>
        </div>
        <div className="of-stat">
          <dt>Order value placed</dt>
          <dd>{bdt(r.received.total.amountPaisa)}</dd>
        </div>
        <div className="of-stat">
          <dt>COD collected by courier</dt>
          <dd>{bdt(r.money.collected.amountPaisa)}</dd>
        </div>
        <div className="of-stat">
          <dt>Settled to you</dt>
          <dd>{bdt(r.money.settled.amountPaisa)}</dd>
        </div>
        <div className="of-stat">
          <dt>Refunded</dt>
          <dd>{bdt(r.money.refunded.amountPaisa)}</dd>
        </div>
      </dl>
      <div className="space-y-3">
        <p className="text-xs text-gray-600">Orders by the time they were placed, with their status now. Order value includes cancelled and unverified orders; it is not sales, revenue or profit.</p>
        <div className="grid items-start gap-x-6 gap-y-5 md:grid-cols-2">
          <Table caption="By source" rows={byKey(r.received.bySource)} amount="Order value" />
          <Table caption="By order status (now)" rows={byKey(r.received.byOrderStatus)} amount="Order value" />
          <Table caption="By fulfilment status (now)" rows={byKey(r.received.byFulfilmentStatus)} amount="Order value" />
          <Table caption="By payment status (now)" rows={byKey(r.received.byPaymentStatus)} amount="Order value" />
        </div>
      </div>
      <div className="space-y-2">
        <Table
          caption="COD money recorded (by the date entered for each payment)"
          rows={[
            ["Collected by the courier", r.money.collected],
            ["Settled to you", r.money.settled],
            ["Kept by the courier (recorded deductions)", r.money.deducted],
            ["Refunded to customers", r.money.refunded],
          ]}
        />
        <p className="text-xs text-gray-600">Courier fees appear only as the deductions you record from the courier&apos;s statements.</p>
      </div>
      <div className="grid items-start gap-x-6 gap-y-5 md:grid-cols-2">
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
    </div>
  );
}

export function CodTable({ rows, links = true }: { rows: CodRow[]; links?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="of-table" data-testid="cod-table">
        <caption className={CAPTION}>Orders with COD still open (oldest first)</caption>
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Fulfilment</th>
            <th scope="col" className="num">
              Total
            </th>
            <th scope="col" className="num">
              Collected
            </th>
            <th scope="col" className="num">
              Settled
            </th>
            <th scope="col" className="num">
              Kept by courier
            </th>
            <th scope="col" className="num">
              To collect
            </th>
            <th scope="col" className="num">
              Held by courier
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{links ? <Link href={`/admin/orders/${r.id}`} className="underline">{formatOrderNumber(r.number)}</Link> : formatOrderNumber(r.number)}</td>
              <td>{label(r.fulfilmentStatus)}</td>
              <td className="num">{bdt(r.totalPaisa)}</td>
              <td className="num">{bdt(r.collectedPaisa)}</td>
              <td className="num">{bdt(r.settledPaisa)}</td>
              <td className="num">{bdt(r.deductedPaisa)}</td>
              <td className="num">{bdt(r.awaitingCollectionPaisa)}</td>
              <td className="num">{bdt(r.heldByCourierPaisa)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
