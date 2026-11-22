import type { Order } from "@/modules/orders/internal";
import { formatTaka } from "@/modules/storefront/i18n";

// Plain labels for the four order dimensions, shown side by side and never merged into one status.

const LABEL: Record<string, string> = {
  pending_verification: "Pending verification",
  verification_expired: "Verification expired — Owner review",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
  closed: "Closed",
  unfulfilled: "Not packed",
  packed: "Packed",
  dispatched: "Dispatched",
  delivered: "Delivered",
  rto: "Returning to sender (RTO)",
  rto_received: "RTO received",
  unpaid: "Nothing received",
  partially_collected: "Partly paid",
  collected: "Collected, not fully settled",
  settled: "Settled",
  none: "No return",
  requested: "Return requested",
  in_progress: "Return in progress",
  resolved: "Return resolved",
  messenger: "Messenger",
  whatsapp: "WhatsApp",
  other: "Other",
  website: "Website",
};
export const label = (value: string) => LABEL[value] ?? value.replace(/_/g, " ");

// Order history in plain language (the order page and the quick view); an event not listed is shown as stored, never hidden.
const EVENTS: Record<string, string> = {
  submitted: "Order placed",
  confirmed: "Confirmed (verified with the customer)",
  packed: "Packed",
  dispatched: "Dispatched (stock deducted)",
  delivered: "Delivery recorded",
  closed: "Closed",
  cancelled_by_owner: "Cancelled by you (reserved stock released)",
  cancelled_by_customer: "Cancelled by the customer (reserved stock released)",
  cancelled_on_request: "Cancelled on the customer's request (reserved stock released)",
  verification_expired: "24-hour verification window passed (reserved stock released)",
  cancellation_requested: "Customer asked to cancel",
  cancellation_request_approved: "Cancellation request approved",
  cancellation_request_rejected: "Cancellation request rejected",
  cod_collected: "COD collected by the courier",
  cod_settled: "COD settled to you",
  cod_deducted: "Courier deduction recorded",
  rto_marked: "Marked returned to sender (RTO)",
  rto_received: "Returned parcel received for inspection",
  rto_charge_recorded: "RTO charge recorded",
  return_requested: "Return or exchange requested",
  return_received: "Returned goods received",
  return_approved: "Return request approved",
  return_rejected: "Return request rejected",
  return_completed: "Return completed",
  refund_recorded: "Refund recorded",
  inspection_restocked: "Inspection passed: back in stock",
  inspection_rejected: "Inspection failed: kept out of stock",
  tracking_link_created: "Tracking link created",
  tracking_link_revoked: "Tracking link revoked",
  advance_reference_submitted: "Customer sent a payment transaction ID (not verified)",
  advance_verified: "Advance payment verified as received",
  advance_reference_rejected: "Payment transaction ID rejected",
  advance_reversed: "Advance payment verification undone",
  advance_refunded: "Advance refund recorded",
};
export const eventLabel = (event: string) => EVENTS[event] ?? event.replace(/_/g, " ");

// The tone of a status pill (First Light): waiting on someone (amber), done (green), moving (blue), off the normal path (red),
// or quiet. The word always says the state; the colour only groups it.
const TONE: Record<string, "wait" | "ok" | "move" | "bad" | "quiet"> = {
  pending_verification: "wait",
  verification_expired: "bad",
  confirmed: "ok",
  cancelled: "bad",
  closed: "quiet",
  unfulfilled: "quiet",
  packed: "move",
  dispatched: "move",
  delivered: "ok",
  rto: "bad",
  rto_received: "bad",
  unpaid: "quiet",
  partially_collected: "wait",
  collected: "wait",
  settled: "ok",
  none: "quiet",
  requested: "wait",
  in_progress: "wait",
  resolved: "ok",
};
export const tone = (value: string) => TONE[value] ?? "quiet";

/** A status as a word in a toned pill. `calm` shows a neutral state as plain grey text, so only states that need a look stand out. */
export function StatusPill({ value, testId, calm = false }: { value: string; testId?: string; calm?: boolean | "hide" }) {
  if (calm === "hide" && tone(value) === "quiet") return null;
  if (calm && tone(value) === "quiet") return <span className="text-sm text-gray-600" data-testid={testId}>{label(value)}</span>;
  return (
    <span className="of-pill" data-tone={tone(value)} data-testid={testId}>
      {label(value)}
    </span>
  );
}

/** Admin money: "৳ 12,810" for whole taka, "৳ 12,810.50" otherwise (the same rule as the shop, English digits). */
export const bdt = (paisa: number) => formatTaka(paisa, "en");

/** "in 3 h 20 min" / "4 h 5 min ago", from the server's clock at render time. */
export function relative(target: Date, now: Date): string {
  const minutes = Math.round((target.getTime() - now.getTime()) / 60_000);
  const abs = Math.abs(minutes);
  const text = abs >= 60 ? `${Math.floor(abs / 60)} h ${abs % 60} min` : `${abs} min`;
  return minutes >= 0 ? `in ${text}` : `${text} ago`;
}

/** "2 h 5 min" / "35 min" between a passed deadline and now. */
export function overdueBy(deadline: Date, now: Date): string {
  const minutes = Math.max(1, Math.round((now.getTime() - deadline.getTime()) / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

export function Dimensions({ order, compact = false }: { order: Pick<Order, "orderStatus" | "fulfilmentStatus" | "paymentStatus" | "returnStatus">; compact?: boolean }) {
  const items: [string, string][] = [
    ["Order", order.orderStatus],
    ["Fulfilment", order.fulfilmentStatus],
    ["Payment", order.paymentStatus],
    ["Return", order.returnStatus],
  ];
  if (compact) {
    // In a list: four pills in a row, each still named for screen readers.
    return (
      <dl className="flex flex-wrap gap-1.5">
        {items.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="sr-only">{name}</dt>
            <dd className="of-pill" data-tone={tone(value)} title={name}>
              {label(value)}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
      {items.map(([name, value]) => (
        <div key={name} className="space-y-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2.5">
          <dt className="text-xs font-semibold text-gray-600">{name}</dt>
          <dd className="of-pill whitespace-normal" data-tone={tone(value)} data-dimension={name.toLowerCase()}>
            {label(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
