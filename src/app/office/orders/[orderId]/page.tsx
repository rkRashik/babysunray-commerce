import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { DomainError } from "@/modules/domain-error";
import { formatPaisa } from "@/modules/money";
import { getOrderDetail, type OrderDetail } from "@/modules/orders/queries";
import { allowedActions, dhakaToday, formatOrderNumber, type OrderAction, returnWindowEnd, verificationOverdue, ZONE_LABELS } from "@/modules/orders/rules";
import { ActionForm, Choice, Field } from "../../_components/action-form";
import { OfficeShell, Section, formatTime, noticeFor } from "../../_components/shell";
import { requireOffice } from "../../_lib/session";
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
import { bdt, Dimensions, label, relative } from "../_components/labels";

export const metadata = { title: "Order · Owner Office" };

type Props = { params: Promise<{ orderId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

// Owner-facing buttons, in the order a normal order moves. Each needs a confirmation where it is hard to undo.
const BUTTONS: { action: OrderAction & ("confirm" | "pack" | "dispatch" | "deliver" | "mark_rto" | "receive_rto" | "close" | "cancel"); label: string; confirm?: string; secondary?: boolean }[] = [
  { action: "confirm", label: "Confirm order (verified with the customer)" },
  { action: "pack", label: "Mark packed" },
  { action: "dispatch", label: "Dispatch", confirm: "Dispatch this order? Its stock is deducted and it can no longer be cancelled." },
  { action: "deliver", label: "Mark delivered" },
  { action: "mark_rto", label: "Mark returned to sender (refused or undelivered)", secondary: true },
  { action: "receive_rto", label: "Receive returned parcel into inspection" },
  { action: "close", label: "Close order", confirm: "Close this order? The tracking link stops working 30 days from now." },
  { action: "cancel", label: "Cancel order", confirm: "Cancel this order? Any reserved stock is released.", secondary: true },
];

const openReturn = (o: OrderDetail) => o.returns.find((r) => r.status === "requested" || r.status === "received" || r.status === "approved");

export default async function OrderPage({ params, searchParams }: Props) {
  await requireOffice("orders:read");
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
  const unsettled = order.codCollectedPaisa - order.codSettledPaisa;
  const receivable = order.totalPaisa - order.codCollectedPaisa;
  const today = dhakaToday(now);
  const windowEnd = order.deliveredAt ? returnWindowEnd(order.deliveredAt) : null;

  return (
    <OfficeShell title={`Order ${formatOrderNumber(order.number)}`} current="orders" notice={noticeFor(done)} breadcrumbs={[{ href: "/office/orders", label: "Orders" }]}>
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
          <p role="status" className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950" data-testid="verification">
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

      <Section title="Actions">
        {BUTTONS.some((b) => allowed.has(b.action)) ? (
          <div className="flex flex-wrap gap-3">
            {BUTTONS.filter((b) => allowed.has(b.action)).map((b) => (
              <ActionForm
                key={b.action}
                action={orderTransitionAction}
                idempotencyKey={randomUUID()}
                hidden={{ ...ref, action: b.action }}
                submitLabel={b.label}
                confirm={b.confirm}
                variant={b.secondary ? "secondary" : "primary"}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-700">No lifecycle step is possible now.</p>
        )}
        {order.fulfilmentStatus === "packed" && request ? <p className="text-sm text-gray-700">Dispatch is blocked until the cancellation request is decided.</p> : null}
        {(order.fulfilmentStatus === "delivered" || order.fulfilmentStatus === "rto_received") && order.orderStatus === "confirmed" && !allowed.has("close") ? (
          <p className="text-sm text-gray-700" data-testid="close-hint">
            {windowEnd && now.getTime() <= windowEnd.getTime() ? `Can be closed after ${formatTime(windowEnd)}, when the 7-day return window has ended. ` : null}
            Closing needs every collected amount settled, no open return and nothing awaiting inspection.
          </p>
        ) : null}
      </Section>

      <Section title="Customer and delivery">
        <Link href={`/office/print/orders/${order.id}`} className="inline-block text-sm underline">
          Print packing and shipping document
        </Link>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-gray-600">Name</dt>
          <dd>{order.customerName}</dd>
          <dt className="text-gray-600">Phone</dt>
          <dd className="tabular-nums">{order.customerPhone}</dd>
          <dt className="text-gray-600">Address</dt>
          <dd className="whitespace-pre-line">{order.deliveryAddress}</dd>
          <dt className="text-gray-600">Zone</dt>
          <dd>{ZONE_LABELS[order.deliveryZone]}</dd>
          {order.note ? (
            <>
              <dt className="text-gray-600">Note</dt>
              <dd className="whitespace-pre-line">{order.note}</dd>
            </>
          ) : null}
        </dl>
      </Section>

      <Section title="Items">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-300 text-gray-600">
              <tr>
                <th scope="col" className="py-2 pr-3">SKU</th>
                <th scope="col" className="py-2 pr-3">Product (as ordered)</th>
                <th scope="col" className="py-2 pr-3 text-right">Unit price</th>
                <th scope="col" className="py-2 pr-3 text-right">Qty</th>
                <th scope="col" className="py-2 pr-3 text-right">Line total</th>
                <th scope="col" className="py-2">Reserved now</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {order.items.map((i) => (
                <tr key={i.id}>
                  <th scope="row" className="py-2 pr-3 font-normal">
                    <Link href={`/office/skus/${encodeURIComponent(i.sku)}`} className="underline">
                      {i.sku}
                    </Link>
                  </th>
                  <td className="py-2 pr-3">
                    {i.productNameEn ?? <span lang="bn">{i.productNameBn}</span>}
                    {[i.size, i.colour].filter(Boolean).length ? <span className="text-gray-600"> · {[i.size, i.colour].filter(Boolean).join(", ")}</span> : null}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{bdt(i.unitPricePaisa)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{i.quantity}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{bdt(i.lineTotalPaisa)}</td>
                  <td className="py-2 tabular-nums">{reservedBy.get(i.variantId) ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:w-80">
          <dt className="text-gray-600">Subtotal</dt>
          <dd className="text-right tabular-nums">{bdt(order.subtotalPaisa)}</dd>
          <dt className="text-gray-600">Delivery ({ZONE_LABELS[order.deliveryZone]})</dt>
          <dd className="text-right tabular-nums">{bdt(order.deliveryChargePaisa)}</dd>
          <dt className="font-medium">Expected COD</dt>
          <dd className="text-right font-medium tabular-nums">{bdt(order.totalPaisa)}</dd>
        </dl>
      </Section>

      <Section title="Cash on delivery">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:w-96" data-testid="cod">
          <dt className="text-gray-600">Expected</dt>
          <dd className="text-right tabular-nums">{bdt(order.totalPaisa)}</dd>
          <dt className="text-gray-600">Collected by courier</dt>
          <dd className="text-right tabular-nums">{bdt(order.codCollectedPaisa)}</dd>
          <dt className="text-gray-600">Settled to you</dt>
          <dd className="text-right tabular-nums">{bdt(order.codSettledPaisa)}</dd>
          <dt className="text-gray-600">Still to collect</dt>
          <dd className="text-right tabular-nums">{bdt(order.fulfilmentStatus === "dispatched" || order.fulfilmentStatus === "delivered" ? receivable : 0)}</dd>
          <dt className="text-gray-600">Collected, not settled</dt>
          <dd className="text-right tabular-nums">{bdt(unsettled)}</dd>
          <dt className="text-gray-600">Refunded</dt>
          <dd className="text-right tabular-nums">{bdt(order.refundedPaisa)}</dd>
          {order.rtoChargePaisa !== null ? (
            <>
              <dt className="text-gray-600">RTO charge</dt>
              <dd className="text-right tabular-nums">{bdt(order.rtoChargePaisa)}</dd>
            </>
          ) : null}
        </dl>
        <p className="text-xs text-gray-600">Delivered does not mean collected or settled: record each amount as it actually happens.</p>
        {allowed.has("record_collection") || allowed.has("record_settlement") ? (
          <ActionForm action={recordPaymentAction} idempotencyKey={randomUUID()} hidden={ref} submitLabel="Record amount">
            <Choice
              name="kind"
              legend="What happened"
              options={[
                ...(allowed.has("record_collection") ? [{ value: "collected", label: "Courier collected" }] : []),
                ...(allowed.has("record_settlement") ? [{ value: "settled", label: "Settled to me" }] : []),
              ]}
            />
            <Field name="amountTaka" label="Amount (BDT)" required inputMode="decimal" hint={`Up to ${formatPaisa(allowed.has("record_collection") ? receivable : unsettled)} for this step; partial amounts are fine.`} />
            <Field name="occurredOn" label="Date" required defaultValue={today} hint="YYYY-MM-DD, not in the future." />
            <Field name="reference" label="Reference" maxLength={100} hint="Optional, for example the courier's statement number." />
          </ActionForm>
        ) : null}
        {allowed.has("record_rto_charge") ? (
          <ActionForm action={rtoChargeAction} idempotencyKey={randomUUID()} hidden={ref} submitLabel="Save RTO charge" variant="secondary">
            <Field name="chargeTaka" label="RTO charge billed by the courier (BDT)" required inputMode="decimal" defaultValue={order.rtoChargePaisa === null ? "" : formatPaisa(order.rtoChargePaisa)} />
          </ActionForm>
        ) : null}
        {order.payments.length ? (
          <ul aria-label="Payment records" className="divide-y divide-gray-200 text-sm">
            {order.payments.map((p) => (
              <li key={p.id} className="flex flex-wrap justify-between gap-2 py-1">
                <span>
                  {p.kind === "collected" ? "Courier collected" : p.kind === "settled" ? "Settled" : `Refunded (${p.method === "bank_transfer" ? "bank transfer" : p.method})`} on {p.occurredOn}
                  {p.reference ? ` · ${p.reference}` : ""}
                </span>
                <span className="tabular-nums">{bdt(p.amountPaisa)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      {allowed.has("create_return") ? (
        <Section title="New return or exchange">
          <p className="text-sm text-gray-700">
            Accepted until {windowEnd ? formatTime(windowEnd) : "—"} (7 days after delivery). Size or preference
            changes need unused, unwashed goods with tags; wrong or defective goods do not. Who pays return shipping follows the reason.
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
        </Section>
      ) : null}

      {order.returns.length ? (
        <Section title="Returns and exchanges">
          <ul className="space-y-4">
            {order.returns.map((r) => (
              <li key={r.id} className="space-y-2 rounded border border-gray-200 p-3 text-sm">
                <p>
                  <strong>{r.kind === "return" ? "Return" : "Exchange"}</strong> · {r.reason === "wrong_or_defective" ? "wrong or defective" : "size or preference"} · return shipping paid by{" "}
                  {r.shippingPaidBy === "business" ? "us" : "the customer"}
                  {r.returnShippingCostPaisa !== null ? ` (${bdt(r.returnShippingCostPaisa)})` : ""} · <span data-testid="return-status">{r.status}</span>
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
        </Section>
      ) : null}

      {order.quarantine.length ? (
        <Section title="Inspection (quarantine)">
          <p className="text-sm text-gray-700">Returned and RTO goods stay out of sellable stock until inspected. Passing restocks them once; failing keeps them out.</p>
          <ul className="space-y-3">
            {order.quarantine.map((q) => (
              <li key={q.id} className="space-y-2 rounded border border-gray-200 p-3 text-sm">
                <p>
                  {itemBy.get(q.orderItemId)?.sku} × {q.quantity} · from {q.source === "rto" ? "RTO" : "a return"} · <span data-testid="inspection-status">{q.status.replace(/_/g, " ")}</span>
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

      <Section title="History">
        <ol className="space-y-1 text-sm" aria-label="Order history">
          {order.events.map((e) => (
            <li key={e.id}>
              <span className="text-gray-600">{formatTime(e.createdAt)}</span> · {e.event.replace(/_/g, " ")} ·{" "}
              {e.actorType === "user" ? "Owner" : e.actorType === "customer" ? "Customer (tracking link)" : `System (${e.actorRef})`}
            </li>
          ))}
        </ol>
      </Section>
    </OfficeShell>
  );
}
