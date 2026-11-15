import { randomUUID } from "node:crypto";
import { getDb } from "@/db/client";
import { listCategories } from "@/modules/catalogue/service";
import { ActionForm, Field } from "../_components/action-form";
import { LanguageStatus } from "../_components/content";
import { noticeFor, OfficeShell, Section } from "../_components/shell";
import { createCategoryAction, updateCategoryAction } from "../content-actions";
import { requireOffice } from "../_lib/session";

export const metadata = { title: "Categories · Owner Office" };

// Owner-defined product categories, named in English and Bangla. None is built in. A category is chosen on a
// product's edit page; the storefront preview filters by it.
export default async function CategoriesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOffice("catalog:read", "catalog:write");
  const { done } = await searchParams;
  const categories = await listCategories(getDb());
  return (
    <OfficeShell title="Categories" current="categories" notice={noticeFor(done)}>
      <Section title="New category">
        <ActionForm action={createCategoryAction} idempotencyKey={randomUUID()} submitLabel="Create category">
          <Field name="slug" label="Slug" required maxLength={100} hint="Lowercase letters a-z, digits and single hyphens, for example baby-sets. Cannot be changed later." />
          <Field name="nameEn" label="Name (English)" maxLength={100} hint="A name in English or Bangla is required." />
          <Field name="nameBn" label="Name (Bangla)" maxLength={100} lang="bn" />
        </ActionForm>
      </Section>
      <Section title={`Categories (${categories.length})`}>
        {categories.length === 0 ? <p className="text-sm text-gray-700">No categories yet.</p> : null}
        <ul className="space-y-4">
          {categories.map((c) => (
            <li key={c.id} className="space-y-2 rounded border border-gray-300 p-3">
              <p className="text-sm">
                <span className="font-mono">{c.slug}</span> · <LanguageStatus en={c.nameEn} bn={c.nameBn} />
              </p>
              <ActionForm action={updateCategoryAction} idempotencyKey={randomUUID()} hidden={{ categoryId: c.id, version: String(c.version) }} submitLabel="Save names" variant="secondary">
                <Field name="nameEn" label={`Name (English) of ${c.slug}`} maxLength={100} defaultValue={c.nameEn ?? ""} />
                <Field name="nameBn" label={`Name (Bangla) of ${c.slug}`} maxLength={100} lang="bn" defaultValue={c.nameBn ?? ""} />
              </ActionForm>
            </li>
          ))}
        </ul>
      </Section>
    </OfficeShell>
  );
}
