import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { movementCursorCodec } from "@/api/v1/schemas";
import { getDb } from "@/db/client";
import { getProductWithVariants, getVariant } from "@/modules/catalogue/service";
import { DomainError } from "@/modules/domain-error";
import { getStockLevel, listStockMovementsPage } from "@/modules/inventory/service";
import { formatPaisa } from "@/modules/money";
import { adjustStockAction, receiveStockAction } from "../../actions";
import { ActionForm, Choice, Field } from "../../_components/action-form";
import { OfficeShell, Section, formatTime, noticeFor, productTitle } from "../../_components/shell";
import { requireOffice } from "../../_lib/session";

export const metadata = { title: "Stock · Owner Office" };

type Props = { params: Promise<{ sku: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const PAGE_SIZE = 50;

export default async function SkuPage({ params, searchParams }: Props) {
  const principal = await requireOffice("stock:read");
  const { sku } = await params;
  const { done, cursor } = await searchParams;
  const db = getDb();
  const afterId = typeof cursor === "string" ? (movementCursorCodec.decode(cursor) ?? undefined) : undefined;
  const loaded = await Promise.all([getStockLevel(db, sku), listStockMovementsPage(db, sku, { limit: PAGE_SIZE, afterId })]).catch((error: unknown) => {
    if (error instanceof DomainError && (error.code === "VARIANT_NOT_FOUND" || error.code === "INVALID_INPUT")) notFound();
    throw error;
  });
  const [level, page] = loaded;
  const variant = await getVariant(db, level.variantId);
  const product = await getProductWithVariants(db, variant.productId);
  const { title, lang } = productTitle(product);
  const last = page.items.at(-1);
  const actor = (type: string, ref: string) => (type === "user" ? (ref === principal.userId ? "You" : `User ${ref.slice(0, 8)}`) : `System: ${ref}`);
  const onHandNow = (
    <p className="text-sm text-gray-700">
      On hand now: <span className="font-semibold tabular-nums">{level.onHand}</span>
    </p>
  );

  return (
    <OfficeShell
      title={`Stock · ${variant.sku}`}
      notice={noticeFor(done)}
      breadcrumbs={[
        { href: "/office", label: "Products" },
        { href: `/office/products/${product.id}`, label: title, lang },
      ]}
    >
      <Section title="Current stock">
        <p className="text-3xl font-semibold tabular-nums" data-testid="on-hand">
          {level.onHand}
        </p>
        <p className="text-sm text-gray-700">
          Units on hand. {[variant.size, variant.colour].filter(Boolean).join(", ") || "No size or colour"} · ৳ {formatPaisa(variant.pricePaisa)} · variant{" "}
          {variant.status}.
        </p>
      </Section>

      <div className="grid gap-6 md:grid-cols-2">
        <Section title="Receive stock">
          {onHandNow}
          <ActionForm action={receiveStockAction} idempotencyKey={randomUUID()} hidden={{ sku: variant.sku }} submitLabel="Record receipt">
            <Field name="quantity" label="Units received" required inputMode="numeric" hint="A whole number of units, added to stock." />
            <Field name="reason" label="Note" maxLength={500} hint="Optional, for example a delivery reference." />
          </ActionForm>
        </Section>
        <Section title="Adjust stock">
          {onHandNow}
          <ActionForm action={adjustStockAction} idempotencyKey={randomUUID()} hidden={{ sku: variant.sku }} submitLabel="Record adjustment">
            <Choice
              name="direction"
              legend="Change"
              options={[
                { value: "add", label: "Add units" },
                { value: "remove", label: "Remove units" },
              ]}
            />
            <Field name="units" label="Units" required inputMode="numeric" hint="A whole number. Stock cannot go below zero." />
            <Field name="reason" label="Reason" required maxLength={500} hint="Recorded with your name, for example a recount or damage." />
          </ActionForm>
        </Section>
      </div>

      <Section title="Movement history (oldest first)">
        {page.items.length === 0 ? (
          <p className="text-sm text-gray-700">No movements yet. Receipts and adjustments appear here with who made them.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-300 text-gray-600">
                <tr>
                  <th scope="col" className="py-2 pr-3">When</th>
                  <th scope="col" className="py-2 pr-3">Type</th>
                  <th scope="col" className="py-2 pr-3 text-right">Change</th>
                  <th scope="col" className="py-2 pr-3">Reason</th>
                  <th scope="col" className="py-2">By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {page.items.map((m) => (
                  <tr key={m.id}>
                    <td className="py-2 pr-3 whitespace-nowrap">{formatTime(m.createdAt)}</td>
                    <td className="py-2 pr-3">{m.movementType}</td>
                    <td className={`py-2 pr-3 text-right font-medium tabular-nums ${m.quantityDelta > 0 ? "text-green-800" : "text-red-800"}`}>
                      {m.quantityDelta > 0 ? `+${m.quantityDelta}` : m.quantityDelta}
                      <span className="sr-only">{m.quantityDelta > 0 ? " added" : " removed"}</span>
                    </td>
                    <td className="py-2 pr-3 break-words">{m.reason ?? "—"}</td>
                    <td className="py-2">{actor(m.actorType, m.actorRef)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {page.hasMore && last ? (
          <Link href={`?cursor=${movementCursorCodec.encode(last.id)}`} className="inline-block text-sm underline">
            Next page
          </Link>
        ) : null}
        {afterId !== undefined ? (
          <Link href={`/office/skus/${encodeURIComponent(variant.sku)}`} className="ml-4 inline-block text-sm underline">
            First page
          </Link>
        ) : null}
      </Section>
    </OfficeShell>
  );
}
