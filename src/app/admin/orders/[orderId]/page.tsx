import { randomUUID } from "node:crypto";
import { Check, Phone, Printer } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { DomainError } from "@/modules/domain-error";
import { formatPaisa } from "@/modules/money";
import { type Permission, roleHasPermission } from "@/modules/auth/permissions";
import { userNames } from "@/modules/auth/staff";
import { referencesOnOtherOrders } from "@/modules/orders/advance";
import { getOrderDetail, type OrderDetail } from "@/modules/orders/queries";
import { advanceRefundDue, allowedActions, amountDue, dhakaToday, formatOrderNumber, type OrderAction, refundableAdvance, returnWindowEnd, verificationOverdue, ZONE_LABELS } from "@/modules/orders/rules";
import { MANUAL_METHODS, METHOD_LABELS } from "@/modules/settings/payments";
import { ActionForm, Choice, Field } from "../../_components/action-form";
import { CopyButton } from "../../_components/copy-button";
import { ActionPanel } from "../../_components/panel";
import { Stat } from "../../_components/stat";
import { AdminShell, Section, formatTime, noticeFor, sectionId } from "../../_components/shell";
import { requireAdmin } from "../../_lib/session";
import {
  createReturnAction,
  createTrackingLinkAction,
  inspectAction,
  orderTransitionAction,
  recordPaymentAction,
  refundAdvanceAction,
  rejectReferenceAction,
  returnStepAction,
  reverseAdvanceAction,
  reviewCancellationAction,
  revokeTrackingLinkAction,
  rtoChargeAction,
  verifyAdvanceAction,
} from "../actions";
import { bdt, Dimensions, eventLabel, label, relative } from "../_components/labels";

export const metadata = { title: "Order · Admin" };

type Props = { params: Promise<{ orderId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

// Owner-facing buttons, in the order a normal order moves. Each needs a confirmation where it is hard to undo.
const BUTTONS: { action: OrderAction & ("confirm" | "pack" | "dispatch" | "deliver" | "mark_rto" | "receive_rto" | "close" | "cancel"); label: string; confirm?: string; secondary?: boolean }[] = [
  { action: "confirm", label: "Confirm order (verified with the customer)" },
  { action: "pack", label: "Mark packed" },
  { action: "dispatch", label: "Dispatch", confirm: "Dispatch this order? Its stock is deducted and it can no longer be cancelled." },
  { action: "deliver", label: "Record delivery", confirm: "Record this order as delivered? This is your own record, not courier evidence, and it starts the 7-day return window." },
  { action: "mark_rto", label: "Mark returned to sender (refused or undelivered)", secondary: true },
  { action: "receive_rto", label: "Receive returned parcel into inspection" },
  { action: "close", label: "Close order", confirm: "Close this order? The tracking link stops working 30 days from now." },
  { action: "cancel", label: "Cancel order", confirm: "Cancel this order? Any reserved stock is released.", secondary: true },
];

// Return and inspection states in plain language.
const RETURN_STATES: Record<string, string> = { requested: "Requested", received: "Received, decision pending", approved: "Approved", rejected: "Rejected", completed: "Completed" };
const INSPECTION_STATES: Record<string, string> = { awaiting_inspection: "Awaiting inspection", restocked: "Passed: back in stock", rejected: "Failed: kept out of stock" };
const words = (map: Record<string, string>, value: string) => map[value] ?? value.replace(/_/g, " ");
const ADVANCE_STATES: Record<string, string> = { submitted: "Awaiting your check", verified: "Verified", rejected: "Rejected", reversed: "Undone" };

/**
 * Where a normal order is on its way, read only from its recorded statuses. Fulfilment moves one step at a time
 * (packed needs a confirmed order, dispatch needs packed, delivery needs dispatch; rules.ts), so a step shown done
 * was recorded. Cancelled and expired orders show no strip: the status alone cannot say whether they were verified.
 */
function OrderProgress({ order }: { order: OrderDetail }) {
  if (order.orderStatus !== "pending_verification" && order.orderStatus !== "confirmed" && order.orderStatus !== "closed") return null;
  const f = order.fulfilmentStatus;
  const returned = f === "rto" || f === "rto_received";
  // Returning (rto) is not done until the parcel is received back (rto_received); only then can the order close.
  const steps: [string, boolean][] = [
    ["Verified", order.orderStatus !== "pending_verification"],
    ["Packed", f !== "unfulfilled"],
    ["Dispatched", f === "dispatched" || f === "delivered" || returned],
    [f === "rto" ? "Returning to sender" : returned ? "Returned to sender" : "Delivered", f === "delivered" || f === "rto_received"],
    ["Closed", order.orderStatus === "closed"],
  ];
  const next = steps.findIndex(([, done]) => !done);
  return (
    <ol aria-label="Progress" className="grid grid-cols-5 gap-1 text-center text-xs sm:text-sm" data-testid="order-progress">
      {steps.map(([name, done], i) => (
        <li key={name} className="flex flex-col items-center gap-1" data-done={done} aria-current={i === next ? "step" : undefined}>
          <span
            aria-hidden="true"
            className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
              done ? (returned && i === 3 ? "bg-[var(--color-sf-danger)] text-white" : "bg-green-700 text-white") : i === next ? (returned && i === 3 ? "bg-[var(--color-sf-danger-soft)] text-gray-900 ring-2 ring-[var(--color-sf-danger)]" : "bg-[var(--color-sf-sun-soft)] text-gray-900 ring-2 ring-[var(--color-sf-sun)]") : "bg-[var(--color-sf-mist)] text-gray-600"
            }`}
          >
            {done ? <Check size={14} strokeWidth={3} /> : i + 1}
          </span>
          <span className={done || i === next ? "font-semibold text-gray-900" : "text-gray-600"}>
            {name}
            <span className="sr-only">{done ? " (done)" : i === next ? " (next)" : " (not yet)"}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

const openReturn = (o: OrderDetail) => o.returns.find((r) => r.status === "requested" || r.status === "received" || r.status === "approved");

export default async function OrderPage({ params, searchParams }: Props) {
  const principal = await requireAdmin("orders:read");
  // Buttons show only for what this role may do (ADR-0013); every action checks its permission again on the server.
  const can = (permission: Permission) => roleHasPermission(principal.role, permission);
  const { orderId } = await params;
  const { done } = await searchParams;
  const order = await getOrderDetail(getDb(), orderId).catch((error: unknown) => {
    if (error instanceof DomainError && (error.code === "ORDER_NOT_FOUND" || error.code === "INVALID_INPUT")) notFound();
    throw error;
  });
  const now = new Date();
  const state = {
    ...order,
    openCancellationRequest: order.cancellationRequests.some((r) => r.status === "open"),
    openReturn: Boolean(openReturn(order)),
    awaitingInspection: order.quarantine.some((q) => q.status === "awaiting_inspection"),
  };
  const allowed = allowedActions(state, now);
  // Independent reads, side by side (each is a round trip to the database).
  const [names, duplicates] = await Promise.all([
    userNames(getDb(), order.events.map((e) => e.actorUserId ?? "")),
    order.advancePayments.some((a) => a.status === "submitted") ? referencesOnOtherOrders(getDb(), order.id) : Promise.resolve(new Set<string>()),
  ]);
  const due = amountDue(order);
  const refundDue = advanceRefundDue(order) ? refundableAdvance(order) : 0;
  const paidCancel = order.advanceReceivedPaisa - order.advanceRefundedPaisa > 0;
  const ref = { orderId: order.id, version: String(order.version) };
  const overdue = verificationOverdue(order, now);
  const request = order.cancellationRequests.find((r) => r.status === "open");
  const current = openReturn(order);
  const itemBy = new Map(order.items.map((i) => [i.id, i]));
  const reservedBy = new Map(order.reservations.filter((r) => r.status === "active").map((r) => [r.variantId, r.quantity]));
  const unsettled = order.codCollectedPaisa - order.codSettledPaisa - order.codDeductedPaisa;
  // Money received from the customer (COD collected plus verified advance) not yet refunded.
  const received = order.codCollectedPaisa + order.advanceReceivedPaisa - order.refundedPaisa - order.advanceRefundedPaisa;
  const receivable = order.totalPaisa - order.codCollectedPaisa - order.advanceReceivedPaisa;
  const toCollect = order.fulfilmentStatus === "dispatched" || order.fulfilmentStatus === "delivered" ? receivable : 0;
  const today = dhakaToday(now);
  const windowEnd = order.deliveredAt ? returnWindowEnd(order.deliveredAt) : null;
  const steps = can("orders:write") ? BUTTONS.filter((b) => allowed.has(b.action) && (b.action !== "cancel" || !paidCancel || can("payments:verify"))) : [];
  const canRecordMoney = can("payments:record") && (allowed.has("record_collection") || allowed.has("record_settlement"));
  // Status, Next step, Items, Cash on delivery and History, plus the cards that only some orders have.
  const mainCards = 5 + [request, allowed.has("create_return") || order.returns.length, order.quarantine.length, order.paymentMethod !== "cod"].filter(Boolean).length;

  return (
    <AdminShell title={`Order ${formatOrderNumber(order.number)}`} current="orders" wide notice={noticeFor(done)} breadcrumbs={[{ href: "/admin/orders", label: "Orders" }]}>
      {/* The side column spans every row of the main column, so a tall side column never stretches the cards beside it. */}
      <div className="of-split" style={{ "--side-rows": mainCards } as React.CSSProperties}>
        <Section title="Status">
          <OrderProgress order={order} />
          <Dimensions order={order} />
          <p className="text-sm text-gray-700">
            Taken on {label(order.source)}, paid by{" "}
            <strong data-testid="order-payment-method">{order.paymentMethod === "cod" ? "cash on delivery" : `advance ${METHOD_LABELS[order.paymentMethod].en}`}</strong>, created {formatTime(order.createdAt)}, version{" "}
            <span data-testid="order-version">{order.version}</span>
          </p>
          {order.orderStatus === "pending_verification" && !overdue ? (
            <p className="text-sm" data-testid="verification">
              Verify with the customer by <strong>{formatTime(order.verificationExpiresAt)}</strong> ({relative(order.verificationExpiresAt, now)}). Until then its stock is reserved.
            </p>
          ) : null}
          {overdue ? (
            <p role="status" className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-950" data-testid="verification">
              Verification expired — Owner review. The 24-hour window ended {relative(order.verificationExpiresAt, now)}; its stock {order.orderStatus === "verification_expired" ? "was released" : "is being released"}.
              Confirming now reserves the stock again, only if it is still available. The order is not cancelled unless you cancel it.
            </p>
          ) : null}
        </Section>

        {request && can("orders:write") ? (
          <Section title="Cancellation request">
            <p className="text-sm">
              The customer asked to cancel on {formatTime(request.createdAt)}.{request.reason ? <> Reason: “{request.reason}”</> : null} Stock stays reserved until you decide. Dispatch waits for your decision.
              {paidCancel ? " This order holds a verified advance payment: approving makes a refund due." : null}
            </p>
            <div className="flex flex-wrap gap-3">
              <ActionForm action={reviewCancellationAction} idempotencyKey={randomUUID()} hidden={{ ...ref, decision: "approve" }} submitLabel="Approve: cancel the order" confirm="Cancel this order as the customer asked? Its stock is released." />
              <ActionForm action={reviewCancellationAction} idempotencyKey={randomUUID()} hidden={{ ...ref, decision: "reject" }} submitLabel="Reject the request" variant="secondary" />
            </div>
          </Section>
        ) : null}

        <Section title="Next step">
          {steps.some((b) => !b.secondary) ? (
            <div className="flex flex-wrap gap-3">
              {steps
                .filter((b) => !b.secondary)
                .map((b) => (
                  <ActionForm key={b.action} action={orderTransitionAction} idempotencyKey={randomUUID()} hidden={{ ...ref, action: b.action }} submitLabel={b.label} confirm={b.confirm} />
                ))}
            </div>
          ) : (
            <p className="text-sm text-gray-700">
              {canRecordMoney ? (
                <>
                  No forward step now.{" "}
                  <a href={`#${sectionId("Cash on delivery")}`} className="underline underline-offset-4">
                    Record the cash on delivery money
                  </a>{" "}
                  as it happens.
                </>
              ) : steps.length ? (
                "No forward step now."
              ) : (
                "No lifecycle step is possible now."
              )}
            </p>
          )}
          {order.fulfilmentStatus === "packed" && request ? <p className="text-sm text-gray-700">Dispatch is blocked until the cancellation request is decided.</p> : null}
          {order.paymentMethod !== "cod" && due > 0 && order.orderStatus === "confirmed" && (order.fulfilmentStatus === "unfulfilled" || order.fulfilmentStatus === "packed") ? (
            <p className="text-sm font-semibold text-amber-900" data-testid="dispatch-due-note">
              {bdt(due)} of the advance payment is not verified yet. The order can be dispatched only after the full amount is verified.
            </p>
          ) : null}
          {paidCancel && allowed.has("cancel") && !can("payments:verify") ? <p className="text-xs text-gray-600">This order holds a verified advance payment, so only the Owner can cancel it.</p> : null}
          {allowed.has("deliver") ? (
            <p className="text-xs text-gray-600" data-testid="deliver-note">
              &quot;Record delivery&quot; is your own record, made when you know the parcel arrived (for example from the courier or the customer). No courier system is connected, so nothing
              here confirms a delivery by itself.
            </p>
          ) : null}
          {(order.fulfilmentStatus === "delivered" || order.fulfilmentStatus === "rto_received") && order.orderStatus === "confirmed" && !allowed.has("close") ? (
            <p className="text-sm text-gray-700" data-testid="close-hint">
              {windowEnd && now.getTime() <= windowEnd.getTime() ? `Can be closed after ${formatTime(windowEnd)}, when the 7-day return window has ended. ` : null}
              Closing needs every collected amount settled or recorded as kept by the courier, no open return and nothing awaiting inspection.
            </p>
          ) : null}
          {steps.some((b) => b.secondary) ? (
            <div className="space-y-2 border-t border-gray-200 pt-4">
              <p className="text-xs font-semibold text-gray-600">If the order cannot go ahead</p>
              <div className="flex flex-wrap gap-3">
                {steps
                  .filter((b) => b.secondary)
                  .map((b) => (
                    <ActionForm key={b.action} action={orderTransitionAction} idempotencyKey={randomUUID()} hidden={{ ...ref, action: b.action }} submitLabel={b.label} confirm={b.confirm} variant="secondary" />
                  ))}
              </div>
            </div>
          ) : null}
        </Section>

        {/* Reference details: beside the work on a desktop, right after the next step on a phone. */}
        <div className="of-side space-y-6">
          <Section title="Customer and delivery">
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-gray-600">Name</dt>
                <dd className="font-semibold">{order.customerName}</dd>
              </div>
              <div>
                <dt className="text-gray-600">Phone</dt>
                <dd className="flex flex-wrap items-center justify-between gap-2">
                  <span className="tabular-nums">{`${order.customerPhone.slice(0, 5)} ${order.customerPhone.slice(5)}`}</span>
                  <span className="flex flex-wrap gap-2">
                    {/* tel: opens the phone's dialler; the number is not sent anywhere or kept in the browser history. */}
                    <a href={`tel:${order.customerPhone}`} className="of-btn of-btn-line of-btn-sm" aria-label="Call the customer">
                      <Phone aria-hidden="true" size={16} />
                      Call
                    </a>
                    <CopyButton value={order.customerPhone} label="phone number" />
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-gray-600">Address</dt>
                <dd className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0 whitespace-pre-line">{order.deliveryAddress}</span>
                  <CopyButton value={order.deliveryAddress} label="address" />
                </dd>
              </div>
              <div>
                <dt className="text-gray-600">Delivery zone</dt>
                <dd>{ZONE_LABELS[order.deliveryZone]}</dd>
              </div>
              {order.note ? (
                <div>
                  <dt className="text-gray-600">Note</dt>
                  <dd className="whitespace-pre-line">{order.note}</dd>
                </div>
              ) : null}
            </dl>
            <Link href={`/admin/print/orders/${order.id}`} className="of-btn of-btn-line w-full text-sm">
              <Printer aria-hidden="true" size={16} className="shrink-0" />
              Print packing and shipping document
            </Link>
          </Section>

          <Section title="Customer tracking link">
            <p className="text-sm text-gray-700">
              {order.trackingLink ? `A link is active (created ${formatTime(order.trackingLink.createdAt)}).` : "No active link."} The link is shown only once, when created; creating a new one stops the old
              one. It works until 30 days after the order is closed.
            </p>
            <div className={`flex flex-wrap items-start gap-3 ${can("orders:write") ? "" : "hidden"}`}>
              <ActionForm action={createTrackingLinkAction} idempotencyKey={randomUUID()} hidden={{ orderId: order.id }} submitLabel={order.trackingLink ? "Create a new link" : "Create link"} confirm={order.trackingLink ? "Create a new link? The current one stops working." : undefined} />
              {order.trackingLink ? <ActionForm action={revokeTrackingLinkAction} idempotencyKey={randomUUID()} hidden={{ orderId: order.id }} submitLabel="Revoke link" variant="secondary" confirm="Revoke the tracking link? It stops working at once." /> : null}
            </div>
          </Section>
        </div>

        <Section title="Items">
          {/* On a phone each line is a card with the same facts as the table's columns: nothing hidden, nothing to scroll. */}
          <ul className="divide-y divide-gray-200 sm:hidden" aria-label="Items">
            {order.items.map((i) => (
              <li key={i.id} className="py-3 first:pt-0" data-testid="order-item">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 font-medium">{i.productNameEn ?? <span lang="bn">{i.productNameBn}</span>}</p>
                  <p className="shrink-0 font-semibold tabular-nums">{bdt(i.lineTotalPaisa)}</p>
                </div>
                <p className="text-xs text-gray-600">
                  <Link href={`/admin/skus/${encodeURIComponent(i.sku)}`} className="inline-flex min-h-11 items-center underline underline-offset-2">
                    {i.sku}
                  </Link>
                  {[i.size, i.colour].filter(Boolean).length ? ` · ${[i.size, i.colour].filter(Boolean).join(", ")}` : null}
                </p>
                <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-gray-700 tabular-nums">
                  <div className="flex gap-1">
                    <dt>Unit price</dt>
                    <dd>{bdt(i.unitPricePaisa)}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt>Qty</dt>
                    <dd>{i.quantity}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt>Reserved now</dt>
                    <dd>{reservedBy.get(i.variantId) ?? 0}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto sm:block">
            <table className="of-table">
              <thead>
                <tr>
                  <th scope="col">Product (as ordered)</th>
                  <th scope="col" className="num">
                    Unit price
                  </th>
                  <th scope="col" className="num">
                    Qty
                  </th>
                  <th scope="col" className="num">
                    Line total
                  </th>
                  <th scope="col" className="num">
                    Reserved now
                  </th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((i) => (
                  <tr key={i.id}>
                    <th scope="row" className="font-normal">
                      <span className="font-medium">{i.productNameEn ?? <span lang="bn">{i.productNameBn}</span>}</span>
                      <span className="block text-xs text-gray-600">
                        <Link href={`/admin/skus/${encodeURIComponent(i.sku)}`} className="inline-flex min-h-11 items-center underline underline-offset-2 lg:min-h-0">
                          {i.sku}
                        </Link>
                        {[i.size, i.colour].filter(Boolean).length ? ` · ${[i.size, i.colour].filter(Boolean).join(", ")}` : null}
                      </span>
                    </th>
                    <td className="num">{bdt(i.unitPricePaisa)}</td>
                    <td className="num">{i.quantity}</td>
                    <td className="num">{bdt(i.lineTotalPaisa)}</td>
                    <td className="num">{reservedBy.get(i.variantId) ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="ml-auto grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:w-80">
            <dt className="text-gray-600">Subtotal</dt>
            <dd className="text-right tabular-nums">{bdt(order.subtotalPaisa)}</dd>
            <dt className="text-gray-600">Delivery ({ZONE_LABELS[order.deliveryZone]})</dt>
            <dd className="text-right tabular-nums">{bdt(order.deliveryChargePaisa)}</dd>
            <dt className="border-t border-gray-200 pt-1 font-semibold">{order.paymentMethod === "cod" ? "Expected COD" : "Order total"}</dt>
            <dd className="border-t border-gray-200 pt-1 text-right font-semibold tabular-nums">{bdt(order.totalPaisa)}</dd>
          </dl>
        </Section>

        {order.paymentMethod !== "cod" ? (
          <Section title="Manual payment">
            <div className="space-y-3" data-testid="manual-payment">
              <p className="text-sm">
                The customer chose to pay in advance by <strong>{METHOD_LABELS[order.paymentMethod].en}</strong>. A transaction ID from the customer proves nothing by itself: check your{" "}
                {METHOD_LABELS[order.paymentMethod].en} account, then verify only the money that really arrived.
              </p>
              <dl className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                <Stat term="Order total" value={bdt(order.totalPaisa)} note="What the customer should pay in advance." />
                <Stat term="Verified as received" value={bdt(order.advanceReceivedPaisa)} note="Only what you checked in your account." tone={order.advanceReceivedPaisa > 0 ? "ok" : undefined} testId="advance-received" />
                <Stat term="Still due" value={bdt(due)} note={due > 0 ? "Not paid yet. If dispatched like this, the courier collects it." : "Nothing more to pay."} tone={due > 0 ? "wait" : "ok"} testId="advance-due" />
                <Stat term="Refunded" value={bdt(order.advanceRefundedPaisa)} note="Advance money paid back by hand." testId="advance-refunded" />
              </dl>
              {refundDue > 0 ? (
                <p role="status" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-900" data-testid="refund-due">
                  Refund due: {bdt(refundDue)}. This order {order.orderStatus === "cancelled" ? "is cancelled" : "came back undelivered"} but holds advance money you verified. Pay it
                  back by hand, then record the refund below. Nothing is refunded automatically.{order.orderStatus === "confirmed" ? " The order can be closed once the refund is recorded." : ""}
                </p>
              ) : null}
              {order.advancePayments.length ? (
                <ul className="space-y-3" aria-label="Payment references">
                  {order.advancePayments.map((a) => (
                    <li key={a.id} className="space-y-2 rounded-xl border border-gray-200 p-3 text-sm" data-testid="advance-reference" data-status={a.status}>
                      <p className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          <span className="font-mono font-semibold">{a.reference}</span> by {METHOD_LABELS[a.method].en}, {a.source === "customer" ? "sent by the customer" : "recorded by you"} {formatTime(a.createdAt)}
                        </span>
                        <span className="of-pill" data-tone={a.status === "verified" ? "ok" : a.status === "submitted" ? "wait" : "bad"}>
                          {ADVANCE_STATES[a.status]}
                        </span>
                      </p>
                      {a.amountPaisa !== null ? (
                        <p className="text-gray-700">
                          {bdt(a.amountPaisa)} received on {a.receivedOn}
                          {a.note ? `. ${a.status === "reversed" ? "Undone" : "Note"}: ${a.note}` : ""}
                        </p>
                      ) : a.note ? (
                        <p className="text-gray-700">Why it was rejected: {a.note}</p>
                      ) : null}
                      {duplicates.has(`${a.method}:${a.reference}`) && a.status === "submitted" ? (
                        <p className="font-semibold text-red-800">This reference was also sent for another order. Check it carefully: one transfer counts once.</p>
                      ) : null}
                      {a.status === "submitted" && can("payments:verify") && allowed.has("record_advance") ? (
                        <div className="grid gap-3 sm:grid-cols-2">
                          <ActionForm action={verifyAdvanceAction} idempotencyKey={randomUUID()} hidden={{ ...ref, advancePaymentId: a.id }} submitLabel="Verify: money received">
                            <Field name="amountTaka" label="Amount that arrived (BDT)" required inputMode="decimal" defaultValue={formatPaisa(due)} hint={`At most ${bdt(due)} still due. Enter less if less arrived.`} />
                            <Field name="receivedOn" label="Date it arrived" required defaultValue={today} hint="YYYY-MM-DD, as on your statement." />
                          </ActionForm>
                          <ActionForm action={rejectReferenceAction} idempotencyKey={randomUUID()} hidden={{ ...ref, advancePaymentId: a.id }} submitLabel="Reject reference" variant="secondary">
                            <Field name="note" label="Why (for your records)" required maxLength={300} hint="For example: no such transfer in the account. The customer is asked to contact you." />
                          </ActionForm>
                        </div>
                      ) : null}
                      {a.status === "verified" && can("payments:verify") && allowed.has("reverse_advance") ? (
                        <ActionPanel key={`undo-${a.id}-${order.version}`} label="Undo this verification">
                          <ActionForm
                            action={reverseAdvanceAction}
                            idempotencyKey={randomUUID()}
                            hidden={{ ...ref, advancePaymentId: a.id }}
                            submitLabel="Undo verification"
                            variant="secondary"
                            confirm="Undo this verification? Its amount stops counting as received. The record of both stays in the history."
                          >
                            <Field name="note" label="Why it was a mistake" required maxLength={300} />
                          </ActionForm>
                        </ActionPanel>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-gray-700">No transaction ID yet. The customer sends one from their order page after paying.</p>
              )}
              {can("payments:verify") && allowed.has("record_advance") ? (
                <ActionPanel key={`advance-${order.version}`} label="Record a payment the customer did not send an ID for">
                  <ActionForm action={verifyAdvanceAction} idempotencyKey={randomUUID()} hidden={ref} submitLabel="Record verified payment">
                    <Choice name="method" legend="Received by" defaultValue={order.paymentMethod} options={MANUAL_METHODS.map((m) => ({ value: m, label: METHOD_LABELS[m].en }))} />
                    <Field name="reference" label="Transaction ID from your statement" required maxLength={40} />
                    <Field name="amountTaka" label="Amount that arrived (BDT)" required inputMode="decimal" defaultValue={formatPaisa(due)} hint={`At most ${bdt(due)} still due.`} />
                    <Field name="receivedOn" label="Date it arrived" required defaultValue={today} />
                  </ActionForm>
                </ActionPanel>
              ) : null}
              {refundDue > 0 && can("payments:record") ? (
                <ActionPanel key={`advance-refund-${order.version}`} label="Record the advance refund" open>
                  <ActionForm action={refundAdvanceAction} idempotencyKey={randomUUID()} hidden={ref} submitLabel="Record refund paid">
                    <p className="text-xs text-gray-700">Record what you actually paid back, by hand. At most {bdt(refundDue)}.</p>
                    <Field name="amountTaka" label="Refund amount (BDT)" required inputMode="decimal" defaultValue={formatPaisa(refundDue)} />
                    <Choice name="method" legend="Paid by" defaultValue={order.paymentMethod} options={MANUAL_METHODS.map((m) => ({ value: m, label: METHOD_LABELS[m].en }))} />
                    <Field name="occurredOn" label="Date paid" required defaultValue={today} />
                    <Field name="reference" label="Transaction reference" maxLength={100} />
                  </ActionForm>
                </ActionPanel>
              ) : null}
              {!can("payments:verify") ? <p className="text-xs text-gray-600">Only the Owner can verify payments or record refunds.</p> : null}
            </div>
          </Section>
        ) : null}

        <Section title="Cash on delivery">
          <div className="space-y-3" data-testid="cod">
            <dl className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <Stat
                term="Expected"
                value={bdt(order.totalPaisa - order.advanceReceivedPaisa)}
                note={order.advanceReceivedPaisa ? "The order total less the verified advance payment. Not money received." : "The order total the courier should collect. Not money received."}
              />
              <Stat term="Collected by courier" value={bdt(order.codCollectedPaisa)} note="Everything the courier has taken from the customer so far." />
              <Stat term="Settled to you" value={bdt(order.codSettledPaisa)} note="Paid to you by the courier." tone={order.codSettledPaisa > 0 ? "ok" : undefined} />
              <Stat term="Still to collect" value={bdt(toCollect)} note="Not yet collected from the customer." tone={toCollect > 0 ? "wait" : undefined} />
            </dl>
            <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm sm:w-[28rem]">
              <dt className="text-gray-600">Collected, not settled or deducted</dt>
              <dd className="text-right tabular-nums">{bdt(unsettled)}</dd>
              <dt className="text-gray-600">Kept by courier (deductions)</dt>
              <dd className="text-right tabular-nums">{bdt(order.codDeductedPaisa)}</dd>
              <dt className="text-gray-600">Refunded</dt>
              <dd className="text-right tabular-nums">{bdt(order.refundedPaisa)}</dd>
              {order.rtoChargePaisa !== null ? (
                <>
                  <dt className="text-gray-600">RTO charge</dt>
                  <dd className="text-right tabular-nums">{bdt(order.rtoChargePaisa)}</dd>
                </>
              ) : null}
            </dl>
          </div>
          <p className="text-xs text-gray-600">Delivered does not mean collected or settled: record each amount as it actually happens.</p>
          {canRecordMoney ? (
            <ActionPanel key={`pay-${order.version}`} label="Record a payment" open={order.fulfilmentStatus === "delivered" && order.codCollectedPaisa === 0}>
              <ActionForm action={recordPaymentAction} idempotencyKey={randomUUID()} hidden={ref} submitLabel="Record amount">
                <Choice
                  name="kind"
                  legend="What happened"
                  options={[
                    ...(allowed.has("record_collection") ? [{ value: "collected", label: "Courier collected" }] : []),
                    ...(allowed.has("record_settlement") ? [{ value: "settled", label: "Settled to me" }] : []),
                    ...(allowed.has("record_deduction") ? [{ value: "deducted", label: "Kept by the courier (fee or deduction on its statement)" }] : []),
                  ]}
                />
                <Field name="amountTaka" label="Amount (BDT)" required inputMode="decimal" hint={`Up to ${bdt(receivable)} to collect, and up to ${bdt(unsettled)} collected and not yet settled or recorded as kept by the courier; partial amounts are fine.`} />
                <Field name="occurredOn" label="Date" required defaultValue={today} hint="YYYY-MM-DD, not in the future." />
                <Field name="reference" label="Reference" maxLength={100} hint="Optional, for example the courier's statement number." />
              </ActionForm>
            </ActionPanel>
          ) : null}
          {allowed.has("record_rto_charge") && can("payments:record") ? (
            <ActionPanel key={`rto-${order.version}`} label="Record the RTO charge">
              <ActionForm action={rtoChargeAction} idempotencyKey={randomUUID()} hidden={ref} submitLabel="Save RTO charge" variant="secondary">
                <Field name="chargeTaka" label="RTO charge billed by the courier (BDT)" required inputMode="decimal" defaultValue={order.rtoChargePaisa === null ? "" : formatPaisa(order.rtoChargePaisa)} />
              </ActionForm>
            </ActionPanel>
          ) : null}
          {order.payments.length ? (
            <div>
              <h3 className="text-sm font-semibold">Payment records</h3>
              <ul aria-label="Payment records" className="divide-y divide-gray-200 text-sm">
                {order.payments.map((p) => (
                  <li key={p.id} className="flex flex-wrap justify-between gap-2 py-1.5">
                    <span>
                      {p.kind === "collected" ? "Courier collected" : p.kind === "settled" ? "Settled" : p.kind === "deducted" ? "Kept by courier" : `Refunded (${p.method === "bank_transfer" ? "bank transfer" : p.method})`} on {p.occurredOn}
                      {p.reference ? ` · ${p.reference}` : ""}
                    </span>
                    <span className="tabular-nums">{bdt(p.amountPaisa)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Section>

        {allowed.has("create_return") || order.returns.length ? (
          <Section title="Returns and exchanges">
            {order.returns.length ? (
              <ul className="space-y-4">
                {order.returns.map((r) => (
                  <li key={r.id} className="space-y-2 rounded-xl border border-gray-200 p-3 text-sm">
                    <p>
                      <strong>{r.kind === "return" ? "Return" : "Exchange"}</strong> · {r.reason === "wrong_or_defective" ? "wrong or defective" : "size or preference"} · return shipping paid by{" "}
                      {r.shippingPaidBy === "business" ? "us" : "the customer"}
                      {r.returnShippingCostPaisa !== null ? ` (${bdt(r.returnShippingCostPaisa)})` : ""} · <span data-testid="return-status">{words(RETURN_STATES, r.status)}</span>
                    </p>
                    <p className="text-gray-700">{r.items.map((i) => `${itemBy.get(i.orderItemId)?.sku} × ${i.quantity}`).join(", ")}</p>
                    {r.id === current?.id && r.status === "requested" && can("orders:write") ? (
                      <ActionForm action={returnStepAction} idempotencyKey={randomUUID()} hidden={{ ...ref, returnId: r.id, step: "receive" }} submitLabel="Goods received: send to inspection">
                        <Field name="costTaka" label="Actual return shipping cost (BDT)" inputMode="decimal" hint="Optional; record it when you know it." />
                      </ActionForm>
                    ) : null}
                    {r.id === current?.id && r.status === "received" && can("returns:decide") ? (
                      <div className="flex flex-wrap gap-3">
                        <ActionForm action={returnStepAction} idempotencyKey={randomUUID()} hidden={{ ...ref, returnId: r.id, step: "approve" }} submitLabel="Approve request" />
                        <ActionForm action={returnStepAction} idempotencyKey={randomUUID()} hidden={{ ...ref, returnId: r.id, step: "reject" }} submitLabel="Reject request" variant="secondary" confirm="Reject this request?" />
                      </div>
                    ) : null}
                    {r.id === current?.id && r.status === "approved" && r.kind === "return" && received > 0 && can("payments:record") ? (
                      <ActionForm action={returnStepAction} idempotencyKey={randomUUID()} hidden={{ ...ref, returnId: r.id, step: "refund" }} submitLabel="Record refund paid">
                        <p className="text-xs text-gray-700">Pay within 7 working days of approval, by hand. Never more than was received ({bdt(received)} available).</p>
                        <Field name="amountTaka" label="Refund amount (BDT)" required inputMode="decimal" />
                        <Choice name="method" legend="Paid by" options={[{ value: "bkash", label: "bKash" }, { value: "nagad", label: "Nagad" }, { value: "bank_transfer", label: "Bank transfer" }]} />
                        <Field name="occurredOn" label="Date paid" required defaultValue={today} />
                        <Field name="reference" label="Transaction reference" maxLength={100} />
                      </ActionForm>
                    ) : null}
                    {r.id === current?.id && r.status === "approved" && (r.kind === "exchange" || received === 0) && can("orders:write") ? (
                      <>
                        {r.kind === "exchange" ? <p className="text-xs text-gray-700">Send the replacement as a new assisted order (it reserves stock normally), then complete this request.</p> : null}
                        <ActionForm action={returnStepAction} idempotencyKey={randomUUID()} hidden={{ ...ref, returnId: r.id, step: "complete" }} submitLabel="Mark completed" />
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {allowed.has("create_return") && can("orders:write") ? (
              <ActionPanel key={`return-${order.version}`} label="Record a return or exchange">
                <p className="text-sm text-gray-700">
                  Accepted until {windowEnd ? formatTime(windowEnd) : "—"} (7 days after delivery). Size or preference changes need unused, unwashed goods with tags; wrong or defective goods do not. Who
                  pays return shipping follows the reason.
                </p>
                <ActionForm action={createReturnAction} idempotencyKey={randomUUID()} hidden={{ ...ref, ...Object.fromEntries(order.items.map((i, n) => [`itemId${n}`, i.id])) }} submitLabel="Record request">
                  <Choice name="kind" legend="Request" options={[{ value: "return", label: "Return (refund)" }, { value: "exchange", label: "Exchange" }]} />
                  <Choice
                    name="reason"
                    legend="Reason"
                    options={[
                      { value: "size_or_preference", label: "Size or preference (customer pays return shipping)" },
                      { value: "wrong_or_defective", label: "Wrong or defective item (we pay return shipping)" },
                    ]}
                  />
                  {order.items.map((i, n) => (
                    <Field key={i.id} name={`itemQty${n}`} label={`Units of ${i.sku} coming back (of ${i.quantity})`} inputMode="numeric" maxLength={4} />
                  ))}
                  <Field name="note" label="Note" multiline maxLength={500} />
                </ActionForm>
              </ActionPanel>
            ) : null}
          </Section>
        ) : null}

        {order.quarantine.length ? (
          <Section title="Inspection (quarantine)">
            <p className="text-sm text-gray-700">Returned and RTO goods stay out of sellable stock until inspected. Passing restocks them once; failing keeps them out.</p>
            <ul className="space-y-3">
              {order.quarantine.map((q) => (
                <li key={q.id} className="space-y-2 rounded-xl border border-gray-200 p-3 text-sm">
                  <p>
                    {itemBy.get(q.orderItemId)?.sku} × {q.quantity} · from {q.source === "rto" ? "RTO" : "a return"} · <span data-testid="inspection-status">{words(INSPECTION_STATES, q.status)}</span>
                    {q.note ? ` · ${q.note}` : ""}
                  </p>
                  {q.status === "awaiting_inspection" && can("stock:receive") ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <ActionForm action={inspectAction} idempotencyKey={randomUUID()} hidden={{ ...ref, quarantineItemId: q.id, outcome: "restock" }} submitLabel="Passed: back to stock">
                        <Field name="note" label="Inspection note" maxLength={500} />
                      </ActionForm>
                      <ActionForm action={inspectAction} idempotencyKey={randomUUID()} hidden={{ ...ref, quarantineItemId: q.id, outcome: "reject" }} submitLabel="Failed: keep out of stock" variant="secondary">
                        <Field name="note" label="Why it failed" maxLength={500} />
                      </ActionForm>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        <Section title="History">
          <ol className="of-timeline text-sm" aria-label="Order history">
            {order.events.map((e) => (
              <li key={e.id}>
                <p className="font-medium">{eventLabel(e.event)}</p>
                <p className="text-xs text-gray-600">
                  {formatTime(e.createdAt)} ·{" "}
                  {e.actorType === "user" ? (names.get(e.actorRef) ?? "Staff") : e.actorType === "customer" ? (e.actorRef === "guest-checkout" ? "Customer (website checkout)" : "Customer (tracking link)") : `System (${e.actorRef})`}
                </p>
              </li>
            ))}
          </ol>
        </Section>
      </div>
    </AdminShell>
  );
}
