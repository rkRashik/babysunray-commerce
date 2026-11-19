import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { formatCentimetres, MEASUREMENT_POINTS } from "@/modules/catalogue/content";
import { evaluateReadiness } from "@/modules/catalogue/readiness";
import { reviewHistory, reviewStates } from "@/modules/catalogue/review";
import { getProductWithVariants } from "@/modules/catalogue/service";
import { DomainError } from "@/modules/domain-error";
import { getStockLevel } from "@/modules/inventory/service";
import { formatPaisa } from "@/modules/money";
import { archiveProductAction, createVariantAction, deactivateVariantAction, reviewProductAction } from "../../actions";
import { ActionForm, Field } from "../../_components/action-form";
import { Bilingual, ReadinessList } from "../../_components/content";
import { MEASUREMENT_LABELS } from "../../_lib/labels";
import { OfficeShell, Section, formatTime, noticeFor, productTitle } from "../../_components/shell";
import { requireOffice } from "../../_lib/session";

export const metadata = { title: "Product · Owner Office" };

type Props = { params: Promise<{ productId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const BUTTON_LINK = "of-btn of-btn-line min-h-10 px-3.5 text-sm";

export default async function ProductPage({ params, searchParams }: Props) {
  await requireOffice("catalog:read", "stock:read");
  const { productId } = await params;
  const db = getDb();
  const product = await getProductWithVariants(db, productId).catch((error: unknown) => {
    if (error instanceof DomainError && (error.code === "PRODUCT_NOT_FOUND" || error.code === "INVALID_INPUT")) notFound();
    throw error;
  });
  const stock = await Promise.all(product.variants.map((v) => getStockLevel(db, v.sku)));
  const review = (await reviewStates(db, [product.id])).get(product.id);
  const history = await reviewHistory(db, product.id);
  const { done } = await searchParams;
  const draft = product.status === "draft";
  const { title, lang } = productTitle(product);

  return (
    <OfficeShell title={title} titleLang={lang} notice={noticeFor(done)} breadcrumbs={[{ href: "/office", label: "Products" }]}>
      <Section title="Details">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-gray-600">Status</dt>
          <dd>{draft ? "draft (not shown to customers)" : `${product.status} (cannot be edited)`}</dd>
          <dt className="text-gray-600">Slug</dt>
          <dd className="break-all">{product.slug}</dd>
          <Bilingual label="Name" en={product.nameEn} bn={product.nameBn} />
          <Bilingual label="Description" en={product.descriptionEn} bn={product.descriptionBn} />
          <Bilingual label="Fabric" en={product.fabricEn} bn={product.fabricBn} />
          <dt className="text-gray-600">Fabric statement</dt>
          <dd data-testid="fabric-confirmation">{product.fabricConfirmedAt ? `Confirmed by you on ${formatTime(product.fabricConfirmedAt)}` : "Not confirmed"}</dd>
          <Bilingual label="Care" en={product.careEn} bn={product.careBn} />
          <Bilingual label="Size guidance (optional)" en={product.sizeGuidanceEn} bn={product.sizeGuidanceBn} />
          <dt className="text-gray-600">Category</dt>
          <dd>{product.category ? (product.category.nameEn ?? <span lang="bn">{product.category.nameBn}</span>) : "—"}</dd>
          <dt className="text-gray-600">Featured</dt>
          <dd>{product.featured ? "Yes (shown first in the storefront preview)" : "No"}</dd>
          <dt className="text-gray-600">Created</dt>
          <dd>{formatTime(product.createdAt)}</dd>
          <dt className="text-gray-600">Last changed</dt>
          <dd>{formatTime(product.updatedAt)}</dd>
        </dl>
        <div className="flex flex-wrap gap-2">
          {draft ? (
            <Link href={`/office/products/${product.id}/edit`} className={BUTTON_LINK}>
              Edit details
            </Link>
          ) : null}
          <Link href={`/office/storefront-preview/en/products/${product.slug}`} className={BUTTON_LINK}>
            View in storefront preview
          </Link>
        </div>
      </Section>

      <Section title="Publishing readiness">
        <ReadinessList items={evaluateReadiness(product)} />
      </Section>

      <Section title="Internal review">
        <p className="text-sm" data-testid="review-state">
          {!review?.reviewedAt
            ? "Not reviewed yet."
            : review.current
              ? `Reviewed on ${formatTime(review.reviewedAt)}; the content has not changed since.`
              : `Outdated: reviewed on ${formatTime(review.reviewedAt)}, and the content (text, claims, sizes, photos, SKUs or prices) has changed since.`}
        </p>
        <p className="text-xs text-gray-600">
          A review records that you checked this content as it is now. It does not publish the product or make it visible to anyone; no publication rule is approved.
        </p>
        {draft && !review?.current && review ? (
          <ActionForm action={reviewProductAction} idempotencyKey={randomUUID()} hidden={{ productId: product.id, contentSha256: review.contentSha256 }} submitLabel="Mark the current content as reviewed" variant="secondary" />
        ) : null}
        {history.length ? (
          <details className="text-sm">
            <summary className="cursor-pointer font-medium">Review history ({history.length})</summary>
            <ul className="mt-2 space-y-1">
              {history.map((h) => (
                <li key={h.id}>
                  {formatTime(h.createdAt)} by the Owner{(h.openItems as string[]).length ? ` · open then: ${(h.openItems as string[]).join(", ")}` : " · nothing open"}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </Section>

      <Section title="Size chart (cm)">
        {product.measurements.length === 0 ? (
          <p className="text-sm text-gray-700">No measurements yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="text-left text-sm">
              <thead className="border-b border-gray-300 text-gray-600">
                <tr>
                  <th scope="col" className="py-2 pr-4">Size</th>
                  {MEASUREMENT_POINTS.filter((p) => product.measurements.some((m) => m.point === p)).map((p) => (
                    <th key={p} scope="col" className="py-2 pr-4 text-right">{MEASUREMENT_LABELS[p]}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {[...new Set(product.measurements.map((m) => m.size))].map((size) => (
                  <tr key={size}>
                    <th scope="row" className="py-2 pr-4 font-normal">{size}</th>
                    {MEASUREMENT_POINTS.filter((p) => product.measurements.some((m) => m.point === p)).map((p) => {
                      const m = product.measurements.find((x) => x.size === size && x.point === p);
                      return <td key={p} className="py-2 pr-4 text-right tabular-nums">{m ? formatCentimetres(m.valueMm) : "—"}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {draft ? (
          <Link href={`/office/products/${product.id}/measurements`} className={BUTTON_LINK}>
            Edit size chart
          </Link>
        ) : null}
      </Section>

      <Section title="Photos">
        {product.media.length === 0 ? (
          <p className="text-sm text-gray-700">No photos yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-3" aria-label="Photos">
            {product.media.map((m) => (
              <li key={m.id}>
                {/* Private photos are served by an Owner-only route; Next.js image optimisation would fetch them without the session. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/office/media/${m.id}?w=320`} alt={m.altEn ?? "Product photo (no English description yet)"} width={120} height={Math.round((120 * m.height) / m.width)} className="rounded border border-gray-300 bg-gray-100 object-cover" />
              </li>
            ))}
          </ul>
        )}
        <Link href={`/office/products/${product.id}/photos`} className={BUTTON_LINK}>
          {draft ? "Manage photos" : "View photos"}
        </Link>
      </Section>

      <Section title="Variants and stock">
        {product.variants.length === 0 ? (
          <p className="text-sm text-gray-700">No variants yet. Add one below; each variant is a SKU with its own price and stock.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-300 text-gray-600">
                <tr>
                  <th scope="col" className="py-2 pr-3">SKU</th>
                  <th scope="col" className="py-2 pr-3">Size</th>
                  <th scope="col" className="py-2 pr-3">Colour</th>
                  <th scope="col" className="py-2 pr-3 text-right">Price (BDT)</th>
                  <th scope="col" className="py-2 pr-3 text-right">On hand</th>
                  <th scope="col" className="py-2 pr-3">Status</th>
                  <th scope="col" className="py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {product.variants.map((v, i) => (
                  <tr key={v.id}>
                    <th scope="row" className="py-2 pr-3 font-normal">
                      <Link href={`/office/skus/${encodeURIComponent(v.sku)}`} className="font-medium underline">
                        {v.sku}
                      </Link>
                    </th>
                    <td className="py-2 pr-3">{v.size ?? "—"}</td>
                    <td className="py-2 pr-3">{v.colour ?? "—"}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">৳ {formatPaisa(v.pricePaisa)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{stock[i].onHand}</td>
                    <td className="py-2 pr-3">{v.status}</td>
                    <td className="py-2">
                      {v.status === "active" ? (
                        <div className="flex flex-wrap items-start gap-2">
                          {draft ? (
                            <Link href={`/office/variants/${v.id}/edit`} className={BUTTON_LINK} aria-label={`Edit ${v.sku}`}>
                              Edit
                            </Link>
                          ) : null}
                          <ActionForm
                            action={deactivateVariantAction}
                            idempotencyKey={randomUUID()}
                            hidden={{ variantId: v.id }}
                            submitLabel="Deactivate"
                            variant="secondary"
                            confirm={`Deactivate ${v.sku}? It keeps its stock and history, but there is no way to reactivate it here.`}
                          />
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Add a variant">
        <ActionForm action={createVariantAction} idempotencyKey={randomUUID()} hidden={{ productId: product.id }} submitLabel="Add variant">
          <Field name="sku" label="SKU" required maxLength={64} hint="Letters A-Z, digits, hyphen and underscore; stored in capitals; must be unique. Cannot be changed later." />
          <Field name="size" label="Size" maxLength={64} />
          <Field name="colour" label="Colour" maxLength={64} />
          <Field name="priceTaka" label="Price (BDT)" required inputMode="decimal" hint="In Taka, for example 850 or 850.50. Stored exactly in paisa." />
        </ActionForm>
      </Section>

      {draft ? (
        <Section title="Archive">
          <p className="text-sm text-gray-700">
            Archiving keeps the product, its variants and their stock history. Nothing is deleted, but an archived product can no longer be edited and there is no way to
            undo archiving here.
          </p>
          <ActionForm
            action={archiveProductAction}
            idempotencyKey={randomUUID()}
            hidden={{ productId: product.id }}
            submitLabel="Archive product"
            variant="secondary"
            confirm="Archive this product? It can no longer be edited afterwards, and archiving cannot be undone here."
          />
        </Section>
      ) : null}
    </OfficeShell>
  );
}
