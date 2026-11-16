import Link from "next/link";
import { getDb } from "@/db/client";
import { readinessFlags } from "@/modules/catalogue/preparation";
import { type PreparationItem, READINESS_ITEMS } from "@/modules/catalogue/readiness";
import { reviewStates } from "@/modules/catalogue/review";
import { listProducts } from "@/modules/catalogue/service";
import { DomainError } from "@/modules/domain-error";
import { formatTime, OfficeShell, productTitle } from "../_components/shell";
import { requireOffice } from "../_lib/session";

export const metadata = { title: "Product reviews · Owner Office" };

// The internal review queue (Gate H.26): every draft product, what it still lacks, and whether its current content
// has been reviewed. Reviewing happens on the product page, after looking at it; the customer preview shows how it
// would appear. A review never publishes: no publication rule is approved and every product stays a draft.

const PAGE = 50;
const WHERE: Record<PreparationItem, (id: string) => string> = {
  name: (id) => `/office/products/${id}/edit`,
  description: (id) => `/office/products/${id}/edit`,
  fabric: (id) => `/office/products/${id}/edit`,
  care: (id) => `/office/products/${id}/edit`,
  category: (id) => `/office/products/${id}/edit`,
  variant: (id) => `/office/products/${id}`,
  sizes: (id) => `/office/products/${id}`,
  measurements: (id) => `/office/products/${id}/measurements`,
  photo: (id) => `/office/products/${id}/photos`,
  alt: (id) => `/office/products/${id}/photos`,
};
const SHORT: Record<PreparationItem, string> = {
  name: "names",
  description: "descriptions",
  variant: "active SKU",
  measurements: "measurements",
  fabric: "fabric",
  care: "care",
  sizes: "sizes",
  category: "category",
  photo: "photo",
  alt: "photo descriptions",
};

export default async function ProductReviewsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOffice("catalog:read");
  const { after, afterId, q } = await searchParams;
  const term = typeof q === "string" && q.trim() !== "" ? q.trim().slice(0, 100) : undefined;
  const db = getDb();
  const cursor = typeof after === "string" && typeof afterId === "string" && /^[0-9T:.\-Z]{20,40}$/.test(after) && /^[0-9a-f-]{36}$/.test(afterId) ? { createdAt: after, id: afterId } : undefined;
  const page = await listProducts(db, { limit: PAGE, status: "draft", after: cursor, q: term }).catch((error: unknown) => {
    // A search term the catalogue search refuses (control characters): no results instead of an error page.
    if (error instanceof DomainError && error.code === "INVALID_INPUT") return { items: [], hasMore: false };
    throw error;
  });
  const ids = page.items.map((p) => p.id);
  const [flags, states] = [await readinessFlags(db, ids), await reviewStates(db, ids)];
  const last = page.items.at(-1);
  return (
    <OfficeShell title="Product reviews" current="reviews">
      <p className="text-sm text-gray-700">
        Draft products, oldest first, with what each still lacks and its internal review. Open a product to check it and record a review; any later change to its text, claims, sizes, photos, SKUs or prices
        makes the review outdated. Reviewing publishes nothing.
      </p>
      <form method="get" action="/office/product-reviews" role="search" className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="review-q" className="block text-sm font-medium">
            Search by name, slug or SKU
          </label>
          <input id="review-q" type="search" name="q" maxLength={100} defaultValue={term ?? ""} className="mt-1 block rounded border border-gray-400 bg-white px-3 py-2 text-base focus:border-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900" />
        </div>
        <button type="submit" className="rounded border border-gray-400 bg-white px-4 py-2 text-sm font-medium hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900">
          Search
        </button>
      </form>
      {page.items.length === 0 ? (
        <p role="status">{term ? "No draft product matches." : "No draft products."}</p>
      ) : (
        <div className="overflow-x-auto rounded border border-gray-300 bg-white">
          <table className="w-full text-left text-sm" data-testid="review-queue">
            <thead className="border-b border-gray-300 text-gray-600">
              <tr>
                <th scope="col" className="px-3 py-2">Product</th>
                <th scope="col" className="px-3 py-2">Still missing</th>
                <th scope="col" className="px-3 py-2">Review</th>
                <th scope="col" className="px-3 py-2"><span className="sr-only">Links</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {page.items.map((p) => {
                const { title, lang } = productTitle(p);
                const missing = READINESS_ITEMS.filter((i) => flags.get(p.id)?.[i.id] === false);
                const state = states.get(p.id);
                return (
                  <tr key={p.id} data-testid={`review-row-${p.slug}`}>
                    <th scope="row" className="px-3 py-2 font-medium">
                      <Link href={`/office/products/${p.id}`} lang={lang} className="underline underline-offset-2">
                        {title}
                      </Link>
                    </th>
                    <td className="px-3 py-2">
                      {missing.length === 0 ? (
                        "Nothing in the checklist"
                      ) : (
                        <ul className="flex flex-wrap gap-x-2 gap-y-1">
                          {missing.map((i) => (
                            <li key={i.id}>
                              <Link href={WHERE[i.id](p.id)} className={`underline underline-offset-2 ${i.basis === "approved" ? "font-semibold text-red-800" : ""}`}>
                                {SHORT[i.id]}
                                {i.basis === "approved" ? " (required)" : ""}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="px-3 py-2" data-testid={`review-status-${p.slug}`}>
                      {!state?.reviewedAt ? "Not reviewed" : state.current ? `Current (${formatTime(state.reviewedAt)})` : "Outdated: changed since review"}
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/office/storefront-preview/en/products/${p.slug}`} className="underline underline-offset-2">
                        Customer preview
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {page.hasMore && last ? (
        <Link href={`/office/product-reviews?after=${encodeURIComponent(last.key.createdAt)}&afterId=${last.id}${term ? `&q=${encodeURIComponent(term)}` : ""}`} className="inline-block underline">
          Next {PAGE}
        </Link>
      ) : null}
    </OfficeShell>
  );
}
