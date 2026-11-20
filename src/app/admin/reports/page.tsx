import { Printer } from "lucide-react";
import { Suspense } from "react";
import Link from "next/link";
import { getDb } from "@/db/client";
import { dhakaToday } from "@/modules/orders/rules";
import type { DateRange } from "@/modules/reports/dates";
import { COD_LIST_LIMIT, getCodReconciliation, getPeriodReport } from "@/modules/reports/summary";
import { RefreshButton } from "../_components/refresh-button";
import { PageSkeleton } from "../_components/skeleton";
import { ScrollArea } from "../_components/scroll-area";
import { AdminShell, Section, formatTime } from "../_components/shell";
import { requireAdmin } from "../_lib/session";
import { rangePresets, readRange } from "./_components/range";
import { CodMoneySection, CodTable, CostsStockSection, KpiTiles, OrdersSection, OutstandingView } from "./_components/report-view";

export const metadata = { title: "Reports · Admin" };

const TABS = [
  { id: "orders", label: "Orders & performance" },
  { id: "cod", label: "COD & reconciliation" },
  { id: "inventory", label: "Inventory & costs" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const day = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
const dateText = (date: string) => day.format(new Date(`${date}T00:00:00Z`));

// Period report and COD reconciliation. Dates are Bangladesh calendar dates, both included; they are in the URL
// (no personal data), so a refresh or a printed copy shows the same figures.
export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin("reports:read");
  const query = await searchParams;
  const { range, error } = readRange(query);
  const presets = rangePresets(dhakaToday());
  const tab: Tab = TABS.find((t) => t.id === query.tab)?.id ?? "orders";

  return (
    <AdminShell
      title="Reports"
      current="reports"
      wide
      actions={
        range ? (
          <Link href={`/admin/print/cod?from=${range.from}&to=${range.to}`} className="of-btn of-btn-line">
            <Printer aria-hidden="true" size={18} />
            Printable reconciliation
          </Link>
        ) : null
      }
    >
      <div className="of-card space-y-3 p-4 lg:p-5">
        <nav aria-label="Quick date ranges">
          <ul className="flex flex-wrap gap-2">
            {presets.map((p) => {
              const active = range?.from === p.range.from && range?.to === p.range.to;
              return (
                <li key={p.label}>
                  <Link href={`/admin/reports?from=${p.range.from}&to=${p.range.to}&tab=${tab}`} aria-current={active ? "page" : undefined} className="of-chip">
                    {p.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <form method="get" action="/admin/reports" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="tab" value={tab} />
          <div>
            <label htmlFor="from" className="block text-sm font-semibold">
              From
            </label>
            <input id="from" type="date" name="from" defaultValue={range?.from ?? (typeof query.from === "string" ? query.from : "")} className="of-input mt-1.5 w-auto" />
          </div>
          <div>
            <label htmlFor="to" className="block text-sm font-semibold">
              To (included)
            </label>
            <input id="to" type="date" name="to" defaultValue={range?.to ?? (typeof query.to === "string" ? query.to : "")} className="of-input mt-1.5 w-auto" />
          </div>
          <button type="submit" className="of-btn of-btn-ink">
            Show
          </button>
          <span className="pb-3 text-xs text-gray-600">Bangladesh dates.</span>
        </form>
      </div>

      {error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
          {error}
        </p>
      ) : null}

      <Suspense fallback={<PageSkeleton cards={5} />}>
        <ReportBody range={range} tab={tab} />
      </Suspense>
    </AdminShell>
  );
}

async function ReportBody({ range, tab }: { range: DateRange | null; tab: Tab }) {
  const db = getDb();
  const [report, cod] = await Promise.all([range ? getPeriodReport(db, range) : null, getCodReconciliation(db)]);
  const tabHref = (id: Tab) => `/admin/reports?from=${range?.from ?? ""}&to=${range?.to ?? ""}&tab=${id}`;
  return (
    <>
      {!cod.outstanding.reconciled ? (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
          The COD payment entries and the orders&apos; running totals disagree. Do not rely on COD figures until this is looked into. Details are under COD &amp; reconciliation.
        </p>
      ) : null}

      {report ? (
        <Section title={`${dateText(report.range.from)} – ${dateText(report.range.to)}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-gray-600" data-testid="report-scope">
              From {formatTime(report.start)} up to, not including, {formatTime(report.end)}. Figures as of {formatTime(report.generatedAt)}.
            </p>
            <RefreshButton />
          </div>
          <KpiTiles r={report} />
          <ScrollArea label="Report section tabs" fade>
          <nav aria-label="Report sections">
            <ul className="flex gap-1 border-b border-gray-300">
              {TABS.map((t) => (
                <li key={t.id} className="shrink-0">
                  <Link href={tabHref(t.id)} aria-current={t.id === tab ? "page" : undefined} className="of-ltab no-underline">
                    {t.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          </ScrollArea>
          {tab === "orders" ? <OrdersSection r={report} charts /> : null}
          {tab === "cod" ? <CodMoneySection r={report} /> : null}
          {tab === "inventory" ? <CostsStockSection r={report} /> : null}
        </Section>
      ) : null}

      {tab === "cod" || !report ? (
        <Section title="COD reconciliation">
          <p className="text-sm text-gray-700">
            Every order with COD money still open, whatever its date. Delivered is not collected, and collected by the courier is not yet received by you. Figures as
            of {formatTime(cod.generatedAt)}.
          </p>
          <OutstandingView o={cod.outstanding} charts />
          {cod.rows.length === 0 ? <p className="text-sm text-gray-700">No order has COD money open.</p> : <CodTable rows={cod.rows} />}
          {cod.truncated ? <p className="text-sm">Only the oldest {COD_LIST_LIMIT} are listed; the totals above cover all of them. Use an export for the full list.</p> : null}
        </Section>
      ) : null}
    </>
  );
}
