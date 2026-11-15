import Link from "next/link";
import { Suspense } from "react";
import { dictionary, type Lang } from "@/modules/storefront/i18n";
import type { Facets } from "@/modules/storefront/service";
import { CartLink, LanguageSwitch } from "./header-client";
import { base, Localised } from "./parts";

// Site header of the preview. On a phone the navigation and search sit in a native disclosure (<details>), so
// the menu opens with the keyboard and screen readers without any script; on wider screens they are inline.

function Nav({ lang, facets, className }: { lang: Lang; facets: Facets; className: string }) {
  const t = dictionary(lang);
  const link = "inline-flex min-h-11 items-center rounded-sm underline-offset-4 hover:underline";
  return (
    <ul className={className}>
      <li>
        <Link href={`${base(lang)}/products`} className={link}>
          {t.shopAll}
        </Link>
      </li>
      {facets.categories.map((c) => (
        <li key={c.slug}>
          <Link href={`${base(lang)}/products?category=${c.slug}`} className={link}>
            <Localised lang={lang} en={c.nameEn} bn={c.nameBn} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Search({ lang, id }: { lang: Lang; id: string }) {
  const t = dictionary(lang);
  return (
    <form action={`${base(lang)}/products`} method="get" role="search" className="flex items-center gap-2">
      <label htmlFor={id} className="sr-only">
        {t.searchLabel}
      </label>
      <input id={id} type="search" name="q" maxLength={100} placeholder={t.searchPlaceholder} className="min-h-11 w-full min-w-0 rounded-sm border border-sf-line bg-white px-3 text-base placeholder:text-sf-umber" />
      <button type="submit" className="min-h-11 rounded-sm border border-sf-cocoa px-3 font-medium hover:bg-sf-cocoa hover:text-sf-ivory">
        {t.search}
      </button>
    </form>
  );
}

export function Header({ lang, facets }: { lang: Lang; facets: Facets }) {
  const t = dictionary(lang);
  return (
    <header className="border-b border-sf-line bg-sf-ivory">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <Link href={base(lang)} className="mr-auto inline-flex min-h-11 items-center rounded-sm text-xl font-semibold" lang="en">
          BabySunray
        </Link>
        <nav aria-label={t.mainNav} className="hidden md:block">
          <Nav lang={lang} facets={facets} className="flex flex-wrap items-center gap-x-5" />
        </nav>
        <div className="hidden w-64 md:block">
          <Search lang={lang} id="sf-search-wide" />
        </div>
        <Suspense>
          <LanguageSwitch lang={lang} />
        </Suspense>
        <CartLink lang={lang} />
        <details className="w-full md:hidden" data-testid="mobile-menu">
          <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-sm font-medium">{t.menu}</summary>
          <nav aria-label={t.mainNav} className="space-y-3 pb-3 pt-1">
            <Search lang={lang} id="sf-search-narrow" />
            <Nav lang={lang} facets={facets} className="flex flex-col" />
          </nav>
        </details>
      </div>
    </header>
  );
}
