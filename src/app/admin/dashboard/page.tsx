import { AlertTriangle, ArrowRight, BarChart3, CheckCircle2, CircleX, type LucideIcon, PackageCheck, PackageX, PhoneCall, Plus, Printer, SearchCheck, Truck, Wallet } from "lucide-react";
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
const URGENT: OrderQueue[] = ["overdue", "cancellation_requests", "payment_to_verify", "refund_due", "pending"];
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
  payment_to_verify: "Payments to verify",
  refund_due: "Advance refunds due",
};

type Queue = Dashboard["queues"][number];

function detail(queue: OrderQueue, o: Queue["oldest"][number], now: Date) {
  if (queue === "pending" || queue === "overdue") return `deadline ${relative(o.verificationExpiresAt, now)}`;
  if (queue === "awaiting_collection") return `${bdt(o.totalPaisa - o.codCollectedPaisa - o.advanceReceivedPaisa)} to collect`;
  if (queue === "refund_due") return `${bdt(o.advanceReceivedPaisa - o.advanceRefundedPaisa)} to refund`;
  if (queue === "unsettled") return `${bdt(o.codCollectedPaisa - o.codSettledPaisa - o.codDeductedPaisa)} with courier`;
  return o.createdAt.getTime() >= now.getTime() - 60_000 ? "placed just now" : `placed ${relative(o.createdAt, now)}`;
}

// What each urgent queue means and what to do about it, in the Owner's words.
const WHY: Partial<Record<OrderQueue, { why: string; action: string }>> = {
  overdue: { why: "Past the 24-hour verification window. Call, then confirm (stock is checked again) or cancel.", action: "Review overdue" },
  cancellation_requests: { why: "Approve or reject each request; a packed order cannot be dispatched until you decide.", action: "Review requests" },
  pending: { why: "Verify each with the customer before its 24-hour deadline, then confirm.", action: "Verify orders" },
  payment_to_verify: { why: "A customer sent a transfer reference. Check your bKash, Nagad or bank account, then verify or reject it. Nothing counts as paid until you do.", action: "Check payments" },
  refund_due: { why: "These cancelled orders hold advance money you verified. Pay it back by hand, then record the refund.", action: "Review refunds" },
};
const URGENT_TITLE: Partial<Record<OrderQueue, (n: number, plural: (n: number, word: string) => string) => string>> = {
  overdue: (n, p) => `${p(n, "order")} past the verification deadline`,
  pending: (n, p) => `${p(n, "order")} to verify`,
  cancellation_requests: (n, p) => p(n, "cancellation request"),
  payment_to_verify: (n, p) => `${p(n, "order")} with a payment reference to verify`,
  refund_due: (n, p) => `${p(n, "cancelled order")} with an advance to refund`,
};

type Attention = { key: string; tone: "bad" | "wait"; icon: LucideIcon; count: number; title: string; why: string; href: string; action: string; queue?: OrderQueue; orders?: React.ReactNode };

/** One thing that needs the Owner: what happened (count and title), why it matters, the oldest orders, and where to act. */
function AttentionRow({ a }: { a: Attention }) {
  const Icon = a.icon;
  return (
    <li className="flex flex-col gap-3 py-3.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center" data-queue={a.queue}>
      <span className="flex min-w-0 flex-1 gap-3">
        <span className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${a.tone === "bad" ? "bg-red-50 text-red-800" : "bg-amber-50 text-amber-900"}`} aria-hidden="true">
          <Icon size={18} strokeWidth={2} />
        </span>
        <span className="min-w-0 space-y-0.5">
          <span className="block font-semibold">
            <span className="tabular-nums" data-testid={a.queue ? `count-${a.queue}` : undefined}>
              {a.count}
            </span>{" "}
            {a.title}
          </span>
          <span className="block text-sm text-gray-700">{a.why}</span>
          {a.orders}
        </span>
      </span>
      {/* Urgent work gets the filled button; the rest an outline, so the eye goes to the overdue and the problems first. */}
      <Link href={a.href} className={`of-btn of-btn-sm self-start sm:self-center ${a.tone === "bad" ? "of-btn-ink" : "of-btn-line"}`}>
        {a.action}
        <ArrowRight aria-hidden="true" size={16} />
      </Link>
    </li>
  );
}

/** A queue of the day's work: how many, what it is, and the way to the list. */
function QueueTile({ q }: { q: Queue }) {
  const empty = q.count === 0;
  return (
    <li
      className={`of-card relative flex flex-col gap-0.5 p-4 ${empty ? "bg-transparent" : "hover:bg-[#fdfaf5] has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-gray-900"}`}
      data-queue={q.queue}
    >
      <span className={`text-[1.75rem] leading-tight font-bold tabular-nums ${empty ? "text-gray-500" : ""}`} data-testid={`count-${q.queue}`}>
        {q.count}
      </span>
      <h3 className={`font-semibold ${empty ? "text-gray-600" : ""}`}>{TITLES[q.queue]}</h3>
      <p className="text-xs text-gray-600">{q.label}</p>
      {empty ? null : (
        // The link covers the whole card (::after), so the card is one large target; its text stays the link's name.
        <Link href={`/admin/orders?queue=${q.queue}`} className="mt-auto inline-flex min-h-11 items-center gap-1 pt-1 text-sm font-semibold underline-offset-4 after:absolute after:inset-0 after:rounded-[inherit] hover:underline focus-visible:outline-none lg:min-h-9">
          Show all {q.count}
          <span className="sr-only"> ({q.label})</span>
          <ArrowRight aria-hidden="true" size={16} />
        </Link>
      )}
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


// The Owner's daily work list. Every number is read from the database at `generatedAt`; nothing is a target or an
// estimate. First what needs the Owner (each with why it matters and where to act), then the orders moving through
// the day's work, shortcuts, returns and stock.
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
        <>
          <Link href="/admin/products/new" className="of-btn of-btn-line">
            <Plus aria-hidden="true" size={18} strokeWidth={2} />
            Add product
          </Link>
          <Link href="/admin/orders/new" className="of-btn of-btn-primary">
            <Plus aria-hidden="true" size={18} strokeWidth={2} />
            New order
          </Link>
        </>
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
  const urgent = URGENT.map((k) => byQueue.get(k)!);
  const returnsOpen = d.returns.awaitingParcel + d.returns.awaitingDecision + d.returns.approvedOpen + d.quarantine.return.count + d.quarantine.rto.count;
  const inspection = d.quarantine.return.units + d.quarantine.rto.units;
  const plural = (n: number, word: string) => `${word}${n === 1 ? "" : "s"}`;
  const attention: Attention[] = [
    ...urgent
      .filter((q) => q.count > 0)
      .map(
        (q): Attention => ({
          key: q.queue,
          queue: q.queue,
          tone: q.queue === "pending" ? "wait" : "bad",
          icon: q.queue === "pending" ? PhoneCall : q.queue === "overdue" ? AlertTriangle : q.queue === "payment_to_verify" || q.queue === "refund_due" ? Wallet : CircleX,
          count: q.count,
          title: URGENT_TITLE[q.queue]!(q.count, plural),
          why: WHY[q.queue]!.why,
          href: `/admin/orders?queue=${q.queue}`,
          action: WHY[q.queue]!.action,
          orders: (
            <span className="block text-sm text-gray-700">
              Oldest:{" "}
              {q.oldest.slice(0, 3).map((o, i) => (
                <span key={o.id}>
                  {i ? ", " : null}
                  <Link prefetch={false} href={`/admin/orders/${o.id}`} className="inline-flex min-h-11 items-center font-medium underline underline-offset-4 lg:min-h-0">
                    {formatOrderNumber(o.number)}
                  </Link>{" "}
                  <span className="text-gray-600">({detail(q.queue, o, now)})</span>
                </span>
              ))}
            </span>
          ),
        }),
      ),
  ];
  if (d.unconfiguredZones.length)
    attention.push({
      key: "zones",
      tone: "bad",
      icon: Truck,
      count: d.unconfiguredZones.length,
      title: plural(d.unconfiguredZones.length, "delivery zone") + " without a charge",
      why: `${d.unconfiguredZones.map((z) => ZONE_LABELS[z]).join(" and ")} cannot take orders until you set an active delivery charge.`,
      href: "/admin/settings/delivery",
      action: "Set delivery charges",
    });
  if (d.stock.zeroAvailable.count)
    attention.push({
      key: "stock",
      tone: "wait",
      icon: PackageX,
      count: d.stock.zeroAvailable.count,
      title: plural(d.stock.zeroAvailable.count, "SKU") + " out of stock",
      why: "No unit is available, so customers cannot buy these sizes. Receive stock on each SKU's page when it arrives.",
      href: "#section-stock-availability",
      action: "See which",
    });
  if (inspection)
    attention.push({
      key: "inspection",
      tone: "wait",
      icon: SearchCheck,
      count: inspection,
      title: plural(inspection, "returned unit") + " awaiting inspection",
      why: "Returned and RTO goods cannot be sold until you inspect them: pass them back into stock or keep them out.",
      href: "#section-returns-and-inspection",
      action: "See returns",
    });
  const clear = urgent.filter((q) => q.count === 0);

  return (
    <>
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

      <Section
        title="Needs attention"
        action={
          // When the figures were read, beside the heading (one row less above the day's work).
          <span className="flex items-center gap-2">
            <span className="text-sm text-gray-600" data-testid="generated-at">
              Updated {formatTime(d.generatedAt)}
            </span>
            <RefreshButton />
          </span>
        }
      >
        {attention.length ? (
          <ul className="divide-y divide-gray-200" aria-label="Things that need you">
            {attention.map((a) => (
              <AttentionRow key={a.key} a={a} />
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 text-sm text-gray-700">
            <CheckCircle2 aria-hidden="true" size={18} className="text-green-700" />
            Nothing needs you right now.
          </p>
        )}
        {clear.length ? (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 border-t border-gray-200 pt-3 text-sm text-gray-600" aria-label="Also checked, nothing waiting">
            {clear.map((q) => (
              <li key={q.queue} data-queue={q.queue} title={q.label}>
                {TITLES[q.queue]}{" "}
                <span className="font-semibold tabular-nums text-gray-500" data-testid={`count-${q.queue}`}>
                  {q.count}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <section aria-labelledby="flow-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="flow-heading" className="text-[1.0625rem] font-bold">
            Orders in progress
          </h2>
          <p className="text-xs text-gray-600">Order counts are not sales: money counts once its collection and settlement are recorded.</p>
        </div>
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-3" aria-label="Queues in progress">
          {FLOW.map((k) => (
            <QueueTile key={k} q={byQueue.get(k)!} />
          ))}
        </ul>
      </section>

      <nav aria-label="Shortcuts" className="flex flex-wrap gap-2">
        <Link href="/admin/print/picking" className="of-btn of-btn-line of-btn-sm">
          <Printer aria-hidden="true" size={16} />
          Picking list
        </Link>
        <Link href="/admin/reports" className="of-btn of-btn-line of-btn-sm">
          <BarChart3 aria-hidden="true" size={16} />
          Reports and COD reconciliation
        </Link>
        <Link href="/admin/stock-counts" className="of-btn of-btn-line of-btn-sm">
          <PackageCheck aria-hidden="true" size={16} />
          Stock counts
        </Link>
      </nav>

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
          {/* One tap for the usual views; any other number in the field. A view only: the system sets no low-stock level. */}
          <nav aria-label="Low stock views" className="mb-3">
            <ul className="flex flex-wrap gap-2">
              {[3, 5, 10].map((n) => (
                <li key={n}>
                  <Link href={`/admin/dashboard?low=${n}#section-stock-availability`} aria-current={d.stock.low?.threshold === n ? "page" : undefined} className="of-chip">
                    At most {n} available
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <label htmlFor="low" className="block text-sm font-semibold">
            Or show SKUs with at most this many available
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

    </>
  );
}
