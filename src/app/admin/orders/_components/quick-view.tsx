"use client";

import { Phone, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { CopyButton } from "../../_components/copy-button";
import { type QuickView, orderQuickViewAction } from "../actions";
import { bdt, eventLabel, label, StatusPill } from "./labels";

// The order list's quick view: a side drawer (full width on a phone) with what is needed to decide the next step without
// leaving the list. A native <dialog>: focus stays inside while it is open, Escape and the backdrop close it, and focus returns
// to the button that opened it. The data is fetched when it opens, by a Server Action that checks the session; nothing is
// kept in the address bar. It shows the order; changing it stays in the list's row actions and on the order's own page.

const when = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const orderNumber = (n: number) => `ORD-${String(n).padStart(6, "0")}`;

export function OrderQuickView() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [order, setOrder] = useState<QuickView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const open = useCallback(
    (id: string) => {
      setOrder(null);
      setError(null);
      dialog.current?.showModal();
      start(async () => {
        const answer = await orderQuickViewAction(id).catch(() => ({ error: "The order could not be loaded. Close this and try again." }));
        if ("error" in answer) setError(answer.error);
        else setOrder(answer);
      });
    },
    [start],
  );

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const trigger = (event.target as HTMLElement).closest<HTMLElement>("[data-quickview]");
      if (trigger?.dataset.quickview) open(trigger.dataset.quickview);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [open]);

  return (
    <dialog
      ref={dialog}
      aria-label="Order quick view"
      className="of-drawer"
      onClick={(event) => {
        // A click on the backdrop (the dialog element itself, outside its panel) closes it.
        if (event.target === dialog.current) dialog.current?.close();
      }}
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-5 py-4">
          <h2 className="text-lg font-bold">{order ? orderNumber(order.number) : "Order"}</h2>
          <button type="button" className="of-btn of-btn-line of-btn-sm" onClick={() => dialog.current?.close()} aria-label="Close quick view">
            <X aria-hidden="true" size={16} />
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4" aria-busy={pending}>
          {error ? (
            <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
              {error}
            </p>
          ) : !order ? (
            <div role="status" aria-label="Loading the order" className="space-y-3">
              <div className="of-skeleton h-6 w-2/3" />
              <div className="of-skeleton h-20 w-full" />
              <div className="of-skeleton h-28 w-full" />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill value={order.orderStatus} calm />
                <StatusPill value={order.fulfilmentStatus} calm />
                <StatusPill value={order.paymentStatus} calm />
                {order.returnStatus !== "none" ? <StatusPill value={order.returnStatus} /> : null}
              </div>
              {order.overdue ? (
                <p role="note" className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-950">
                  <strong>Verification overdue.</strong> The 24-hour window ended {when.format(new Date(order.verificationExpiresAt))}. It can still be confirmed: stock is checked again first.
                </p>
              ) : null}
              {order.openRequest ? (
                <p role="note" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-900">
                  <strong>Cancellation requested.</strong> The customer asked to cancel. Decide on the order page.
                </p>
              ) : null}
              <section aria-label="Customer">
                <h3 className="text-sm font-bold">Customer</h3>
                <p className="mt-1 text-sm">
                  {order.customerName}
                  <span className="block text-gray-700 tabular-nums">{`${order.customerPhone.slice(0, 5)} ${order.customerPhone.slice(5)}`}</span>
                  <span className="block text-gray-700">{order.deliveryAddress}</span>
                  <span className="block text-gray-600">
                    {order.zone} · {label(order.source)} · placed {when.format(new Date(order.createdAt))}
                  </span>
                </p>
                {order.note ? <p className="mt-1 text-sm text-gray-700">Note: {order.note}</p> : null}
                <div className="mt-2 flex flex-wrap gap-2">
                  {/* tel: opens the phone's dialler; the number is not sent anywhere or kept in the browser history. */}
                  <a href={`tel:${order.customerPhone}`} className="of-btn of-btn-line of-btn-sm" aria-label="Call the customer">
                    <Phone aria-hidden="true" size={16} />
                    Call
                  </a>
                  <CopyButton value={order.customerPhone} label="phone number" />
                </div>
              </section>
              <section aria-label="Items">
                <h3 className="text-sm font-bold">Items</h3>
                <ul className="mt-1 divide-y divide-gray-200 text-sm">
                  {order.items.map((i) => (
                    <li key={i.sku} className="flex items-start justify-between gap-3 py-2">
                      <span>
                        <span className="block font-medium">{i.name}</span>
                        <span className="block text-xs text-gray-600">
                          {[i.size, i.colour].filter(Boolean).join(" · ") || "No size or colour"} · SKU {i.sku} · × {i.quantity}
                        </span>
                      </span>
                      <span className="shrink-0 tabular-nums">{bdt(i.lineTotalPaisa)}</span>
                    </li>
                  ))}
                </ul>
              </section>
              <section aria-label="Amounts">
                <h3 className="text-sm font-bold">Amounts</h3>
                <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm tabular-nums">
                  <dt>Items</dt>
                  <dd className="text-right">{bdt(order.subtotalPaisa)}</dd>
                  <dt>Delivery</dt>
                  <dd className="text-right">{bdt(order.deliveryChargePaisa)}</dd>
                  <dt className="font-bold">{order.paymentMethod === "cod" ? "Total (COD)" : `Total (advance ${order.paymentMethodLabel})`}</dt>
                  <dd className="text-right font-bold">{bdt(order.totalPaisa)}</dd>
                  {order.paymentMethod !== "cod" ? (
                    <>
                      <dt className="text-gray-700">Verified as received</dt>
                      <dd className="text-right">{bdt(order.advanceReceivedPaisa)}</dd>
                    </>
                  ) : null}
                  {/* The courier's three amounts once money has moved; before that one line says so. */}
                  {order.codCollectedPaisa || order.codSettledPaisa || order.codDeductedPaisa ? (
                    <>
                      <dt className="text-gray-700">Collected by courier</dt>
                      <dd className="text-right">{bdt(order.codCollectedPaisa)}</dd>
                      <dt className="text-gray-700">Settled to you</dt>
                      <dd className="text-right">{bdt(order.codSettledPaisa)}</dd>
                      <dt className="text-gray-700">Kept by courier</dt>
                      <dd className="text-right">{bdt(order.codDeductedPaisa)}</dd>
                    </>
                  ) : (
                    <>
                      <dt className="text-gray-700">Collected so far</dt>
                      <dd className="text-right text-gray-700">Nothing yet</dd>
                    </>
                  )}
                </dl>
              </section>
              <section aria-label="Recent history">
                <h3 className="text-sm font-bold">Recent history</h3>
                <ol className="mt-2 space-y-2 border-s-2 border-gray-200 ps-4 text-sm text-gray-700">
                  {order.events.map((e, n) => (
                    <li key={`${e.event}-${n}`} className="relative flex justify-between gap-3">
                      <span aria-hidden="true" className={`absolute top-1.5 inset-s-[-1.3rem] h-2.5 w-2.5 rounded-full border-2 border-white ${n === 0 ? "bg-gray-800" : "bg-gray-400"}`} />
                      <span>{eventLabel(e.event)}</span>
                      <span className="shrink-0 text-gray-600 tabular-nums">{when.format(new Date(e.at))}</span>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          )}
        </div>
        {order ? (
          <div className="border-t border-gray-200 px-5 py-4">
            <Link href={`/admin/orders/${order.id}`} className="of-btn of-btn-primary w-full">
              Open full order
            </Link>
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
