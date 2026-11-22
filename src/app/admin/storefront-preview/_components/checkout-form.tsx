"use client";

import { ArrowLeft, Banknote, Check, ChevronDown, CircleAlert, Copy, Info, Lock, PhoneCall } from "lucide-react";
import Link from "next/link";
import { useId, useRef, useState } from "react";
import { SunMark } from "@/app/_design/sun-mark";
import { dictionary, formatTaka, type Lang, localised, toBnDigits } from "@/modules/storefront/i18n";
import type { CheckoutResult, Quote } from "@/modules/storefront/service";
import { useCart } from "./cart-store";
import { EmptyBag, LineThumb, lineName, TotalsList, useZoneQuote, ZoneChoice } from "./cart-view";
import { GoogleSignInButton } from "./customer-auth";
import { useSurface, useWide } from "./frame";

// The guest checkout in three steps: contact, delivery, review; then a confirmation. Every step asks the server to validate
// the details and re-check every line's price and stock exactly as an order would be checked (the surface's check action)
// and shows the problems that belong to that step; the last step needs the whole check to pass.
//
// Preview: a simulation. Nothing is recorded: no order, reservation, tracking link or idempotency record.
// Shop: the last step places a REAL order (POST /api/shop/checkout, src/api/guest-checkout.ts) with the prices the server
// showed and one idempotency key per checkout, so pressing the button again after a lost answer returns the same order,
// never a second one. "Order received" appears only after the server answered that the order was committed; any other
// answer says the order was not placed (or, without an answer, that we do not know and the same button retries safely).
// The typed details stay in this page's memory only; the private tracking link is shown once and never stored here.

type Field = "name" | "phone" | "address";
/** The server's answer to a placed order (GuestOrderResult without anything the page does not show). */
type Placed = {
  replayed: boolean;
  trackingToken: string | null;
  order: { reference: string; placedAt: string; deliveryZone: string; items: { sku: string; name: { en: string | null; bn: string | null }; size: string | null; colour: string | null; quantity: number; lineTotalPaisa: number }[]; subtotalPaisa: number; deliveryChargePaisa: number; totalPaisa: number };
};

const newKey = () => crypto.randomUUID();

/** The private tracking link, shown once with a copy button. */
function TrackingLink({ lang, token }: { lang: Lang; token: string }) {
  const t = dictionary(lang);
  const [copied, setCopied] = useState<"" | "ok" | "failed">("");
  const link = `${window.location.origin}/track#t=${token}`;
  return (
    <div className="space-y-3 rounded-[1.25rem] border border-sf-sun-glow bg-sf-sun-soft p-5" data-testid="tracking-link">
      <p className="flex items-center gap-2 font-bold">
        <Lock aria-hidden="true" size={18} strokeWidth={2} />
        {t.trackTitle}
      </p>
      <p className="text-[0.9375rem]">{t.trackBody}</p>
      <p className="break-all rounded-xl bg-sf-card px-3 py-3 font-mono text-[0.875rem]" lang="en" data-testid="tracking-url">
        {link}
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className="sf-btn sf-btn-ink sf-btn-sm gap-2"
          onClick={() =>
            navigator.clipboard.writeText(link).then(
              () => setCopied("ok"),
              () => setCopied("failed"),
            )
          }
        >
          <Copy aria-hidden="true" size={16} strokeWidth={2} />
          {t.copyLink}
        </button>
        <a href={link} target="_blank" rel="noreferrer noopener" className="sf-btn sf-btn-ghost sf-btn-sm">
          {t.openTracking}
        </a>
      </div>
      <p role="status" className="text-[0.875rem] font-semibold empty:hidden">
        {copied === "ok" ? t.linkCopied : copied === "failed" ? t.copyFailed : ""}
      </p>
    </div>
  );
}
type Stage = "contact" | "delivery" | "review" | "done";
type ErrorKey = keyof CheckoutResult["errors"];

const STEP_FIELDS: Record<Exclude<Stage, "done">, ErrorKey[]> = { contact: ["name", "phone"], delivery: ["address", "zone", "cart"], review: ["name", "phone", "address", "zone", "cart"] };
const NEXT: Record<Exclude<Stage, "done">, Stage> = { contact: "delivery", delivery: "review", review: "done" };

function Summary({ quote, lang, zone }: { quote: Quote | null; lang: Lang; zone: string }) {
  const count = (n: number) => (lang === "bn" ? toBnDigits(n) : String(n));
  return (
    <div className="space-y-5">
      <ul className="space-y-4">
        {(quote?.lines ?? []).map((l) => (
          <li key={l.sku} className="flex items-center gap-3">
            <div className="relative">
              <LineThumb line={l} className="aspect-[4/5] w-14" />
              <span className="sf-count sf-num absolute -end-1.5 -top-1">{count(l.quantity)}</span>
            </div>
            <div className="min-w-0 flex-1 text-[0.9375rem]">
              <p className="truncate font-semibold">{lineName(lang, l, l.sku)}</p>
              <p className="text-[0.8125rem] text-sf-ink-2">{[l.size, l.colour].filter(Boolean).join(", ")}</p>
            </div>
            <p className="sf-num shrink-0 font-semibold whitespace-nowrap">{l.lineTotalPaisa !== null ? formatTaka(l.lineTotalPaisa, lang) : "—"}</p>
          </li>
        ))}
      </ul>
      <TotalsList quote={quote} lang={lang} zone={zone} />
    </div>
  );
}

/** What happens after an order: three numbered steps, the same in the simulation and after a real order. */
function NextSteps({ lang }: { lang: Lang }) {
  const t = dictionary(lang);
  return (
    <ol className="space-y-3.5">
      {t.nextSteps.slice(0, 3).map((step, i) => (
        <li key={step} className="flex gap-3">
          <span aria-hidden="true" className="sf-step-num" data-state="current">
            {lang === "bn" ? toBnDigits(i + 1) : i + 1}
          </span>
          <span className="pt-0.5">{step}</span>
        </li>
      ))}
    </ol>
  );
}

export function CheckoutForm({ lang }: { lang: Lang }) {
  const t = dictionary(lang);
  const id = useId();
  const wide = useWide();
  const { surface, root, actions, customer, policies, signIn } = useSurface();
  const shop = surface === "shop";
  const [, setCart] = useCart();
  const heading = useRef<HTMLHeadingElement>(null);
  // The area chosen in the bag carries over; the server prices it again here and at every step.
  const { zone, setZone, lines, quote, state: quoteState, retry } = useZoneQuote();
  const [values, setValues] = useState<Record<Field, string>>({ name: customer?.name.slice(0, 100) ?? "", phone: "", address: "" });
  // One key per checkout: a retry after a lost answer sends the same key and gets the same order back.
  const key = useRef<string | null>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [placeFailure, setPlaceFailure] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("contact");
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const [shown, setShown] = useState<ErrorKey[]>([]);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const count = (n: number) => (lang === "bn" ? toBnDigits(n) : String(n));
  const errorFor = (field: ErrorKey) => (shown.includes(field) && result?.errors[field] ? t.errors[result.errors[field]] : null);

  const go = (next: Stage) => {
    setStage(next);
    setShown([]);
    setFailed(false);
    requestAnimationFrame(() => {
      heading.current?.focus();
      heading.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  };

  async function check(from: Exclude<Stage, "done">) {
    setPending(true);
    setFailed(false);
    try {
      const form = new FormData();
      for (const [k, v] of Object.entries(values)) form.append(k, v);
      form.append("zone", zone);
      form.append("lines", JSON.stringify(lines));
      const answer = await actions.check(null, form);
      setResult(answer);
      const problems = STEP_FIELDS[from].filter((f) => answer.errors[f]);
      const passes = from === "review" ? answer.ok : problems.length === 0;
      if (passes && from === "review" && shop && answer.customer && answer.quote) await place(answer);
      else if (passes) go(NEXT[from]);
      else {
        // At the last step a problem belongs to an earlier step: go back to the first step that has one.
        const back = from !== "review" ? from : problems.some((f) => f === "name" || f === "phone") ? "contact" : "delivery";
        setStage(back);
        setShown(STEP_FIELDS[back].filter((f) => answer.errors[f]));
        requestAnimationFrame(() => heading.current?.focus());
      }
    } catch {
      setFailed(true);
    }
    setPending(false);
  }

  /** Places the real order with exactly the prices and charge the server just showed. Only a 200 or 201 means it exists. */
  async function place(checked: CheckoutResult) {
    const q = checked.quote;
    const c = checked.customer;
    if (!q || !c || q.zone === null || q.deliveryChargePaisa === null || q.totalPaisa === null) return;
    key.current ??= newKey();
    setPlaceFailure(null);
    let response: Response;
    try {
      response = await fetch("/api/shop/checkout", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key.current },
        body: JSON.stringify({
          customer: { name: c.name, phone: c.phone, address: c.address },
          deliveryZone: q.zone,
          items: q.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, unitPricePaisa: l.unitPricePaisa })),
          deliveryChargePaisa: q.deliveryChargePaisa,
          totalPaisa: q.totalPaisa,
        }),
      });
    } catch {
      // No answer: the order may or may not exist. The same key makes pressing again safe.
      setPlaceFailure(t.checkoutFailures.network);
      return;
    }
    const body = (await response.json().catch(() => null)) as { data?: Placed & { order: Placed["order"] }; error?: string } | null;
    if ((response.status === 200 || response.status === 201) && body?.data?.order) {
      setPlaced({ replayed: response.status === 200, trackingToken: body.data.trackingToken ?? null, order: body.data.order });
      key.current = null;
      setCart([]);
      go("done");
      return;
    }
    const code = body?.error ?? (response.status >= 500 ? "internal" : "invalid");
    // A definite refusal: nothing was created, so a new attempt may use a new key.
    if (code === "key_reused") key.current = null;
    setPlaceFailure(t.checkoutFailures[code] ?? t.checkoutFailures.internal);
  }

  if (placed && stage === "done") {
    const o = placed.order;
    return (
      <section aria-labelledby={`${id}-placed`} className="mx-auto max-w-2xl space-y-8" data-testid="order-placed">
        <div className="sf-enter flex flex-col items-center gap-4 pt-2 text-center">
          <SunMark className="sf-rays h-14 w-24 text-sf-sun" />
          <h1 id={`${id}-placed`} ref={heading} tabIndex={-1} className="sf-display text-[2.125rem] focus:outline-none lg:text-[2.75rem]">
            {t.orderReceivedTitle}
          </h1>
          <p className="sf-badge px-4 py-1.5 text-[0.9375rem]" data-tone="sun">
            {t.orderReference}: <span className="sf-num font-bold" lang="en" data-testid="order-reference">{o.reference}</span>
          </p>
          <p className="max-w-prose text-sf-ink-2">{t.orderReceivedBody}</p>
        </div>
        {placed.trackingToken ? <TrackingLink lang={lang} token={placed.trackingToken} /> : <p className="sf-note" data-tone="sun">{t.replayedNote}</p>}
        <section aria-labelledby={`${id}-next`} className="sf-card space-y-4 p-5" data-testid="next-steps">
          <h3 id={`${id}-next`} className="sf-plain text-lg">
            {t.nextTitle}
          </h3>
          <NextSteps lang={lang} />
        </section>
        <div className="sf-card space-y-4 p-5 lg:p-7">
          <ul className="space-y-2 text-[0.9375rem]">
            {o.items.map((i) => (
              <li key={i.sku} className="flex justify-between gap-3">
                <span>
                  {count(i.quantity)} × {localised(lang, i.name.en, i.name.bn) ?? localised(lang === "en" ? "bn" : "en", i.name.en, i.name.bn) ?? i.sku}
                  {[i.size, i.colour].filter(Boolean).length ? <span className="text-sf-ink-2"> ({[i.size, i.colour].filter(Boolean).join(", ")})</span> : null}
                </span>
                <span className="sf-num shrink-0 font-semibold">{formatTaka(i.lineTotalPaisa, lang)}</span>
              </li>
            ))}
          </ul>
          <dl className="sf-num grid grid-cols-[1fr_auto] gap-y-1.5 border-t border-sf-line pt-3 text-[0.9375rem]">
            <dt className="text-sf-ink-2">{t.subtotal}</dt>
            <dd className="text-end">{formatTaka(o.subtotalPaisa, lang)}</dd>
            <dt className="text-sf-ink-2">
              {t.deliveryLine} ({t.deliveryZone[o.deliveryZone] ?? o.deliveryZone})
            </dt>
            <dd className="text-end">{formatTaka(o.deliveryChargePaisa, lang)}</dd>
            <dt className="flex items-center gap-2 font-bold">
              <Banknote aria-hidden="true" size={18} strokeWidth={1.75} />
              {t.total}
            </dt>
            <dd className="sf-price text-end text-[1.5rem]" data-testid="placed-total">
              {formatTaka(o.totalPaisa, lang)}
            </dd>
          </dl>
        </div>
        <Link href={`${root}/${lang}/products`} className="sf-btn sf-btn-lg w-full">
          {t.continueShopping}
        </Link>
      </section>
    );
  }

  // The page heading belongs to the form: after a confirmation the confirmation's own heading takes its place.
  const titled = (content: React.ReactNode) => (
    <div className="space-y-4 lg:space-y-8">
      <h1 className="sf-display text-[2.125rem] lg:text-[3.25rem]">{t.checkoutTitle}</h1>
      {content}
    </div>
  );
  if (lines.length === 0 && stage !== "done") return titled(<EmptyBag lang={lang} message={t.cartEmpty} />);

  const steps: [Exclude<Stage, "done">, string][] = [["contact", t.stepContact], ["delivery", t.stepDelivery], ["review", t.stepReview]];
  const position = stage === "done" ? steps.length : steps.findIndex(([s]) => s === stage);
  const progress = (
    <ol className="flex items-center gap-2" aria-label={t.stepOf(count(Math.min(position + 1, 3)), count(steps.length))} data-testid="checkout-steps">
      {steps.map(([s, label], i) => (
        <li key={s} aria-current={s === stage ? "step" : undefined} className={`flex min-w-0 items-center gap-2 text-[0.9375rem] ${i < steps.length - 1 ? "flex-1" : ""} ${i <= position ? "font-bold text-sf-ink" : "font-semibold text-sf-ink-2"}`}>
          <span className="sf-step-num" data-state={i < position ? "done" : i === position ? "current" : undefined} aria-hidden="true">
            {i < position ? <Check size={16} strokeWidth={3} /> : count(i + 1)}
          </span>
          <span className="truncate">{label}</span>
          {i < steps.length - 1 ? <span aria-hidden="true" className={`h-0.5 min-w-3 flex-1 rounded-full ${i < position ? "bg-sf-success" : "bg-sf-line-strong/50"}`} /> : null}
        </li>
      ))}
    </ol>
  );
  const notice = shop ? (
    <p className="sf-note">
      <Info aria-hidden="true" size={18} strokeWidth={1.75} />
      <span>{t.placeNote}</span>
    </p>
  ) : (
    <p className="sf-note" data-tone="sun" data-testid="simulation-note">
      <Info aria-hidden="true" size={18} strokeWidth={1.75} />
      <span>{t.simulateOnly}</span>
    </p>
  );
  const policyNote = shop && policies.length ? (
    <p className="text-[0.9375rem]" data-testid="checkout-policies">
      {t.readBeforeOrder}:{" "}
      {policies.map((p, i) => (
        <span key={p.kind}>
          {i ? ", " : ""}
          <Link href={p.href} target="_blank" className="sf-link">
            {t.policyNames[p.kind] ?? p.kind}
          </Link>
        </span>
      ))}
    </p>
  ) : null;
  // At the last step a failure means the order was not placed (S-12); before it, only the check failed.
  const failure =
    failed || placeFailure ? (
      <p role="alert" className="sf-note font-semibold" data-tone="bad" data-testid="checkout-failure">
        {placeFailure ?? (stage === "review" ? t.orderNotPlaced : t.cartCheckFailed)}
      </p>
    ) : null;
  const errorList = shown.map((k) => errorFor(k)).filter((e): e is string => e !== null);
  const errors = errorList.length ? (
    <div role="alert" className="rounded-2xl border-[1.5px] border-sf-danger bg-sf-danger-soft px-4 py-3 text-sf-danger" data-testid="checkout-errors">
      <p className="flex items-center gap-2 font-bold">
        <CircleAlert aria-hidden="true" size={18} strokeWidth={2} />
        {t.fixErrors}
      </p>
      <ul className="mt-1 list-disc ps-5 text-[0.9375rem]">
        {errorList.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
      {errorFor("cart") ? (
        <Link href={`${root}/${lang}/cart`} className="mt-1 inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
          {t.backToCart}
        </Link>
      ) : null}
    </div>
  ) : null;

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
      className: "sf-field",
    };
    return (
      <div>
        <label htmlFor={`${id}-${name}`} className="sf-label">
          {label}
        </label>
        {options.multiline ? <textarea rows={3} maxLength={500} {...common} /> : <input type={options.inputMode === "tel" ? "tel" : "text"} inputMode={options.inputMode} maxLength={name === "name" ? 100 : 20} {...common} />}
        {options.hint ? (
          <p id={`${id}-${name}-hint`} className="sf-hint mt-1.5">
            {options.hint}
          </p>
        ) : null}
        {error ? (
          <p id={`${id}-${name}-error`} className="sf-error mt-1.5">
            <CircleAlert aria-hidden="true" size={16} strokeWidth={2} className="mt-0.5 shrink-0" />
            {error}
          </p>
        ) : null}
      </div>
    );
  };

  const total = quote?.totalPaisa ?? quote?.subtotalPaisa ?? null;
  // On a phone the order summary folds at the top; on a desktop it stays beside the steps.
  const summaryFold = (
    <details className="group sf-card px-4" open={stage === "review"}>
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 font-semibold [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-1.5">
          {t.showSummary}
          <ChevronDown aria-hidden="true" size={18} strokeWidth={2} className="transition-transform duration-300 group-open:rotate-180" />
        </span>
        <span className="sf-num">{total !== null ? formatTaka(total, lang) : ""}</span>
      </summary>
      <div className="pb-5">
        <Summary quote={quote} lang={lang} zone={zone} />
      </div>
    </details>
  );
  const aside = (
    <aside aria-label={t.orderSummary} className="sf-card space-y-5 self-start p-7 lg:sticky lg:top-28">
      <h2 className="text-[1.5rem]">{t.orderSummary}</h2>
      <p role="status" aria-live="polite" className="text-[0.875rem] text-sf-ink-2 empty:hidden">
        {quoteState === "loading" ? t.checkingCart : quoteState === "error" ? t.cartCheckFailed : ""}
      </p>
      {quoteState === "error" ? (
        <button type="button" onClick={retry} className="sf-btn sf-btn-ghost sf-btn-sm">
          {t.retry}
        </button>
      ) : null}
      <Summary quote={quote} lang={lang} zone={zone} />
    </aside>
  );

  if (stage === "done" && result?.customer && result.quote) {
    const q = result.quote;
    return (
      <section aria-labelledby={`${id}-done`} className="mx-auto max-w-2xl space-y-8" data-testid="simulation-result">
        <div className="sf-enter flex flex-col items-center gap-4 pt-2 text-center">
          <SunMark className="sf-rays h-14 w-24 text-sf-sun" />
          <h1 id={`${id}-done`} ref={heading} tabIndex={-1} className="sf-display text-[2.125rem] focus:outline-none lg:text-[2.75rem]">
            {t.pendingTitle}
          </h1>
          <p role="status" className="sf-badge max-w-full rounded-2xl px-4 py-1.5 text-center text-[0.875rem] whitespace-normal" data-tone="sun">
            {t.simulatedNote}
          </p>
          <p className="max-w-prose text-sf-ink-2">{t.pendingBody}</p>
        </div>
        <p className="rounded-2xl border-2 border-dashed border-sf-line-strong px-4 py-3 text-center text-[0.875rem] text-sf-ink-2" data-testid="reference-preview">
          {t.referencePreview}
        </p>
        <section aria-labelledby={`${id}-next`} className="sf-card space-y-4 p-5" data-testid="next-steps">
          <h3 id={`${id}-next`} className="sf-plain text-lg">
            {t.nextTitle}
          </h3>
          <NextSteps lang={lang} />
        </section>
        <div className="space-y-3 rounded-[1.25rem] border border-sf-sun-glow bg-sf-sun-soft p-5">
          <p className="flex items-center gap-2 font-bold">
            <Lock aria-hidden="true" size={18} strokeWidth={2} />
            {t.nextSteps[3]}
          </p>
          <p className="rounded-xl border-2 border-dashed border-sf-line-strong bg-sf-card px-3 py-3 text-[0.9375rem] text-sf-ink-2">{t.linkPreview}</p>
        </div>
        <div className="sf-card space-y-5 p-5 lg:p-7">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[0.9375rem]">
            <dt className="text-sf-ink-2">{t.name}</dt>
            <dd>{result.customer.name}</dd>
            <dt className="text-sf-ink-2">{t.phone}</dt>
            <dd className="sf-num">{result.customer.phone}</dd>
            <dt className="text-sf-ink-2">{t.deliverTo}</dt>
            <dd className="whitespace-pre-line">
              {result.customer.address}
              {q.zone ? ` (${t.deliveryZone[q.zone]})` : ""}
            </dd>
          </dl>
          {/* One total: the summary's "Total to pay on delivery" already says how it is paid. */}
          <Summary quote={q} lang={lang} zone={q.zone ?? ""} />
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Link href={`${root}/${lang}/products`} className="sf-btn sf-btn-lg flex-1">
            {t.continueShopping}
          </Link>
          {/* Only the simulation can go back: nothing was recorded. A real order is never edited from here. */}
          <button type="button" onClick={() => go("contact")} className="sf-btn sf-btn-ghost sf-btn-lg flex-1">
            {t.simulationEdit}
          </button>
        </div>
      </section>
    );
  }

  const stepTitle = stage === "contact" ? t.contact : stage === "delivery" ? t.deliverTo : t.reviewTitle;
  const button = (label: string) => (
    <button type="submit" disabled={pending} className="sf-btn sf-btn-lg w-full lg:w-auto lg:min-w-72">
      {pending ? (shop && stage === "review" ? t.placing : t.checking) : label}
    </button>
  );

  const back = (to: Stage) => (
    <button type="button" onClick={() => go(to)} className="sf-btn sf-btn-ghost sf-btn-lg">
      <ArrowLeft aria-hidden="true" size={18} strokeWidth={2} className="rtl:rotate-180" />
      {t.back}
    </button>
  );
  const actionsRow = (from: Stage | null, label: string) => (
    <div className="flex flex-col-reverse items-stretch gap-3 lg:flex-row lg:items-center">
      {from ? (
        back(from)
      ) : (
        <Link href={`${root}/${lang}/cart`} className="sf-btn sf-btn-ghost sf-btn-lg">
          <ArrowLeft aria-hidden="true" size={18} strokeWidth={2} className="rtl:rotate-180" />
          {t.backToCart}
        </Link>
      )}
      {button(label)}
    </div>
  );

  return titled(
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:gap-12">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (stage !== "done") void check(stage);
        }}
        className="min-w-0 space-y-6"
        noValidate
        data-testid={stage === "review" ? "checkout-review" : undefined}
      >
        {wide ? null : summaryFold}
        {progress}
        <h2 ref={heading} tabIndex={-1} className="scroll-mt-28 text-[1.75rem] focus:outline-none lg:text-[2.125rem]">
          {stepTitle}
        </h2>
        {errors}

        {stage === "contact" ? (
          <div className="space-y-5">
            {customer ? (
              <p className="sf-badge" data-tone="ok" data-testid="checkout-signed-in">
                <Check aria-hidden="true" size={15} strokeWidth={2.5} />
                {t.signedInAs(customer.name)}
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <p className="sf-badge" data-tone="ok">
                  <Check aria-hidden="true" size={15} strokeWidth={2.5} />
                  {t.guestNote}
                </p>
                {shop && signIn ? <GoogleSignInButton lang={lang} returnTo={`/${lang}/checkout`} className="sf-btn-sm" /> : null}
              </div>
            )}
            {field("name", t.name, { autoComplete: "name" })}
            {field("phone", t.phone, { hint: t.phoneHint, autoComplete: "tel", inputMode: "tel" })}
            {failure}
            {actionsRow(null, t.continue)}
          </div>
        ) : null}

        {stage === "delivery" ? (
          <div className="space-y-6">
            {field("address", t.address, { hint: t.addressHint, multiline: true, autoComplete: "street-address" })}
            <div>
              <ZoneChoice quote={quote} lang={lang} zone={zone} onZone={setZone} invalid={Boolean(errorFor("zone"))} />
              {errorFor("zone") ? <p className="mt-1.5 text-[0.875rem] font-semibold text-sf-danger">{errorFor("zone")}</p> : null}
            </div>
            {failure}
            {actionsRow("contact", t.continue)}
          </div>
        ) : null}

        {stage === "review" ? (
          <div className="space-y-6">
            <div className="sf-card divide-y divide-sf-line">
              <div className="flex items-start justify-between gap-4 p-4">
                <div className="min-w-0 text-[0.9375rem]">
                  <p className="text-[0.8125rem] font-semibold text-sf-ink-2">{t.stepContact}</p>
                  <p>{result?.customer?.name ?? values.name}</p>
                  <p className="sf-num">{result?.customer?.phone ?? values.phone}</p>
                </div>
                <button type="button" onClick={() => go("contact")} className="sf-link inline-flex min-h-11 shrink-0 items-center">
                  {t.edit}
                </button>
              </div>
              <div className="flex items-start justify-between gap-4 p-4">
                <div className="min-w-0 text-[0.9375rem]">
                  <p className="text-[0.8125rem] font-semibold text-sf-ink-2">{t.deliverTo}</p>
                  <p className="whitespace-pre-line">{result?.customer?.address ?? values.address}</p>
                  <p>{t.deliveryZone[zone] ?? ""}</p>
                </div>
                <button type="button" onClick={() => go("delivery")} className="sf-link inline-flex min-h-11 shrink-0 items-center">
                  {t.edit}
                </button>
              </div>
              <div className="flex items-center gap-3 p-4 text-[0.9375rem]">
                <Banknote aria-hidden="true" size={20} strokeWidth={1.75} className="shrink-0" />
                <p>
                  <span className="font-semibold">{t.cod}.</span> {t.codNote}
                </p>
              </div>
            </div>
            <p className="sf-note">
              <PhoneCall aria-hidden="true" size={18} strokeWidth={1.75} />
              <span>{t.receivedNotConfirmed}</span>
            </p>
            {policyNote}
            {notice}
            {failure}
            {actionsRow("delivery", shop ? t.placeOrder : t.placeOrderSimulated)}
          </div>
        ) : null}
      </form>
      {wide ? aside : null}
    </div>
  );
}
