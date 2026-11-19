import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { DomainError } from "@/modules/domain-error";
import { formatCountNumber, getStockCount } from "@/modules/inventory/counts";
import { formatTime } from "../../../_components/shell";
import { requireAdmin } from "../../../_lib/session";
import { CountingConvention } from "../../../stock-counts/_components/convention";
import { PrintPage, TABLE } from "../../_components/print-page";

export const metadata = { title: "Stock count · Admin", robots: { index: false, follow: false } };

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

// A draft prints as a count sheet (system quantity at the start, an empty column to write the count in); an
// applied or discarded count prints as its reconciliation summary.
export default async function StockCountPrintPage({ params }: { params: Promise<{ countId: string }> }) {
  await requireAdmin("stock:read");
  const { countId } = await params;
  const count = await getStockCount(getDb(), countId).catch((error: unknown) => {
    if (error instanceof DomainError && (error.code === "STOCK_COUNT_NOT_FOUND" || error.code === "INVALID_INPUT")) notFound();
    throw error;
  });
  const draft = count.status === "draft";
  const applied = count.lines.filter((l) => l.appliedDelta !== null);
  return (
    <PrintPage
      title={`${draft ? "Stock count sheet" : "Stock reconciliation summary"} · ${formatCountNumber(count.number)}`}
      scope={`Started ${formatTime(count.createdAt)} · ${count.lines.length} SKUs · status ${count.status}${count.closedAt ? ` ${formatTime(count.closedAt)}` : ""}${count.reason ? ` · reason: ${count.reason}` : ""}`}
      generatedAt={new Date()}
      back={{ href: `/admin/stock-counts/${count.id}`, label: "Back to the count" }}
    >
      {draft ? <CountingConvention /> : null}
      <table className={TABLE} data-testid="count-sheet">
        <thead>
          <tr>
            <th scope="col">SKU</th>
            <th scope="col">Product</th>
            {draft ? (
              <>
                <th scope="col" className="text-right">
                  System at start
                </th>
                <th scope="col" className="text-right">
                  Reserved at start
                </th>
                <th scope="col" className="w-24">
                  Counted
                </th>
              </>
            ) : (
              <>
                <th scope="col" className="text-right">
                  System when counted
                </th>
                <th scope="col" className="text-right">
                  Counted
                </th>
                <th scope="col" className="text-right">
                  Correction
                </th>
                <th scope="col" className="text-right">
                  Movement
                </th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {count.lines.map((l) => (
            <tr key={l.variantId}>
              <td className="font-mono">{l.sku}</td>
              <td>
                {l.nameEn ?? <span lang="bn">{l.nameBn}</span>}
                {[l.size, l.colour].filter(Boolean).length ? ` · ${[l.size, l.colour].filter(Boolean).join(", ")}` : ""}
              </td>
              {draft ? (
                <>
                  <td className="text-right tabular-nums">{l.snapshotOnHand}</td>
                  <td className="text-right tabular-nums">{l.snapshotReserved}</td>
                  <td> </td>
                </>
              ) : (
                <>
                  <td className="text-right tabular-nums">{l.basisOnHand ?? "—"}</td>
                  <td className="text-right tabular-nums">{l.counted ?? "not counted"}</td>
                  <td className="text-right tabular-nums">{l.appliedDelta === null ? "—" : signed(l.appliedDelta)}</td>
                  <td className="text-right tabular-nums">{l.movementId ?? "—"}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {!draft ? (
        <p className="text-sm">
          {applied.length} SKUs applied, {applied.filter((l) => l.appliedDelta !== 0).length} corrected, net {signed(applied.reduce((n, l) => n + (l.appliedDelta ?? 0), 0))} units.
        </p>
      ) : (
        <p className="text-sm">Counted by: ____________________ Date and time: ____________________</p>
      )}
    </PrintPage>
  );
}
