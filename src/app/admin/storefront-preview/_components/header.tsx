import { Package } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { BrandLogo } from "@/app/_design/brand";
import { dictionary, type Lang } from "@/modules/storefront/i18n";
import type { Facets } from "@/modules/storefront/service";
import { BagLink, LanguageSwitch, SearchForm } from "./header-client";
import { base, Localised, type Surface } from "./parts";

// The site header (First Light). A phone gets the logo and the language switch, both always visible: search, the shop,
// the bag and the order page live in the tab bar under the thumb. A desktop gets the categories, search, the order page
// and the bag in one row.

// Three categories fit beside search on a wide desktop; below 1280 px only "Shop All" (the rest is one tap away there).
const MAX_NAV = 3;

export function Header({ lang, facets, storeName, surface }: { lang: Lang; facets: Facets; storeName: string; surface: Surface }) {
  const t = dictionary(lang);
  const link = "inline-flex min-h-11 items-center rounded-full px-3 text-[0.9375rem] font-semibold whitespace-nowrap transition-colors hover:bg-sf-sun-soft";
  return (
    <header className="sticky top-0 z-30 border-b border-sf-line bg-sf-paper/95 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 lg:h-20 lg:gap-4 lg:px-8">
        <Link href={base(lang, surface)} className="me-auto inline-flex min-h-11 shrink-0 items-center rounded-lg lg:me-0" data-testid="store-home">
          <BrandLogo name={storeName} height={36} className="lg:h-[44px] lg:w-auto" textClassName="text-[1.5rem] lg:text-[1.75rem]" />
        </Link>
        <nav aria-label={t.mainNav} className="me-auto hidden min-w-0 lg:block">
          <ul className="flex items-center gap-1">
            <li>
              <Link href={`${base(lang, surface)}/products`} className={link}>
                {t.shopAll}
              </Link>
            </li>
            {facets.categories.slice(0, MAX_NAV).map((c) => (
              <li key={c.slug} className="hidden xl:list-item">
                <Link href={`${base(lang, surface)}/products?category=${c.slug}`} className={link}>
                  <Localised lang={lang} en={c.nameEn} bn={c.nameBn} />
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="hidden w-56 lg:block xl:w-60">
          <SearchForm lang={lang} id="sf-search-header" />
        </div>
        <Suspense>
          <LanguageSwitch lang={lang} />
        </Suspense>
        <Link href={`${base(lang, surface)}/order`} className="sf-btn sf-btn-ghost sf-btn-sm hidden gap-2 px-3 lg:inline-flex xl:px-4">
          <Package aria-hidden="true" size={18} strokeWidth={1.75} />
          <span className="sr-only xl:not-sr-only">{t.tabOrder}</span>
        </Link>
        <BagLink lang={lang} place="header" />
      </div>
    </header>
  );
}
