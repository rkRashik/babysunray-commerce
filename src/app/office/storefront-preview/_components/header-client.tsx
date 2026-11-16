"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cartUnits } from "@/modules/storefront/cart";
import { dictionary, type Lang, toBnDigits } from "@/modules/storefront/i18n";
import { chooseConceptAction } from "../actions";
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

/** Owner-only switch between the two design concepts; stays on the same page (same language, filters and cart). */
export function ConceptSwitch({ concept, labels }: { concept: "editorial" | "family"; labels: { label: string; editorial: string; family: string } }) {
  const pathname = usePathname();
  const search = useSearchParams();
  return (
    <form action={chooseConceptAction} className="flex flex-wrap items-center gap-2" data-testid="concept-switch">
      <input type="hidden" name="returnTo" value={`${pathname}${search.size ? `?${search.toString()}` : ""}`} />
      <span id="sf-concept-label">{labels.label}:</span>
      {(["editorial", "family"] as const).map((c) => (
        <button
          key={c}
          type="submit"
          name="concept"
          value={c}
          aria-pressed={concept === c}
          aria-describedby="sf-concept-label"
          className="min-h-11 rounded-sm border border-sf-cocoa px-3 font-medium aria-pressed:bg-sf-cocoa aria-pressed:text-sf-ivory"
        >
          {labels[c]}
        </button>
      ))}
    </form>
  );
}
