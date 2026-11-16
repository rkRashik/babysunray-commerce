"use client";

import Link from "next/link";
import { useId, useRef, useState } from "react";
import { dictionary, formatTaka, type Lang, toBnDigits } from "@/modules/storefront/i18n";
import type { CheckoutResult } from "@/modules/storefront/service";
import { simulateCheckoutAction } from "../actions";
import { lineName, Totals, useQuote } from "./cart-view";

// The guest checkout as a three-step simulation: details, review, summary. Each step asks the server to validate the
// details and re-check every line's price and stock exactly as an order would be checked (simulateCheckoutAction),
// and nothing more: no order, reservation, tracking link, payment or idempotency record is ever created, and nothing
// is sent anywhere. The typed details stay in this page's memory only.

type Field = "name" | "phone" | "address";
type Stage = "details" | "review" | "done";

export function CheckoutForm({ lang }: { lang: Lang }) {
  const t = dictionary(lang);
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [zone, setZone] = useState("");
  const { lines, quote, state: quoteState, retry } = useQuote(zone);
  const [values, setValues] = useState<Record<Field, string>>({ name: "", phone: "", address: "" });
  const [stage, setStage] = useState<Stage>("details");
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const count = (n: number) => (lang === "bn" ? toBnDigits(n) : String(n));
  const errors = stage === "details" && result ? result.errors : {};
  const errorFor = (field: keyof CheckoutResult["errors"]) => (errors[field] ? t.errors[errors[field]] : null);

  async function check(next: Stage) {
    setPending(true);
    setFailed(false);
    try {
      const form = new FormData();
      for (const [k, v] of Object.entries(values)) form.append(k, v);
      form.append("zone", zone);
      form.append("lines", JSON.stringify(lines));
      const answer = await simulateCheckoutAction(null, form);
      setResult(answer);
      setStage(answer.ok ? next : "details");
      requestAnimationFrame(() => heading.current?.focus());
    } catch {
      setFailed(true);
    }
    setPending(false);
  }

  if (lines.length === 0 && stage !== "done") {
    return (
      <div className="space-y-4" role="status">
        <p className="text-lg">{t.cartEmpty}</p>
        <Link href={`/office/storefront-preview/${lang}/products`} className="inline-flex min-h-11 items-center rounded-sm bg-sf-cocoa px-5 font-semibold text-sf-ivory">
          {t.continueShopping}
        </Link>
      </div>
    );
  }

  const steps: [Stage, string][] = [["details", t.stepDetails], ["review", t.stepReview], ["done", t.stepDone]];
  const position = steps.findIndex(([s]) => s === stage);
  const progress = (
    <ol className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm" aria-label={t.stepOf(count(position + 1), count(steps.length))} data-testid="checkout-steps">
      {steps.map(([s, label], i) => (
        <li key={s} aria-current={s === stage ? "step" : undefined} className={`flex items-center gap-2 ${s === stage ? "font-semibold" : "text-sf-umber"}`}>
          {/* Done steps filled, the current one outlined in cocoa: the number repeats the order for sighted readers. */}
          <span
            aria-hidden="true"
            className={`sf-pill inline-flex h-7 w-7 items-center justify-center border text-xs tabular-nums ${i < position ? "border-sf-cocoa bg-sf-cocoa text-sf-ivory" : s === stage ? "border-2 border-sf-cocoa bg-white text-sf-cocoa" : "border-sf-line bg-white"}`}
          >
            {count(i + 1)}
          </span>
          <span>{label}</span>
        </li>
      ))}
    </ol>
  );
  const notice = (
    <p className="rounded-sm border-2 border-sf-amber bg-white px-4 py-3 font-medium" data-testid="simulation-note">
      {t.simulateOnly}
    </p>
  );
  // At the last step a failure means the order was not placed (S-12); before it, only the check failed.
  const failure = failed ? (
    <p role="alert" className="font-medium text-sf-danger" data-testid="checkout-failure">
      {stage === "review" ? t.orderNotPlaced : t.cartCheckFailed}
    </p>
  ) : null;
  const q = result?.quote;
  const summary =
    q && result?.customer ? (
      <>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-sf-umber">{t.name}</dt>
          <dd>{result.customer.name}</dd>
          <dt className="text-sf-umber">{t.phone}</dt>
          <dd className="tabular-nums">{result.customer.phone}</dd>
          <dt className="text-sf-umber">{t.deliverTo}</dt>
          <dd className="whitespace-pre-line">
            {result.customer.address}
            {q.zone ? ` (${t.deliveryZone[q.zone]})` : ""}
          </dd>
        </dl>
        <ul className="divide-y divide-sf-line border-y border-sf-line">
          {q.lines.map((l) => (
            <li key={l.sku} className="flex justify-between gap-4 py-2 tabular-nums">
              <span>
                {lineName(lang, l, l.sku)}
                {[l.size, l.colour].filter(Boolean).length ? ` (${[l.size, l.colour].filter(Boolean).join(", ")})` : ""} × {count(l.quantity)}
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
        <p className="font-medium">{t.payment}</p>
      </>
    ) : null;

  if (stage === "done" && summary) {
    return (
      <section aria-labelledby={`${id}-done`} className="max-w-2xl space-y-5" data-testid="simulation-result">
        {progress}
        <h2 id={`${id}-done`} ref={heading} tabIndex={-1} className="text-2xl font-semibold focus:outline-none">
          {t.pendingTitle}
        </h2>
        <p role="status" className="rounded-sm bg-sf-amber px-4 py-3 font-semibold">
          {t.simulatedNote}
        </p>
        <p>{t.pendingBody}</p>
        <p className="sf-card border border-dashed border-sf-umber bg-white px-4 py-3 text-sm" data-testid="reference-preview">
          {t.referencePreview}
        </p>
        <section aria-labelledby={`${id}-next`} className="space-y-2" data-testid="next-steps">
          <h3 id={`${id}-next`} className="text-lg font-semibold">
            {t.nextTitle}
          </h3>
          <ol className="list-decimal space-y-1 pl-5">
            {t.nextSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </section>
        <div className="space-y-4 rounded-sm bg-white p-5">{summary}</div>
        <div className="flex flex-wrap gap-4">
          <button type="button" onClick={() => setStage("details")} className="min-h-11 rounded-sm border border-sf-cocoa px-5 font-medium">
            {t.editDetails}
          </button>
          <Link href={`/office/storefront-preview/${lang}/cart`} className="inline-flex min-h-11 items-center font-medium underline underline-offset-4">
            {t.backToCart}
          </Link>
        </div>
      </section>
    );
  }

  if (stage === "review" && summary) {
    return (
      <section aria-labelledby={`${id}-review`} className="max-w-2xl space-y-5" data-testid="checkout-review">
        {progress}
        {notice}
        <h2 id={`${id}-review`} ref={heading} tabIndex={-1} className="text-2xl font-semibold focus:outline-none">
          {t.reviewTitle}
        </h2>
        <div className="space-y-4 rounded-sm bg-white p-5">{summary}</div>
        <p className="text-sm">{t.receivedNotConfirmed}</p>
        {failure}
        <div className="flex flex-wrap items-center gap-4">
          <button type="button" onClick={() => check("done")} disabled={pending} className="min-h-12 rounded-sm bg-sf-cocoa px-6 text-lg font-semibold text-sf-ivory disabled:opacity-70">
            {pending ? t.checking : t.placeOrderSimulated}
          </button>
          <button type="button" onClick={() => setStage("details")} className="min-h-11 rounded-sm border border-sf-cocoa px-5 font-medium">
            {t.editDetails}
          </button>
          <Link href={`/office/storefront-preview/${lang}/cart`} className="inline-flex min-h-11 items-center font-medium underline underline-offset-4">
            {t.backToCart}
          </Link>
        </div>
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
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void check("review");
      }}
      className="grid gap-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
      noValidate
    >
      <div className="space-y-5">
        {progress}
        {notice}
        {summaryErrors.length ? (
          <div role="alert" className="rounded-sm border-2 border-sf-danger bg-white px-4 py-3" data-testid="checkout-errors">
            <h2 ref={heading} tabIndex={-1} className="font-semibold focus:outline-none">
              {t.fixErrors}
            </h2>
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
        {quoteState === "error" ? (
          <button type="button" onClick={retry} className="min-h-11 rounded-sm border border-sf-cocoa px-4 font-medium">
            {t.retry}
          </button>
        ) : null}
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
              {t.backToCart}
            </Link>
          </p>
        ) : null}
        <p className="text-sm">{t.receivedNotConfirmed}</p>
        {failure}
        <button type="submit" disabled={pending} className="min-h-12 w-full rounded-sm bg-sf-cocoa px-5 text-lg font-semibold text-sf-ivory disabled:opacity-70">
          {pending ? t.checking : t.reviewOrder}
        </button>
      </aside>
    </form>
  );
}
