import Link from "next/link";
import { getDb } from "@/db/client";
import { COD_LIST_LIMIT, getCodReconciliation, getPeriodReport } from "@/modules/reports/summary";
import { AdminShell, Section, formatTime } from "../_components/shell";
import { requireAdmin } from "../_lib/session";
import { readRange } from "./_components/range";
import { CodTable, OutstandingView, PeriodReportView } from "./_components/report-view";

export const metadata = { title: "Reports · Admin" };

const FIELD = "of-input mt-1.5 w-auto";

// Period report and COD reconciliation. Dates are Bangladesh calendar dates, both included; they are in the URL
// (no personal data), so a refresh or a printed copy shows the same figures.
export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin("reports:read");
  const query = await searchParams;
  const { range, error } = readRange(query);
  const db = getDb();
  const [report, cod] = await Promise.all([range ? getPeriodReport(db, range) : null, getCodReconciliation(db)]);

  return (
    <AdminShell title="Reports" current="reports">
      <form method="get" action="/admin/reports" className="flex flex-wrap items-end gap-3 of-card p-4 lg:p-5">
        <div>
          <label htmlFor="from" className="block text-sm font-semibold">
            From (Dhaka date)
          </label>
          <input id="from" type="date" name="from" defaultValue={range?.from ?? (typeof query.from === "string" ? query.from : "")} className={FIELD} />
        </div>
        <div>
          <label htmlFor="to" className="block text-sm font-semibold">
            To (included)
          </label>
          <input id="to" type="date" name="to" defaultValue={range?.to ?? (typeof query.to === "string" ? query.to : "")} className={FIELD} />
        </div>
        <button type="submit" className="of-btn of-btn-primary">
          Show
        </button>
        {range ? (
          <Link href={`/admin/print/cod?from=${range.from}&to=${range.to}`} className="text-sm underline">
            Printable COD reconciliation summary
          </Link>
        ) : null}
      </form>

      {error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
          {error}
        </p>
      ) : null}

      {report ? (
        <Section title={`Period ${report.range.from} to ${report.range.to}`}>
          <p className="text-sm text-gray-700" data-testid="report-scope">
            From {formatTime(report.start)} up to, not including, {formatTime(report.end)}. Figures as of {formatTime(report.generatedAt)}.
          </p>
          <PeriodReportView r={report} />
        </Section>
      ) : null}

      <Section title="COD reconciliation">
        <p className="text-sm text-gray-700">
          Every order whose COD is still open, whatever its date. Delivered does not mean collected; collected by the courier does not mean received
          by you. Figures as of {formatTime(cod.generatedAt)}.
        </p>
        <OutstandingView o={cod.outstanding} />
        {cod.rows.length === 0 ? <p className="text-sm">No order has COD money open.</p> : <CodTable rows={cod.rows} />}
        {cod.truncated ? <p className="text-sm">Only the oldest {COD_LIST_LIMIT} are listed; the totals above cover all of them. Use an export for the full list.</p> : null}
      </Section>
    </AdminShell>
  );
}
