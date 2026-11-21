import { randomUUID } from "node:crypto";
import { Printer } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { DomainError } from "@/modules/domain-error";
import { formatPaisa } from "@/modules/money";
import { getOrderDetail, type OrderDetail } from "@/modules/orders/queries";
import { allowedActions, dhakaToday, formatOrderNumber, type OrderAction, returnWindowEnd, verificationOverdue, ZONE_LABELS } from "@/modules/orders/rules";
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
  returnStepAction,
  reviewCancellationAction,
  revokeTrackingLinkAction,
  rtoChargeAction,
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

const openReturn = (o: OrderDetail) => o.returns.find((r) => r.status === "requested" || r.status === "received" || r.status === "approved");

export default async function OrderPage({ params, searchParams }: Props) {
  await requireAdmin("orders:read");
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
  const ref = { orderId: order.id, version: String(order.version) };
  const overdue = verificationOverdue(order, now);
  const request = order.cancellationRequests.find((r) => r.status === "open");
  const current = openReturn(order);
  const itemBy = new Map(order.items.map((i) => [i.id, i]));
  const reservedBy = new Map(order.reservations.filter((r) => r.status === "active").map((r) => [r.variantId, r.quantity]));
  const unsettled = order.codCollectedPaisa - order.codSettledPaisa - order.codDeductedPaisa;
  const receivable = order.totalPaisa - order.codCollectedPaisa;
  const toCollect = order.fulfilmentStatus === "dispatched" || order.fulfilmentStatus === "delivered" ? receivable : 0;
  const today = dhakaToday(now);
  const windowEnd = order.deliveredAt ? returnWindowEnd(order.deliveredAt) : null;
  const steps = BUTTONS.filter((b) => allowed.has(b.action));
  const canRecordMoney = allowed.has("record_collection") || allowed.has("record_settlement");
  // Status, Next step, Items, Cash on delivery and History, plus the cards that only some orders have.
  const mainCards = 5 + [request, allowed.has("create_return") || order.returns.length, order.quarantine.length].filter(Boolean).length;

  return (
    <AdminShell title={`Order ${formatOrderNumber(order.number)}`} current="orders" wide notice={noticeFor(done)} breadcrumbs={[{ href: "/admin/orders", label: "Orders" }]}>
      {/* The side column spans every row of the main column, so a tall side column never stretches the cards beside it. */}
      <div className="of-split" style={{ "--side-rows": mainCards } as React.CSSProperties}>
        <Section title="Status">
          <Dimensions order={order} />
          <p className="text-sm text-gray-700">
            Taken on {label(order.source)} · created {formatTime(order.createdAt)} · version <span data-testid="order-version">{order.version}</span>
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

        {request ? (
          <Section title="Cancellation request">
            <p className="text-sm">
              The customer asked to cancel on {formatTime(request.createdAt)}.{request.reason ? <> Reason: “{request.reason}”</> : null} Stock stays reserved until you decide. Dispatch waits for your decision.
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
                  <span className="tabular-nums">{order.customerPhone}</span>
                  <CopyButton value={order.customerPhone} label="phone number" />
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
            <div className="flex flex-wrap items-start gap-3">
              <ActionForm action={createTrackingLinkAction} idempotencyKey={randomUUID()} hidden={{ orderId: order.id }} submitLabel={order.trackingLink ? "Create a new link" : "Create link"} confirm={order.trackingLink ? "Create a new link? The current one stops working." : undefined} />
              {order.trackingLink ? <ActionForm action={revokeTrackingLinkAction} idempotencyKey={randomUUID()} hidden={{ orderId: order.id }} submitLabel="Revoke link" variant="secondary" confirm="Revoke the tracking link? It stops working at once." /> : null}
            </div>
          </Section>
        </div>

        <Section title="Items">
          <div className="overflow-x-auto">
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
            <dt className="border-t border-gray-200 pt-1 font-semibold">Expected COD</dt>
            <dd className="border-t border-gray-200 pt-1 text-right font-semibold tabular-nums">{bdt(order.totalPaisa)}</dd>
          </dl>
        </Section>

        <Section title="Cash on delivery">
          <div className="space-y-3" data-testid="cod">
            <dl className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <Stat term="Expected" value={bdt(order.totalPaisa)} note="The order total the courier should collect. Not money received." />
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
          {allowed.has("record_rto_charge") ? (
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
                    {r.id === current?.id && r.status === "requested" ? (
                      <ActionForm action={returnStepAction} idempotencyKey={randomUUID()} hidden={{ ...ref, returnId: r.id, step: "receive" }} submitLabel="Goods received: send to inspection">
                        <Field name="costTaka" label="Actual return shipping cost (BDT)" inputMode="decimal" hint="Optional; record it when you know it." />
                      </ActionForm>
                    ) : null}
                    {r.id === current?.id && r.status === "received" ? (
                      <div className="flex flex-wrap gap-3">
                        <ActionForm action={returnStepAction} idempotencyKey={randomUUID()} hidden={{ ...ref, returnId: r.id, step: "approve" }} submitLabel="Approve request" />
                        <ActionForm action={returnStepAction} idempotencyKey={randomUUID()} hidden={{ ...ref, returnId: r.id, step: "reject" }} submitLabel="Reject request" variant="secondary" confirm="Reject this request?" />
                      </div>
                    ) : null}
                    {r.id === current?.id && r.status === "approved" && r.kind === "return" && order.codCollectedPaisa - order.refundedPaisa > 0 ? (
                      <ActionForm action={returnStepAction} idempotencyKey={randomUUID()} hidden={{ ...ref, returnId: r.id, step: "refund" }} submitLabel="Record refund paid">
                        <p className="text-xs text-gray-700">Pay within 7 working days of approval, by hand. Never more than was collected ({bdt(order.codCollectedPaisa - order.refundedPaisa)} available).</p>
                        <Field name="amountTaka" label="Refund amount (BDT)" required inputMode="decimal" />
                        <Choice name="method" legend="Paid by" options={[{ value: "bkash", label: "bKash" }, { value: "nagad", label: "Nagad" }, { value: "bank_transfer", label: "Bank transfer" }]} />
                        <Field name="occurredOn" label="Date paid" required defaultValue={today} />
                        <Field name="reference" label="Transaction reference" maxLength={100} />
                      </ActionForm>
                    ) : null}
                    {r.id === current?.id && r.status === "approved" && (r.kind === "exchange" || order.codCollectedPaisa - order.refundedPaisa === 0) ? (
                      <>
                        {r.kind === "exchange" ? <p className="text-xs text-gray-700">Send the replacement as a new assisted order (it reserves stock normally), then complete this request.</p> : null}
                        <ActionForm action={returnStepAction} idempotencyKey={randomUUID()} hidden={{ ...ref, returnId: r.id, step: "complete" }} submitLabel="Mark completed" />
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {allowed.has("create_return") ? (
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
                  {q.status === "awaiting_inspection" ? (
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
                  {e.actorType === "user" ? "Owner" : e.actorType === "customer" ? (e.actorRef === "guest-checkout" ? "Customer (website checkout)" : "Customer (tracking link)") : `System (${e.actorRef})`}
                </p>
              </li>
            ))}
          </ol>
        </Section>
      </div>
    </AdminShell>
  );
}
