"use client";

import Link from "next/link";
import { useActionState, useId, useState } from "react";
import { dictionary, formatTaka, type Lang, toBnDigits } from "@/modules/storefront/i18n";
import type { CheckoutResult } from "@/modules/storefront/service";
import { simulateCheckoutAction } from "../actions";
import { lineName, Totals, useQuote } from "./cart-view";

// The guest checkout form, as a simulation. The server validates it exactly as an order would be validated
// (simulateCheckoutAction) and answers with errors or a summary; it never records an order. The typed details
// stay in this form only: they are not stored in the browser and not sent anywhere else.

type Field = "name" | "phone" | "address";

export function CheckoutForm({ lang }: { lang: Lang }) {
  const t = dictionary(lang);
  const id = useId();
  const count = (n: number) => (lang === "bn" ? toBnDigits(n) : String(n));
  const [zone, setZone] = useState("");
  const { lines, quote, state: quoteState } = useQuote(zone);
  const [result, formAction, pending] = useActionState(simulateCheckoutAction, null);
  const [editing, setEditing] = useState(false);
  // Controlled, so a refused simulation keeps what was typed (React resets uncontrolled fields after an action).
  const [values, setValues] = useState<Record<Field, string>>({ name: "", phone: "", address: "" });
  const errors = result && !editing ? result.errors : {};
  const errorFor = (field: keyof CheckoutResult["errors"]) => (errors[field] ? t.errors[errors[field]] : null);

  if (lines.length === 0 && !result) {
    return (
      <div className="space-y-4" role="status">
        <p className="text-lg">{t.cartEmpty}</p>
        <Link href={`/office/storefront-preview/${lang}/products`} className="inline-flex min-h-11 items-center rounded-sm bg-sf-cocoa px-5 font-semibold text-sf-ivory">
          {t.continueShopping}
        </Link>
      </div>
    );
  }

  if (result?.ok && result.quote && result.customer && !editing) {
    const q = result.quote;
    return (
      <section aria-labelledby={`${id}-done`} className="max-w-2xl space-y-5 rounded-sm bg-white p-6" data-testid="simulation-result">
        <h2 id={`${id}-done`} className="text-2xl font-semibold" tabIndex={-1} ref={(el) => el?.focus()}>
          {t.simulatedTitle}
        </h2>
        <p role="status" className="rounded-sm bg-sf-amber px-4 py-3 font-semibold">
          {t.simulatedNote}
        </p>
        <p>{t.wouldBeReceived}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-sf-umber">{t.name}</dt>
          <dd>{result.customer.name}</dd>
          <dt className="text-sf-umber">{t.phone}</dt>
          <dd className="tabular-nums">{result.customer.phone}</dd>
          <dt className="text-sf-umber">{t.address}</dt>
          <dd className="whitespace-pre-line">{result.customer.address}</dd>
          <dt className="text-sf-umber">{t.zone}</dt>
          <dd>{q.zone ? t.deliveryZone[q.zone] : "—"}</dd>
        </dl>
        <ul className="divide-y divide-sf-line border-y border-sf-line">
          {q.lines.map((l) => (
            <li key={l.sku} className="flex justify-between gap-4 py-2 tabular-nums">
              <span>
                {lineName(lang, l, l.sku)} × {count(l.quantity)}
              </span>
              <span>{l.lineTotalPaisa !== null ? formatTaka(l.lineTotalPaisa, lang) : "—"}</span>
            </li>
          ))}
        </ul>
        <dl className="grid grid-cols-[1fr_auto] gap-y-1 tabular-nums">
          <dt>{t.subtotal}</dt>
          <dd className="text-right">{formatTaka(q.subtotalPaisa, lang)}</dd>
          <dt>{t.deliveryLine}</dt>
          <dd className="text-right">{q.deliveryChargePaisa !== null ? formatTaka(q.deliveryChargePaisa, lang) : "—"}</dd>
          <dt className="font-semibold">{t.total}</dt>
          <dd className="text-right text-lg font-semibold" data-testid="simulated-total">
            {q.totalPaisa !== null ? formatTaka(q.totalPaisa, lang) : "—"}
          </dd>
        </dl>
        <p className="text-sm text-sf-umber">{t.receivedNotConfirmed}</p>
        <button type="button" onClick={() => setEditing(true)} className="min-h-11 rounded-sm border border-sf-cocoa px-5 font-medium">
          {t.editOrder}
        </button>
      </section>
    );
  }

  const input = "mt-1 block min-h-11 w-full rounded-sm border bg-white px-3 text-base aria-[invalid=true]:border-2 aria-[invalid=true]:border-sf-danger";
  const field = (name: Field, label: string, options: { hint?: string; multiline?: boolean; autoComplete: string; inputMode?: "tel" | "text" }) => {
    const error = errorFor(name);
    const describedBy = [options.hint ? `${id}-${name}-hint` : null, error ? `${id}-${name}-error` : null].filter(Boolean).join(" ") || undefined;
    const common = {
      id: `${id}-${name}`,
      name,
      required: true,
      autoComplete: options.autoComplete,
      value: values[name],
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValues((v) => ({ ...v, [name]: e.target.value })),
      "aria-invalid": error ? true : undefined,
      "aria-describedby": describedBy,
      className: `${input} ${error ? "" : "border-sf-line"}`,
    };
    return (
      <div>
        <label htmlFor={`${id}-${name}`} className="font-medium">
          {label}
        </label>
        {options.multiline ? <textarea rows={3} maxLength={500} {...common} /> : <input type="text" inputMode={options.inputMode} maxLength={name === "name" ? 100 : 20} {...common} />}
        {options.hint ? (
          <p id={`${id}-${name}-hint`} className="mt-1 text-sm text-sf-umber">
            {options.hint}
          </p>
        ) : null}
        {error ? (
          <p id={`${id}-${name}-error`} className="mt-1 font-medium text-sf-danger">
            {error}
          </p>
        ) : null}
      </div>
    );
  };
  const summaryErrors = (Object.keys(errors) as (keyof CheckoutResult["errors"])[]).map((k) => errorFor(k)).filter(Boolean);

  return (
    <form action={(form) => { setEditing(false); formAction(form); }} className="grid gap-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" noValidate>
      <input type="hidden" name="lines" value={JSON.stringify(lines)} />
      <div className="space-y-5">
        <p className="rounded-sm border-2 border-sf-amber bg-white px-4 py-3 font-medium" data-testid="simulation-note">
          {t.simulateOnly}
        </p>
        {summaryErrors.length ? (
          <div role="alert" className="rounded-sm border-2 border-sf-danger bg-white px-4 py-3" data-testid="checkout-errors">
            <p className="font-semibold">{t.fixErrors}</p>
            <ul className="mt-1 list-disc pl-5">
              {summaryErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <fieldset className="space-y-4">
          <legend className="text-xl font-semibold">{t.contact}</legend>
          <p className="text-sf-umber">{t.guestNote}</p>
          {field("name", t.name, { autoComplete: "name" })}
          {field("phone", t.phone, { hint: t.phoneHint, autoComplete: "tel", inputMode: "tel" })}
          {field("address", t.address, { hint: t.addressHint, multiline: true, autoComplete: "street-address" })}
        </fieldset>
      </div>
      <aside aria-label={t.orderSummary} className="space-y-5 rounded-sm bg-white p-5 lg:self-start">
        <h2 className="text-xl font-semibold">{t.orderSummary}</h2>
        <p role="status" aria-live="polite" className="text-sm text-sf-umber">
          {quoteState === "loading" ? t.checkingCart : quoteState === "error" ? t.cartCheckFailed : ""}
        </p>
        <ul className="divide-y divide-sf-line border-y border-sf-line">
          {(quote?.lines ?? []).map((l) => (
            <li key={l.sku} className="flex justify-between gap-4 py-2 tabular-nums">
              <span>
                {lineName(lang, l, l.sku)} × {count(l.quantity)}
              </span>
              <span>{l.lineTotalPaisa !== null ? formatTaka(l.lineTotalPaisa, lang) : "—"}</span>
            </li>
          ))}
        </ul>
        <Totals quote={quote} lang={lang} zone={zone} onZone={setZone} />
        {errorFor("zone") ? <p className="font-medium text-sf-danger">{errorFor("zone")}</p> : null}
        {errorFor("cart") ? (
          <p className="font-medium text-sf-danger">
            {errorFor("cart")}{" "}
            <Link href={`/office/storefront-preview/${lang}/cart`} className="underline underline-offset-4">
              {t.cartTitle}
            </Link>
          </p>
        ) : null}
        <p className="text-sm">{t.receivedNotConfirmed}</p>
        <p className="text-sm font-medium">{t.payment}</p>
        <button type="submit" disabled={pending} className="min-h-12 w-full rounded-sm bg-sf-cocoa px-5 text-lg font-semibold text-sf-ivory disabled:opacity-70">
          {pending ? t.checking : t.placeOrder}
        </button>
      </aside>
    </form>
  );
}
