import { Banknote, ChevronDown, Truck } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { formatCentimetres, MEASUREMENT_POINTS } from "@/modules/catalogue/content";
import { dictionary, formatTaka, isLang, localised } from "@/modules/storefront/i18n";
import { getPreviewProduct, listPreviewProducts } from "@/modules/storefront/service";
import { requireOffice } from "../../../../_lib/session";
import { Gallery } from "../../../_components/gallery";
import { base, cdnFor, listQuery, Localised, ProductRail, SectionHeading } from "../../../_components/parts";
import { VariantPicker } from "../../../_components/variant-picker";

type Props = { params: Promise<{ lang: string; slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const sizeOrder = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/** One fold of the product details: a native disclosure, so it opens with the keyboard and screen readers without script. */
function Fold({ title, open = false, children }: { title: string; open?: boolean; children: React.ReactNode }) {
  return (
    <details className="group sf-card overflow-hidden" open={open}>
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-4 font-semibold [&::-webkit-details-marker]:hidden">
        <h2 className="sf-plain text-base">{title}</h2>
        <ChevronDown aria-hidden="true" size={20} strokeWidth={1.75} className="shrink-0 transition-transform duration-300 group-open:rotate-180" />
      </summary>
      <div className="max-w-prose space-y-3 px-4 pb-5 text-[0.9375rem] leading-relaxed">{children}</div>
    </details>
  );
}

// The product page: photographs, the buying panel (size with measurements and a size guide, colour, quantity,
// availability), delivery and payment next to the decision, and the Owner's own content in folds. A fabric statement
// appears only once the Owner confirmed it; until then the preview says it would be hidden. Delivery charges are the
// configured ones; policy text does not exist yet.
export default async function PreviewProduct({ params, searchParams }: Props) {
  const { lang, slug } = await params;
  const from = listQuery(typeof (await searchParams).from === "string" ? ((await searchParams).from as string) : null);
  if (!isLang(lang)) notFound();
  const principal = await requireOffice("storefront:preview");
  const found = await getPreviewProduct(getDb(), principal, slug);
  if (!found) notFound();
  const { product, variants, zones } = found;
  const t = dictionary(lang);
  const other = lang === "en" ? "bn" : "en";
  const name = localised(lang, product.nameEn, product.nameBn) ?? localised(other, product.nameEn, product.nameBn) ?? product.slug;
  const sizes = [...new Set(variants.map((v) => v.size).filter((s): s is string => s !== null))].sort(sizeOrder);
  const points = MEASUREMENT_POINTS.filter((p) => product.measurements.some((m) => m.point === p));
  const chartSizes = [...new Set(product.measurements.map((m) => m.size))].sort(sizeOrder);
  const summary = Object.fromEntries(
    sizes.map((s) => [
      s,
      product.measurements
        .filter((m) => m.size === s)
        .slice(0, 2)
        .map((m) => `${t.points[m.point]} ${formatCentimetres(m.valueMm, lang)} ${t.cm}`)
        .join(", "),
    ]),
  );
  const description = localised(lang, product.descriptionEn, product.descriptionBn);
  const fabric = product.fabricConfirmedAt ? localised(lang, product.fabricEn, product.fabricBn) : null;
  const care = localised(lang, product.careEn, product.careBn);
  const guidance = localised(lang, product.sizeGuidanceEn, product.sizeGuidanceBn);
  const photos = product.media.map((m) => ({ id: m.id, width: m.width, height: m.height, altEn: m.altEn, altBn: m.altBn, cdn: cdnFor(m) }));
  const category = product.category;
  const categoryName = category ? (localised(lang, category.nameEn, category.nameBn) ?? localised(other, category.nameEn, category.nameBn) ?? category.slug) : null;
  // Other products of the same category, from the catalogue as it is: no similarity is claimed.
  const related = category ? (await listPreviewProducts(getDb(), principal, { category: category.slug })).items.filter((p) => p.id !== product.id).slice(0, 8) : [];

  const sizeChart =
    points.length || guidance ? (
      <section aria-label={t.sizeGuide} className="space-y-5">
        {points.length ? (
          <div className="overflow-x-auto rounded-2xl border border-sf-line bg-sf-card">
            <table className="sf-num w-full text-start text-[0.9375rem]">
              <caption className="px-4 pt-3 text-start text-[0.8125rem] text-sf-ink-2">{t.sizeGuideUnit}</caption>
              <thead className="border-b border-sf-line text-[0.8125rem] text-sf-ink-2">
                <tr>
                  <th scope="col" className="px-4 py-2.5 text-start font-semibold">
                    {t.size}
                  </th>
                  {points.map((p) => (
                    <th key={p} scope="col" className="px-4 py-2.5 text-end font-semibold">
                      {t.points[p]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-sf-line">
                {chartSizes.map((s) => (
                  <tr key={s}>
                    <th scope="row" className="px-4 py-3 text-start font-semibold">
                      {s}
                    </th>
                    {points.map((p) => {
                      const m = product.measurements.find((x) => x.size === s && x.point === p);
                      return (
                        <td key={p} className="px-4 py-3 text-end">
                          {m ? formatCentimetres(m.valueMm, lang) : "—"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sf-ink-2">{t.noMeasurements}</p>
        )}
        {guidance ? (
          <div>
            <h3 className="sf-plain">{t.sizeGuidance}</h3>
            <p className="mt-1 whitespace-pre-line text-sf-ink-2">{guidance}</p>
          </div>
        ) : null}
      </section>
    ) : null;

  return (
    <div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-16">
        <Gallery lang={lang} photos={photos} name={name} />

        <div className="min-w-0 space-y-5 lg:space-y-7">
          <div className="space-y-1 lg:space-y-2">
            <nav aria-label={t.home} className="-mb-1 text-[0.875rem] text-sf-ink-2">
              <ol className="flex flex-wrap items-center gap-x-2">
                <li className="hidden lg:list-item">
                  <Link href={base(lang)} className="inline-flex min-h-11 items-center hover:text-sf-ink hover:underline">
                    {t.home}
                  </Link>
                </li>
                <li aria-hidden="true" className="hidden lg:list-item">
                  /
                </li>
                <li>
                  <Link href={`${base(lang)}/products`} className="inline-flex min-h-11 items-center hover:text-sf-ink hover:underline">
                    {t.shopAll}
                  </Link>
                </li>
                {category ? (
                  <>
                    <li aria-hidden="true">/</li>
                    <li>
                      <Link href={`${base(lang)}/products?category=${category.slug}`} className="inline-flex min-h-11 items-center font-semibold text-sf-ink hover:underline">
                        {categoryName}
                      </Link>
                    </li>
                  </>
                ) : null}
                {from ? (
                  <li className="ms-auto">
                    <Link href={`${base(lang)}/products?${from}`} className="sf-link inline-flex min-h-11 items-center text-sf-ink" data-testid="back-to-results">
                      {t.backToResults}
                    </Link>
                  </li>
                ) : null}
              </ol>
            </nav>
            <h1 className="text-[2rem] leading-tight lg:text-[2.75rem]">
              <Localised lang={lang} en={product.nameEn} bn={product.nameBn} missing={t.untitled} />
            </h1>
          </div>

          {variants.length ? (
            <VariantPicker lang={lang} productName={name} variants={variants} sizes={sizes} measurements={summary} sizeChart={sizeChart} />
          ) : (
            <p className="sf-badge" data-tone="out">
              {t.soldOut}
            </p>
          )}

          {/* The delivery charges and payment method next to the buying decision, as configured; nothing promised beyond them. */}
          <section aria-labelledby="sf-buy-info" className="space-y-3 rounded-[1.25rem] bg-sf-sun-soft p-4 text-[0.9375rem] lg:p-5" data-testid="buy-info">
            <h2 id="sf-buy-info" className="sr-only">
              {t.deliveryAndPayment}
            </h2>
            <div className="flex gap-3">
              <Truck aria-hidden="true" size={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-sf-sun-deep" />
              <ul className="sf-num">
                {zones.map((z) => (
                  <li key={z.code}>{z.chargePaisa === null ? t.deliveryNotSet(t.deliveryZone[z.code]) : t.deliveryCharge(t.deliveryZone[z.code], formatTaka(z.chargePaisa, lang))}</li>
                ))}
              </ul>
            </div>
            <div className="flex gap-3">
              <Banknote aria-hidden="true" size={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-sf-sun-deep" />
              <p>
                <span className="font-semibold">{t.cod}.</span> {t.codNote}
              </p>
            </div>
          </section>

          <div className="space-y-2.5">
            <Fold title={t.description} open>
              <p className="whitespace-pre-line">{description ?? <span className="text-sf-ink-2">{t.missingLanguage}</span>}</p>
            </Fold>
            <Fold title={t.fabric}>
              {product.fabricConfirmedAt === null && (product.fabricEn || product.fabricBn) ? (
                <p className="rounded-xl border-2 border-dashed border-sf-line-strong px-3 py-2 text-sf-ink-2" data-testid="fabric-hidden">
                  {t.fabricUnconfirmed}
                </p>
              ) : (
                <p className="whitespace-pre-line">{fabric ?? <span className="text-sf-ink-2">{t.missingLanguage}</span>}</p>
              )}
            </Fold>
            <Fold title={t.care}>
              <p className="whitespace-pre-line">{care ?? <span className="text-sf-ink-2">{t.missingLanguage}</span>}</p>
            </Fold>
            <Fold title={t.delivery}>
              <p>{t.deliveryNote}</p>
              <p className="text-sf-ink-2">{t.policiesPending}</p>
            </Fold>
          </div>
        </div>
      </div>

      {related.length && categoryName ? (
        <section aria-labelledby="sf-related" className="mt-14 lg:mt-24">
          <SectionHeading id="sf-related" title={t.moreInCategory(categoryName)} action={category ? { href: `${base(lang)}/products?category=${category.slug}`, label: t.seeAll } : undefined} />
          <ProductRail products={related} lang={lang} label={t.moreInCategory(categoryName)} />
        </section>
      ) : null}
    </div>
  );
}
