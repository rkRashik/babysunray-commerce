import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { formatCentimetres, MEASUREMENT_POINTS } from "@/modules/catalogue/content";
import { publicationHistory, publicationRuleFor, publicationState } from "@/modules/catalogue/publication";
import { evaluateReadiness, READINESS_ITEMS } from "@/modules/catalogue/readiness";
import { reviewHistory, reviewStates } from "@/modules/catalogue/review";
import { getProductWithVariants } from "@/modules/catalogue/service";
import { DomainError } from "@/modules/domain-error";
import { getStockLevel } from "@/modules/inventory/service";
import { archiveProductAction, createVariantAction, deactivateVariantAction, publishProductAction, reviewProductAction, withdrawProductAction } from "../../actions";
import { ActionForm, Field } from "../../_components/action-form";
import { Bilingual, ReadinessList } from "../../_components/content";
import { MEASUREMENT_LABELS } from "../../_lib/labels";
import { AdminShell, Section, formatTime, noticeFor, productTitle } from "../../_components/shell";
import { requireAdmin } from "../../_lib/session";
import { bdt } from "../../orders/_components/labels";
import { ScrollArea } from "../../_components/scroll-area";

export const metadata = { title: "Product · Admin" };

type Props = { params: Promise<{ productId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const BUTTON_LINK = "of-btn of-btn-line min-h-10 px-3.5 text-sm";

/** Why a product cannot be published, in the Owner's words (codes from publicationBlockers). */
function blockerText(code: string): string {
  if (code === "no_approved_rule") return "Publishing is off until you approve your publication requirements (Settings, Publication requirements).";
  if (code === "not_draft") return "Only a draft can be published.";
  if (code === "review_not_current") return "Mark the current content as reviewed first (above).";
  const item = READINESS_ITEMS.find((i) => `item:${i.id}` === code);
  return item ? `Missing: ${item.label}.` : code;
}

export default async function ProductPage({ params, searchParams }: Props) {
  await requireAdmin("catalog:read", "stock:read");
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
  const rule = await publicationRuleFor(db);
  const publication = await publicationState(db, product.id, rule);
  const published = await publicationHistory(db, product.id);
  const draft = product.status === "draft";
  const { title, lang } = productTitle(product);

  return (
    <AdminShell
      title={title}
      titleLang={lang}
      notice={noticeFor(done)}
      breadcrumbs={[{ href: "/admin", label: "Products" }]}
      actions={
        <>
          <Link href={`/admin/storefront-preview/en/products/${product.slug}`} className="of-btn of-btn-line">
            View in storefront preview
          </Link>
          {draft ? (
            <Link href={`/admin/products/${product.id}/edit`} className="of-btn of-btn-primary">
              Edit details
            </Link>
          ) : null}
        </>
      }
    >
      <Section title="Details">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-gray-600">Status</dt>
          <dd>{draft ? "draft (not shown to customers)" : `${product.status} (cannot be edited)`}</dd>
          <dt className="text-gray-600">Web address</dt>
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
      </Section>

      <Section title="Publishing readiness">
        <ReadinessList items={evaluateReadiness(product)} rule={rule} />
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
          A review records that you checked this content as it is now. It does not publish the product or make it visible to anyone.
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

      <Section title="Publication">
        <p className="text-sm" data-testid="publication-state">
          {product.status === "published"
            ? "Published: customers who can open the shop see this product. It cannot be edited until you withdraw it."
            : product.status === "archived"
              ? "Archived: never shown to customers."
              : "Draft: not shown to customers."}
        </p>
        <p className="text-xs text-gray-600" data-testid="publication-rule">
          {rule === null
            ? "Publishing is off until you approve your publication requirements (Settings, Publication requirements)."
            : rule.id === "i6-proposed-acceptance"
              ? "Test shop (staging database): a trial set of requirements applies (every checklist item above and a current review). It is not your approved set; each publication records it."
              : "Your approved publication requirements apply."}
        </p>
        {draft && publication.blockers.length ? (
          <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="publication-blockers">
            {publication.blockers.map((b) => (
              <li key={b}>{blockerText(b)}</li>
            ))}
          </ul>
        ) : null}
        {draft && publication.blockers.length === 0 ? (
          <ActionForm
            action={publishProductAction}
            idempotencyKey={randomUUID()}
            hidden={{ productId: product.id, contentSha256: publication.contentSha256 }}
            submitLabel="Publish to the shop"
            confirm="Publish this product exactly as it is now? Customers who can open the shop will see it at once."
          />
        ) : null}
        {product.status === "published" ? (
          <div className="flex flex-wrap items-start gap-2">
            <Link href={`/en/products/${product.slug}`} className={BUTTON_LINK}>
              Open in the shop
            </Link>
            <ActionForm
              action={withdrawProductAction}
              idempotencyKey={randomUUID()}
              hidden={{ productId: product.id, version: String(product.version) }}
              submitLabel="Withdraw from the shop"
              variant="secondary"
              confirm="Withdraw this product? It leaves the shop at once and becomes an editable draft. Orders and stock are not changed."
            />
          </div>
        ) : null}
        {published.length ? (
          <details className="text-sm">
            <summary className="cursor-pointer font-medium">Publication history ({published.length})</summary>
            <ul className="mt-2 space-y-1">
              {published.map((e) => (
                <li key={e.id}>
                  {formatTime(e.createdAt)}: {e.event}
                  {e.ruleId ? ` under ${e.ruleId === "i6-proposed-acceptance" ? "the proposed rule (acceptance)" : e.ruleId}` : ""}
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
          <Link href={`/admin/products/${product.id}/measurements`} className={BUTTON_LINK}>
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
                <img src={`/admin/media/${m.id}?w=320`} alt={m.altEn ?? "Product photo (no English description yet)"} width={120} height={Math.round((120 * m.height) / m.width)} className="rounded border border-gray-300 bg-gray-100 object-cover" />
              </li>
            ))}
          </ul>
        )}
        <Link href={`/admin/products/${product.id}/photos`} className={BUTTON_LINK}>
          {draft ? "Manage photos" : "View photos"}
        </Link>
      </Section>

      <Section title="Variants and stock">
        {product.variants.length === 0 ? (
          <p className="text-sm text-gray-700">No variants yet. Add one below; each variant is a SKU with its own price and stock.</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-gray-200">
            <ScrollArea label="Variants table" hint="Scroll sideways for more columns. The actions stay in view.">
              <table className="of-table">
                <thead>
                  <tr>
                    <th scope="col">SKU</th>
                    <th scope="col">Size</th>
                    <th scope="col">Colour</th>
                    <th scope="col" className="num">
                      Price
                    </th>
                    <th scope="col" className="num">
                      On hand
                    </th>
                    <th scope="col">Status</th>
                    <th scope="col" className="of-sticky-end">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {product.variants.map((v, i) => (
                    <tr key={v.id}>
                      <th scope="row" className="font-normal">
                        <Link href={`/admin/skus/${encodeURIComponent(v.sku)}`} className="font-medium underline underline-offset-4">
                          {v.sku}
                        </Link>
                      </th>
                      <td>{v.size ?? "—"}</td>
                      <td>{v.colour ?? "—"}</td>
                      <td className="num">{bdt(v.pricePaisa)}</td>
                      <td className="num">{stock[i].onHand}</td>
                      <td>
                        <span className="of-pill first-letter:uppercase" data-tone={v.status === "active" ? "ok" : "quiet"}>
                          {v.status}
                        </span>
                      </td>
                      <td className="of-sticky-end">
                        {v.status === "active" ? (
                          <div className="flex items-start justify-end gap-2">
                            {draft ? (
                              <Link href={`/admin/variants/${v.id}/edit`} className="of-btn of-btn-line of-btn-sm" aria-label={`Edit ${v.sku}`}>
                                Edit
                              </Link>
                            ) : null}
                            <ActionForm
                              action={deactivateVariantAction}
                              idempotencyKey={randomUUID()}
                              hidden={{ variantId: v.id }}
                              submitLabel="Deactivate"
                              variant="secondary"
                              compact
                              confirm={`Deactivate ${v.sku}? It keeps its stock and history, but there is no way to reactivate it here.`}
                            />
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollArea>
          </div>
        )}
      </Section>

      <Section title="Add a variant">
        <ActionForm action={createVariantAction} idempotencyKey={randomUUID()} hidden={{ productId: product.id }} submitLabel="Add variant">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field name="sku" label="SKU" required maxLength={64} hint="Letters A-Z, digits, hyphen and underscore; stored in capitals; must be unique. Cannot be changed later." />
            </div>
            <Field name="size" label="Size" maxLength={64} />
            <Field name="colour" label="Colour" maxLength={64} />
            <Field name="priceTaka" label="Price (BDT)" required inputMode="decimal" hint="In Taka, for example 850 or 850.50. Stored exactly in paisa." />
          </div>
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
    </AdminShell>
  );
}
