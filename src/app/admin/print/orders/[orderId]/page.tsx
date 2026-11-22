import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { DomainError } from "@/modules/domain-error";
import { getOrderDetail } from "@/modules/orders/queries";
import { formatOrderNumber, ZONE_LABELS } from "@/modules/orders/rules";
import { formatTime } from "../../../_components/shell";
import { requireAdmin } from "../../../_lib/session";
import { bdt, label } from "../../../orders/_components/labels";
import { PrintPage, TABLE } from "../../_components/print-page";

export const metadata = { title: "Order · Admin", robots: { index: false, follow: false } };

// One order's packing and shipping document. It is the only printed document with the customer's name,
// phone and address, because the parcel needs them; it never shows the tracking link, ids of other records
// or internal notes about money.
export default async function OrderPrintPage({ params }: { params: Promise<{ orderId: string }> }) {
  await requireAdmin("orders:read");
  const { orderId } = await params;
  const order = await getOrderDetail(getDb(), orderId).catch((error: unknown) => {
    if (error instanceof DomainError && (error.code === "ORDER_NOT_FOUND" || error.code === "INVALID_INPUT")) notFound();
    throw error;
  });
  // The courier collects only what is still due: the total less COD already collected and advance money verified.
  const toCollect = order.totalPaisa - order.codCollectedPaisa - order.advanceReceivedPaisa;
  return (
    <PrintPage
      title={`Order ${formatOrderNumber(order.number)}`}
      scope={`Placed ${formatTime(order.createdAt)} · source ${label(order.source)} · ${label(order.orderStatus)}, ${label(order.fulfilmentStatus)}, ${label(order.paymentStatus)}`}
      generatedAt={new Date()}
      back={{ href: `/admin/orders/${order.id}`, label: "Back to the order" }}
    >
      <section className="print-avoid-break space-y-1" aria-label="Deliver to">
        <h2 className="font-semibold">Deliver to</h2>
        <p data-testid="ship-name">{order.customerName}</p>
        <p data-testid="ship-phone">{order.customerPhone}</p>
        <p className="whitespace-pre-line">{order.deliveryAddress}</p>
        <p>Zone: {ZONE_LABELS[order.deliveryZone]}</p>
      </section>
      <table className={TABLE}>
        <thead>
          <tr>
            <th scope="col">SKU</th>
            <th scope="col">Product</th>
            <th scope="col">Size, colour</th>
            <th scope="col" className="text-right">
              Units
            </th>
            <th scope="col" className="text-right">
              Unit price
            </th>
            <th scope="col" className="text-right">
              Line total
            </th>
          </tr>
        </thead>
        <tbody>
          {order.items.map((i) => (
            <tr key={i.id}>
              <td className="font-mono">{i.sku}</td>
              <td>
                {i.productNameEn}
                {i.productNameBn ? <span lang="bn"> {i.productNameBn}</span> : null}
              </td>
              <td>{[i.size, i.colour].filter(Boolean).join(", ") || "—"}</td>
              <td className="text-right tabular-nums">{i.quantity}</td>
              <td className="text-right tabular-nums">{bdt(i.unitPricePaisa)}</td>
              <td className="text-right tabular-nums">{bdt(i.lineTotalPaisa)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={5}>Subtotal</td>
            <td className="text-right tabular-nums">{bdt(order.subtotalPaisa)}</td>
          </tr>
          <tr>
            <td colSpan={5}>Delivery charge</td>
            <td className="text-right tabular-nums">{bdt(order.deliveryChargePaisa)}</td>
          </tr>
          <tr>
            <td colSpan={5} className="font-semibold">
              {order.paymentMethod === "cod" ? "Total (cash on delivery)" : "Total"}
            </td>
            <td className="text-right font-semibold tabular-nums">{bdt(order.totalPaisa)}</td>
          </tr>
          {order.advanceReceivedPaisa > 0 ? (
            <tr>
              <td colSpan={5}>Paid in advance (verified)</td>
              <td className="text-right tabular-nums">{bdt(order.advanceReceivedPaisa)}</td>
            </tr>
          ) : null}
          {order.codCollectedPaisa > 0 || order.paymentMethod !== "cod" ? (
            <tr>
              <td colSpan={5} className="font-semibold">
                Cash to collect on delivery
              </td>
              <td className="text-right font-semibold tabular-nums" data-testid="print-to-collect">
                {bdt(toCollect)}
              </td>
            </tr>
          ) : null}
        </tfoot>
      </table>
    </PrintPage>
  );
}
