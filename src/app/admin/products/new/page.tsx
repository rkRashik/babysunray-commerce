import { randomUUID } from "node:crypto";
import { createProductAction } from "../../actions";
import { ActionForm, Field } from "../../_components/action-form";
import { LanguageTabs } from "../../_components/language-tabs";
import { AdminShell, Section } from "../../_components/shell";
import { requireAdmin } from "../../_lib/session";
import { SlugField } from "../_components/slug-field";

export const metadata = { title: "New product · Admin" };

// The name comes first; the web address follows it by itself and is editable under "Web address (advanced)".
export default async function NewProductPage() {
  await requireAdmin("catalog:write");
  return (
    <AdminShell title="New draft product" current="products" breadcrumbs={[{ href: "/admin", label: "Products" }]}>
      <Section title="Product details">
        <p className="text-sm text-gray-700">A new product is a draft. Drafts are never shown to customers. A name in English or Bangla is enough to start; add the rest later.</p>
        <ActionForm action={createProductAction} idempotencyKey={randomUUID()} submitLabel="Create draft">
          <LanguageTabs
            english={
              <>
                <Field name="nameEn" label="Name (English)" maxLength={200} />
                <Field name="descriptionEn" label="Description (English)" multiline maxLength={5000} />
              </>
            }
            bangla={
              <>
                <Field name="nameBn" label="Name (Bangla)" maxLength={200} lang="bn" />
                <Field name="descriptionBn" label="Description (Bangla)" multiline maxLength={5000} lang="bn" />
              </>
            }
          />
          <SlugField />
        </ActionForm>
      </Section>
    </AdminShell>
  );
}
