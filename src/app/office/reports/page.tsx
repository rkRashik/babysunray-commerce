import Link from "next/link";
import { getDb } from "@/db/client";
import { COD_LIST_LIMIT, getCodReconciliation, getPeriodReport } from "@/modules/reports/summary";
import { OfficeShell, Section, formatTime } from "../_components/shell";
import { requireOffice } from "../_lib/session";
import { readRange } from "./_components/range";
import { CodTable, OutstandingView, PeriodReportView } from "./_components/report-view";

export const metadata = { title: "Reports · Owner Office" };

const FIELD = "mt-1 block rounded border border-gray-400 bg-white px-3 py-2 text-base focus:border-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900";

// Period report and COD reconciliation. Dates are Bangladesh calendar dates, both included; they are in the URL
// (no personal data), so a refresh or a printed copy shows the same figures.
export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOffice("reports:read");
  const query = await searchParams;
  const { range, error } = readRange(query);
  const db = getDb();
  const [report, cod] = await Promise.all([range ? getPeriodReport(db, range) : null, getCodReconciliation(db)]);

  return (
    <OfficeShell title="Reports" current="reports">
      <form method="get" action="/office/reports" className="flex flex-wrap items-end gap-3 rounded border border-gray-300 bg-white p-4">
        <div>
          <label htmlFor="from" className="block text-sm font-medium">
            From (Dhaka date)
          </label>
          <input id="from" type="date" name="from" defaultValue={range?.from ?? (typeof query.from === "string" ? query.from : "")} className={FIELD} />
        </div>
        <div>
          <label htmlFor="to" className="block text-sm font-medium">
            To (included)
          </label>
          <input id="to" type="date" name="to" defaultValue={range?.to ?? (typeof query.to === "string" ? query.to : "")} className={FIELD} />
        </div>
        <button type="submit" className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2">
          Show
        </button>
        {range ? (
          <Link href={`/office/print/cod?from=${range.from}&to=${range.to}`} className="text-sm underline">
            Printable COD reconciliation summary
          </Link>
        ) : null}
      </form>

      {error ? (
        <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
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
    </OfficeShell>
  );
}
