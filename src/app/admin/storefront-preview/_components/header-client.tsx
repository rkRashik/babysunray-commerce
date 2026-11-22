"use client";

import { House, LayoutGrid, Package, Search as SearchIcon, ShoppingBag } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cartUnits } from "@/modules/storefront/cart";
import { dictionary, type Lang, toBnDigits } from "@/modules/storefront/i18n";
import type { Facets } from "@/modules/storefront/service";
import { useCart } from "./cart-store";
import { useSurface, useWide } from "./frame";
import { Sheet } from "./sheet";

// The storefront's browser-side navigation: the language switch, the bag with this browser's count, the search form and
// sheet, and the phone's tab bar. The tab bar shows on browsing pages only; a product, the bag and checkout have their own
// action bar instead, so two bars never stack.


/** Both languages always on screen, the current one filled: no menu to find, no guessing which is which. */
export function LanguageSwitch({ lang }: { lang: Lang }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const t = dictionary(lang);
  const { root } = useSurface();
  const other: Lang = lang === "en" ? "bn" : "en";
  const rest = pathname.startsWith(`${root}/${lang}`) ? pathname.slice(`${root}/${lang}`.length) : "";
  const href = `${root}/${other}${rest}${search.size ? `?${search.toString()}` : ""}`;
  const names: Record<Lang, string> = { en: "English", bn: "বাংলা" };
  const item = (l: Lang) =>
    l === lang ? (
      <span key={l} lang={l} aria-current="true">
        {names[l]}
      </span>
    ) : (
      <Link key={l} href={href} lang={l} hrefLang={l} data-testid="language-switch">
        {names[l]}
      </Link>
    );
  return (
    <div role="group" aria-label={t.language} className="sf-seg shrink-0">
      {item("en")}
      {item("bn")}
    </div>
  );
}

/**
 * The bag with this browser's count. One is on screen at a time: in the desktop header, in the phone's tab bar, or in a
 * phone action bar. The others are not rendered at all (not only hidden), so the count exists once on the page. The count
 * bumps when it grows.
 */
export function BagLink({ lang, place }: { lang: Lang; place: "header" | "tab" | "bar" }) {
  const t = dictionary(lang);
  const wide = useWide();
  const [lines] = useCart();
  const pathname = usePathname();
  const { root } = useSurface();
  const units = cartUnits(lines);
  const previous = useRef(units);
  const [bump, setBump] = useState(false);
  useEffect(() => {
    if (units > previous.current) {
      setBump(true);
      const timer = setTimeout(() => setBump(false), 450);
      previous.current = units;
      return () => clearTimeout(timer);
    }
    previous.current = units;
  }, [units]);
  const count = lang === "bn" ? toBnDigits(units) : String(units);
  const href = `${root}/${lang}/cart`;
  const current = pathname === href ? "page" : undefined;
  const badge = (
    <>
      <span data-testid="cart-count" data-bump={bump || undefined} aria-hidden="true" className={`sf-count absolute -end-1.5 -top-1 ${units === 0 ? "invisible" : ""}`}>
        {count}
      </span>
      <span className="sr-only">{`${count} ${t.cartUnitsWord(units)}`}</span>
    </>
  );
  if (place === "header") {
    // Reserves its place on a desktop until the browser knows the screen is wide, so the header does not shift.
    if (!wide) return <span aria-hidden="true" className="hidden h-11 w-24 lg:block" />;
    return (
      <Link href={href} aria-current={current} className="sf-btn sf-btn-ink sf-btn-sm relative gap-2">
        <ShoppingBag aria-hidden="true" size={18} strokeWidth={1.75} />
        <span>{t.cart}</span>
        {badge}
      </Link>
    );
  }
  if (wide) return null;
  if (place === "bar") {
    return (
      <Link href={href} className="sf-icon-btn sf-icon-btn-ring relative h-[3.25rem] w-[3.25rem]">
        <ShoppingBag aria-hidden="true" size={22} strokeWidth={1.75} />
        <span className="sr-only">{t.cart}</span>
        {badge}
      </Link>
    );
  }
  return (
    <Link href={href} aria-current={current} className="sf-tab">
      <span className="relative">
        <ShoppingBag aria-hidden="true" size={24} strokeWidth={1.75} />
        {badge}
      </span>
      <span>{t.cart}</span>
    </Link>
  );
}

/** The search form: a GET to the product list, so it works without script. */
export function SearchForm({ lang, id, inputRef, large = false }: { lang: Lang; id: string; inputRef?: React.RefObject<HTMLInputElement | null>; large?: boolean }) {
  const t = dictionary(lang);
  const { root } = useSurface();
  const pathname = usePathname();
  const params = useSearchParams();
  // On the results the field keeps what was searched, so it can be changed rather than typed again.
  const current = pathname === `${root}/${lang}/products` ? (params.get("q") ?? "") : "";
  return (
    <form action={`${root}/${lang}/products`} method="get" role="search" className="relative flex items-center">
      <label htmlFor={id} className="sr-only">
        {t.searchLabel}
      </label>
      <SearchIcon aria-hidden="true" size={19} strokeWidth={1.75} className="pointer-events-none absolute start-4 text-sf-ink-2" />
      <input
        key={current}
        ref={inputRef}
        id={id}
        type="search"
        name="q"
        maxLength={100}
        defaultValue={current}
        enterKeyHint="search"
        autoComplete="off"
        placeholder={t.searchPlaceholder}
        className={`sf-field rounded-full ps-11 ${large ? "pe-24" : "min-h-11 pe-[5.25rem] text-[0.9375rem]"}`}
      />
      {/* A visible submit (Enter is not the only way), quieter than the Bag so the Bag stays the header's one dark button. */}
      <button type="submit" className="sf-btn sf-btn-soft absolute end-1 min-h-9 px-4 text-[0.875rem]">
        {t.search}
      </button>
    </form>
  );
}

function SearchTab({ lang, categories }: { lang: Lang; categories: Facets["categories"] }) {
  const t = dictionary(lang);
  const input = useRef<HTMLInputElement>(null);
  const { root } = useSurface();
  return (
    <Sheet
      title={t.searchLabel}
      closeLabel={t.close}
      side="top"
      initialFocus={input}
      triggerClassName="sf-tab"
      triggerTestId="tab-search"
      trigger={
        <>
          <SearchIcon aria-hidden="true" size={24} strokeWidth={1.75} />
          <span>{t.tabSearch}</span>
        </>
      }
    >
      <div className="sf-sheet-body space-y-6 pb-6">
        <SearchForm lang={lang} id="sf-search-sheet" inputRef={input} large />
        {categories.length ? (
          <div>
            <h2 className="sf-plain mb-3 text-[0.9375rem] text-sf-ink-2">{t.shopByCategory}</h2>
            <ul className="flex flex-wrap gap-2">
              {categories.map((c) => (
                <li key={c.slug}>
                  <Link href={`${root}/${lang}/products?category=${c.slug}`} className="sf-chip">
                    {(lang === "bn" ? c.nameBn : c.nameEn) ?? (lang === "bn" ? c.nameEn : c.nameBn) ?? c.slug}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

/** The phone's tab bar: Home, Shop, Search, Bag and My order, each with its word. Not on a product, the bag or checkout, nor on a desktop. */
export function TabBar({ lang, categories }: { lang: Lang; categories: Facets["categories"] }) {
  const t = dictionary(lang);
  const pathname = usePathname();
  const wide = useWide();
  const { root } = useSurface();
  const home = `${root}/${lang}`;
  if (wide || /\/(products\/[^/]+|cart|checkout)$/.test(pathname)) return null;
  const tab = (href: string, active: boolean, icon: React.ReactNode, label: string) => (
    <Link href={href} aria-current={active ? "page" : undefined} className="sf-tab">
      {icon}
      <span>{label}</span>
    </Link>
  );
  return (
    <nav aria-label={t.tabBar} className="sf-bar sf-bar-phone" data-testid="tab-bar">
      <ul className="mx-auto grid h-[var(--sf-bar-h)] max-w-lg grid-cols-5">
        <li>{tab(home, pathname === home, <House aria-hidden="true" size={24} strokeWidth={1.75} />, t.home)}</li>
        <li>{tab(`${home}/products`, pathname.startsWith(`${home}/products`), <LayoutGrid aria-hidden="true" size={24} strokeWidth={1.75} />, t.tabShop)}</li>
        <li>
          <SearchTab lang={lang} categories={categories} />
        </li>
        <li>
          <BagLink lang={lang} place="tab" />
        </li>
        <li>{tab(`${home}/order`, pathname === `${home}/order`, <Package aria-hidden="true" size={24} strokeWidth={1.75} />, t.tabOrder)}</li>
      </ul>
    </nav>
  );
}
