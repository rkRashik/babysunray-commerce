"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cartUnits } from "@/modules/storefront/cart";
import { dictionary, type Lang, toBnDigits } from "@/modules/storefront/i18n";
import { useCart } from "./cart-store";

// The two header controls that depend on the browser: the language switch (same page, other language, same
// filters) and the cart count from this browser's cart.

export function LanguageSwitch({ lang }: { lang: Lang }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const other: Lang = lang === "en" ? "bn" : "en";
  const href = `${pathname.replace(/^\/office\/storefront-preview\/(en|bn)/, `/office/storefront-preview/${other}`)}${search.size ? `?${search.toString()}` : ""}`;
  return (
    <Link href={href} lang={other} hrefLang={other} className="inline-flex min-h-11 items-center rounded-sm px-2 font-medium underline-offset-4 hover:underline" data-testid="language-switch">
      {dictionary(lang).otherLang}
    </Link>
  );
}

export function CartLink({ lang }: { lang: Lang }) {
  const t = dictionary(lang);
  const [lines] = useCart();
  const units = cartUnits(lines);
  return (
    <Link href={`/office/storefront-preview/${lang}/cart`} className="inline-flex min-h-11 items-center gap-2 rounded-sm px-2 font-medium underline-offset-4 hover:underline">
      <span>{t.cart}</span>
      <span data-testid="cart-count" className="min-w-7 rounded-full bg-sf-cocoa px-2 py-0.5 text-center text-sm text-sf-ivory tabular-nums">
        {lang === "bn" ? toBnDigits(units) : units}
      </span>
      <span className="sr-only">{t.cartUnitsWord(units)}</span>
    </Link>
  );
}
