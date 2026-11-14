import { randomUUID } from "node:crypto";
import { createProductAction } from "../../actions";
import { ActionForm, Field } from "../../_components/action-form";
import { OfficeShell, Section } from "../../_components/shell";
import { requireOffice } from "../../_lib/session";

export const metadata = { title: "New product · Owner Office" };

export default async function NewProductPage() {
  await requireOffice("catalog:write");
  return (
    <OfficeShell title="New draft product">
      <Section title="Product details">
        <p className="text-sm text-gray-700">A new product is a draft. Drafts are never shown to customers.</p>
        <ActionForm action={createProductAction} idempotencyKey={randomUUID()} submitLabel="Create draft">
          <Field name="slug" label="Slug" required maxLength={100} hint="For the product's web address: lowercase letters, digits and single hyphens, e.g. cotton-romper." />
          <Field name="nameEn" label="Name (English)" maxLength={200} hint="A name in English or Bangla is required." />
          <Field name="nameBn" label="Name (Bangla)" maxLength={200} lang="bn" />
          <Field name="descriptionEn" label="Description (English)" multiline maxLength={5000} />
          <Field name="descriptionBn" label="Description (Bangla)" multiline maxLength={5000} lang="bn" />
        </ActionForm>
      </Section>
    </OfficeShell>
  );
}
