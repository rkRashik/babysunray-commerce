import Link from "next/link";
import { notFound } from "next/navigation";
import { installationIdentity } from "@/config/installation";
import { getDb } from "@/db/client";
import { dictionary, isLang, localised } from "@/modules/storefront/i18n";
import { listPreviewProducts, previewFacets } from "@/modules/storefront/service";
import { requireOffice } from "../../_lib/session";
import { base, Localised, ProductGrid } from "../_components/parts";

// Home page prototype: the installation's name and optional description (src/config/installation.ts), the Owner's
// categories, featured products and what is new. No slogan, claim, review or stock photo: only configured or Owner data.
export default async function PreviewHome({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const principal = await requireOffice("storefront:preview");
  const db = getDb();
  const [{ items }, facets] = [await listPreviewProducts(db, principal, {}), await previewFacets(db, principal)];
  const t = dictionary(lang);
  const identity = installationIdentity();
  const line = localised(lang, identity.storeLine.en, identity.storeLine.bn);
  const featured = items.filter((p) => p.featured).slice(0, 4);
  const latest = items.filter((p) => !p.featured).slice(0, 8);

  return (
    <div className="space-y-14">
      <section aria-labelledby="sf-hero" className="sf-dark -mx-4 rounded-sm bg-sf-cocoa px-6 py-10 text-sf-ivory sm:mx-0 sm:px-10 sm:py-14">
        <h1 id="sf-hero" className="max-w-2xl text-3xl font-semibold leading-tight sm:text-5xl">
          {identity.storeName}
        </h1>
        {line ? <p className="mt-4 max-w-xl text-lg leading-relaxed text-sf-sand">{line}</p> : null}
        <ul aria-label={t.categories} className="mt-8 flex flex-wrap gap-3">
          <li>
            <Link href={`${base(lang)}/products`} className="inline-flex min-h-11 items-center rounded-sm bg-sf-amber px-5 font-semibold text-sf-cocoa hover:bg-sf-sand">
              {t.shopAll}
            </Link>
          </li>
          {facets.categories.map((c) => (
            <li key={c.slug}>
              <Link href={`${base(lang)}/products?category=${c.slug}`} className="inline-flex min-h-11 items-center rounded-sm border border-sf-sand px-5 font-medium hover:bg-sf-ivory hover:text-sf-cocoa">
                <Localised lang={lang} en={c.nameEn} bn={c.nameBn} />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {items.length === 0 ? (
        <p className="max-w-xl text-lg" role="status">
          {t.noProducts}
        </p>
      ) : null}

      {featured.length ? (
        <section aria-labelledby="sf-featured" className="space-y-5">
          <h2 id="sf-featured" className="text-2xl font-semibold">
            {t.featured}
          </h2>
          <ProductGrid products={featured} lang={lang} label={t.featured} />
        </section>
      ) : null}

      {latest.length ? (
        <section aria-labelledby="sf-latest" className="space-y-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="sf-latest" className="text-2xl font-semibold">
              {t.latest}
            </h2>
            <Link href={`${base(lang)}/products`} className="font-medium text-sf-tan underline underline-offset-4">
              {t.shopAll}
            </Link>
          </div>
          <ProductGrid products={latest} lang={lang} label={t.latest} />
        </section>
      ) : null}
    </div>
  );
}
