import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { getProductWithVariants, listCategories } from "@/modules/catalogue/service";
import { DomainError } from "@/modules/domain-error";
import { updateProductAction } from "../../../actions";
import { ActionForm, Checkbox, Field, SelectField } from "../../../_components/action-form";
import { AdminShell, Section, productTitle } from "../../../_components/shell";
import { requireAdmin } from "../../../_lib/session";

export const metadata = { title: "Edit product · Admin" };

// Edits a draft product's content in both languages. The form carries the version it was rendered from, so a
// save after someone else's change is refused instead of silently overwriting it. Nothing is translated or
// generated: an empty language stays empty and the readiness checklist says so.
export default async function EditProductPage({ params }: { params: Promise<{ productId: string }> }) {
  await requireAdmin("catalog:read", "catalog:write");
  const { productId } = await params;
  const db = getDb();
  const product = await getProductWithVariants(db, productId).catch((error: unknown) => {
    if (error instanceof DomainError && (error.code === "PRODUCT_NOT_FOUND" || error.code === "INVALID_INPUT")) notFound();
    throw error;
  });
  const categories = await listCategories(db);
  const { title, lang } = productTitle(product);
  const back = `/admin/products/${product.id}`;
  const crumbs = [
    { href: "/admin", label: "Products" },
    { href: back, label: title, lang },
  ];

  if (product.status !== "draft") {
    return (
      <AdminShell title="Edit details" breadcrumbs={crumbs}>
        <p role="status" className="text-sm text-gray-700">
          This product is {product.status}, so it cannot be edited. <Link href={back} className="underline">Back to the product</Link>.
        </p>
      </AdminShell>
    );
  }

  return (
    <AdminShell title="Edit details" breadcrumbs={crumbs}>
      <Section title="Product details">
        <p className="text-sm text-gray-700">
          Slug: <span className="font-mono">{product.slug}</span> (cannot be changed). Empty a field to remove it; at least one name must remain. Write each language yourself:
          nothing is translated automatically.
        </p>
        <ActionForm action={updateProductAction} idempotencyKey={randomUUID()} hidden={{ productId: product.id, version: String(product.version) }} submitLabel="Save changes">
          <Field name="nameEn" label="Name (English)" maxLength={200} defaultValue={product.nameEn ?? ""} hint="A name in English or Bangla is required." />
          <Field name="nameBn" label="Name (Bangla)" maxLength={200} lang="bn" defaultValue={product.nameBn ?? ""} />
          <Field name="descriptionEn" label="Description (English)" multiline maxLength={5000} defaultValue={product.descriptionEn ?? ""} />
          <Field name="descriptionBn" label="Description (Bangla)" multiline maxLength={5000} lang="bn" defaultValue={product.descriptionBn ?? ""} />
          <SelectField
            name="categoryId"
            label="Category"
            defaultValue={product.categoryId ?? ""}
            options={[{ value: "", label: "No category" }, ...categories.map((c) => ({ value: c.id, label: c.nameEn ?? c.nameBn ?? c.slug, lang: c.nameEn ? undefined : "bn" }))]}
            hint="Categories are created under Categories."
          />
          <Checkbox name="featured" label="Featured (shown first in the storefront preview)" defaultChecked={product.featured} />
          <Field
            name="fabricEn"
            label="Fabric (English)"
            multiline
            maxLength={1000}
            defaultValue={product.fabricEn ?? ""}
            hint="Only what you can show: the care label or the supplier's document. No claims such as organic, hypoallergenic or certified without evidence."
          />
          <Field name="fabricBn" label="Fabric (Bangla)" multiline maxLength={1000} lang="bn" defaultValue={product.fabricBn ?? ""} />
          <Checkbox
            name="fabricConfirmed"
            label="I confirm the fabric statement above is accurate and backed by evidence. Changing the text needs a new confirmation."
            defaultChecked={product.fabricConfirmedAt !== null}
          />
          <Field name="careEn" label="Care instructions (English)" multiline maxLength={1000} defaultValue={product.careEn ?? ""} />
          <Field name="careBn" label="Care instructions (Bangla)" multiline maxLength={1000} lang="bn" defaultValue={product.careBn ?? ""} />
          <Field name="sizeGuidanceEn" label="Size or age guidance, optional (English)" multiline maxLength={1000} defaultValue={product.sizeGuidanceEn ?? ""} />
          <Field name="sizeGuidanceBn" label="Size or age guidance, optional (Bangla)" multiline maxLength={1000} lang="bn" defaultValue={product.sizeGuidanceBn ?? ""} />
        </ActionForm>
        <Link href={back} className="inline-block text-sm underline">
          Cancel
        </Link>
      </Section>
    </AdminShell>
  );
}
