import { Plus } from "lucide-react";
import Link from "next/link";
import { getDb } from "@/db/client";
import { DomainError } from "@/modules/domain-error";
import { formatOrderNumber, ZONE_LABELS } from "@/modules/orders/rules";
import { getDashboard, MAX_LOW_STOCK_THRESHOLD, parseLowStockThreshold, type StockRow } from "@/modules/reports/dashboard";
import { AdminShell, Section, formatTime } from "../_components/shell";
import { requireAdmin } from "../_lib/session";
import { bdt, relative } from "../orders/_components/labels";

export const metadata = { title: "Dashboard · Admin" };

const FIELD = "of-input mt-1.5 w-32";
// Queues where the Owner must act now (a call, a decision): drawn first, with an amber edge.
const URGENT = new Set(["pending", "overdue", "cancellation_requests"]);

function StockTable({ rows, caption }: { rows: StockRow[]; caption: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-gray-300 text-gray-600">
          <tr>
            <th scope="col" className="py-1 pr-3">SKU</th>
            <th scope="col" className="py-1 pr-3">Product</th>
            <th scope="col" className="py-1 pr-3 text-right">On hand</th>
            <th scope="col" className="py-1 pr-3 text-right">Reserved</th>
            <th scope="col" className="py-1 text-right">Available</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {rows.map((r) => (
            <tr key={r.variantId}>
              <td className="py-1 pr-3">
                <Link href={`/admin/skus/${encodeURIComponent(r.sku)}`} className="inline-flex min-h-11 items-center underline underline-offset-4">
                  {r.sku}
                </Link>
              </td>
              <td className="py-1 pr-3">{r.nameEn ?? <span lang="bn">{r.nameBn}</span>}</td>
              <td className="py-1 pr-3 text-right tabular-nums">{r.onHand}</td>
              <td className="py-1 pr-3 text-right tabular-nums">{r.reserved}</td>
              <td className="py-1 text-right font-medium tabular-nums">{r.available}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The Owner's daily work list. Every number is read from the database at `generatedAt`; nothing is a target or
// an estimate. Lists show the oldest ten of each queue; "Show all" opens the full, paginated order list.
export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin("reports:read", "orders:read", "stock:read");
  const query = await searchParams;
  const rawLow = typeof query.low === "string" ? query.low : undefined;
  let lowStockThreshold: number | null = null;
  let lowError: string | undefined;
  try {
    lowStockThreshold = parseLowStockThreshold(rawLow);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    lowError = `Enter a whole number from 1 to ${MAX_LOW_STOCK_THRESHOLD}, or leave it empty.`;
  }
  const d = await getDashboard(getDb(), { lowStockThreshold });
  const now = d.generatedAt;

  return (
    <AdminShell
      title="Dashboard"
      current="dashboard"
      actions={
        <Link href="/admin/orders/new" className="of-btn of-btn-primary">
          <Plus aria-hidden="true" size={18} strokeWidth={2} />
          New order
        </Link>
      }
    >
      <p className="text-sm text-gray-600" data-testid="generated-at">
        Figures as of {formatTime(d.generatedAt)}. Reload the page for current figures. A pending order is not a sale, and a delivered order is not
        money received until its collection and settlement are recorded.
      </p>

      {d.unconfiguredZones.length ? (
        <p role="alert" className="rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-950">
          No active delivery charge for {d.unconfiguredZones.map((z) => ZONE_LABELS[z]).join(" and ")}: orders for{" "}
          {d.unconfiguredZones.length > 1 ? "these zones" : "this zone"} cannot be taken.{" "}
          <Link href="/admin/settings/delivery" className="underline">
            Set delivery charges
          </Link>
          .
        </p>
      ) : null}

      <Section title="Order work queues">
        <ul className="grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-3" aria-label="Order work queues">
          {[...d.queues].sort((a, b) => Number(URGENT.has(b.queue) && b.count > 0) - Number(URGENT.has(a.queue) && a.count > 0)).map((q) => (
            <li
              key={q.queue}
              className={`flex flex-col rounded-2xl border bg-white ${q.count > 0 ? "col-span-2 p-4 sm:col-span-1" : "p-3 sm:p-4"} ${URGENT.has(q.queue) && q.count > 0 ? "border-amber-300 shadow-[inset_4px_0_0_var(--color-sf-sun)]" : "border-gray-200"}`}
              data-queue={q.queue}
            >
              <div className="flex items-start justify-between gap-3">
                <h3 className={`leading-snug font-semibold text-gray-700 ${q.count === 0 ? "text-[0.8125rem] sm:text-sm" : "text-sm"}`}>{q.label}</h3>
                <span className={`leading-none font-bold tabular-nums ${q.count === 0 ? "text-2xl text-gray-400 sm:text-[2rem]" : "text-[2rem]"}`} data-testid={`count-${q.queue}`}>
                  {q.count}
                </span>
              </div>
              {q.count === 0 ? (
                <p className="mt-2 hidden text-xs text-gray-600 sm:block">None right now.</p>
              ) : (
                <>
                  <ul className="mt-3 space-y-1.5 border-t border-gray-200 pt-3 text-sm">
                    {q.oldest.map((o) => (
                      <li key={o.id} className="flex flex-wrap justify-between gap-x-2">
                        <Link href={`/admin/orders/${o.id}`} className="inline-flex min-h-11 items-center underline underline-offset-4">
                          {formatOrderNumber(o.number)}
                        </Link>
                        <span className="text-xs text-gray-600">
                          {q.queue === "pending" || q.queue === "overdue"
                            ? `deadline ${relative(o.verificationExpiresAt, now)}`
                            : q.queue === "awaiting_collection"
                              ? `${bdt(o.totalPaisa - o.codCollectedPaisa)} to collect`
                              : q.queue === "unsettled"
                                ? `${bdt(o.codCollectedPaisa - o.codSettledPaisa - o.codDeductedPaisa)} held by courier`
                                : `placed ${formatTime(o.createdAt)}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <Link href={`/admin/orders?queue=${q.queue}`} className="mt-auto inline-flex min-h-11 items-center pt-2 text-sm font-semibold underline underline-offset-4">
                    Show all {q.count}
                    <span className="sr-only"> ({q.label})</span>
                  </Link>
                </>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Returns and inspection">
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div className="rounded-xl bg-gray-50 px-4 py-3">
            <dt className="text-gray-600">Return requested, parcel not received</dt>
            <dd className="mt-1 text-2xl font-bold tabular-nums">{d.returns.awaitingParcel}</dd>
          </div>
          <div className="rounded-xl bg-gray-50 px-4 py-3">
            <dt className="text-gray-600">Return received, decision pending</dt>
            <dd className="mt-1 text-2xl font-bold tabular-nums">{d.returns.awaitingDecision}</dd>
          </div>
          <div className="rounded-xl bg-gray-50 px-4 py-3">
            <dt className="text-gray-600">Approved, refund or completion pending</dt>
            <dd className="mt-1 text-2xl font-bold tabular-nums">{d.returns.approvedOpen}</dd>
          </div>
        </dl>
        {(["return", "rto"] as const).map((source) => {
          const q = d.quarantine[source];
          return (
            <div key={source} data-quarantine={source}>
              <h3 className="text-sm font-medium">
                {source === "return" ? "Returned goods awaiting inspection" : "RTO goods in quarantine awaiting inspection"}:{" "}
                <span className="tabular-nums">{q.count}</span> line{q.count === 1 ? "" : "s"}, <span className="tabular-nums">{q.units}</span> unit
                {q.units === 1 ? "" : "s"} (not sellable until inspected)
              </h3>
              {q.count === 0 ? (
                <p className="text-xs text-gray-600">None right now.</p>
              ) : (
                <ul className="mt-1 space-y-1 text-sm">
                  {q.oldest.map((item) => (
                    <li key={item.id}>
                      <Link href={`/admin/orders/${item.orderId}`} className="underline">
                        {formatOrderNumber(item.orderNumber)}
                      </Link>{" "}
                      · {item.sku} × {item.quantity} · received {formatTime(item.receivedAt)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </Section>

      <Section title="Stock availability">
        <p className="text-sm text-gray-700">
          Active SKUs of products that are not archived. Available = on hand − reserved for orders. Goods awaiting inspection are not counted.
        </p>
        <h3 className="text-sm font-medium">
          No units available: <span className="tabular-nums" data-testid="zero-available">{d.stock.zeroAvailable.count}</span>
        </h3>
        {d.stock.zeroAvailable.count === 0 ? (
          <p className="text-xs text-gray-600">Every active SKU has at least one unit available.</p>
        ) : (
          <StockTable rows={d.stock.zeroAvailable.items} caption="SKUs with no units available" />
        )}
        {d.stock.zeroAvailable.count > d.stock.zeroAvailable.items.length ? (
          <p className="text-xs text-gray-600">Showing {d.stock.zeroAvailable.items.length} of {d.stock.zeroAvailable.count}. Use an export for the full list.</p>
        ) : null}
        <form method="get" action="/admin/dashboard" className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="low" className="block text-sm font-semibold">
              Show SKUs with at most this many available
            </label>
            <input id="low" name="low" inputMode="numeric" defaultValue={rawLow ?? ""} className={FIELD} aria-describedby="low-hint" />
            <p id="low-hint" className="mt-1 text-xs text-gray-600">
              Your own choice for this view only; no low-stock level is set by the system.
            </p>
          </div>
          <button type="submit" className="of-btn of-btn-line mb-6">
            Show
          </button>
        </form>
        {lowError ? (
          <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
            {lowError}
          </p>
        ) : d.stock.low ? (
          <>
            <h3 className="text-sm font-medium">
              At most {d.stock.low.threshold} available: <span className="tabular-nums">{d.stock.low.count}</span>
            </h3>
            {d.stock.low.count === 0 ? (
              <p className="text-xs text-gray-600">No SKU matches.</p>
            ) : (
              <StockTable rows={d.stock.low.items} caption={`SKUs with at most ${d.stock.low.threshold} available`} />
            )}
          </>
        ) : null}
      </Section>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link href="/admin/reports" className="of-btn of-btn-line">
          Reports and COD reconciliation
        </Link>
        <Link href="/admin/print/picking" className="of-btn of-btn-line">
          Picking list and packing summary
        </Link>
        <span className="text-gray-600">(confirmed orders not dispatched yet)</span>
      </div>
    </AdminShell>
  );
}
