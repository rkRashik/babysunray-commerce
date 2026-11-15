import { getDb } from "@/db/client";
import { COD_LIST_LIMIT, getCodReconciliation, getPeriodReport } from "@/modules/reports/summary";
import { formatTime } from "../../_components/shell";
import { requireOffice } from "../../_lib/session";
import { readRange } from "../../reports/_components/range";
import { CodTable, OutstandingView, PeriodReportView } from "../../reports/_components/report-view";
import { PrintPage } from "../_components/print-page";

export const metadata = { title: "COD reconciliation · Owner Office", robots: { index: false, follow: false } };

// Printable period report and COD reconciliation summary. Routine document: order numbers and amounts only.
export default async function CodPrintPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOffice("reports:read");
  const { range, error } = readRange(await searchParams);
  const db = getDb();
  const [report, cod] = await Promise.all([range ? getPeriodReport(db, range) : null, getCodReconciliation(db)]);
  return (
    <PrintPage
      title="COD reconciliation summary"
      scope={report ? `Period ${report.range.from} to ${report.range.to} (Dhaka dates, both included): ${formatTime(report.start)} up to, not including, ${formatTime(report.end)}.` : error}
      generatedAt={cod.generatedAt}
      back={{ href: range ? `/office/reports?from=${range.from}&to=${range.to}` : "/office/reports", label: "Back to reports" }}
    >
      {report ? <PeriodReportView r={report} /> : null}
      <OutstandingView o={cod.outstanding} />
      {cod.rows.length === 0 ? <p>No order has COD money open.</p> : <CodTable rows={cod.rows} links={false} />}
      {cod.truncated ? <p className="text-sm">Only the oldest {COD_LIST_LIMIT} orders are listed; the totals cover all of them.</p> : null}
    </PrintPage>
  );
}
