import type { Order } from "@/modules/orders/internal";
import { formatPaisa } from "@/modules/money";

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
  unpaid: "Nothing collected",
  partially_collected: "Partly collected",
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

export const bdt = (paisa: number) => `৳ ${formatPaisa(paisa)}`;

/** "in 3 h 20 min" / "4 h 5 min ago", from the server's clock at render time. */
export function relative(target: Date, now: Date): string {
  const minutes = Math.round((target.getTime() - now.getTime()) / 60_000);
  const abs = Math.abs(minutes);
  const text = abs >= 60 ? `${Math.floor(abs / 60)} h ${abs % 60} min` : `${abs} min`;
  return minutes >= 0 ? `in ${text}` : `${text} ago`;
}

export function Dimensions({ order }: { order: Pick<Order, "orderStatus" | "fulfilmentStatus" | "paymentStatus" | "returnStatus"> }) {
  const items: [string, string][] = [
    ["Order", order.orderStatus],
    ["Fulfilment", order.fulfilmentStatus],
    ["Payment", order.paymentStatus],
    ["Return", order.returnStatus],
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
      {items.map(([name, value]) => (
        <div key={name} className="rounded border border-gray-300 bg-gray-50 px-2 py-1">
          <dt className="text-xs text-gray-600">{name}</dt>
          <dd className="font-medium" data-dimension={name.toLowerCase()}>
            {label(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
