import Link from "next/link";
import { productCursorCodec } from "@/api/v1/schemas";
import { getDb } from "@/db/client";
import { DomainError } from "@/modules/domain-error";
import { listOrders } from "@/modules/orders/queries";
import { formatOrderNumber, type OrderStatus, verificationOverdue } from "@/modules/orders/rules";
import { OfficeShell, formatTime } from "../_components/shell";
import { requireOffice } from "../_lib/session";
import { bdt, Dimensions, relative } from "./_components/labels";

export const metadata = { title: "Orders · Owner Office" };

const STATUSES: OrderStatus[] = ["pending_verification", "verification_expired", "confirmed", "cancelled", "closed"];
const STATUS_LABELS: Record<OrderStatus, string> = {
  pending_verification: "Pending verification",
  verification_expired: "Verification expired",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
  closed: "Closed",
};
const PAGE_SIZE = 25;
const FIELD = "mt-1 block w-full rounded border border-gray-400 bg-white px-3 py-2 text-base focus:border-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900";

const href = (params: Record<string, string | undefined>) => {
  const query = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => Boolean(e[1])));
  return query.size ? `/office/orders?${query}` : "/office/orders";
};

// Orders newest first. Filters live in the URL; only the order number is searchable, so no phone number or
// name ever appears in a URL.
export default async function OrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOffice("orders:read");
  const query = await searchParams;
  const status = STATUSES.find((s) => s === query.status);
  const attention = query.attention === "true";
  const number = typeof query.number === "string" ? query.number.trim() : "";
  const after = typeof query.cursor === "string" ? (productCursorCodec.decode(query.cursor) ?? undefined) : undefined;
  let error: string | undefined;
  let page: Awaited<ReturnType<typeof listOrders>> = { items: [], hasMore: false };
  try {
    page = await listOrders(getDb(), { limit: PAGE_SIZE, status, attention, number: number || undefined, after });
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
    error = "Enter an order number such as ORD-000042 or 42.";
  }
  const now = new Date();
  const last = page.items.at(-1);
  const next = page.hasMore && last ? href({ status, attention: attention ? "true" : undefined, number: number || undefined, cursor: productCursorCodec.encode(last.key) }) : null;

  return (
    <OfficeShell title="Orders" current="orders">
      <div className="flex flex-wrap gap-3">
        <Link href="/office/orders/new" className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2">
          New assisted order
        </Link>
        <Link href={href({ attention: "true" })} className="rounded border border-gray-400 bg-white px-4 py-2 text-sm hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900">
          Needs attention
        </Link>
      </div>
      <div role="search" aria-label="Find orders">
        <form method="get" action="/office/orders" className="flex flex-col gap-3 rounded border border-gray-300 bg-white p-4 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label htmlFor="order-number" className="block text-sm font-medium">
              Order number
            </label>
            <input id="order-number" name="number" defaultValue={number} maxLength={20} inputMode="text" className={FIELD} aria-describedby="order-number-hint" />
            <p id="order-number-hint" className="mt-1 text-xs text-gray-600">
              For example ORD-000042 or 42. Names and phone numbers are not searchable.
            </p>
          </div>
          <div>
            <label htmlFor="order-status" className="block text-sm font-medium">
              Order status
            </label>
            <select id="order-status" name="status" defaultValue={status ?? ""} className={FIELD}>
              <option value="">All</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2 sm:pb-[1.375rem]">
            <button type="submit" className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2">
              Show
            </button>
            {status || number || attention ? (
              <Link href="/office/orders" className="rounded border border-gray-400 bg-white px-4 py-2 text-sm hover:bg-gray-100">
                Clear
              </Link>
            ) : null}
          </div>
        </form>
      </div>

      {error ? (
        <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : page.items.length === 0 ? (
        <p role="status" className="text-sm text-gray-700">
          {status || number || attention ? "No orders match." : "No orders yet."} <Link href="/office/orders/new" className="underline">Create an assisted order</Link>.
        </p>
      ) : (
        <ul aria-label="Orders" className="divide-y divide-gray-200 rounded border border-gray-300 bg-white">
          {page.items.map((o) => (
            <li key={o.id} className="space-y-2 px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Link href={`/office/orders/${o.id}`} className="font-medium underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900">
                  {formatOrderNumber(o.number)}
                </Link>
                <span className="text-sm tabular-nums">{bdt(o.totalPaisa)}</span>
              </div>
              <p className="text-xs text-gray-600">
                {o.customerName} · {formatTime(o.createdAt)}
                {verificationOverdue(o, now) ? (
                  <strong className="ml-2 text-red-800">Verification deadline passed</strong>
                ) : o.orderStatus === "pending_verification" ? (
                  <span className="ml-2">Verify {relative(o.verificationExpiresAt, now)}</span>
                ) : null}
              </p>
              <Dimensions order={o} />
            </li>
          ))}
        </ul>
      )}
      {next || after ? (
        <nav aria-label="Pages" className="flex gap-4 text-sm">
          {after ? (
            <Link href={href({ status, attention: attention ? "true" : undefined, number: number || undefined })} className="underline">
              First page
            </Link>
          ) : null}
          {next ? (
            <Link href={next} className="underline">
              Next page
            </Link>
          ) : null}
        </nav>
      ) : null}
    </OfficeShell>
  );
}
