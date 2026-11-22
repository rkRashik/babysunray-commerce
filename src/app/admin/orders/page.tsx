import { randomUUID } from "node:crypto";
import { Eye, Plus, X } from "lucide-react";
import { cookies } from "next/headers";
import Link from "next/link";
import { productCursorCodec } from "@/api/v1/schemas";
import { getDb } from "@/db/client";
import { roleHasPermission } from "@/modules/auth/permissions";
import { readAuthSettings } from "@/modules/auth/settings";
import { DomainError } from "@/modules/domain-error";
import type { Order } from "@/modules/orders/internal";
import { classifyOrderSearch, isOrderQueue, listOrders, type OrderQueue, orderQueueCounts } from "@/modules/orders/queries";
import { formatOrderNumber, type OrderStatus, verificationOverdue } from "@/modules/orders/rules";
import { ActionForm } from "../_components/action-form";
import { ScrollArea } from "../_components/scroll-area";
import { AdminShell, noticeFor } from "../_components/shell";
import { requireAdmin } from "../_lib/session";
import { clearOrderSearchAction, orderTransitionAction } from "./actions";
import { openSearch, SEARCH_COOKIE } from "./_lib/search-cookie";
import { BulkBar } from "./_components/bulk-bar";
import { METHOD_LABELS } from "@/modules/settings/payments";
import { bdt, label, overdueBy, relative, StatusPill } from "./_components/labels";
import { OrderFilters } from "./_components/order-filters";
import { OrderQuickView } from "./_components/quick-view";

export const metadata = { title: "Orders · Admin" };

const STATUSES: OrderStatus[] = ["pending_verification", "verification_expired", "confirmed", "cancelled", "closed"];
const STATUS_LABELS: Record<OrderStatus, string> = {
  pending_verification: "Pending verification",
  verification_expired: "Verification expired",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
  closed: "Closed",
};
// The work queues as filter chips, in the order the work happens. "Needs attention" is the attention filter, not a queue.
const CHIPS: { label: string; queue?: OrderQueue; attention?: true }[] = [
  { label: "All orders" },
  { label: "Needs attention", attention: true },
  { label: "To verify", queue: "pending" },
  { label: "Payments to verify", queue: "payment_to_verify" },
  { label: "To pack", queue: "to_pack" },
  { label: "To dispatch", queue: "to_dispatch" },
  { label: "In transit", queue: "in_transit" },
  { label: "COD to collect", queue: "awaiting_collection" },
  { label: "Not settled", queue: "unsettled" },
  { label: "Returning (RTO)", queue: "returning" },
  { label: "Refunds due", queue: "refund_due" },
];
const QUEUE_TITLES: Record<OrderQueue, string> = {
  pending: "Waiting for verification",
  overdue: "Past the 24-hour verification window",
  to_pack: "Confirmed, to pack",
  to_dispatch: "Packed, to dispatch",
  in_transit: "Dispatched, awaiting delivery",
  cancellation_requests: "Cancellation requests to review",
  returning: "Returning to sender (RTO)",
  awaiting_collection: "COD not fully collected",
  unsettled: "Collected, not fully settled to you",
  payment_to_verify: "Advance payment references to verify",
  refund_due: "Cancelled with advance money to refund",
};
const PAGE_SIZE = 25;

type Filters = { status?: OrderStatus; attention?: boolean; queue?: OrderQueue; number?: string; search?: boolean; cursor?: string };
const href = (f: Filters) => {
  const query = new URLSearchParams();
  if (f.status) query.set("status", f.status);
  if (f.attention) query.set("attention", "true");
  if (f.queue) query.set("queue", f.queue);
  if (f.number) query.set("number", f.number);
  if (f.search) query.set("search", "1");
  if (f.cursor) query.set("cursor", f.cursor);
  return query.size ? `/admin/orders?${query}` : "/admin/orders";
};

const day = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short" });
const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", hour: "2-digit", minute: "2-digit" });
const phoneText = (phone: string) => `${phone.slice(0, 5)} ${phone.slice(5)}`;

type Row = Order & { openRequest: boolean };
const isBulk = (step: Step) => step.kind === "action" && (step.action === "pack" || step.action === "dispatch");
type Step =
  | { kind: "action"; action: "confirm" | "pack" | "dispatch" | "deliver"; label: string; confirm?: string }
  | { kind: "link"; label: string };

const CONFIRM_TEXT = "Confirm this order? Only do this after you have verified it with the customer.";
const DELIVERY_TEXT =
  "Record this order as delivered? This is your own record: no courier system has confirmed it. It starts the 7-day return window. COD collection and settlement are recorded separately.";
const OVERDUE_TEXT =
  "The 24-hour verification window has passed. You can still confirm: stock is checked again and the confirmation is refused if there is not enough. Confirm only after you have verified this order with the customer.";

/** The next step for an order, taken from the list when it is one tap; anything needing a decision opens the order. */
function nextStep(o: Row, now: Date): Step {
  if (o.orderStatus === "pending_verification" || o.orderStatus === "verification_expired") {
    return { kind: "action", action: "confirm", label: "Confirm", confirm: verificationOverdue(o, now) ? OVERDUE_TEXT : CONFIRM_TEXT };
  }
  if (o.openRequest) return { kind: "link", label: "Review request" };
  if (o.orderStatus === "confirmed" && o.fulfilmentStatus === "unfulfilled") return { kind: "action", action: "pack", label: "Mark packed" };
  if (o.orderStatus === "confirmed" && o.fulfilmentStatus === "packed" && o.paymentMethod !== "cod" && o.codCollectedPaisa + o.advanceReceivedPaisa < o.totalPaisa)
    return { kind: "link", label: "Verify payment" };
  if (o.orderStatus === "confirmed" && o.fulfilmentStatus === "packed")
    return { kind: "action", action: "dispatch", label: "Dispatch", confirm: "Dispatch this order? Its stock is deducted and it can no longer be cancelled." };
  if (o.orderStatus === "confirmed" && o.fulfilmentStatus === "dispatched") return { kind: "action", action: "deliver", label: "Record delivery", confirm: DELIVERY_TEXT };
  return { kind: "link", label: "Open" };
}

function Deadline({ order, now }: { order: Row; now: Date }) {
  if (verificationOverdue(order, now)) return <span className="block text-xs font-semibold whitespace-nowrap text-red-800">Overdue by {overdueBy(order.verificationExpiresAt, now)}</span>;
  if (order.orderStatus === "pending_verification") return <span className="block text-xs font-semibold whitespace-nowrap text-amber-900">Verify {relative(order.verificationExpiresAt, now)}</span>;
  if (order.openRequest) return <span className="block text-xs font-semibold text-red-800">Cancellation requested</span>;
  return null;
}

/** Payment, without "nothing collected" noise before there is anything to collect; COD that is due or not settled stands out. */
function PaymentCell({ order, hideEmpty = false, labelled = false }: { order: Row; hideEmpty?: boolean; labelled?: boolean }) {
  const none = hideEmpty ? null : <span className="text-sm text-gray-500">—</span>;
  const prefixed = (pill: React.ReactNode) => (
    <>
      {labelled ? <span className="sr-only">Payment: </span> : null}
      {pill}
    </>
  );
  // A manual advance payment: never "paid" until the Owner verified the money (ADR-0013).
  if (order.paymentMethod !== "cod") {
    const name = METHOD_LABELS[order.paymentMethod].en;
    if (order.orderStatus === "cancelled") {
      return order.advanceReceivedPaisa > order.advanceRefundedPaisa
        ? prefixed(
            <span className="of-pill" data-tone="bad">
              Refund due
            </span>,
          )
        : none;
    }
    const paid = order.advanceReceivedPaisa >= order.totalPaisa;
    return prefixed(
      <span className="of-pill" data-tone={paid ? "ok" : "wait"} data-testid="advance-pill">
        {paid ? `${name} verified` : order.advanceReceivedPaisa > 0 ? `${name} part paid` : `${name} not verified`}
      </span>,
    );
  }
  if (order.orderStatus === "cancelled") return none;
  const dispatched = order.fulfilmentStatus === "dispatched" || order.fulfilmentStatus === "delivered";
  const prefix = labelled ? <span className="sr-only">Payment: </span> : null;
  if (order.paymentStatus === "unpaid") {
    return dispatched ? (
      <>
        {prefix}
        <span className="of-pill" data-tone="wait">
          COD to collect
        </span>
      </>
    ) : (
      none
    );
  }
  return (
    <>
      {prefix}
      <StatusPill value={order.paymentStatus} />
    </>
  );
}

function QuickAction({ order, step, returnTo, idempotencyKey }: { order: Row; step: Step; returnTo: string; idempotencyKey: string }) {
  const url = `/admin/orders/${order.id}`;
  if (step.kind === "link")
    return (
      <Link prefetch={false} href={url} className={`of-btn of-btn-sm ${step.label === "Open" ? "of-btn-line" : "of-btn-ink"}`} aria-label={`${step.label}: ${formatOrderNumber(order.number)}`}>
        {step.label}
      </Link>
    );
  return (
    <ActionForm
      action={orderTransitionAction}
      idempotencyKey={idempotencyKey}
      hidden={{ orderId: order.id, version: String(order.version), action: step.action, returnTo }}
      submitLabel={step.label}
      confirm={step.confirm}
      variant={step.action === "confirm" ? "secondary" : "primary"}
      compact
    />
  );
}

// Orders newest first. Filters live in the URL. A name or phone search lives in a sealed HttpOnly cookie (actions.ts,
// _lib/search-cookie.ts), so no customer's name or phone number ever appears in a URL, a request log line or the browser history.
export default async function OrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const principal = await requireAdmin("orders:read");
  const canWrite = roleHasPermission(principal.role, "orders:write");
  const query = await searchParams;
  const status = STATUSES.find((s) => s === query.status);
  const attention = query.attention === "true";
  const queue = isOrderQueue(query.queue) ? query.queue : undefined;
  const number = typeof query.number === "string" ? query.number.trim() : "";
  const cursor = typeof query.cursor === "string" ? query.cursor : undefined;
  const after = cursor ? (productCursorCodec.decode(cursor) ?? undefined) : undefined;
  const term = query.search === "1" ? (openSearch((await cookies()).get(SEARCH_COOKIE)?.value, principal.userId, readAuthSettings(process.env).secret) ?? "") : "";
  const search = term ? classifyOrderSearch(term) : null;
  const filters: Filters = { status, attention, queue, number: number || undefined, search: Boolean(term) };
  const db = getDb();
  let error: string | undefined;
  let hint: string | undefined;
  let page: Awaited<ReturnType<typeof listOrders>> = { items: [], hasMore: false };
  const counting = orderQueueCounts(db);
  if (query.search === "1" && !term) {
    error = "That search has expired. Search again.";
  } else if (term && !search && /^[0-9+\s-]{1,15}$/.test(term) && term.replace(/\D/g, "").length < 11) {
    // Part of a phone number while it is still being typed (the list searches as you type): a calm hint, not an error.
    // Only a whole number is searched; a partial one would scan every order's phone.
    hint = "Keep typing: a phone number is found once all 11 digits are in (01XXXXXXXXX). Or search an order number or a name.";
  } else if (term && !search) {
    error = "Search with an order number (ORD-000042 or 42), a mobile number (01XXXXXXXXX) or at least two letters of the customer's name.";
  } else {
    try {
      page = await listOrders(db, { limit: PAGE_SIZE, status, attention, queue, number: number || undefined, search: search ?? undefined, after });
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      error = "Enter an order number such as ORD-000042 or 42.";
    }
  }
  const counts = await counting;
  const now = new Date();
  const last = page.items.at(-1);
  const next = page.hasMore && last ? href({ ...filters, cursor: productCursorCodec.encode(last.key) }) : null;
  const returnTo = href({ ...filters, cursor });
  const filtered = Boolean(status || attention || queue || number || term);
  const searchLabel = number ? formatOrderNumber(Number(number.replace(/\D/g, "")) || 0) : term;
  const rows = page.items.map((o) => ({ o, step: nextStep(o, now), key: randomUUID() }));
  const bulkable = canWrite && rows.some((r) => isBulk(r.step));
  const countOf = (c: (typeof CHIPS)[number]) => (c.attention ? counts.attention : c.queue ? counts.queues[c.queue] : null);

  return (
    <AdminShell
      title="Orders"
      current="orders"
      wide
      notice={noticeFor(query.done)}
      actions={
        <Link href="/admin/orders/new" className="of-btn of-btn-primary" aria-label="New assisted order">
          <Plus aria-hidden="true" size={18} strokeWidth={2} />
          <span className="lg:hidden">New</span>
          <span className="hidden lg:inline">New assisted order</span>
        </Link>
      }
    >
      <div className="space-y-3">
        <div role="search" aria-label="Find orders">
          <OrderFilters
            key={`${searchLabel}|${status ?? ""}|${queue ?? ""}|${attention}`}
            term={searchLabel}
            status={status ?? ""}
            queue={queue}
            attention={attention}
            statuses={STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))}
          />
        </div>
        <ScrollArea label="Order queues" fade className="-mx-4 lg:mx-0">
          {/* A swipeable row on a phone; on a desktop every queue is in view (the chips wrap rather than slide out of sight). */}
          <nav aria-label="Order queues" className="px-4 pb-1 lg:px-0">
            <ul className="flex gap-2 lg:flex-wrap">
              {CHIPS.map((c) => {
                const active = c.attention ? attention && !queue : c.queue ? queue === c.queue : !attention && !queue;
                const n = countOf(c);
                return (
                  <li key={c.label} className="shrink-0">
                    <Link href={href({ attention: c.attention, queue: c.queue })} aria-current={active ? "page" : undefined} className="of-chip">
                      {c.label}
                      {n !== null ? (
                        <span className="of-count" aria-label={`, ${n} order${n === 1 ? "" : "s"}`}>
                          {n}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </ScrollArea>
        {queue || term || number || status ? (
          <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
            {queue ? (
              <span>
                Queue: <strong>{QUEUE_TITLES[queue]}</strong>
              </span>
            ) : null}
            {status ? (
              <span>
                Status: <strong>{STATUS_LABELS[status]}</strong>
              </span>
            ) : null}
            {term || number ? (
              <span>
                Searching for <strong>{searchLabel}</strong>
              </span>
            ) : null}
            {term ? (
              <form action={clearOrderSearchAction}>
                <button type="submit" className="of-btn of-btn-line of-btn-sm">
                  <X aria-hidden="true" size={16} />
                  Clear search
                </button>
              </form>
            ) : (
              <Link href="/admin/orders" className="of-btn of-btn-line of-btn-sm">
                <X aria-hidden="true" size={16} />
                Clear
              </Link>
            )}
          </div>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
          {error}
        </p>
      ) : hint ? (
        <p role="status" className="rounded-xl bg-gray-100 px-4 py-3 text-sm text-gray-800" data-testid="search-hint">
          {hint}
        </p>
      ) : page.items.length === 0 ? (
        <div role="status" className="of-card px-5 py-10 text-center">
          <p className="font-semibold">{filtered ? "No orders match" : "No orders yet"}</p>
          <p className="mt-1 text-sm text-gray-600">
            {filtered ? (
              <>
                Try another search or <Link href="/admin/orders" className="underline">show all orders</Link>.
              </>
            ) : (
              <>
                Orders from the shop appear here. <Link href="/admin/orders/new" className="underline">Create an assisted order</Link> for Messenger or WhatsApp.
              </>
            )}
          </p>
        </div>
      ) : (
        <>
          <div className="of-card hidden overflow-hidden lg:block">
            <ScrollArea label="Orders table" hint="Scroll sideways for more columns. The action stays in view.">
              <table className="of-table" aria-label="Orders">
                <thead>
                  <tr>
                    {bulkable ? (
                      <th scope="col" className="w-10">
                        <input type="checkbox" className="of-check" data-select-all aria-label="Select every order on this page that can take a step" />
                      </th>
                    ) : null}
                    <th scope="col">Order</th>
                    <th scope="col">Customer</th>
                    <th scope="col" className="num">
                      Total
                    </th>
                    <th scope="col">Status</th>
                    <th scope="col" className="of-sticky-end">
                      <span className="sr-only">Next step</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ o, step, key }) => (
                    <tr key={o.id} data-order={o.id}>
                      {bulkable ? (
                        <td>
                          {isBulk(step) ? (
                            <input
                              type="checkbox"
                              className="of-check"
                              form="orders-bulk"
                              name="order"
                              value={`${o.id}:${o.version}`}
                              data-step={step.kind === "action" ? step.action : ""}
                              aria-label={`Select ${formatOrderNumber(o.number)}: ${step.label}`}
                            />
                          ) : null}
                        </td>
                      ) : null}
                      <td>
                        <div className="flex items-center gap-1">
                          <Link prefetch={false} href={`/admin/orders/${o.id}`} className="font-bold whitespace-nowrap underline-offset-4 hover:underline">
                            {formatOrderNumber(o.number)}
                          </Link>
                          <button type="button" data-quickview={o.id} className="of-iconbtn" aria-label={`Quick view ${formatOrderNumber(o.number)}`} title="Quick view">
                            <Eye aria-hidden="true" size={16} />
                          </button>
                        </div>
                        <p className="text-xs whitespace-nowrap text-gray-600 tabular-nums">
                          {label(o.source)} · {day.format(o.createdAt)}, {clock.format(o.createdAt)}
                        </p>
                        <Deadline order={o} now={now} />
                      </td>
                      <td className="max-w-44">
                        <p className="truncate font-medium" title={o.customerName}>
                          {o.customerName}
                        </p>
                        <p className="text-xs whitespace-nowrap text-gray-600 tabular-nums">{phoneText(o.customerPhone)}</p>
                      </td>
                      <td className="num font-semibold">{bdt(o.totalPaisa)}</td>
                      <td>
                        {/* The separate states one under the other (order, fulfilment, payment, return), never merged into one;
                            each says which it is to a screen reader. One column, so the table fits a 1280-pixel laptop. */}
                        <div className="flex flex-col items-start gap-1">
                          <span>
                            <span className="sr-only">Order: </span>
                            <StatusPill value={o.orderStatus} calm />
                          </span>
                          {o.orderStatus === "cancelled" && o.fulfilmentStatus === "unfulfilled" ? null : (
                            <span>
                              <span className="sr-only">Fulfilment: </span>
                              <StatusPill value={o.fulfilmentStatus} calm />
                            </span>
                          )}
                          <span className="empty:hidden">
                            <PaymentCell order={o} hideEmpty labelled />
                          </span>
                          {o.returnStatus !== "none" ? (
                            <span>
                              <span className="sr-only">Return: </span>
                              <StatusPill value={o.returnStatus} />
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="of-sticky-end">
                        <div className="flex justify-end">
                          <QuickAction order={o} step={step} returnTo={returnTo} idempotencyKey={key} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollArea>
          </div>
          <ul aria-label="Orders" className="of-card divide-y divide-gray-200 overflow-hidden lg:hidden">
            {rows.map(({ o, step, key }) => (
              <li key={o.id} className="space-y-2 px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="flex items-center gap-1">
                    <Link prefetch={false} href={`/admin/orders/${o.id}`} className="inline-flex min-h-11 items-center font-bold underline-offset-4 hover:underline">
                      {formatOrderNumber(o.number)}
                    </Link>
                    <button type="button" data-quickview={o.id} className="of-iconbtn" aria-label={`Quick view ${formatOrderNumber(o.number)}`}>
                      <Eye aria-hidden="true" size={18} />
                    </button>
                  </span>
                  <span className="font-bold tabular-nums">{bdt(o.totalPaisa)}</span>
                </div>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">
                    <span className="font-medium">{o.customerName}</span>
                    <span className="text-gray-600 tabular-nums"> · {phoneText(o.customerPhone)}</span>
                  </span>
                  <span className="shrink-0 text-gray-600 tabular-nums">
                    {day.format(o.createdAt)}, {clock.format(o.createdAt)}
                  </span>
                </div>
                <div className="flex items-end justify-between gap-3">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {/* Packed, dispatched or delivered already says it was confirmed: one pill fewer on a small card. */}
                      {o.orderStatus === "confirmed" && o.fulfilmentStatus !== "unfulfilled" ? null : <StatusPill value={o.orderStatus} calm="hide" />}
                      <StatusPill value={o.fulfilmentStatus} calm="hide" />
                      <PaymentCell order={o} hideEmpty />
                      {o.returnStatus !== "none" ? <StatusPill value={o.returnStatus} /> : null}
                    </div>
                    <Deadline order={o} now={now} />
                  </div>
                  <div className="shrink-0">
                    <QuickAction order={o} step={step} returnTo={returnTo} idempotencyKey={key} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <OrderQuickView />
        </>
      )}
      {/* Outside the list, so its result stays on screen when the step empties the list (all of "To pack" packed). */}
      {canWrite ? <BulkBar batch={randomUUID()} /> : null}
      {next || after ? (
        <nav aria-label="Pages" className="flex items-center gap-2 text-sm">
          {after ? (
            <Link href={href(filters)} className="of-btn of-btn-line of-btn-sm">
              First page
            </Link>
          ) : null}
          {next ? (
            <Link href={next} className="of-btn of-btn-line of-btn-sm">
              Next page
            </Link>
          ) : null}
          <span className="text-gray-600">{page.items.length} orders on this page</span>
        </nav>
      ) : null}
    </AdminShell>
  );
}
