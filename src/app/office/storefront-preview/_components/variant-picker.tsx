"use client";

import { useId, useState } from "react";
import { addToCart, parseQuantity } from "@/modules/storefront/cart";
import { dictionary, formatTaka, type Lang } from "@/modules/storefront/i18n";
import type { PreviewVariant } from "@/modules/storefront/service";
import { useCart } from "./cart-store";

// Size and colour choice, quantity and "Add to cart" on the product page. Sizes show the product's own
// measurements in cm under the label. Availability comes from the server render; the cart page checks it again
// against the database. Adding to the cart holds no stock (the cart is not a reservation).

type Props = { lang: Lang; productName: string; variants: PreviewVariant[]; sizes: string[]; measurements: Record<string, string> };

const CHIP =
  "relative flex min-h-11 cursor-pointer flex-col justify-center rounded-sm border px-4 py-2 has-[:checked]:border-2 has-[:checked]:border-sf-cocoa has-[:checked]:bg-white has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-sf-cocoa";

export function VariantPicker({ lang, productName, variants, sizes, measurements }: Props) {
  const t = dictionary(lang);
  const id = useId();
  const [lines, setLines] = useCart();
  const colours = [...new Set(variants.map((v) => v.colour).filter((c): c is string => c !== null))];
  const [size, setSize] = useState<string | null>(sizes.length === 1 ? sizes[0] : null);
  const [colour, setColour] = useState<string | null>(colours.length === 1 ? colours[0] : null);
  const [quantity, setQuantity] = useState("1");
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const selected =
    variants.find((v) => (sizes.length === 0 || v.size === size) && (colours.length === 0 || v.colour === colour)) ?? (variants.length === 1 ? variants[0] : null);
  const soldOutSize = (s: string) => variants.filter((v) => v.size === s).every((v) => v.available === 0);
  const soldOutColour = (c: string) => variants.filter((v) => v.colour === c && (size === null || v.size === size)).every((v) => v.available === 0);
  const prices = variants.map((v) => v.pricePaisa);
  const price = selected ? formatTaka(selected.pricePaisa, lang) : Math.min(...prices) === Math.max(...prices) ? formatTaka(prices[0], lang) : t.from(formatTaka(Math.min(...prices), lang));
  const inCart = selected ? (lines.find((l) => l.sku === selected.sku)?.quantity ?? 0) : 0;

  function add() {
    if (!selected) return setMessage({ text: t.chooseFirst, error: true });
    if (selected.available === 0) return setMessage({ text: t.outOfStock, error: true });
    const n = parseQuantity(quantity);
    if (n === null) return setMessage({ text: t.quantityInvalid(Math.max(1, Math.min(1000, selected.available))), error: true });
    if (n + inCart > selected.available) return setMessage({ text: t.onlyAvailable(selected.available), error: true });
    setLines(addToCart(lines, selected.sku, n));
    setMessage({ text: t.added(productName, n), error: false });
  }

  const step = (delta: number) => {
    const n = parseQuantity(quantity) ?? 1;
    setQuantity(String(Math.min(1000, Math.max(1, n + delta))));
  };

  return (
    <div className="space-y-6">
      <p className="text-2xl font-semibold tabular-nums" data-testid="price">
        {price}
      </p>
      {sizes.length ? (
        <fieldset>
          <legend className="mb-2 font-medium">{size ? t.chosen(t.size, size) : t.chooseSize}</legend>
          <div className="flex flex-wrap gap-2">
            {sizes.map((s) => (
              <label key={s} className={`${CHIP} ${soldOutSize(s) ? "border-dashed border-sf-umber text-sf-umber" : "border-sf-line bg-sf-ivory"}`}>
                <input type="radio" name={`${id}-size`} value={s} checked={size === s} onChange={() => setSize(s)} className="sr-only" />
                <span className="font-semibold">{s}</span>
                {measurements[s] ? <span className="text-xs text-sf-umber">{measurements[s]}</span> : null}
                {soldOutSize(s) ? <span className="text-xs">{t.unavailableOption}</span> : null}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {colours.length ? (
        <fieldset>
          <legend className="mb-2 font-medium">{colour ? t.chosen(t.colour, colour) : t.chooseColour}</legend>
          <div className="flex flex-wrap gap-2">
            {colours.map((c) => {
              // A colour that does not exist in the chosen size cannot be chosen with it.
              const absent = size !== null && sizes.length > 0 && !variants.some((v) => v.size === size && v.colour === c);
              return (
                <label key={c} className={`${CHIP} ${absent ? "cursor-not-allowed border-dashed border-sf-line text-sf-umber opacity-70" : soldOutColour(c) ? "border-dashed border-sf-umber text-sf-umber" : "border-sf-line bg-sf-ivory"}`}>
                  <input type="radio" name={`${id}-colour`} value={c} checked={colour === c && !absent} disabled={absent} onChange={() => setColour(c)} className="sr-only" />
                  <span className="font-medium">{c}</span>
                  {absent ? <span className="text-xs">{t.notInThisSize}</span> : soldOutColour(c) ? <span className="text-xs">{t.unavailableOption}</span> : null}
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}
      <p data-testid="availability" className={selected && selected.available === 0 ? "font-medium text-sf-danger" : "text-sf-umber"}>
        {selected ? (selected.available === 0 ? t.soldOut : `${t.inStock}: ${t.available(selected.available)}`) : t.chooseFirst}
      </p>
      <div>
        <label htmlFor={`${id}-qty`} className="mb-2 block font-medium">
          {t.quantity}
        </label>
        <div className="flex items-stretch gap-2">
          <button type="button" onClick={() => step(-1)} aria-label={t.decrease} className="min-h-11 min-w-11 rounded-sm border border-sf-line bg-white text-lg">
            −
          </button>
          <input
            id={`${id}-qty`}
            inputMode="numeric"
            autoComplete="off"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            aria-invalid={message?.error && parseQuantity(quantity) === null ? true : undefined}
            className="min-h-11 w-20 rounded-sm border border-sf-line bg-white px-3 text-center text-base tabular-nums"
          />
          <button type="button" onClick={() => step(1)} aria-label={t.increase} className="min-h-11 min-w-11 rounded-sm border border-sf-line bg-white text-lg">
            +
          </button>
        </div>
      </div>
      <button type="button" onClick={add} className="min-h-12 w-full rounded-sm bg-sf-cocoa px-6 text-lg font-semibold text-sf-ivory hover:bg-[#4a3c33] sm:w-auto">
        {t.addToCart}
      </button>
      <p role="status" aria-live="polite" className={message?.error ? "font-medium text-sf-danger" : "font-medium"} data-testid="add-message">
        {message?.text ?? ""}
      </p>
      <p className="text-sm text-sf-umber">{t.notInCart}</p>
    </div>
  );
}
