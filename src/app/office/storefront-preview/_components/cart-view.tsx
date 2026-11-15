"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { parseQuantity, removeLine, setQuantity } from "@/modules/storefront/cart";
import { dictionary, formatTaka, type Lang, localised, toBnDigits } from "@/modules/storefront/i18n";
import type { Quote, QuotedLine } from "@/modules/storefront/service";
import { quoteCartAction } from "../actions";
import { useCart } from "./cart-store";

// The cart page. Each change asks the server for current prices, stock and the delivery charge (quoteCartAction);
// nothing shown here comes from the browser except SKUs and quantities. Problems are named per line, and checkout
// stays blocked until they are fixed.

export function lineName(lang: Lang, line: QuotedLine, fallback: string) {
  return localised(lang, line.nameEn, line.nameBn) ?? localised(lang === "en" ? "bn" : "en", line.nameEn, line.nameBn) ?? fallback;
}

function useQuote(zone: string) {
  const [lines, setLines] = useCart();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- shows that a new check started
    setState("loading");
    quoteCartAction({ lines, zone: zone || null })
      .then((q) => {
        if (!live) return;
        setQuote(q);
        setState(q ? "ready" : "error");
      })
      .catch(() => live && setState("error"));
    return () => {
      live = false;
    };
  }, [lines, zone, attempt]);
  return { lines, setLines, quote, state, retry: () => setAttempt((a) => a + 1) };
}

export { useQuote };

function LineRow({ line, lang, onQuantity, onRemove }: { line: QuotedLine; lang: Lang; onQuantity: (n: number) => void; onRemove: () => void }) {
  const t = dictionary(lang);
  const id = useId();
  const [typed, setTyped] = useState(String(line.quantity));
  const [error, setError] = useState<string | null>(null);
  const name = lineName(lang, line, line.sku);
  const max = line.status === "unknown" || line.status === "unavailable" ? 1000 : Math.max(1, Math.min(1000, line.available));
  const commit = (raw: string) => {
    const n = parseQuantity(raw);
    if (n === null) {
      setError(t.quantityInvalid(max));
      return;
    }
    setError(null);
    if (n !== line.quantity) onQuantity(n);
  };
  const problem = line.status === "ok" ? null : line.status === "insufficient" ? t.lineStatus.insufficient(line.available) : t.lineStatus[line.status];
  return (
    <li className="grid grid-cols-[5rem_1fr] gap-4 border-b border-sf-line py-5 sm:grid-cols-[6rem_1fr_auto]" data-testid={`cart-line-${line.sku}`}>
      <div className="aspect-[4/5] overflow-hidden rounded-sm bg-sf-sand">
        {line.photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/office/media/${line.photo.id}?w=320`} alt="" width={line.photo.width} height={line.photo.height} className="h-full w-full object-cover" />
        ) : null}
      </div>
      <div className="space-y-2">
        <p className="font-medium">
          {line.productSlug ? (
            <Link href={`/office/storefront-preview/${lang}/products/${line.productSlug}`} className="underline-offset-4 hover:underline">
              {name}
            </Link>
          ) : (
            name
          )}
        </p>
        <p className="text-sm text-sf-umber">{[line.size, line.colour].filter(Boolean).join(", ")}</p>
        {line.unitPricePaisa !== null ? <p className="text-sm tabular-nums">{t.each(formatTaka(line.unitPricePaisa, lang))}</p> : null}
        {problem ? (
          <p className="font-medium text-sf-danger" data-testid="line-problem">
            {problem}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`${id}-qty`} className="sr-only">
            {`${t.quantity}: ${name}`}
          </label>
          <button type="button" aria-label={`${t.decrease}: ${name}`} onClick={() => line.quantity > 1 && onQuantity(line.quantity - 1)} className="min-h-11 min-w-11 rounded-sm border border-sf-line bg-white text-lg">
            −
          </button>
          <input
            id={`${id}-qty`}
            inputMode="numeric"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && commit(e.currentTarget.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            className="min-h-11 w-20 rounded-sm border border-sf-line bg-white px-3 text-center text-base tabular-nums"
          />
          <button type="button" aria-label={`${t.increase}: ${name}`} onClick={() => onQuantity(Math.min(1000, line.quantity + 1))} className="min-h-11 min-w-11 rounded-sm border border-sf-line bg-white text-lg">
            +
          </button>
          <button type="button" onClick={onRemove} className="min-h-11 rounded-sm px-2 font-medium text-sf-tan underline underline-offset-4">
            {t.remove(name)}
          </button>
        </div>
        {error ? (
          <p id={`${id}-error`} className="text-sm font-medium text-sf-danger">
            {error}
          </p>
        ) : null}
      </div>
      <p className="col-start-2 font-semibold tabular-nums sm:col-start-3 sm:text-right" aria-label={t.lineTotal}>
        {line.lineTotalPaisa !== null ? formatTaka(line.lineTotalPaisa, lang) : "—"}
      </p>
    </li>
  );
}

export function Totals({ quote, lang, zone, onZone }: { quote: Quote | null; lang: Lang; zone: string; onZone: (zone: string) => void }) {
  const t = dictionary(lang);
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-2 font-medium">{t.zone}</legend>
        <div className="space-y-2">
          {(quote?.zones ?? []).map((z) => (
            <label key={z.code} className="flex min-h-11 items-center gap-3">
              <input type="radio" name="zone" value={z.code} checked={zone === z.code} onChange={() => onZone(z.code)} className="h-5 w-5 accent-sf-cocoa" />
              <span>
                {t.deliveryZone[z.code]}{" "}
                <span className="text-sf-umber tabular-nums">{z.chargePaisa === null ? `(${t.chargeNotSet})` : `(${formatTaka(z.chargePaisa, lang)})`}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <dl className="grid grid-cols-[1fr_auto] gap-y-2 tabular-nums" data-testid="totals">
        <dt>{t.subtotal}</dt>
        <dd className="text-right" data-testid="subtotal">
          {quote ? formatTaka(quote.subtotalPaisa, lang) : "—"}
        </dd>
        <dt>{t.deliveryLine}</dt>
        <dd className="text-right" data-testid="delivery">
          {quote?.deliveryChargePaisa != null ? formatTaka(quote.deliveryChargePaisa, lang) : zone ? t.chargeNotSet : t.chooseZone}
        </dd>
        <dt className="border-t border-sf-line pt-2 font-semibold">{t.total}</dt>
        <dd className="border-t border-sf-line pt-2 text-right text-lg font-semibold" data-testid="total">
          {quote?.totalPaisa != null ? formatTaka(quote.totalPaisa, lang) : "—"}
        </dd>
      </dl>
    </div>
  );
}

export function CartView({ lang }: { lang: Lang }) {
  const t = dictionary(lang);
  const [zone, setZone] = useState("");
  const { lines, setLines, quote, state, retry } = useQuote(zone);
  // What just changed, read out by screen readers (polite) and shown under the heading.
  const [announcement, setAnnouncement] = useState("");
  const blocked = !quote || quote.lines.some((l) => l.status !== "ok");
  const count = (n: number) => (lang === "bn" ? toBnDigits(n) : String(n));
  const changeQuantity = (line: QuotedLine, n: number) => {
    setLines(setQuantity(lines, line.sku, n));
    setAnnouncement(t.quantityUpdated(lineName(lang, line, line.sku), count(n)));
  };
  const remove = (line: QuotedLine) => {
    const next = removeLine(lines, line.sku);
    setLines(next);
    setAnnouncement(next.length ? t.removedFromCart(lineName(lang, line, line.sku)) : t.cartEmptied);
  };
  if (lines.length === 0) {
    return (
      <div className="space-y-4" role="status">
        <p className="text-lg">{announcement && announcement !== t.cartEmptied ? announcement : t.cartEmpty}</p>
        <Link href={`/office/storefront-preview/${lang}/products`} className="inline-flex min-h-11 items-center rounded-sm bg-sf-cocoa px-5 font-semibold text-sf-ivory">
          {t.continueShopping}
        </Link>
      </div>
    );
  }
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div>
        <p role="status" aria-live="polite" className="min-h-6 font-medium" data-testid="cart-announcement">
          {announcement}
        </p>
        <p className="text-sm text-sf-umber" data-testid="cart-state">
          {state === "loading" ? t.checkingCart : state === "error" ? t.cartCheckFailed : ""}
        </p>
        {state === "error" ? (
          <button type="button" onClick={retry} className="mb-3 min-h-11 rounded-sm border border-sf-cocoa px-4 font-medium">
            {t.retry}
          </button>
        ) : null}
        <ul aria-label={t.cartTitle} className="border-t border-sf-line">
          {(quote?.lines ?? []).map((line) => (
            <LineRow key={`${line.sku}-${line.quantity}`} line={line} lang={lang} onQuantity={(n) => changeQuantity(line, n)} onRemove={() => remove(line)} />
          ))}
        </ul>
        <button
          type="button"
          onClick={() => {
            setLines([]);
            setAnnouncement(t.cartEmptied);
          }}
          className="mt-4 min-h-11 font-medium text-sf-tan underline underline-offset-4"
        >
          {t.clearCart}
        </button>
      </div>
      <aside aria-label={t.orderSummary} className="space-y-5 rounded-sm bg-white p-5 lg:self-start">
        <Totals quote={quote} lang={lang} zone={zone} onZone={setZone} />
        <p className="text-sm text-sf-umber">{t.notInCart}</p>
        {blocked ? (
          <p className="font-medium text-sf-danger" data-testid="checkout-blocked">
            {t.fixCart}
          </p>
        ) : (
          <Link href={`/office/storefront-preview/${lang}/checkout`} className="inline-flex min-h-12 w-full items-center justify-center rounded-sm bg-sf-cocoa px-5 text-lg font-semibold text-sf-ivory">
            {t.toCheckout}
          </Link>
        )}
      </aside>
    </div>
  );
}
