import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { SunMark } from "@/app/_design/sun-mark";
import { installationIdentity } from "@/config/installation";
import { getDb } from "@/db/client";
import { dictionary, type Lang, localised } from "@/modules/storefront/i18n";
import { type CatalogueScope, catalogueFacets, listProductCards } from "@/modules/storefront/service";
import { NoPhoto } from "../no-photo";
import { base, HowToOrder, Localised, Photo, ProductGrid, ProductRail, productName, SectionHeading, type Surface, tintFor, TrustLines } from "../parts";

const MAX_CATEGORIES = 8;
const MAX_SIZES = 10;
// The opening's three arches, middle tallest: the sunrise.
const ARCHES = [
  { box: "w-[30%] aspect-[4/5.2]", tint: "bg-sf-sky" },
  { box: "w-[36%] aspect-[4/6.2]", tint: "bg-sf-butter" },
  { box: "w-[30%] aspect-[4/4.6]", tint: "bg-sf-sage" },
];

// Home page of the storefront (First Light), for the preview and the shop alike: the caller checked access and chose the
// scope (drafts for the preview, published products for the shop). One bold moment, then calm: the opening on the sun wash with the
// shop's own line (or "New Arrivals") and its newest photographed products in three arches; the three approved promises;
// shortcuts by size (parents shop by the baby's age) and by category; featured and new products; and how ordering works.
// Everything shown is the installation's configured text (src/config/installation.ts) or the Owner's data: no slogan,
// claim, review, discount or stock photo.
export async function HomeView({ lang, surface, scope }: { lang: Lang; surface: Surface; scope: CatalogueScope }) {
  const db = getDb();
  const [{ items }, facets] = [await listProductCards(db, {}, scope), await catalogueFacets(db, scope)];
  const categories = facets.categories.slice(0, MAX_CATEGORIES);
  // Each category is shown by the first photographed product in it (the catalogue's own order); no photo, no picture.
  const covers = await Promise.all(categories.map(async (c) => (await listProductCards(db, { category: c.slug }, scope)).items.find((p) => p.photo) ?? null));
  const t = dictionary(lang);
  const identity = installationIdentity();
  const other = lang === "en" ? "bn" : "en";
  const lineHere = localised(lang, identity.storeLine.en, identity.storeLine.bn);
  const line = lineHere ?? localised(other, identity.storeLine.en, identity.storeLine.bn);
  const lineLang = lineHere === null ? other : lang;
  const featured = items.filter((p) => p.featured).slice(0, 4);
  const latest = items.filter((p) => !p.featured).slice(0, 8);
  const photographed = [...latest, ...featured].filter((p) => p.photo).slice(0, 3);
  // The tallest arch (the middle) gets the newest photo.
  const heroes = photographed.length === 3 ? [photographed[1], photographed[0], photographed[2]] : photographed;
  const headline = line ?? t.latest;

  return (
    <div className="space-y-12 lg:space-y-20">
      <section aria-labelledby="sf-hero" className="-mx-4 -mt-5 overflow-hidden bg-sf-sun-soft lg:mx-0 lg:-mt-2 lg:rounded-[2.5rem]">
        <div className="grid items-end gap-6 px-5 pt-8 lg:grid-cols-[1.05fr_1fr] lg:gap-12 lg:px-14 lg:pt-14">
          <div className="sf-enter space-y-5 lg:self-center lg:pb-14">
            <SunMark className="sf-rays h-7 w-12 text-sf-sun" />
            <h1 id="sf-hero" lang={line !== null && lineLang !== lang ? lineLang : undefined} className={`sf-display max-w-[14ch] ${headline.length > 40 ? "text-[2.125rem] lg:text-[3.5rem]" : "text-[2.75rem] lg:text-[4.75rem]"}`}>
              {headline}
            </h1>
            <div className="flex flex-wrap gap-3">
              <Link href={`${base(lang, surface)}/products`} className="sf-btn sf-btn-lg">
                {t.shopAll}
                <ArrowRight aria-hidden="true" size={20} strokeWidth={2} className="rtl:rotate-180" />
              </Link>
              {facets.sizes.length ? (
                <a href="#sf-sizes" className="sf-btn sf-btn-ghost sf-btn-lg hidden sm:inline-flex">
                  {t.shopBySize}
                </a>
              ) : null}
            </div>
          </div>
          <div className="mx-auto flex w-full max-w-[30rem] items-end justify-center gap-2.5 lg:gap-4" data-testid="hero-photo">
            {heroes.length ? (
              heroes.map((p, i) => {
                const arch = heroes.length === 3 ? ARCHES[i] : { box: heroes.length === 1 ? "w-[62%] aspect-[4/5.4]" : "w-[44%] aspect-[4/5.4]", tint: tintFor(p.id) };
                return (
                  <Link key={p.id} href={`${base(lang, surface)}/products/${p.slug}`} className={`group block ${arch.box}`} aria-label={productName(lang, p)}>
                    <div className={`sf-photo sf-arch-open h-full w-full ${arch.tint}`}>
                      {p.photo ? <Photo photo={p.photo} lang={lang} surface={surface} name={productName(lang, p)} sizes="(min-width: 1024px) 16vw, 34vw" priority decorative className="transition-transform duration-700 ease-out group-hover:scale-[1.04]" /> : null}
                    </div>
                  </Link>
                );
              })
            ) : (
              <div aria-hidden="true" className="sf-arch-open flex aspect-[4/5] w-[62%] items-center justify-center bg-sf-butter">
                <SunMark className="h-16 w-28 text-sf-sun" />
              </div>
            )}
          </div>
        </div>
      </section>

      <TrustLines lang={lang} className="-mt-4 lg:-mt-8" />

      {items.length === 0 ? (
        <section className="sf-card px-6 py-10 text-center">
          <p role="status" className="mx-auto max-w-xl text-lg">
            {t.noProducts}
          </p>
        </section>
      ) : null}

      {facets.sizes.length ? (
        <section aria-labelledby="sf-sizes" id="sf-sizes" className="scroll-mt-24">
          <SectionHeading id="sf-sizes-title" title={t.shopBySize} />
          <ul aria-label={t.shopBySize} className="sf-rail gap-2.5 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0">
            {facets.sizes.slice(0, MAX_SIZES).map((s) => (
              <li key={s}>
                <Link href={`${base(lang, surface)}/products?size=${encodeURIComponent(s)}`} className="sf-chip sf-option min-h-14 min-w-24 bg-sf-card text-[1.0625rem] lg:min-w-32">
                  {s}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {categories.length ? (
        <section aria-labelledby="sf-categories">
          <SectionHeading id="sf-categories" title={t.shopByCategory} action={{ href: `${base(lang, surface)}/products`, label: t.seeAll }} />
          <ul aria-label={t.shopByCategory} className={`grid grid-cols-2 gap-3 sm:grid-cols-3 lg:gap-5 ${categories.length >= 4 ? "lg:grid-cols-4" : categories.length === 3 ? "lg:grid-cols-3" : "lg:grid-cols-2"}`}>
            {categories.map((c, i) => {
              const cover = covers[i];
              return (
                <li key={c.slug}>
                  <Link href={`${base(lang, surface)}/products?category=${c.slug}`} className={`group flex h-full flex-col items-center gap-3 rounded-[1.5rem] px-3 pt-4 pb-4 text-center transition-transform active:scale-[0.98] ${tintFor(c.slug)}`}>
                    <div className="sf-photo sf-arch aspect-[4/5] w-[72%] bg-sf-card/60">
                      {cover?.photo ? (
                        <Photo photo={cover.photo} lang={lang} surface={surface} name={productName(lang, cover)} sizes="(min-width: 1024px) 16vw, 32vw" className="transition-transform duration-700 ease-out group-hover:scale-[1.04]" decorative />
                      ) : (
                        <NoPhoto label="" />
                      )}
                    </div>
                    <p className="text-[1.0625rem] font-bold">
                      <Localised lang={lang} en={c.nameEn} bn={c.nameBn} />
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {featured.length ? (
        <section aria-labelledby="sf-featured">
          <SectionHeading id="sf-featured" title={t.featured} />
          <ProductGrid products={featured} lang={lang} surface={surface} label={t.featured} />
        </section>
      ) : null}

      {latest.length ? (
        <section aria-labelledby="sf-latest">
          <SectionHeading id="sf-latest" title={t.latest} action={{ href: `${base(lang, surface)}/products`, label: t.seeAll }} />
          <ProductRail products={latest} lang={lang} surface={surface} label={t.latest} />
        </section>
      ) : null}

      <HowToOrder lang={lang} />
    </div>
  );
}
