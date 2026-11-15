"use client";

import { useEffect, useRef, useState } from "react";
import type { GuestView } from "@/modules/orders/tracking";

// The customer's private order page. The token is read from the URL fragment (#t=...), which browsers never
// send to a server, and posted to /api/track in a same-origin JSON body. Right after reading it, the page
// replaces its own history entry with plain /track, so the token leaves the address bar, the back and forward
// history of this tab and anything copied from the address bar. It is then kept in memory only: never in
// storage, a URL, a log or a third-party request (this page loads no third-party code). Reloading therefore
// needs the original link again (docs/operations/runbook.md, Guest tracking).

const STATUS: Record<string, string> = {
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
};
const taka = (paisa: number) => `৳ ${Math.floor(paisa / 100)}.${String(paisa % 100).padStart(2, "0")}`;

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
  return { ok: response.ok, data: json.data, message: json.message ?? "Something went wrong. Please try again later." };
}

export function TrackView() {
  const token = useRef<string | null>(null);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const show = (t: string | null) => {
      if (!t) {
        setState({ kind: "idle" });
        return;
      }
      setState({ kind: "loading" });
      post("/api/track", { token: t })
        .then((r) => live && setState(r.ok && r.data ? { kind: "ready", view: r.data } : { kind: "error", message: r.message! }))
        .catch(() => live && setState({ kind: "error", message: "The order could not be loaded. Please check your connection and try again." }));
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

  async function act(action: "cancel" | "request") {
    const question = action === "cancel" ? "Cancel this order?" : "Ask the shop to cancel this order?";
    if (!token.current || !window.confirm(question)) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await post("/api/track/cancel", { token: token.current, action });
      if (r.ok && r.data) {
        setState({ kind: "ready", view: r.data });
        setNotice(action === "cancel" ? "Your order is cancelled." : "Your request was sent. The shop will contact you.");
      } else {
        setNotice(r.message!);
      }
    } catch {
      setNotice("The request could not be sent. Please check your connection and try again.");
    }
    setBusy(false);
  }

  if (state.kind === "idle") {
    return (
      <div role="alert" className="space-y-2">
        <p>Open the tracking link from the shop&apos;s message to see your order.</p>
        <p className="text-sm text-gray-700">
          For your privacy this page removes the link from the address bar once it has opened your order, so reloading the page or coming back to it later needs the link again.
        </p>
      </div>
    );
  }
  if (state.kind === "loading") return <p role="status">Loading your order…</p>;
  if (state.kind === "error") return <p role="alert">{state.message}</p>;
  const v = state.view;
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Order {v.reference}</h1>
        <p className="text-sm text-gray-700">
          For {v.customer.name} ({v.customer.phone}) · {v.deliveryZone}
        </p>
      </div>
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div className="rounded border border-gray-300 p-2">
          <dt className="text-xs text-gray-600">Order</dt>
          <dd className="font-medium" data-testid="guest-order-status">{STATUS[v.orderStatus] ?? v.orderStatus}</dd>
        </div>
        <div className="rounded border border-gray-300 p-2">
          <dt className="text-xs text-gray-600">Delivery</dt>
          <dd className="font-medium">{STATUS[v.fulfilmentStatus] ?? v.fulfilmentStatus}</dd>
        </div>
      </dl>
      <ul className="divide-y divide-gray-200 rounded border border-gray-300 text-sm" aria-label="Items">
        {v.items.map((i, n) => (
          <li key={n} className="flex justify-between gap-2 px-3 py-2">
            <span>
              {i.name.en ?? <span lang="bn">{i.name.bn}</span>}
              {[i.size, i.colour].filter(Boolean).length ? ` · ${[i.size, i.colour].filter(Boolean).join(", ")}` : ""} × {i.quantity}
            </span>
            <span className="tabular-nums">{taka(i.unitPricePaisa * i.quantity)}</span>
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-2 gap-1 text-sm sm:w-72">
        <dt>Delivery</dt>
        <dd className="text-right tabular-nums">{taka(v.deliveryChargePaisa)}</dd>
        <dt className="font-medium">To pay on delivery</dt>
        <dd className="text-right font-medium tabular-nums">{taka(v.totalPaisa)}</dd>
      </dl>
      {notice ? <p role="status" className="rounded border border-gray-300 bg-gray-50 px-3 py-2 text-sm">{notice}</p> : null}
      {v.cancellationRequested ? <p className="text-sm">You asked to cancel this order. The shop will contact you.</p> : null}
      <div className="flex flex-wrap gap-3">
        {v.canCancel ? (
          <button type="button" disabled={busy} onClick={() => act("cancel")} className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
            {busy ? "Sending…" : "Cancel order"}
          </button>
        ) : null}
        {v.canRequestCancellation ? (
          <button type="button" disabled={busy} onClick={() => act("request")} className="rounded border border-gray-400 px-4 py-2 text-sm disabled:opacity-60">
            {busy ? "Sending…" : "Ask the shop to cancel"}
          </button>
        ) : null}
      </div>
      {!v.canCancel && !v.canRequestCancellation && !v.cancellationRequested && v.orderStatus !== "cancelled" ? (
        <p className="text-sm text-gray-700">This order can no longer be cancelled here. For a return, please contact the shop.</p>
      ) : null}
    </div>
  );
}
