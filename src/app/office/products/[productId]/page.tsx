import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { getProductWithVariants } from "@/modules/catalogue/service";
import { DomainError } from "@/modules/domain-error";
import { getStockLevel } from "@/modules/inventory/service";
import { formatPaisa } from "@/modules/money";
import { archiveProductAction, createVariantAction, deactivateVariantAction } from "../../actions";
import { ActionForm, Field } from "../../_components/action-form";
import { OfficeShell, Section, formatTime, noticeFor, productTitle } from "../../_components/shell";
import { requireOffice } from "../../_lib/session";

export const metadata = { title: "Product · Owner Office" };

type Props = { params: Promise<{ productId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const BUTTON_LINK =
  "inline-block rounded border border-gray-400 bg-white px-3 py-1 text-sm hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900";

export default async function ProductPage({ params, searchParams }: Props) {
  await requireOffice("catalog:read", "stock:read");
  const { productId } = await params;
  const db = getDb();
  const product = await getProductWithVariants(db, productId).catch((error: unknown) => {
    if (error instanceof DomainError && (error.code === "PRODUCT_NOT_FOUND" || error.code === "INVALID_INPUT")) notFound();
    throw error;
  });
  const stock = await Promise.all(product.variants.map((v) => getStockLevel(db, v.sku)));
  const { done } = await searchParams;
  const draft = product.status === "draft";
  const { title, lang } = productTitle(product);

  return (
    <OfficeShell title={title} titleLang={lang} notice={noticeFor(done)} breadcrumbs={[{ href: "/office", label: "Products" }]}>
      <Section title="Details">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-gray-600">Status</dt>
          <dd>{draft ? "draft (not shown to customers)" : "archived (cannot be edited)"}</dd>
          <dt className="text-gray-600">Slug</dt>
          <dd className="break-all">{product.slug}</dd>
          <dt className="text-gray-600">Name (English)</dt>
          <dd>{product.nameEn ?? "—"}</dd>
          <dt className="text-gray-600">Name (Bangla)</dt>
          <dd lang="bn">{product.nameBn ?? "—"}</dd>
          <dt className="text-gray-600">Description (English)</dt>
          <dd className="whitespace-pre-line">{product.descriptionEn ?? "—"}</dd>
          <dt className="text-gray-600">Description (Bangla)</dt>
          <dd lang="bn" className="whitespace-pre-line">{product.descriptionBn ?? "—"}</dd>
          <dt className="text-gray-600">Created</dt>
          <dd>{formatTime(product.createdAt)}</dd>
          <dt className="text-gray-600">Last changed</dt>
          <dd>{formatTime(product.updatedAt)}</dd>
        </dl>
        {draft ? (
          <Link href={`/office/products/${product.id}/edit`} className={BUTTON_LINK}>
            Edit details
          </Link>
        ) : null}
      </Section>

      <Section title="Variants and stock">
        {product.variants.length === 0 ? (
          <p className="text-sm text-gray-700">No variants yet. Add one below; each variant is a SKU with its own price and stock.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-300 text-gray-600">
                <tr>
                  <th scope="col" className="py-2 pr-3">SKU</th>
                  <th scope="col" className="py-2 pr-3">Size</th>
                  <th scope="col" className="py-2 pr-3">Colour</th>
                  <th scope="col" className="py-2 pr-3 text-right">Price (BDT)</th>
                  <th scope="col" className="py-2 pr-3 text-right">On hand</th>
                  <th scope="col" className="py-2 pr-3">Status</th>
                  <th scope="col" className="py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {product.variants.map((v, i) => (
                  <tr key={v.id}>
                    <th scope="row" className="py-2 pr-3 font-normal">
                      <Link href={`/office/skus/${encodeURIComponent(v.sku)}`} className="font-medium underline">
                        {v.sku}
                      </Link>
                    </th>
                    <td className="py-2 pr-3">{v.size ?? "—"}</td>
                    <td className="py-2 pr-3">{v.colour ?? "—"}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">৳ {formatPaisa(v.pricePaisa)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{stock[i].onHand}</td>
                    <td className="py-2 pr-3">{v.status}</td>
                    <td className="py-2">
                      {v.status === "active" ? (
                        <div className="flex flex-wrap items-start gap-2">
                          {draft ? (
                            <Link href={`/office/variants/${v.id}/edit`} className={BUTTON_LINK} aria-label={`Edit ${v.sku}`}>
                              Edit
                            </Link>
                          ) : null}
                          <ActionForm
                            action={deactivateVariantAction}
                            idempotencyKey={randomUUID()}
                            hidden={{ variantId: v.id }}
                            submitLabel="Deactivate"
                            variant="secondary"
                            confirm={`Deactivate ${v.sku}? It keeps its stock and history, but there is no way to reactivate it here.`}
                          />
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Add a variant">
        <ActionForm action={createVariantAction} idempotencyKey={randomUUID()} hidden={{ productId: product.id }} submitLabel="Add variant">
          <Field name="sku" label="SKU" required maxLength={64} hint="Letters A-Z, digits, hyphen and underscore; stored in capitals; must be unique. Cannot be changed later." />
          <Field name="size" label="Size" maxLength={64} />
          <Field name="colour" label="Colour" maxLength={64} />
          <Field name="priceTaka" label="Price (BDT)" required inputMode="decimal" hint="In Taka, for example 850 or 850.50. Stored exactly in paisa." />
        </ActionForm>
      </Section>

      {draft ? (
        <Section title="Archive">
          <p className="text-sm text-gray-700">
            Archiving keeps the product, its variants and their stock history. Nothing is deleted, but an archived product can no longer be edited and there is no way to
            undo archiving here.
          </p>
          <ActionForm
            action={archiveProductAction}
            idempotencyKey={randomUUID()}
            hidden={{ productId: product.id }}
            submitLabel="Archive product"
            variant="secondary"
            confirm="Archive this product? It can no longer be edited afterwards, and archiving cannot be undone here."
          />
        </Section>
      ) : null}
    </OfficeShell>
  );
}
