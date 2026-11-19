import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { formatCentimetres, MEASUREMENT_POINTS } from "@/modules/catalogue/content";
import { getProductWithVariants } from "@/modules/catalogue/service";
import { DomainError } from "@/modules/domain-error";
import { ActionForm, CellInput } from "../../../_components/action-form";
import { AdminShell, Section, productTitle } from "../../../_components/shell";
import { replaceMeasurementsAction } from "../../../content-actions";
import { MEASUREMENT_LABELS } from "../../../_lib/labels";
import { requireAdmin } from "../../../_lib/session";

export const metadata = { title: "Size chart · Admin" };

// The size chart: one row per size on the product's active SKUs (and any size already measured), one column per
// measuring point, in centimetres with at most one decimal. Saving replaces the whole chart; an empty cell has no
// value. Stored exactly as whole millimetres.
export default async function MeasurementsPage({ params }: { params: Promise<{ productId: string }> }) {
  await requireAdmin("catalog:read", "catalog:write");
  const { productId } = await params;
  const product = await getProductWithVariants(getDb(), productId).catch((error: unknown) => {
    if (error instanceof DomainError && (error.code === "PRODUCT_NOT_FOUND" || error.code === "INVALID_INPUT")) notFound();
    throw error;
  });
  const { title, lang } = productTitle(product);
  const back = `/admin/products/${product.id}`;
  const crumbs = [
    { href: "/admin", label: "Products" },
    { href: back, label: title, lang },
  ];
  const sizes = [...new Set([...product.variants.filter((v) => v.status === "active" && v.size).map((v) => v.size as string), ...product.measurements.map((m) => m.size)])];
  const value = (size: string, point: string) => {
    const m = product.measurements.find((x) => x.size === size && x.point === point);
    return m ? formatCentimetres(m.valueMm) : "";
  };

  return (
    <AdminShell title="Size chart" breadcrumbs={crumbs}>
      <Section title="Measurements in centimetres">
        {product.status !== "draft" ? (
          <p className="text-sm text-gray-700">This product is archived, so its size chart cannot be changed.</p>
        ) : sizes.length === 0 ? (
          <p className="text-sm text-gray-700">
            No active SKU has a size yet. Give each variant a size first (<Link href={back} className="underline">back to the product</Link>).
          </p>
        ) : (
          <ActionForm
            action={replaceMeasurementsAction}
            idempotencyKey={randomUUID()}
            hidden={{ productId: product.id, version: String(product.version), rows: String(sizes.length), ...Object.fromEntries(sizes.map((s, i) => [`size${i}`, s])) }}
            submitLabel="Save size chart"
          >
            <p className="text-sm text-gray-700">
              Centimetres, for example 42 or 42.5. Leave a cell empty when a measurement does not apply. Measure the same way for every size and say how in the size guidance.
            </p>
            <div className="overflow-x-auto">
              <table className="text-left text-sm">
                <thead className="text-gray-600">
                  <tr>
                    <th scope="col" className="py-2 pr-3">Size</th>
                    {MEASUREMENT_POINTS.map((p) => (
                      <th key={p} scope="col" className="py-2 pr-3">{MEASUREMENT_LABELS[p]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sizes.map((size, i) => (
                    <tr key={size}>
                      <th scope="row" className="py-1 pr-3 font-normal">{size}</th>
                      {MEASUREMENT_POINTS.map((p) => (
                        <td key={p} className="py-1 pr-3">
                          <CellInput name={`m${i}${p}`} label={`${MEASUREMENT_LABELS[p]} (cm), size ${size}`} defaultValue={value(size, p)} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </ActionForm>
        )}
        <Link href={back} className="inline-block text-sm underline">
          Back to the product
        </Link>
      </Section>
    </AdminShell>
  );
}
