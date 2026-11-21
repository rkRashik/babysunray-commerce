import Link from "next/link";
import { formatOrderNumber } from "@/modules/orders/rules";
import type { Bucket, CodRow, Outstanding, PeriodReport } from "@/modules/reports/summary";
import { bdt, label, tone } from "../../orders/_components/labels";
import { ScrollArea } from "../../_components/scroll-area";
import { Stat } from "../../_components/stat";
import { StackBar } from "./stack-bar";

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
          <th scope="col" className="num w-14 sm:w-20">
            Count
          </th>
          <th scope="col" className="num w-24 sm:w-36">
            {amount}
          </th>
        </tr>
      </thead>
      <Rows rows={rows} money={money} />
    </table>
  );
}

const byKey = (record: Record<string, Bucket>) => Object.entries(record).map(([k, b]) => [label(k), b] as [string, Bucket]);

export function OutstandingView({ o, charts = false }: { o: Outstanding; charts?: boolean }) {
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
      {charts ? (
        <StackBar
          title="Where the COD money collected so far is (every date)"
          segments={[
            { label: "Settled to you", value: o.ledger.settledPaisa, tone: "ok" },
            { label: "Kept by the courier", value: o.ledger.deductedPaisa, tone: "bad" },
            { label: "Still with the courier", value: Math.max(0, o.ledger.collectedPaisa - o.ledger.settledPaisa - o.ledger.deductedPaisa), tone: "wait" },
          ]}
          format={bdt}
        />
      ) : null}
      <table className="of-table">
        <caption className={CAPTION}>All recorded COD entries (every date)</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Entry</span>
            </th>
            <th scope="col" className="num w-24 sm:w-36">
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

/** The headline figures of the period: order activity and money recorded, kept apart so order value is never read as money. */
export function KpiTiles({ r }: { r: PeriodReport }) {
  return (
    <div className="grid gap-x-5 gap-y-4 lg:grid-cols-[2fr_3fr]" data-testid="report-kpis">
      <div className="space-y-2">
        <h3 className="text-sm font-bold">
          Orders placed <span className="font-normal text-gray-600">(activity, not money)</span>
        </h3>
        <dl className="grid grid-cols-2 gap-3">
          <Stat term="Orders placed" value={r.received.total.count} note="Including cancelled and unverified orders." />
          <Stat term="Order value placed" value={bdt(r.received.total.amountPaisa)} note="What these orders are worth. Not sales or money received." />
        </dl>
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-bold">
          Money recorded <span className="font-normal text-gray-600">(by the date you entered)</span>
        </h3>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat term="COD collected by courier" value={bdt(r.money.collected.amountPaisa)} note="Taken from customers by the courier." />
          <Stat term="Settled to you" value={bdt(r.money.settled.amountPaisa)} note="Paid to you by the courier." tone={r.money.settled.amountPaisa > 0 ? "ok" : undefined} />
          <Stat term="Refunded" value={bdt(r.money.refunded.amountPaisa)} note="Paid back by you to customers." />
        </dl>
      </div>
    </div>
  );
}

/** Orders placed in the period, by source and by their status now. `charts` adds the status bar (not in the printed copy). */
export function OrdersSection({ r, charts = false }: { r: PeriodReport; charts?: boolean }) {
  const tables = (
    <div className="grid items-start gap-x-6 gap-y-5 md:grid-cols-2">
      <Table caption="By source" rows={byKey(r.received.bySource)} amount="Order value" />
      <Table caption="By order status (now)" rows={byKey(r.received.byOrderStatus)} amount="Order value" />
      <Table caption="By fulfilment status (now)" rows={byKey(r.received.byFulfilmentStatus)} amount="Order value" />
      <Table caption="By payment status (now)" rows={byKey(r.received.byPaymentStatus)} amount="Order value" />
    </div>
  );
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-600">Orders by the time they were placed, with their status now. Order value includes cancelled and unverified orders; it is not sales, revenue or profit.</p>
      {charts ? (
        <StackBar
          title="Orders by status now"
          segments={Object.entries(r.received.byOrderStatus).map(([k, b]) => ({ label: label(k), value: b.count, tone: tone(k) }))}
          format={(n) => `${n} order${n === 1 ? "" : "s"}`}
        />
      ) : null}
      {charts ? (
        // On screen the bar gives the overview; the four tables wait behind one toggle. The printed copy shows them all.
        <details className="text-sm">
          <summary className="cursor-pointer py-3 font-semibold lg:py-1">Show the detail tables (by source, order, fulfilment and payment status)</summary>
          <div className="mt-3">{tables}</div>
        </details>
      ) : (
        tables
      )}
    </div>
  );
}

/** COD money entered in the period. */
export function CodMoneySection({ r }: { r: PeriodReport }) {
  return (
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
  );
}

/** Costs and stock movements recorded in the period. */
export function CostsStockSection({ r }: { r: PeriodReport }) {
  return (
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
  );
}

/** Everything in the period, one after another: the printed copy. */
export function PeriodReportView({ r }: { r: PeriodReport }) {
  return (
    <div className="space-y-6">
      <KpiTiles r={r} />
      <OrdersSection r={r} />
      <CodMoneySection r={r} />
      <CostsStockSection r={r} />
    </div>
  );
}

export function CodTable({ rows, links = true }: { rows: CodRow[]; links?: boolean }) {
  return (
    <ScrollArea label="Orders with COD still open" hint="Scroll sideways for more columns.">
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
    </ScrollArea>
  );
}
