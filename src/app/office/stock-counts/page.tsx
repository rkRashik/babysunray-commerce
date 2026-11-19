import { randomUUID } from "node:crypto";
import Link from "next/link";
import { getDb } from "@/db/client";
import { formatCountNumber, listStockCounts, MAX_COUNT_LINES } from "@/modules/inventory/counts";
import { ActionForm, Choice, Field } from "../_components/action-form";
import { OfficeShell, Section, formatTime } from "../_components/shell";
import { requireOffice } from "../_lib/session";
import { startCountAction } from "./actions";

export const metadata = { title: "Stock counts · Owner Office" };

// Physical stock counts: start one, resume a draft, review the history. The rules are in
// src/modules/inventory/counts.ts; how often to count is the Owner's decision (none is set here).
export default async function StockCountsPage() {
  await requireOffice("stock:read", "stock:adjust");
  const counts = await listStockCounts(getDb());
  const drafts = counts.filter((c) => c.status === "draft");

  return (
    <OfficeShell title="Stock counts" current="counts">
      <p className="text-sm text-gray-700">
        Compare the units on your shelves with the system. Nothing changes until you review the differences and apply them; each correction is recorded
        as a stock adjustment with your reason.
      </p>
      {drafts.length ? (
        <p role="status" className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-950">
          {drafts.length === 1 ? "A count is" : `${drafts.length} counts are`} still in progress:{" "}
          {drafts.map((d, i) => (
            <span key={d.id}>
              {i ? ", " : ""}
              <Link href={`/office/stock-counts/${d.id}`} className="underline">
                resume {formatCountNumber(d.number)}
              </Link>
            </span>
          ))}
          .
        </p>
      ) : null}

      <Section title="Start a count">
        <ActionForm action={startCountAction} idempotencyKey={randomUUID()} submitLabel="Start count">
          <Choice
            name="scope"
            legend="What to count"
            options={[
              { value: "all", label: "Every SKU" },
              { value: "selected", label: "Only the SKUs listed below" },
            ]}
          />
          <Field name="skus" label="SKUs to count" multiline hint={`One per line (or separated by commas), at most ${MAX_COUNT_LINES}. Used only for "Only the SKUs listed below".`} />
        </ActionForm>
      </Section>

      <Section title="History">
        {counts.length === 0 ? (
          <p className="text-sm text-gray-700">No counts yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="count-history">
              <thead className="border-b border-gray-300 text-gray-600">
                <tr>
                  <th scope="col" className="py-1 pr-3">Count</th>
                  <th scope="col" className="py-1 pr-3">Status</th>
                  <th scope="col" className="py-1 pr-3">Started</th>
                  <th scope="col" className="py-1 pr-3 text-right">SKUs</th>
                  <th scope="col" className="py-1 pr-3 text-right">Counted</th>
                  <th scope="col" className="py-1 pr-3 text-right">Differences</th>
                  <th scope="col" className="py-1 text-right">Net correction</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {counts.map((c) => (
                  <tr key={c.id}>
                    <td className="py-1 pr-3">
                      <Link href={`/office/stock-counts/${c.id}`} className="underline">
                        {formatCountNumber(c.number)}
                      </Link>
                    </td>
                    <td className="py-1 pr-3">{c.status}</td>
                    <td className="py-1 pr-3 whitespace-nowrap">{formatTime(c.createdAt)}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{c.lines}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{c.countedLines}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{c.differingLines}</td>
                    <td className="py-1 text-right tabular-nums">{c.status === "applied" ? (c.netDelta > 0 ? `+${c.netDelta}` : c.netDelta) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </OfficeShell>
  );
}
