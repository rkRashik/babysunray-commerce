import { getDb } from "@/db/client";
import { formatOrderNumber } from "@/modules/orders/rules";
import { getPickingList, PICKING_LIMIT } from "@/modules/reports/picking";
import { formatTime } from "../../_components/shell";
import { requireAdmin } from "../../_lib/session";
import { PrintPage, TABLE } from "../_components/print-page";

export const metadata = { title: "Picking list · Admin", robots: { index: false, follow: false } };

const variantText = (l: { size: string | null; colour: string | null }) => [l.size, l.colour].filter(Boolean).join(", ") || "—";

// Picking list (units per SKU) and packing summary (items per order) for confirmed orders not packed yet.
// Routine document: no customer contact details.
export default async function PickingPrintPage() {
  await requireAdmin("orders:read");
  const list = await getPickingList(getDb());
  return (
    <PrintPage
      title="Picking list and packing summary"
      scope={`Confirmed orders not packed yet: ${list.orders.length}${list.truncated ? ` (the oldest ${PICKING_LIMIT}; more are waiting)` : ""}.`}
      generatedAt={list.generatedAt}
      back={{ href: "/admin/dashboard", label: "Back to the dashboard" }}
    >
      {list.orders.length === 0 ? (
        <p>No confirmed order is waiting to be packed.</p>
      ) : (
        <>
          <section className="space-y-2">
            <h2 className="font-semibold">Picking list</h2>
            <table className={TABLE} data-testid="pick-table">
              <thead>
                <tr>
                  <th scope="col">SKU</th>
                  <th scope="col">Product</th>
                  <th scope="col">Size, colour</th>
                  <th scope="col" className="text-right">
                    Units
                  </th>
                  <th scope="col" className="text-right">
                    Orders
                  </th>
                  <th scope="col">Picked</th>
                </tr>
              </thead>
              <tbody>
                {list.skus.map((s) => (
                  <tr key={s.sku}>
                    <td className="font-mono">{s.sku}</td>
                    <td>
                      {s.nameEn}
                      {s.nameBn ? <span lang="bn"> {s.nameBn}</span> : null}
                    </td>
                    <td>{variantText(s)}</td>
                    <td className="text-right tabular-nums">{s.quantity}</td>
                    <td className="text-right tabular-nums">{s.orders}</td>
                    <td className="w-16"> </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="space-y-3">
            <h2 className="font-semibold">Packing summary</h2>
            {list.orders.map((o) => (
              <div key={o.id} className="print-avoid-break space-y-1" data-testid="pack-order">
                <h3 className="text-sm font-semibold">
                  {formatOrderNumber(o.number)} <span className="font-normal">· placed {formatTime(o.createdAt)}</span>
                </h3>
                <table className={TABLE}>
                  <thead>
                    <tr>
                      <th scope="col">SKU</th>
                      <th scope="col">Product</th>
                      <th scope="col">Size, colour</th>
                      <th scope="col" className="text-right">
                        Units
                      </th>
                      <th scope="col">Packed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.items.map((i) => (
                      <tr key={i.sku}>
                        <td className="font-mono">{i.sku}</td>
                        <td>
                          {i.nameEn}
                          {i.nameBn ? <span lang="bn"> {i.nameBn}</span> : null}
                        </td>
                        <td>{variantText(i)}</td>
                        <td className="text-right tabular-nums">{i.quantity}</td>
                        <td className="w-16"> </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </section>
        </>
      )}
    </PrintPage>
  );
}
