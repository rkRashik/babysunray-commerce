import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { roleHasPermission } from "@/modules/auth/permissions";
import { DomainError } from "@/modules/domain-error";
import { type CountLineView, formatCountNumber, getStockCount } from "@/modules/inventory/counts";
import { ActionForm, Checkbox, Field } from "../../_components/action-form";
import { AdminShell, Section, formatTime, noticeFor } from "../../_components/shell";
import { requireAdmin } from "../../_lib/session";
import { CountingConvention } from "../_components/convention";
import { applyCountAction, discardCountAction, recordCountsAction } from "../actions";

export const metadata = { title: "Stock count · Admin" };

type Props = { params: Promise<{ countId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const productName = (l: CountLineView) => [l.nameEn ?? l.nameBn, l.size, l.colour].filter(Boolean).join(" · ");

export default async function StockCountPage({ params, searchParams }: Props) {
  const principal = await requireAdmin("stock:read", "stock:count");
  // Applying changes stock: only a role with stock:adjust (Manager, Owner) sees it; the action checks it again.
  const canApply = roleHasPermission(principal.role, "stock:adjust");
  const { countId } = await params;
  const { done } = await searchParams;
  const count = await getStockCount(getDb(), countId).catch((error: unknown) => {
    if (error instanceof DomainError && (error.code === "STOCK_COUNT_NOT_FOUND" || error.code === "INVALID_INPUT")) notFound();
    throw error;
  });
  const draft = count.status === "draft";
  const counted = count.lines.filter((l) => l.counted !== null);
  const differing = counted.filter((l) => l.variance !== 0);
  const stale = counted.filter((l) => l.stale);
  const hidden = { countId: count.id, version: String(count.version) };
  const ids = Object.fromEntries(count.lines.map((l, i) => [`id${i}`, l.variantId]));

  return (
    <AdminShell title={`Stock count ${formatCountNumber(count.number)}`} current="counts" notice={noticeFor(done)} breadcrumbs={[{ href: "/admin/stock-counts", label: "Stock counts" }]}>
      <p className="text-sm text-gray-700" data-testid="count-status">
        Status: <strong>{count.status}</strong> · started {formatTime(count.createdAt)} · {count.lines.length} SKU{count.lines.length === 1 ? "" : "s"}
        {count.closedAt ? ` · ${count.status} ${formatTime(count.closedAt)}` : ""} ·{" "}
        <Link href={`/admin/print/stock-counts/${count.id}`} className="underline">
          {draft ? "Print count sheet" : "Print reconciliation summary"}
        </Link>
      </p>

      {draft ? (
        <>
          <CountingConvention />
          <Section title="Enter counted units">
            <ActionForm action={recordCountsAction} idempotencyKey={randomUUID()} hidden={{ ...hidden, ...ids }} submitLabel="Save counts">
              <ul className="divide-y divide-gray-200" aria-label="SKUs in this count">
                {count.lines.map((l, i) => (
                  <li key={l.variantId} className="grid gap-2 py-3 sm:grid-cols-[1fr_12rem]" data-sku={l.sku}>
                    <div className="text-sm">
                      <Link href={`/admin/skus/${encodeURIComponent(l.sku)}`} className="font-medium underline">
                        {l.sku}
                      </Link>{" "}
                      <span lang={l.nameEn ? undefined : "bn"}>{productName(l)}</span>
                      <p className="text-gray-700">
                        System now: <span className="tabular-nums">{l.onHandNow}</span> on hand (<span className="tabular-nums">{l.reservedNow}</span> reserved,{" "}
                        <span className="tabular-nums">{l.onHandNow - l.reservedNow}</span> available)
                        {l.awaitingInspection ? ` · ${l.awaitingInspection} awaiting inspection, not counted` : ""}
                      </p>
                      {l.counted !== null ? (
                        <p className={l.stale ? "font-medium text-red-800" : "text-gray-700"} data-testid={`line-state-${l.sku}`}>
                          {l.stale
                            ? `Stock moved after you counted ${l.counted} (then ${l.basisOnHand} on hand, now ${l.onHandNow}). Recount and tick the box, or change the number.`
                            : `Counted ${l.counted} against ${l.basisOnHand} on hand: difference ${signed(l.variance ?? 0)}.`}
                        </p>
                      ) : null}
                    </div>
                    <div className="space-y-2">
                      <Field name={`count${i}`} label={`Counted units of ${l.sku}`} inputMode="numeric" defaultValue={l.counted === null ? "" : String(l.counted)} />
                      {l.stale ? <Checkbox name={`recount${i}`} label="I recounted it now" /> : null}
                    </div>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-gray-600">Leave a SKU empty if you did not count it: it is not changed when the count is applied.</p>
            </ActionForm>
          </Section>

          <Section title="Review and apply">
            <p className="text-sm" data-testid="review-summary">
              {counted.length} of {count.lines.length} counted · {differing.length} with a difference · {stale.length} to recount.
            </p>
            {differing.length ? (
              <ul className="space-y-1 text-sm" aria-label="Proposed corrections">
                {differing.map((l) => (
                  <li key={l.variantId}>
                    <span className="font-mono">{l.sku}</span>: system {l.basisOnHand}, counted {l.counted} → correction <strong className="tabular-nums">{signed(l.variance ?? 0)}</strong>
                    {l.counted !== null && l.counted < l.reservedNow ? <strong className="ml-1 text-red-800">below the {l.reservedNow} reserved units: cannot be applied</strong> : null}
                    {l.stale ? <strong className="ml-1 text-red-800">recount first</strong> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="grid gap-6 md:grid-cols-2">
              {canApply ? (
                <ActionForm action={applyCountAction} idempotencyKey={randomUUID()} hidden={hidden} submitLabel="Apply corrections">
                  <Field name="reason" label="Reason" maxLength={400} hint="Required when any count differs, for example “Monthly shelf count”. Recorded with each correction." />
                </ActionForm>
              ) : (
                <p className="text-sm text-gray-700" data-testid="apply-needs-manager">
                  When the counts are saved, ask a Store Manager or the Owner to review and apply them. Your account can count but not change stock.
                </p>
              )}
              <ActionForm action={discardCountAction} idempotencyKey={randomUUID()} hidden={hidden} submitLabel="Discard count" variant="secondary" confirm="Discard this count? Nothing in stock changes.">
                <p className="text-sm text-gray-700">Discarding closes the count without changing any stock.</p>
              </ActionForm>
            </div>
          </Section>
        </>
      ) : (
        <Section title={count.status === "applied" ? "Corrections applied" : "Discarded: nothing was changed"}>
          {count.reason ? <p className="text-sm">Reason: {count.reason}</p> : null}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="count-result">
              <thead className="border-b border-gray-300 text-gray-600">
                <tr>
                  <th scope="col" className="py-1 pr-3">SKU</th>
                  <th scope="col" className="py-1 pr-3 text-right">System when counted</th>
                  <th scope="col" className="py-1 pr-3 text-right">Counted</th>
                  <th scope="col" className="py-1 pr-3 text-right">Correction</th>
                  <th scope="col" className="py-1 text-right">On hand now</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {count.lines.map((l) => (
                  <tr key={l.variantId}>
                    <td className="py-1 pr-3 font-mono">{l.sku}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{l.basisOnHand ?? "—"}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{l.counted ?? "not counted"}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{l.appliedDelta === null ? "—" : signed(l.appliedDelta)}</td>
                    <td className="py-1 text-right tabular-nums">{l.onHandNow}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </AdminShell>
  );
}
