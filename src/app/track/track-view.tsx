"use client";

import { Check, Home, Link2, Package, PhoneCall, Truck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { GuestView } from "@/modules/orders/tracking";
import { formatTaka, type Lang, toBnDigits } from "@/modules/storefront/i18n";

// The customer's private order page. The token is read from the URL fragment (#t=...), which browsers never
// send to a server, and posted to /api/track in a same-origin JSON body. Right after reading it, the page
// replaces its own history entry with plain /track, so the token leaves the address bar, the back and forward
// history of this tab and anything copied from the address bar. It is then kept in memory only: never in
// storage, a URL, a log or a third-party request (this page loads no third-party code). Reloading therefore
// needs the original link again (docs/operations/runbook.md, Guest tracking). The language switch is page state only,
// so switching never touches the address bar or the token.

const TEXT = {
  en: {
    status: {
      pending_verification: "Received, waiting for the shop to confirm with you",
      verification_expired: "Received, waiting for the shop's review",
      confirmed: "Confirmed",
      cancelled: "Cancelled",
      closed: "Completed",
      unfulfilled: "Not packed yet",
      packed: "Packed",
      dispatched: "On its way",
      delivered: "Delivered",
      rto: "Returning to the shop",
      rto_received: "Returned to the shop",
    } as Record<string, string>,
    steps: ["Received", "Confirmed", "Packed", "On its way", "Delivered"],
    callNote: "The shop will contact you to confirm the order. It is confirmed only after that.",
    order: (ref: string) => `Order ${ref}`,
    forWhom: (name: string, phone: string, zone: string) => `For ${name} (${phone}), ${zone}`,
    orderLabel: "Order",
    deliveryLabel: "Delivery",
    items: "Items",
    deliveryCharge: "Delivery",
    toPay: "To pay on delivery",
    cancel: "Cancel order",
    ask: "Ask the shop to cancel",
    sending: "Sending…",
    cancelQuestion: "Cancel this order?",
    askQuestion: "Ask the shop to cancel this order?",
    cancelDetail: "The order is cancelled at once and nothing is owed.",
    askDetail: "The shop will contact you about it. The order is not cancelled until the shop agrees.",
    yesCancel: "Yes, cancel the order",
    yesAsk: "Yes, send the request",
    noKeep: "No, keep the order",
    cancelled: "Your order is cancelled.",
    requested: "Your request was sent. The shop will contact you.",
    requestedNote: "You asked to cancel this order. The shop will contact you.",
    noCancel: "This order can no longer be cancelled here. For a return, please contact the shop.",
    sendFailed: "The request could not be sent. Please check your connection and try again.",
    loadFailed: "The order could not be loaded. Please check your connection and try again.",
    generic: "Something went wrong. Please try again later.",
    idleTitle: "Open the tracking link from the shop's message to see your order.",
    idleBody: "For your privacy this page removes the link from the address bar once it has opened your order, so reloading the page or coming back to it later needs the link again.",
    loading: "Loading your order…",
    privacy: "This page shows only masked details. It is not indexed and keeps the link in this tab only.",
    language: "Language",
    zones: {} as Record<string, string>,
  },
  bn: {
    status: {
      pending_verification: "পেয়েছি, দোকান আপনার সঙ্গে নিশ্চিত করবে",
      verification_expired: "পেয়েছি, দোকান অর্ডারটি দেখছে",
      confirmed: "নিশ্চিত হয়েছে",
      cancelled: "বাতিল হয়েছে",
      closed: "সম্পন্ন",
      unfulfilled: "এখনো প্যাক হয়নি",
      packed: "প্যাক হয়েছে",
      dispatched: "পথে আছে",
      delivered: "পৌঁছে গেছে",
      rto: "দোকানে ফেরত যাচ্ছে",
      rto_received: "দোকানে ফেরত এসেছে",
    } as Record<string, string>,
    steps: ["পেয়েছি", "নিশ্চিত", "প্যাক হয়েছে", "পথে আছে", "পৌঁছে গেছে"],
    callNote: "অর্ডার নিশ্চিত করতে দোকান আপনার সঙ্গে যোগাযোগ করবে। তারপরই অর্ডার নিশ্চিত হবে।",
    order: (ref: string) => `অর্ডার ${ref}`,
    forWhom: (name: string, phone: string, zone: string) => `${name} (${phone}), ${zone}`,
    orderLabel: "অর্ডার",
    deliveryLabel: "ডেলিভারি",
    items: "পণ্য",
    deliveryCharge: "ডেলিভারি চার্জ",
    toPay: "ডেলিভারির সময় মোট দেবেন",
    cancel: "অর্ডার বাতিল করুন",
    ask: "দোকানকে বাতিল করতে বলুন",
    sending: "পাঠানো হচ্ছে…",
    cancelQuestion: "অর্ডারটি বাতিল করবেন?",
    askQuestion: "দোকানকে অর্ডারটি বাতিল করতে বলবেন?",
    cancelDetail: "অর্ডারটি এখনই বাতিল হবে এবং কিছু দিতে হবে না।",
    askDetail: "দোকান আপনার সঙ্গে যোগাযোগ করবে। দোকান রাজি না হওয়া পর্যন্ত অর্ডার বাতিল হবে না।",
    yesCancel: "হ্যাঁ, অর্ডার বাতিল করুন",
    yesAsk: "হ্যাঁ, অনুরোধ পাঠান",
    noKeep: "না, অর্ডার থাক",
    cancelled: "আপনার অর্ডার বাতিল হয়েছে।",
    requested: "আপনার অনুরোধ পাঠানো হয়েছে। দোকান আপনার সঙ্গে যোগাযোগ করবে।",
    requestedNote: "আপনি অর্ডারটি বাতিল করতে বলেছেন। দোকান আপনার সঙ্গে যোগাযোগ করবে।",
    noCancel: "এই অর্ডার এখান থেকে আর বাতিল করা যাবে না। ফেরত দিতে চাইলে দোকানে যোগাযোগ করুন।",
    sendFailed: "অনুরোধ পাঠানো যায়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।",
    loadFailed: "অর্ডার দেখানো যায়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।",
    generic: "কিছু একটা সমস্যা হয়েছে। পরে আবার চেষ্টা করুন।",
    idleTitle: "অর্ডার দেখতে দোকানের মেসেজে পাওয়া ট্র্যাকিং লিংকটি খুলুন।",
    idleBody: "আপনার গোপনীয়তার জন্য অর্ডার খোলার পর এই পাতা লিংকটি ঠিকানা-বার থেকে সরিয়ে দেয়, তাই পাতা রিলোড করলে বা পরে আবার দেখতে লিংকটি আবার লাগবে।",
    loading: "আপনার অর্ডার লোড হচ্ছে…",
    privacy: "এই পাতায় শুধু আড়াল করা তথ্য দেখানো হয়। পাতাটি সার্চে আসে না, আর লিংকটি শুধু এই ট্যাবেই থাকে।",
    language: "ভাষা",
    zones: { "Dhaka City": "ঢাকা সিটি", "Outside Dhaka": "ঢাকার বাইরে" } as Record<string, string>,
  },
};

/** Which milestone the order has reached (1 to 5), or null when it left the normal path (cancelled, returned). */
function progressOf(orderStatus: string, fulfilmentStatus: string): number | null {
  if (orderStatus === "cancelled" || fulfilmentStatus === "rto" || fulfilmentStatus === "rto_received") return null;
  if (fulfilmentStatus === "delivered") return 5;
  if (fulfilmentStatus === "dispatched") return 4;
  if (fulfilmentStatus === "packed") return 3;
  return orderStatus === "confirmed" || orderStatus === "closed" ? 2 : 1;
}
const STEP_ICONS = [Check, PhoneCall, Package, Truck, Home];

type Load = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; view: GuestView };

/** The token in the fragment (null without one), after removing the fragment from this history entry. */
function takeToken(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("t");
  if (window.location.hash) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  return token;
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; data?: GuestView; message?: string }> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store", credentials: "omit" });
  const json = (await response.json().catch(() => ({}))) as { data?: GuestView; message?: string };
  return { ok: response.ok, data: json.data, message: json.message ?? TEXT.en.generic };
}

export function TrackView({ logo, className, style }: { logo: React.ReactNode; className: string; style: React.CSSProperties }) {
  const [lang, setLang] = useState<Lang>("en");
  const t = TEXT[lang];
  const token = useRef<string | null>(null);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  // The cancel question, asked in the page (in the chosen language, readable by a screen reader) instead of a browser dialog.
  const [asking, setAsking] = useState<"cancel" | "request" | null>(null);
  const askRef = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState<"cancelled" | "requested" | "sendFailed" | { raw: string } | null>(null);

  useEffect(() => {
    let live = true;
    const show = (tok: string | null) => {
      if (!tok) {
        setState({ kind: "idle" });
        return;
      }
      setState({ kind: "loading" });
      post("/api/track", { token: tok })
        .then((r) => live && setState(r.ok && r.data ? { kind: "ready", view: r.data } : { kind: "error", message: r.message! }))
        .catch(() => live && setState({ kind: "error", message: "" }));
    };
    // The ref keeps a token already taken when the effect runs again (React's development double run).
    token.current = takeToken() ?? token.current;
    show(token.current);
    // Opening another link in this tab changes only the fragment.
    const onHashChange = () => {
      const taken = takeToken();
      if (taken === null) return;
      token.current = taken;
      show(taken);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      live = false;
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  function ask(action: "cancel" | "request") {
    setAsking(action);
    setNotice(null);
    requestAnimationFrame(() => askRef.current?.focus());
  }

  async function act(action: "cancel" | "request") {
    if (!token.current) return;
    setAsking(null);
    setBusy(true);
    setNotice(null);
    try {
      const r = await post("/api/track/cancel", { token: token.current, action });
      if (r.ok && r.data) {
        setState({ kind: "ready", view: r.data });
        setNotice(action === "cancel" ? "cancelled" : "requested");
      } else {
        setNotice({ raw: r.message! });
      }
    } catch {
      setNotice("sendFailed");
    }
    setBusy(false);
  }

  const names: Record<Lang, string> = { en: "English", bn: "বাংলা" };
  const money = (paisa: number) => formatTaka(paisa, lang);
  return (
    <div lang={lang} className={className} style={style}>
      <header className="sticky top-0 z-30 border-b border-sf-line bg-sf-paper/95 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-xl items-center justify-between gap-3 px-4 lg:h-20">
          {logo}
          <div role="group" aria-label={t.language} className="sf-seg shrink-0">
            {(["en", "bn"] as const).map((l) =>
              l === lang ? (
                <span key={l} lang={l} aria-current="true">
                  {names[l]}
                </span>
              ) : (
                <button key={l} type="button" lang={l} onClick={() => setLang(l)} className="relative">
                  {names[l]}
                </button>
              ),
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-xl px-4 pt-7 pb-14 lg:pt-12">{body()}</main>
    </div>
  );

  function body() {
    if (state.kind === "idle") {
      return (
        <div role="alert" className="sf-card space-y-4 p-6">
          <span aria-hidden="true" className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-sf-sun-soft text-sf-sun-deep">
            <Link2 size={24} strokeWidth={1.75} />
          </span>
          <p className="text-[1.25rem] leading-snug font-bold">{t.idleTitle}</p>
          <p className="text-[0.9375rem] text-sf-ink-2">{t.idleBody}</p>
        </div>
      );
    }
    if (state.kind === "loading") {
      return (
        <div role="status" className="space-y-4">
          <p className="sr-only">{t.loading}</p>
          <div aria-hidden="true" className="sf-skeleton h-10 w-2/3" />
          <div aria-hidden="true" className="sf-skeleton h-64 rounded-[1.25rem]" />
          <div aria-hidden="true" className="sf-skeleton h-28 rounded-[1.25rem]" />
        </div>
      );
    }
    if (state.kind === "error") {
      return (
        <p role="alert" className="sf-note p-5 font-semibold" data-tone="bad">
          {state.message || t.loadFailed}
        </p>
      );
    }
    const v = state.view;
    const progress = progressOf(v.orderStatus, v.fulfilmentStatus);
    const zone = t.zones[v.deliveryZone] ?? v.deliveryZone;
    const noticeText = notice === null ? null : typeof notice === "object" ? notice.raw : t[notice];
    return (
      <div className="sf-enter space-y-6">
        <div className="space-y-2">
          <h1 className="sf-display text-[2.125rem] lg:text-[2.75rem]">{t.order(v.reference)}</h1>
          <p className="text-[0.9375rem] text-sf-ink-2">{t.forWhom(v.customer.name, v.customer.phone, zone)}</p>
        </div>

        <section className="sf-card space-y-5 p-5">
          {progress !== null ? (
            // Decoration with words: the status lines below are the information for screen readers.
            <ol aria-hidden="true" className="sf-timeline">
              {t.steps.map((label, i) => {
                const n = i + 1;
                const stepState = n < progress || (n === progress && progress === 5) ? "done" : n === progress ? "now" : undefined;
                const Icon = stepState === "done" ? Check : STEP_ICONS[i];
                return (
                  <li key={label} data-state={stepState}>
                    <span className="sf-timeline-dot">
                      <Icon size={15} strokeWidth={2.25} />
                    </span>
                    <div className="pt-0.5">
                      <p className={stepState ? "font-bold" : "font-semibold text-sf-ink-2"}>{label}</p>
                      {stepState === "now" && n === 1 ? <p className="sf-hint mt-0.5">{t.callNote}</p> : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : null}
          <dl className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${progress !== null ? "border-t border-sf-line pt-4" : ""}`}>
            <div>
              <dt className="text-[0.8125rem] font-semibold text-sf-ink-2">{t.orderLabel}</dt>
              <dd className="mt-0.5 text-lg font-bold" data-testid="guest-order-status">
                {t.status[v.orderStatus] ?? v.orderStatus}
              </dd>
            </div>
            <div>
              <dt className="text-[0.8125rem] font-semibold text-sf-ink-2">{t.deliveryLabel}</dt>
              <dd className="mt-0.5 text-lg font-bold">{t.status[v.fulfilmentStatus] ?? v.fulfilmentStatus}</dd>
            </div>
          </dl>
        </section>

        <section className="sf-card p-5">
          <ul className="divide-y divide-sf-line" aria-label={t.items}>
            {v.items.map((i, n) => {
              const name = (lang === "bn" ? (i.name.bn ?? i.name.en) : (i.name.en ?? i.name.bn)) ?? "";
              const nameLang = lang === "bn" ? (i.name.bn ? "bn" : "en") : i.name.en ? "en" : "bn";
              const detail = [i.size, i.colour].filter(Boolean).join(", ");
              return (
                <li key={n} className="flex justify-between gap-4 py-3 first:pt-0">
                  <span>
                    <span lang={nameLang !== lang ? nameLang : undefined} className="font-semibold">
                      {name}
                    </span>
                    <span className="block text-[0.875rem] text-sf-ink-2">
                      {detail}
                      {detail ? ", " : ""}× {lang === "bn" ? toBnDigits(i.quantity) : i.quantity}
                    </span>
                  </span>
                  <span className="sf-price shrink-0">{money(i.unitPricePaisa * i.quantity)}</span>
                </li>
              );
            })}
          </ul>
          <dl className="sf-num mt-3 grid grid-cols-[1fr_auto] gap-y-2 border-t border-sf-line pt-3">
            <dt className="text-sf-ink-2">{t.deliveryCharge}</dt>
            <dd className="text-end">{money(v.deliveryChargePaisa)}</dd>
            <dt className="font-bold">{t.toPay}</dt>
            <dd className="sf-price text-end text-[1.5rem]">{money(v.totalPaisa)}</dd>
          </dl>
        </section>

        {noticeText ? (
          <p role="status" className="sf-note font-semibold" data-tone="sun">
            {noticeText}
          </p>
        ) : null}
        {v.cancellationRequested ? <p className="sf-note">{t.requestedNote}</p> : null}
        {asking ? (
          <div ref={askRef} tabIndex={-1} role="group" aria-labelledby="track-ask" className="sf-card space-y-4 border-sf-danger p-5 focus:outline-none" data-testid="cancel-question">
            <div className="space-y-1">
              <p id="track-ask" className="text-lg font-bold">
                {asking === "cancel" ? t.cancelQuestion : t.askQuestion}
              </p>
              <p className="text-[0.9375rem] text-sf-ink-2">{asking === "cancel" ? t.cancelDetail : t.askDetail}</p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <button type="button" onClick={() => act(asking)} className="sf-btn sf-btn-ink sf-btn-lg">
                {asking === "cancel" ? t.yesCancel : t.yesAsk}
              </button>
              <button type="button" onClick={() => setAsking(null)} className="sf-btn sf-btn-ghost sf-btn-lg">
                {t.noKeep}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row">
            {v.canCancel ? (
              <button type="button" disabled={busy} onClick={() => ask("cancel")} className="sf-btn sf-btn-ghost sf-btn-lg">
                {busy ? t.sending : t.cancel}
              </button>
            ) : null}
            {v.canRequestCancellation ? (
              <button type="button" disabled={busy} onClick={() => ask("request")} className="sf-btn sf-btn-ghost sf-btn-lg">
                {busy ? t.sending : t.ask}
              </button>
            ) : null}
          </div>
        )}
        {!v.canCancel && !v.canRequestCancellation && !v.cancellationRequested && v.orderStatus !== "cancelled" ? <p className="text-sf-ink-2">{t.noCancel}</p> : null}
        <p className="sf-hint border-t border-sf-line pt-4">{t.privacy}</p>
      </div>
    );
  }
}
