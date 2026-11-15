import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { getProductWithVariants } from "@/modules/catalogue/service";
import { DomainError } from "@/modules/domain-error";
import { updateProductAction } from "../../../actions";
import { ActionForm, Field } from "../../../_components/action-form";
import { OfficeShell, Section, productTitle } from "../../../_components/shell";
import { requireOffice } from "../../../_lib/session";

export const metadata = { title: "Edit product · Owner Office" };

// Edits a draft product's names and descriptions. The form carries the version it was rendered from, so a
// save after someone else's change is refused instead of silently overwriting it.
export default async function EditProductPage({ params }: { params: Promise<{ productId: string }> }) {
  await requireOffice("catalog:read", "catalog:write");
  const { productId } = await params;
  const product = await getProductWithVariants(getDb(), productId).catch((error: unknown) => {
    if (error instanceof DomainError && (error.code === "PRODUCT_NOT_FOUND" || error.code === "INVALID_INPUT")) notFound();
    throw error;
  });
  const { title, lang } = productTitle(product);
  const back = `/office/products/${product.id}`;
  const crumbs = [
    { href: "/office", label: "Products" },
    { href: back, label: title, lang },
  ];

  if (product.status !== "draft") {
    return (
      <OfficeShell title="Edit details" breadcrumbs={crumbs}>
        <p role="status" className="text-sm text-gray-700">
          This product is archived, so it cannot be edited. <Link href={back} className="underline">Back to the product</Link>.
        </p>
      </OfficeShell>
    );
  }

  return (
    <OfficeShell title="Edit details" breadcrumbs={crumbs}>
      <Section title="Product details">
        <p className="text-sm text-gray-700">
          Slug: <span className="font-mono">{product.slug}</span> (cannot be changed). Empty a field to remove it; at least one name must remain.
        </p>
        <ActionForm action={updateProductAction} idempotencyKey={randomUUID()} hidden={{ productId: product.id, version: String(product.version) }} submitLabel="Save changes">
          <Field name="nameEn" label="Name (English)" maxLength={200} defaultValue={product.nameEn ?? ""} hint="A name in English or Bangla is required." />
          <Field name="nameBn" label="Name (Bangla)" maxLength={200} lang="bn" defaultValue={product.nameBn ?? ""} />
          <Field name="descriptionEn" label="Description (English)" multiline maxLength={5000} defaultValue={product.descriptionEn ?? ""} />
          <Field name="descriptionBn" label="Description (Bangla)" multiline maxLength={5000} lang="bn" defaultValue={product.descriptionBn ?? ""} />
        </ActionForm>
        <Link href={back} className="inline-block text-sm underline">
          Cancel
        </Link>
      </Section>
    </OfficeShell>
  );
}
