import { ArrowRight, Plus } from "lucide-react";
import { Suspense } from "react";
import Link from "next/link";
import { getDb } from "@/db/client";
import { storeSetupProgress } from "@/modules/settings/progress";
import { DomainError } from "@/modules/domain-error";
import { formatOrderNumber, ZONE_LABELS } from "@/modules/orders/rules";
import type { OrderQueue } from "@/modules/orders/queries";
import { type Dashboard, getDashboard, MAX_LOW_STOCK_THRESHOLD, parseLowStockThreshold, type StockRow } from "@/modules/reports/dashboard";
import type { Principal } from "@/modules/auth/principal";
import { RefreshButton } from "../_components/refresh-button";
import { PageSkeleton } from "../_components/skeleton";
import { AdminShell, Section, formatTime } from "../_components/shell";
import { requireAdmin } from "../_lib/session";
import { bdt, relative } from "../orders/_components/labels";

export const metadata = { title: "Dashboard · Admin" };

// Queues where the Owner must act now (a call, a decision), in that order.
const URGENT: OrderQueue[] = ["overdue", "cancellation_requests", "pending"];
// The rest of the day's work, in the order it happens.
const FLOW: OrderQueue[] = ["to_pack", "to_dispatch", "in_transit", "returning", "awaiting_collection", "unsettled"];
const TITLES: Record<OrderQueue, string> = {
  overdue: "Verification overdue",
  cancellation_requests: "Cancellation requests",
  pending: "To verify",
  to_pack: "To pack",
  to_dispatch: "To dispatch",
  in_transit: "In transit",
  returning: "Returning (RTO)",
  awaiting_collection: "COD to collect",
  unsettled: "Not settled by courier",
};

type Queue = Dashboard["queues"][number];

function detail(queue: OrderQueue, o: Queue["oldest"][number], now: Date) {
  if (queue === "pending" || queue === "overdue") return `deadline ${relative(o.verificationExpiresAt, now)}`;
  if (queue === "awaiting_collection") return `${bdt(o.totalPaisa - o.codCollectedPaisa)} to collect`;
  if (queue === "unsettled") return `${bdt(o.codCollectedPaisa - o.codSettledPaisa - o.codDeductedPaisa)} with courier`;
  return o.createdAt.getTime() >= now.getTime() - 60_000 ? "placed just now" : `placed ${relative(o.createdAt, now)}`;
}

function QueueCard({ q, now, urgent }: { q: Queue; now: Date; urgent: boolean }) {
  return (
    <li className={`flex flex-col rounded-2xl border bg-white p-4 ${urgent ? "border-amber-300 shadow-[inset_4px_0_0_var(--color-sf-sun)]" : "border-gray-200"}`} data-queue={q.queue}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{TITLES[q.queue]}</h3>
          <p className="text-xs text-gray-600">{q.label}</p>
        </div>
        <span className="text-[2rem] leading-none font-bold tabular-nums" data-testid={`count-${q.queue}`}>
          {q.count}
        </span>
      </div>
      <table className="mt-3 w-full border-t border-gray-200 text-sm">
        <caption className="sr-only">Oldest orders: {q.label}</caption>
        <tbody>
          {q.oldest.slice(0, 5).map((o) => (
            <tr key={o.id}>
              <th scope="row" className="py-1 text-left font-normal">
                <Link href={`/admin/orders/${o.id}`} className="inline-flex min-h-11 items-center font-medium underline underline-offset-4 lg:min-h-9">
                  {formatOrderNumber(o.number)}
                </Link>
              </th>
              <td className="py-1 text-right text-xs text-gray-600 tabular-nums">{detail(q.queue, o, now)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Link href={`/admin/orders?queue=${q.queue}`} className="mt-auto inline-flex min-h-11 items-center gap-1 pt-2 text-sm font-semibold underline-offset-4 hover:underline lg:min-h-10">
        Show all {q.count}
        <span className="sr-only"> ({q.label})</span>
        <ArrowRight aria-hidden="true" size={16} />
      </Link>
    </li>
  );
}

const productName = (r: StockRow) => r.nameEn ?? r.nameBn ?? "Product";
const variantText = (r: StockRow) => [r.size, r.colour].filter(Boolean).join(" · ") || "No size or colour";

/** Stock rows with the product and its variant first and the SKU second: a table from tablet width, plain rows on a phone. */
function StockTable({ rows, caption }: { rows: StockRow[]; caption: string }) {
  return (
    <>
      <ul aria-label={caption} className="divide-y divide-gray-200 rounded-xl border border-gray-200 md:hidden">
        {rows.map((r) => (
          <li key={r.variantId}>
            <Link href={`/admin/skus/${encodeURIComponent(r.sku)}`} className="of-row-link block space-y-1 px-4 py-3">
              <span className="of-row-title block font-semibold break-words" lang={r.nameEn ? undefined : "bn"}>
                {productName(r)}
              </span>
              <span className="block text-sm text-gray-700">{variantText(r)}</span>
              <span className="block text-xs text-gray-600">SKU {r.sku}</span>
              <span className="flex gap-4 text-sm tabular-nums">
                <span>
                  On hand <strong>{r.onHand}</strong>
                </span>
                <span>
                  Reserved <strong>{r.reserved}</strong>
                </span>
                <span>
                  Available <strong>{r.available}</strong>
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-hidden rounded-xl border border-gray-200 md:block">
        <table className="of-table">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Product</th>
              <th scope="col">Variant</th>
              <th scope="col" className="num">
                On hand
              </th>
              <th scope="col" className="num">
                Reserved
              </th>
              <th scope="col" className="num">
                Available
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.variantId}>
                <td className="font-medium" lang={r.nameEn ? undefined : "bn"}>
                  {productName(r)}
                </td>
                <td>
                  <Link href={`/admin/skus/${encodeURIComponent(r.sku)}`} className="of-row-link block">
                    <span className="of-row-title block text-sm">{variantText(r)}</span>
                    <span className="block text-xs text-gray-600">SKU {r.sku}</span>
                  </Link>
                </td>
                <td className="num">{r.onHand}</td>
                <td className="num">{r.reserved}</td>
                <td className="num font-semibold">{r.available}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** A grid that never leaves one card alone on its last row: 4 cards make two rows of two, 5 or 6 make rows of three. */
const gridFor = (n: number) => (n <= 1 ? "" : n === 2 || n === 4 ? "sm:grid-cols-2" : "md:grid-cols-3");

// The Owner's daily work list. Every number is read from the database at `generatedAt`; nothing is a target or an
// estimate. Queues with work come first (the urgent ones on top); empty queues shrink to one line.
export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Access is checked before anything is sent; only then the figures stream in behind a placeholder.
  const principal = await requireAdmin("reports:read", "orders:read", "stock:read");
  const query = await searchParams;
  const rawLow = typeof query.low === "string" ? query.low : undefined;
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
      <Suspense fallback={<PageSkeleton />}>
        <DashboardBody principal={principal} rawLow={rawLow} />
      </Suspense>
    </AdminShell>
  );
}

async function DashboardBody({ principal, rawLow }: { principal: Principal; rawLow: string | undefined }) {
  let lowStockThreshold: number | null = null;
  let lowError: string | undefined;
  try {
    lowStockThreshold = parseLowStockThreshold(rawLow);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    lowError = `Enter a whole number from 1 to ${MAX_LOW_STOCK_THRESHOLD}, or leave it empty.`;
  }
  // Two independent reads, side by side (separate pool connections when the pool has them).
  const [d, setup] = await Promise.all([getDashboard(getDb(), { lowStockThreshold }), storeSetupProgress(getDb(), principal).catch(() => null)]);
  const now = d.generatedAt;
  const essential = setup ? setup.filter((s) => s.required) : [];
  const setupLeft = essential.filter((s) => !s.done);
  const byQueue = new Map(d.queues.map((q) => [q.queue, q]));
  const urgent = URGENT.map((k) => byQueue.get(k)!).filter((q) => q.count > 0);
  const flow = FLOW.map((k) => byQueue.get(k)!).filter((q) => q.count > 0);
  const quiet = [...URGENT, ...FLOW].map((k) => byQueue.get(k)!).filter((q) => q.count === 0);
  const returnsOpen = d.returns.awaitingParcel + d.returns.awaitingDecision + d.returns.approvedOpen + d.quarantine.return.count + d.quarantine.rto.count;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-600" data-testid="generated-at">
          Updated {formatTime(d.generatedAt)}
        </p>
        <RefreshButton />
      </div>

      {setupLeft.length ? (
        <Link href="/admin/onboarding" className="of-card flex items-center gap-4 px-4 py-3 hover:bg-[#fdfaf5]" data-testid="setup-card">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">
              Store setup: {essential.length - setupLeft.length} of {essential.length} essential steps done
            </span>
            <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-gray-200" aria-hidden="true">
              <span className="block h-full rounded-full bg-sf-sun" style={{ width: `${Math.round(((essential.length - setupLeft.length) / essential.length) * 100)}%` }} />
            </span>
            <span className="mt-1 block text-xs text-gray-600">Next: {setupLeft[0].title}</span>
          </span>
          <ArrowRight aria-hidden="true" size={18} className="shrink-0 text-gray-600" />
        </Link>
      ) : null}

      {d.unconfiguredZones.length ? (
        <p role="alert" className="rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-950">
          No active delivery charge for {d.unconfiguredZones.map((z) => ZONE_LABELS[z]).join(" and ")}, so orders there cannot be taken.{" "}
          <Link href="/admin/settings/delivery" className="underline">
            Set delivery charges
          </Link>
        </p>
      ) : null}

      <Section title="Order work queues">
        {urgent.length || flow.length ? null : <p className="text-sm text-gray-700">No order is waiting for you.</p>}
        {urgent.length ? (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-amber-900">Needs you now</h3>
            <ul className={`grid gap-3 ${gridFor(urgent.length)}`} aria-label="Urgent queues">
              {urgent.map((q) => (
                <QueueCard key={q.queue} q={q} now={now} urgent />
              ))}
            </ul>
          </div>
        ) : null}
        {flow.length ? (
          <div className="space-y-2">
            {urgent.length ? <h3 className="text-sm font-semibold text-gray-700">In progress</h3> : null}
            <ul className={`grid gap-3 ${gridFor(flow.length)}`} aria-label="Queues in progress">
              {flow.map((q) => (
                <QueueCard key={q.queue} q={q} now={now} urgent={false} />
              ))}
            </ul>
          </div>
        ) : null}
        {quiet.length ? (
          <div className="border-t border-gray-200 pt-3">
            <h3 className="sr-only">Empty queues</h3>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-600" aria-label="Empty queues">
              {quiet.map((q) => (
                <li key={q.queue} data-queue={q.queue} title={q.label}>
                  {TITLES[q.queue]}{" "}
                  <span className="font-semibold tabular-nums text-gray-500" data-testid={`count-${q.queue}`}>
                    {q.count}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="text-xs text-gray-600">
          Order counts are not sales: money counts once its collection and settlement are recorded (see{" "}
          <Link href="/admin/reports" className="underline">
            Reports
          </Link>
          ).
        </p>
      </Section>

      <Section title="Returns and inspection">
        {returnsOpen === 0 ? (
          <p className="text-sm text-gray-700">No open return and nothing awaiting inspection.</p>
        ) : (
          <>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="of-stat">
                <dt>Return requested, parcel not received</dt>
                <dd>{d.returns.awaitingParcel}</dd>
              </div>
              <div className="of-stat">
                <dt>Received, decision pending</dt>
                <dd>{d.returns.awaitingDecision}</dd>
              </div>
              <div className="of-stat">
                <dt>Approved, refund or completion pending</dt>
                <dd>{d.returns.approvedOpen}</dd>
              </div>
            </dl>
            {(["return", "rto"] as const).map((source) => {
              const q = d.quarantine[source];
              return (
                <div key={source} data-quarantine={source}>
                  <h3 className="text-sm font-medium">
                    {source === "return" ? "Returned goods awaiting inspection" : "RTO goods awaiting inspection"}: <span className="tabular-nums">{q.units}</span> unit
                    {q.units === 1 ? "" : "s"} in <span className="tabular-nums">{q.count}</span> line{q.count === 1 ? "" : "s"}
                    {q.count ? <span className="font-normal text-gray-600"> (not sellable until inspected)</span> : null}
                  </h3>
                  {q.count ? (
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
                  ) : null}
                </div>
              );
            })}
          </>
        )}
      </Section>

      <Section title="Stock availability">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">
            Out of stock: <span className="tabular-nums" data-testid="zero-available">{d.stock.zeroAvailable.count}</span> SKU{d.stock.zeroAvailable.count === 1 ? "" : "s"}
          </h3>
          <p className="text-xs text-gray-600">Active SKUs of products not archived. Available = on hand − reserved.</p>
        </div>
        {d.stock.zeroAvailable.count === 0 ? (
          <p className="text-sm text-gray-700">Every active SKU has at least one unit available.</p>
        ) : (
          <StockTable rows={d.stock.zeroAvailable.items} caption="SKUs with no units available" />
        )}
        {d.stock.zeroAvailable.count > d.stock.zeroAvailable.items.length ? (
          <p className="text-xs text-gray-600">
            Showing {d.stock.zeroAvailable.items.length} of {d.stock.zeroAvailable.count}. Use an export for the full list.
          </p>
        ) : null}
        <form method="get" action="/admin/dashboard" className="border-t border-gray-200 pt-4">
          <label htmlFor="low" className="block text-sm font-semibold">
            Show SKUs with at most this many available
          </label>
          <div className="mt-1.5 flex gap-2">
            <input id="low" name="low" inputMode="numeric" defaultValue={rawLow ?? ""} className="of-input w-32" aria-describedby="low-hint" />
            <button type="submit" className="of-btn of-btn-line">
              Show
            </button>
          </div>
          <p id="low-hint" className="mt-1.5 text-xs text-gray-600">
            For this view only; the system sets no low-stock level.
          </p>
        </form>
        {lowError ? (
          <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
            {lowError}
          </p>
        ) : d.stock.low ? (
          <>
            <h3 className="text-sm font-semibold">
              At most {d.stock.low.threshold} available: <span className="tabular-nums">{d.stock.low.count}</span>
            </h3>
            {d.stock.low.count === 0 ? <p className="text-sm text-gray-700">No SKU matches.</p> : <StockTable rows={d.stock.low.items} caption={`SKUs with at most ${d.stock.low.threshold} available`} />}
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
      </div>
    </>
  );
}
