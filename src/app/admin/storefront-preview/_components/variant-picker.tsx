"use client";

import { Check, CircleAlert, Minus, Plus, Ruler, ShoppingBag } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { addToCart, parseQuantity } from "@/modules/storefront/cart";
import { dictionary, formatTaka, type Lang, toBnDigits } from "@/modules/storefront/i18n";
import type { PreviewVariant } from "@/modules/storefront/service";
import { useCart } from "./cart-store";
import { useSurface } from "./frame";
import { BagLink } from "./header-client";
import { Sheet } from "./sheet";

// Size and colour choice, quantity and "Add to Bag" on the product page. The selected size shows the product's own
// measurements in cm; the size guide opens in a sheet. Availability comes from the server render; the bag checks it again
// against the database. Adding holds no stock (the bag is not a reservation). On a phone the add button and the bag sit in
// a bar under the thumb, and the answer to an add appears just above it.

type Props = {
  lang: Lang;
  productName: string;
  variants: PreviewVariant[];
  sizes: string[];
  measurements: Record<string, string>;
  /** The size chart (server-rendered), shown in the size guide sheet; null when there are no measurements. */
  sizeChart: React.ReactNode;
};

type Message = { text: string; error: boolean };

/** The size guide's body: a cm / inch switch (cm stays the stored figure) and the chosen size's row marked in the chart. */
function SizeGuideBody({ lang, size, children }: { lang: Lang; size: string | null; children: React.ReactNode }) {
  const t = dictionary(lang);
  const [unit, setUnit] = useState<"cm" | "in">("cm");
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    for (const row of body.current?.querySelectorAll<HTMLElement>("tr[data-size]") ?? []) {
      const chosen = row.dataset.size === size;
      row.toggleAttribute("data-current", chosen);
      if (chosen) row.setAttribute("aria-current", "true");
      else row.removeAttribute("aria-current");
    }
  }, [size]);
  return (
    <div ref={body} className="sf-sheet-body space-y-4" data-units={unit}>
      <div role="group" aria-label={t.unit} className="sf-seg">
        {(["cm", "in"] as const).map((u) => (
          <button key={u} type="button" aria-pressed={unit === u} onClick={() => setUnit(u)} data-testid={`unit-${u}`}>
            {u === "cm" ? t.cm : t.inch}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}

export function VariantPicker({ lang, productName, variants, sizes, measurements, sizeChart }: Props) {
  const t = dictionary(lang);
  const id = useId();
  const [lines, setLines] = useCart();
  const { root } = useSurface();
  const colours = [...new Set(variants.map((v) => v.colour).filter((c): c is string => c !== null))];
  const [size, setSize] = useState<string | null>(sizes.length === 1 ? sizes[0] : null);
  const [colour, setColour] = useState<string | null>(colours.length === 1 ? colours[0] : null);
  // Bangla digits in Bangla (the parser reads both), like the prices and the bag's count beside it.
  const digits = (n: number) => (lang === "bn" ? toBnDigits(n) : String(n));
  const [quantity, setQuantity] = useState(digits(1));
  const [message, setMessage] = useState<Message | null>(null);

  // A success message steps aside after a few seconds; an error stays until the next action.
  useEffect(() => {
    if (!message || message.error) return;
    const timer = setTimeout(() => setMessage(null), 6000);
    return () => clearTimeout(timer);
  }, [message]);

  const selected =
    variants.find((v) => (sizes.length === 0 || v.size === size) && (colours.length === 0 || v.colour === colour)) ?? (variants.length === 1 ? variants[0] : null);
  const soldOutSize = (s: string) => variants.filter((v) => v.size === s).every((v) => v.available === 0);
  // A colour is marked sold out only when no size of it is left; one sold-out size marks that size, not the colour.
  const soldOutColour = (c: string) => variants.filter((v) => v.colour === c).every((v) => v.available === 0);
  const prices = variants.map((v) => v.pricePaisa);
  const price = selected ? formatTaka(selected.pricePaisa, lang) : Math.min(...prices) === Math.max(...prices) ? formatTaka(prices[0], lang) : t.from(formatTaka(Math.min(...prices), lang));
  const inCart = selected ? (lines.find((l) => l.sku === selected.sku)?.quantity ?? 0) : 0;
  const allOut = variants.every((v) => v.available === 0);
  const out = allOut || (selected !== null && selected.available === 0);
  // The button names the next step until there is something to add. It stays focusable (aria-disabled), so pressing it
  // says why; the bag and checkout check stock again on the server either way.
  const cta = out ? t.soldOut : selected ? t.addToCart : sizes.length > 0 && size === null ? t.chooseSize : t.chooseColour;
  const ready = selected !== null && !out;

  function add() {
    if (out) return setMessage({ text: t.outOfStock, error: true });
    if (!selected) return setMessage({ text: sizes.length > 0 && size === null ? t.chooseSizeFirst : t.chooseColourFirst, error: true });
    const n = parseQuantity(quantity);
    if (n === null) return setMessage({ text: t.quantityInvalid(Math.max(1, Math.min(1000, selected.available))), error: true });
    if (n + inCart > selected.available) return setMessage({ text: t.onlyAvailable(selected.available), error: true });
    setLines(addToCart(lines, selected.sku, n));
    setMessage({ text: t.added(productName, n), error: false });
  }

  const step = (delta: number) => {
    const n = parseQuantity(quantity) ?? 1;
    setQuantity(digits(Math.min(1000, Math.max(1, n + delta))));
  };

  return (
    <div className="space-y-6 lg:space-y-7">
      <div className="space-y-1.5">
        <p className="sf-price text-[1.875rem] leading-none" data-testid="price">
          {price}
        </p>
        <p className="pt-1">
          <span data-testid="availability" className="sf-badge" data-tone={out ? "out" : !selected ? undefined : selected.available <= 3 ? "low" : "ok"}>
            {out ? t.soldOut : selected ? `${t.inStock}: ${t.available(selected.available)}` : cta}
          </span>
        </p>
      </div>

      {sizes.length ? (
        <fieldset>
          {/* Floated, so the size guide can sit on the legend's line (a rendered legend would push it into the chips). */}
          <legend className="float-left mb-2 flex min-h-11 items-center text-[1.0625rem] font-bold">{size ? t.chosen(t.size, size) : t.chooseSize}</legend>
          {sizeChart ? (
            <div className="float-right mb-2">
              <Sheet
                title={t.sizeGuide}
                closeLabel={t.close}
                testId="size-guide-sheet"
                triggerClassName="sf-btn sf-btn-soft sf-btn-sm gap-1.5"
                trigger={
                  <>
                    <Ruler aria-hidden="true" size={18} strokeWidth={1.75} />
                    {t.sizeGuide}
                  </>
                }
              >
                <SizeGuideBody lang={lang} size={size}>
                  {sizeChart}
                </SizeGuideBody>
              </Sheet>
            </div>
          ) : null}
          <div className="clear-both flex flex-wrap gap-2">
            {sizes.map((s) => (
              <label key={s} className="sf-chip sf-option" data-out={soldOutSize(s)}>
                <input type="radio" name={`${id}-size`} value={s} checked={size === s} onChange={() => setSize(s)} className="sr-only" aria-describedby={soldOutSize(s) ? `${id}-out` : undefined} />
                <span className="sf-chip-label">{s}</span>
              </label>
            ))}
          </div>
          <p className="mt-2.5 min-h-6 text-[0.9375rem] font-medium text-sf-ink-2" aria-live="polite">
            {size && measurements[size] ? measurements[size] : ""}
            {size && soldOutSize(size) ? <span className="font-semibold text-sf-danger"> {t.unavailableOption}</span> : null}
          </p>
          <span id={`${id}-out`} hidden>
            {t.unavailableOption}
          </span>
        </fieldset>
      ) : null}

      {colours.length ? (
        <fieldset>
          <legend className="mb-3 text-[1.0625rem] font-bold">{colour ? t.chosen(t.colour, colour) : t.chooseColour}</legend>
          <div className="flex flex-wrap gap-2">
            {colours.map((c) => {
              // A colour that does not exist in the chosen size cannot be chosen with it.
              const absent = size !== null && sizes.length > 0 && !variants.some((v) => v.size === size && v.colour === c);
              return (
                <label key={c} className={`sf-chip sf-option ${absent ? "opacity-45" : ""}`} data-out={!absent && soldOutColour(c)}>
                  <input type="radio" name={`${id}-colour`} value={c} checked={colour === c && !absent} disabled={absent} onChange={() => setColour(c)} className="sr-only" />
                  <span className="sf-chip-label">{c}</span>
                  {absent ? <span className="sr-only"> ({t.notInThisSize})</span> : !absent && soldOutColour(c) ? <span className="sr-only"> ({t.unavailableOption})</span> : null}
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <div hidden={out}>
          <label htmlFor={`${id}-qty`} className="sf-label">
            {t.quantity}
          </label>
          <div className="inline-flex h-[3.25rem] items-center rounded-full border-[1.5px] border-sf-line-strong bg-sf-card">
            <button type="button" onClick={() => step(-1)} aria-label={t.decrease} className="sf-icon-btn ms-1">
              <Minus aria-hidden="true" size={18} strokeWidth={2} />
            </button>
            <input
              id={`${id}-qty`}
              inputMode="numeric"
              autoComplete="off"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              aria-invalid={message?.error && parseQuantity(quantity) === null ? true : undefined}
              className="sf-num h-full w-12 bg-transparent text-center text-base font-semibold focus:outline-none focus-visible:rounded-md focus-visible:outline-2"
            />
            <button type="button" onClick={() => step(1)} aria-label={t.increase} className="sf-icon-btn me-1">
              <Plus aria-hidden="true" size={18} strokeWidth={2} />
            </button>
          </div>
        </div>
        <button type="button" onClick={add} className="sf-btn sf-btn-lg hidden min-w-64 flex-1 lg:inline-flex" aria-disabled={!ready || undefined} data-testid="add-to-bag">
          {ready ? <ShoppingBag aria-hidden="true" size={20} strokeWidth={1.75} /> : null}
          {cta}
        </button>
      </div>

      {/* One answer for both layouts: in the panel on a desktop, a snackbar above the buying bar on a phone. */}
      <div role="status" aria-live="polite" className="sf-snack" data-state={message ? (message.error ? "error" : "ok") : "empty"}>
        {message ? (
          <span aria-hidden="true" className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${message.error ? "bg-sf-danger text-white" : "bg-sf-sun text-sf-ink"}`}>
            {message.error ? <CircleAlert size={16} strokeWidth={2.5} /> : <Check size={16} strokeWidth={2.5} />}
          </span>
        ) : null}
        <p className="min-w-0 flex-1 empty:hidden" data-testid="add-message">
          {message?.text ?? ""}
        </p>
        {message && !message.error ? (
          <span className="flex shrink-0 gap-4">
            <Link href={`${root}/${lang}/cart`} className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
              {t.viewBag}
            </Link>
            <Link href={`${root}/${lang}/checkout`} className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
              {t.toCheckout}
            </Link>
          </span>
        ) : null}
      </div>

      <div className="sf-bar sf-bar-phone">
        <div className="mx-auto flex h-[var(--sf-bar-h)] max-w-lg items-center gap-3 px-4">
          <BagLink lang={lang} place="bar" />
          <button type="button" onClick={add} className={`sf-btn min-h-[3.25rem] flex-1 ps-6 pe-5 ${ready ? "justify-between" : ""}`} aria-disabled={!ready || undefined}>
            <span>{cta}</span>
            {ready ? <span className="sf-num font-bold">{formatTaka(selected.pricePaisa, lang)}</span> : null}
          </button>
        </div>
      </div>
    </div>
  );
}
