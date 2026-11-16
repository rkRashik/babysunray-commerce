import Link from "next/link";
import { notFound } from "next/navigation";
import { installationIdentity } from "@/config/installation";
import { getDb } from "@/db/client";
import { dictionary, isLang, localised } from "@/modules/storefront/i18n";
import { listPreviewProducts, previewFacets } from "@/modules/storefront/service";
import { requireOffice } from "../../_lib/session";
import { previewConcept } from "../_components/concept";
import { Search } from "../_components/header";
import { base, Localised, ProductGrid } from "../_components/parts";

// Home page prototype in two concepts (Gate H.27): the installation's name and optional description
// (src/config/installation.ts), the Owner's categories, featured products and what is new. No slogan, claim,
// review or stock photo in either: only configured or Owner data. The products and their order are the same.
export default async function PreviewHome({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const principal = await requireOffice("storefront:preview");
  const db = getDb();
  const [{ items }, facets, concept] = [await listPreviewProducts(db, principal, {}), await previewFacets(db, principal), await previewConcept()];
  const t = dictionary(lang);
  const identity = installationIdentity();
  const line = localised(lang, identity.storeLine.en, identity.storeLine.bn);
  const featured = items.filter((p) => p.featured).slice(0, 4);
  const latest = items.filter((p) => !p.featured).slice(0, 8);
  const family = concept === "family";

  const hero = family ? (
    // Concept B: search first, then every category as a large chip (scrolls sideways on a phone).
    <section aria-labelledby="sf-hero" className="sf-card space-y-5 bg-sf-sand px-5 py-8 sm:px-10 sm:py-10">
      <h1 id="sf-hero" className="text-3xl font-bold leading-tight sm:text-4xl">
        {identity.storeName}
      </h1>
      {line ? <p className="max-w-xl text-lg leading-relaxed">{line}</p> : null}
      <div className="max-w-xl">
        <Search lang={lang} id="sf-search-hero" large />
      </div>
      <ul aria-label={t.categories} className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        <li className="shrink-0">
          <Link href={`${base(lang)}/products`} className="sf-pill inline-flex min-h-11 items-center bg-sf-cocoa px-5 font-semibold text-sf-ivory">
            {t.shopAll}
          </Link>
        </li>
        {facets.categories.map((c) => (
          <li key={c.slug} className="shrink-0">
            <Link href={`${base(lang)}/products?category=${c.slug}`} className="sf-pill inline-flex min-h-11 items-center border border-sf-cocoa bg-white px-5 font-medium">
              <Localised lang={lang} en={c.nameEn} bn={c.nameBn} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  ) : (
    // Concept A: the name set large in the display face, a fine amber rule, categories as a quiet index.
    <section aria-labelledby="sf-hero" className="grid gap-10 border-b border-sf-line pb-12 pt-4 md:grid-cols-[3fr_2fr] md:items-end">
      <div>
        <h1 id="sf-hero" className="sf-display max-w-2xl text-4xl leading-tight sm:text-6xl">
          {identity.storeName}
        </h1>
        <span aria-hidden="true" className="mt-6 block h-px w-24 bg-sf-amber" />
        {line ? <p className="mt-6 max-w-xl text-lg leading-relaxed text-sf-umber">{line}</p> : null}
      </div>
      <ul aria-label={t.categories} className="divide-y divide-sf-line border-y border-sf-line">
        {facets.categories.map((c) => (
          <li key={c.slug}>
            <Link href={`${base(lang)}/products?category=${c.slug}`} className="flex min-h-12 items-center justify-between gap-4 py-2 text-lg hover:underline hover:underline-offset-4">
              <Localised lang={lang} en={c.nameEn} bn={c.nameBn} />
              <span aria-hidden="true">→</span>
            </Link>
          </li>
        ))}
        <li>
          <Link href={`${base(lang)}/products`} className="flex min-h-12 items-center justify-between gap-4 py-2 text-lg font-medium text-sf-tan hover:underline hover:underline-offset-4">
            {t.shopAll}
            <span aria-hidden="true">→</span>
          </Link>
        </li>
      </ul>
    </section>
  );

  const heading = family ? "text-2xl font-bold" : "sf-display text-3xl";
  return (
    <div className={family ? "space-y-10" : "space-y-16"}>
      {hero}

      {items.length === 0 ? (
        <p className="max-w-xl text-lg" role="status">
          {t.noProducts}
        </p>
      ) : null}

      {featured.length ? (
        <section aria-labelledby="sf-featured" className="space-y-6">
          <h2 id="sf-featured" className={heading}>
            {t.featured}
          </h2>
          <ProductGrid products={featured} lang={lang} label={t.featured} concept={concept} lead={!family} />
        </section>
      ) : null}

      {latest.length ? (
        <section aria-labelledby="sf-latest" className="space-y-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="sf-latest" className={heading}>
              {t.latest}
            </h2>
            <Link href={`${base(lang)}/products`} className="inline-flex min-h-11 items-center font-medium text-sf-tan underline underline-offset-4">
              {t.shopAll}
            </Link>
          </div>
          <ProductGrid products={latest} lang={lang} label={t.latest} concept={concept} />
        </section>
      ) : null}
    </div>
  );
}
