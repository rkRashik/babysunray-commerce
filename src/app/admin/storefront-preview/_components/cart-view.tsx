"use client";

import { CircleAlert, ImageOff, Info, Minus, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { SunMark } from "@/app/_design/sun-mark";
import { parseQuantity, removeLine, setQuantity } from "@/modules/storefront/cart";
import { dictionary, formatTaka, type Lang, localised, toBnDigits } from "@/modules/storefront/i18n";
import type { Quote, QuotedLine } from "@/modules/storefront/service";
import { useCart, useZone } from "./cart-store";
import { useSurface } from "./frame";
import { photoPath } from "./surface";

// The bag. Each change asks the server for current prices, stock and the delivery charge (the surface's quote action); nothing
// shown here comes from the browser except SKUs and quantities. Problems are named per line, and checkout stays blocked
// until they are fixed. On a phone the total and Checkout sit in a bar under the thumb.

export function lineName(lang: Lang, line: QuotedLine, fallback: string) {
  return localised(lang, line.nameEn, line.nameBn) ?? localised(lang === "en" ? "bn" : "en", line.nameEn, line.nameBn) ?? fallback;
}

export function useQuote(zone: string) {
  const [lines, setLines] = useCart();
  const { actions } = useSurface();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- shows that a new check started
    setState("loading");
    actions.quote({ lines, zone: zone || null })
      .then((q) => {
        if (!live) return;
        setQuote(q);
        setState(q ? "ready" : "error");
      })
      .catch(() => live && setState("error"));
    return () => {
      live = false;
    };
    // The surface's quote action is the same Server Action for the life of the page; a new props object from a later server
    // payload must not ask again (that would re-quote after the page settled).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, zone, attempt]);
  return { lines, setLines, quote, state, retry: () => setAttempt((a) => a + 1) };
}

/** The quote for the remembered delivery area (shared by the bag and checkout). An area the shop no longer offers is dropped. */
export function useZoneQuote() {
  const [zone, setZone] = useZone();
  const result = useQuote(zone);
  const { quote } = result;
  useEffect(() => {
    if (zone && quote && !quote.zones.some((z) => z.code === zone)) setZone("");
  }, [zone, quote, setZone]);
  return { zone, setZone, ...result };
}

/** A line's thumbnail: the product's first photo in a small arch, or the empty ground. */
export function LineThumb({ line, className = "" }: { line: QuotedLine; className?: string }) {
  const { surface } = useSurface();
  return (
    <div className={`sf-photo sf-arch shrink-0 bg-sf-oat ${className}`}>
      {line.photo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photoPath(surface, line.photo.id, 320)} alt="" width={line.photo.width} height={line.photo.height} loading="lazy" />
      ) : (
        // No photo yet: a quiet mark, so the arch does not look like a picture that failed to load.
        <span aria-hidden="true" className="flex h-full w-full items-center justify-center text-sf-ink-2/70">
          <ImageOff size={20} strokeWidth={1.5} />
        </span>
      )}
    </div>
  );
}

function LineRow({ line, lang, onQuantity, onRemove }: { line: QuotedLine; lang: Lang; onQuantity: (n: number) => void; onRemove: () => void }) {
  const t = dictionary(lang);
  const id = useId();
  // Bangla digits in Bangla (parseQuantity reads both).
  const [typed, setTyped] = useState(lang === "bn" ? toBnDigits(line.quantity) : String(line.quantity));
  const [error, setError] = useState<string | null>(null);
  const name = lineName(lang, line, line.sku);
  const { root } = useSurface();
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
    <li className="sf-card flex gap-3.5 p-3 lg:gap-5 lg:p-4" data-testid={`cart-line-${line.sku}`}>
      <LineThumb line={line} className="aspect-[4/5] w-[5.5rem] lg:w-28" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start justify-between gap-3">
          <p className="font-semibold leading-snug">
            {line.productSlug ? (
              <Link href={`${root}/${lang}/products/${line.productSlug}`} className="hover:underline hover:underline-offset-4">
                {name}
              </Link>
            ) : (
              name
            )}
          </p>
          <p className="sf-price shrink-0" aria-label={t.lineTotal}>
            {line.lineTotalPaisa !== null ? formatTaka(line.lineTotalPaisa, lang) : "—"}
          </p>
        </div>
        <p className="text-[0.875rem] text-sf-ink-2">{[line.size, line.colour].filter(Boolean).join(", ")}</p>
        {line.unitPricePaisa !== null && line.quantity > 1 ? <p className="sf-num text-[0.875rem] text-sf-ink-2">{t.each(formatTaka(line.unitPricePaisa, lang))}</p> : null}
        {problem ? (
          <p className="sf-note mt-1 font-semibold" data-tone="bad" data-testid="line-problem">
            {problem}
          </p>
        ) : null}
        <div className="mt-auto flex items-center justify-between gap-3 pt-2">
          <div className="inline-flex h-12 items-center rounded-full border-[1.5px] border-sf-line-strong bg-sf-card">
            <label htmlFor={`${id}-qty`} className="sr-only">
              {`${t.quantity}: ${name}`}
            </label>
            <button type="button" aria-label={`${t.decrease}: ${name}`} onClick={() => line.quantity > 1 && onQuantity(line.quantity - 1)} className="sf-icon-btn">
              <Minus aria-hidden="true" size={16} strokeWidth={2} />
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
              className="sf-num h-full w-10 bg-transparent text-center font-semibold focus:outline-none focus-visible:rounded-md focus-visible:outline-2"
            />
            <button type="button" aria-label={`${t.increase}: ${name}`} onClick={() => onQuantity(Math.min(1000, line.quantity + 1))} className="sf-icon-btn">
              <Plus aria-hidden="true" size={16} strokeWidth={2} />
            </button>
          </div>
          <button type="button" onClick={onRemove} aria-label={t.remove(name)} className="sf-icon-btn text-sf-ink-2 hover:text-sf-danger">
            <Trash2 aria-hidden="true" size={20} strokeWidth={1.75} />
          </button>
        </div>
        {error ? (
          <p id={`${id}-error`} className="text-[0.875rem] font-semibold text-sf-danger">
            {error}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/** The delivery area choice: the configured zones with their charges. */
export function ZoneChoice({ quote, lang, zone, onZone, invalid }: { quote: Quote | null; lang: Lang; zone: string; onZone: (zone: string) => void; invalid?: boolean }) {
  const t = dictionary(lang);
  return (
    <fieldset aria-invalid={invalid || undefined}>
      <legend className="mb-2.5 font-bold">{t.zone}</legend>
      <div className="grid gap-2.5">
        {(quote?.zones ?? []).map((z) => (
          <label key={z.code} className="sf-choice" data-invalid={invalid || undefined}>
            <input type="radio" name="zone" value={z.code} checked={zone === z.code} onChange={() => onZone(z.code)} className="sr-only" />
            <span aria-hidden="true" className="sf-radio" />
            <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3">
              <span className="font-bold">{t.deliveryZone[z.code]}</span>
              <span className="sf-num text-[0.9375rem] text-sf-ink-2">{z.chargePaisa === null ? t.chargeNotSet : formatTaka(z.chargePaisa, lang)}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Subtotal, delivery and total, from the server's quote. */
export function TotalsList({ quote, lang, zone, totalLabel }: { quote: Quote | null; lang: Lang; zone: string; totalLabel?: string }) {
  const t = dictionary(lang);
  return (
    <dl className="sf-num grid grid-cols-[1fr_auto] gap-y-2 text-[0.9375rem]" data-testid="totals">
      <dt className="text-sf-ink-2">{t.subtotal}</dt>
      <dd className="text-end whitespace-nowrap" data-testid="subtotal">
        {quote ? formatTaka(quote.subtotalPaisa, lang) : "—"}
      </dd>
      <dt className="text-sf-ink-2">{t.deliveryLine}</dt>
      <dd className="text-end" data-testid="delivery">
        {quote?.deliveryChargePaisa != null ? formatTaka(quote.deliveryChargePaisa, lang) : zone ? t.chargeNotSet : t.chooseZone}
      </dd>
      <dt className="mt-2 border-t border-sf-line pt-3 font-bold">{totalLabel ?? t.total}</dt>
      <dd className="sf-price mt-2 self-end border-t border-sf-line pt-3 text-end text-[1.5rem]" data-testid="total">
        {quote?.totalPaisa != null ? formatTaka(quote.totalPaisa, lang) : "—"}
      </dd>
    </dl>
  );
}

/** The delivery area choice and the totals, from the server's quote. */
export function Totals({ quote, lang, zone, onZone }: { quote: Quote | null; lang: Lang; zone: string; onZone: (zone: string) => void }) {
  return (
    <div className="space-y-5">
      <ZoneChoice quote={quote} lang={lang} zone={zone} onZone={onZone} />
      <TotalsList quote={quote} lang={lang} zone={zone} />
    </div>
  );
}

export function EmptyBag({ lang, message }: { lang: Lang; message: string }) {
  const t = dictionary(lang);
  const { root } = useSurface();
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-5 py-12 text-center" role="status">
      <SunMark className="h-10 w-16 text-sf-sun" />
      <p className="text-xl font-bold">{message}</p>
      <Link href={`${root}/${lang}/products`} className="sf-btn">
        {t.continueShopping}
      </Link>
    </div>
  );
}

export function CartView({ lang }: { lang: Lang }) {
  const t = dictionary(lang);
  const { root } = useSurface();
  const { zone, setZone, lines, setLines, quote, state, retry } = useZoneQuote();
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
  if (lines.length === 0) return <EmptyBag lang={lang} message={announcement && announcement !== t.cartEmptied ? announcement : t.cartEmpty} />;
  const checkout = `${root}/${lang}/checkout`;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:gap-12">
      <div>
        <p role="status" aria-live="polite" className="min-h-6 text-[0.9375rem] font-semibold" data-testid="cart-announcement">
          {announcement}
        </p>
        <p className="sf-hint mb-2 empty:hidden" data-testid="cart-state">
          {state === "loading" ? t.checkingCart : state === "error" ? t.cartCheckFailed : ""}
        </p>
        {state === "error" ? (
          <button type="button" onClick={retry} className="sf-btn sf-btn-ghost sf-btn-sm mb-3">
            {t.retry}
          </button>
        ) : null}
        <ul aria-label={t.cartTitle} className="space-y-3">
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
          className="sf-link mt-3 inline-flex min-h-11 items-center text-[0.9375rem] text-sf-ink-2"
        >
          {t.clearCart}
        </button>
      </div>
      <aside aria-label={t.orderSummary} className="sf-card space-y-5 self-start p-5 lg:sticky lg:top-28 lg:p-7">
        <h2 className="text-[1.5rem]">{t.orderSummary}</h2>
        <Totals quote={quote} lang={lang} zone={zone} onZone={setZone} />
        {blocked ? (
          <p className="sf-note font-semibold" data-tone="bad" data-testid="checkout-blocked">
            <CircleAlert aria-hidden="true" size={18} strokeWidth={2} />
            <span>{t.fixCart}</span>
          </p>
        ) : (
          <Link href={checkout} className="sf-btn sf-btn-lg hidden w-full lg:flex">
            {t.toCheckout}
          </Link>
        )}
        <p className="sf-hint flex gap-2">
          <Info aria-hidden="true" size={16} strokeWidth={1.75} className="mt-0.5 shrink-0" />
          <span>{t.notInCart}</span>
        </p>
      </aside>
      {blocked ? null : (
        <div className="sf-bar sf-bar-phone">
          <div className="mx-auto flex h-[var(--sf-bar-h)] max-w-lg items-center justify-between gap-4 px-4">
            <p className="leading-tight">
              <span className="block text-[0.8125rem] font-semibold text-sf-ink-2">{quote?.totalPaisa != null ? t.totalShort : t.subtotal}</span>
              <span className="sf-price text-[1.25rem]">{formatTaka(quote?.totalPaisa ?? quote?.subtotalPaisa ?? 0, lang)}</span>
            </p>
            <Link href={checkout} className="sf-btn min-w-44">
              {t.toCheckout}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
