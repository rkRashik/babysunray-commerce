import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { getProductWithVariants, getVariant } from "@/modules/catalogue/service";
import { DomainError } from "@/modules/domain-error";
import { getStockLevel } from "@/modules/inventory/service";
import { formatPaisa } from "@/modules/money";
import { updateVariantAction } from "../../../actions";
import { ActionForm, Field } from "../../../_components/action-form";
import { AdminShell, Section, productTitle } from "../../../_components/shell";
import { requireAdmin } from "../../../_lib/session";

export const metadata = { title: "Edit variant · Admin" };

// Edits an active variant's size, colour and price. SKU and stock are shown but never changed here.
export default async function EditVariantPage({ params }: { params: Promise<{ variantId: string }> }) {
  await requireAdmin("catalog:read", "catalog:write", "stock:read");
  const { variantId } = await params;
  const db = getDb();
  const variant = await getVariant(db, variantId).catch((error: unknown) => {
    if (error instanceof DomainError && (error.code === "VARIANT_NOT_FOUND" || error.code === "INVALID_INPUT")) notFound();
    throw error;
  });
  const [product, level] = await Promise.all([getProductWithVariants(db, variant.productId), getStockLevel(db, variant.sku)]);
  const { title, lang } = productTitle(product);
  const back = `/admin/products/${product.id}`;
  const crumbs = [
    { href: "/admin", label: "Products" },
    { href: back, label: title, lang },
  ];
  const editable = product.status === "draft" && variant.status === "active";

  return (
    <AdminShell title={`Edit ${variant.sku}`} breadcrumbs={crumbs}>
      <Section title="Variant">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-gray-600">SKU</dt>
          <dd>{variant.sku} (cannot be changed)</dd>
          <dt className="text-gray-600">On hand</dt>
          <dd>
            {level.onHand} units (not changed by this form;{" "}
            <Link href={`/admin/skus/${encodeURIComponent(variant.sku)}`} className="underline">
              receive or adjust stock
            </Link>
            )
          </dd>
        </dl>
        {editable ? (
          <ActionForm action={updateVariantAction} idempotencyKey={randomUUID()} hidden={{ variantId: variant.id, version: String(variant.version) }} submitLabel="Save changes">
            <Field name="size" label="Size" maxLength={64} defaultValue={variant.size ?? ""} hint="Empty to remove." />
            <Field name="colour" label="Colour" maxLength={64} defaultValue={variant.colour ?? ""} hint="Empty to remove." />
            <Field
              name="priceTaka"
              label="Price (BDT)"
              required
              inputMode="decimal"
              defaultValue={formatPaisa(variant.pricePaisa)}
              hint="In Taka, for example 850 or 850.50. Stored exactly in paisa."
            />
          </ActionForm>
        ) : (
          <p role="status" className="text-sm text-gray-700">
            {variant.status !== "active" ? "This variant is inactive" : "Its product is archived"}, so it cannot be edited.
          </p>
        )}
        <Link href={back} className="inline-block text-sm underline">
          {editable ? "Cancel" : "Back to the product"}
        </Link>
      </Section>
    </AdminShell>
  );
}
