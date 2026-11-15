import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { formatCentimetres, MEASUREMENT_POINTS } from "@/modules/catalogue/content";
import { dictionary, formatTaka, isLang, localised } from "@/modules/storefront/i18n";
import { getPreviewProduct } from "@/modules/storefront/service";
import { requireOffice } from "../../../../_lib/session";
import { base, Localised, Photo } from "../../../_components/parts";
import { VariantPicker } from "../../../_components/variant-picker";

type Props = { params: Promise<{ lang: string; slug: string }> };

const sizeOrder = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

function Block({ title, children, id }: { title: string; children: React.ReactNode; id: string }) {
  return (
    <section aria-labelledby={id} className="space-y-3 border-t border-sf-line pt-6">
      <h2 id={id} className="text-xl font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

// Product page prototype: photos, the buying panel (size with measurements, colour, quantity, availability)
// and the Owner's own content. A fabric statement appears only once the Owner confirmed it; until then the
// preview says it would be hidden. Delivery charges are the configured ones; policy text does not exist yet.
export default async function PreviewProduct({ params }: Props) {
  const { lang, slug } = await params;
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
  const photos = product.media.map((m) => ({ id: m.id, width: m.width, height: m.height, altEn: m.altEn, altBn: m.altBn }));

  return (
    <div className="space-y-10">
      <nav aria-label={t.home} className="text-sm text-sf-umber">
        <ol className="flex flex-wrap gap-2">
          <li>
            <Link href={base(lang)} className="underline underline-offset-4">
              {t.home}
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link href={`${base(lang)}/products`} className="underline underline-offset-4">
              {t.shopAll}
            </Link>
          </li>
        </ol>
      </nav>

      <div className="grid gap-8 md:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] md:gap-12">
        <div>
          {photos.length ? (
            <ul className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 md:mx-0 md:grid md:grid-cols-2 md:overflow-visible md:px-0" aria-label={name}>
              {photos.map((p, i) => (
                <li key={p.id} className={`aspect-[4/5] ${photos.length === 1 ? "w-full" : "w-4/5"} shrink-0 snap-start overflow-hidden rounded-sm bg-sf-sand md:w-auto ${i === 0 ? "md:col-span-2" : ""}`}>
                  <Photo photo={p} lang={lang} name={name} sizes={i === 0 ? "(min-width: 768px) 55vw, 80vw" : "(min-width: 768px) 27vw, 80vw"} />
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex aspect-[4/5] items-end rounded-sm bg-sf-sand p-4 text-sf-umber">{t.noPhoto}</div>
          )}
        </div>

        <div className="space-y-6 md:sticky md:top-6 md:self-start">
          <h1 className="text-3xl font-semibold leading-tight">
            <Localised lang={lang} en={product.nameEn} bn={product.nameBn} missing={t.untitled} />
          </h1>
          {variants.length ? (
            <VariantPicker lang={lang} productName={name} variants={variants} sizes={sizes} measurements={summary} />
          ) : (
            <p className="font-medium text-sf-danger">{t.soldOut}</p>
          )}
        </div>
      </div>

      <div className="max-w-3xl space-y-8">
        <Block title={t.description} id="sf-description">
          <p className="whitespace-pre-line leading-relaxed">{description ?? <span className="text-sf-umber">{t.missingLanguage}</span>}</p>
        </Block>
        <Block title={t.fabric} id="sf-fabric">
          {product.fabricConfirmedAt === null && (product.fabricEn || product.fabricBn) ? (
            <p className="text-sf-umber" data-testid="fabric-hidden">
              {t.fabricUnconfirmed}
            </p>
          ) : (
            <p className="whitespace-pre-line">{fabric ?? <span className="text-sf-umber">{t.missingLanguage}</span>}</p>
          )}
        </Block>
        <Block title={t.care} id="sf-care">
          <p className="whitespace-pre-line">{care ?? <span className="text-sf-umber">{t.missingLanguage}</span>}</p>
        </Block>
        <Block title={t.sizeGuide} id="sf-size-guide">
          {points.length ? (
            <div className="overflow-x-auto">
              <table className="text-left">
                <caption className="sr-only">{t.sizeGuide}</caption>
                <thead className="border-b border-sf-line text-sm text-sf-umber">
                  <tr>
                    <th scope="col" className="py-2 pr-10 font-medium">
                      {t.size}
                    </th>
                    {points.map((p) => (
                      <th key={p} scope="col" className="py-2 pr-10 text-right font-medium">
                        {t.points[p]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-sf-line">
                  {chartSizes.map((s) => (
                    <tr key={s}>
                      <th scope="row" className="py-2 pr-10 font-semibold">
                        {s}
                      </th>
                      {points.map((p) => {
                        const m = product.measurements.find((x) => x.size === s && x.point === p);
                        return (
                          <td key={p} className="py-2 pr-10 text-right tabular-nums">
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
            <p className="text-sf-umber">{t.noMeasurements}</p>
          )}
          {guidance ? (
            <div>
              <h3 className="font-medium">{t.sizeGuidance}</h3>
              <p className="whitespace-pre-line">{guidance}</p>
            </div>
          ) : null}
        </Block>
        <Block title={t.delivery} id="sf-delivery">
          <ul className="space-y-1">
            {zones.map((z) => (
              <li key={z.code} className="tabular-nums">
                {z.chargePaisa === null ? t.deliveryNotSet(t.deliveryZone[z.code]) : t.deliveryCharge(t.deliveryZone[z.code], formatTaka(z.chargePaisa, lang))}
              </li>
            ))}
          </ul>
          <p className="text-sf-umber">{t.deliveryNote}</p>
          <p className="text-sf-umber">{t.policiesPending}</p>
        </Block>
      </div>
    </div>
  );
}
