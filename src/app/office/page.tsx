import Link from "next/link";
import { productCursorCodec } from "@/api/v1/schemas";
import { getDb } from "@/db/client";
import { MAX_SEARCH_LENGTH, normalizeSearch } from "@/modules/catalogue/rules";
import { listProducts } from "@/modules/catalogue/service";
import { DomainError } from "@/modules/domain-error";
import { OfficeShell, formatTime } from "./_components/shell";
import { requireOffice } from "./_lib/session";

export const metadata = { title: "Products · Owner Office" };

const STATUSES = ["draft", "archived"] as const;
const PAGE_SIZE = 25;

const href = (params: Record<string, string | undefined>) => {
  const query = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => Boolean(e[1])));
  return query.size ? `/office?${query}` : "/office";
};

// Product list, oldest first in pages of 25, searchable by slug, English or Bangla name and SKU, filterable by
// status. Search, filter and page live in the URL, so a refresh or a shared link shows the same list.
export default async function ProductsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOffice("catalog:read");
  const query = await searchParams;
  const status = STATUSES.find((s) => s === query.status);
  const rawQ = typeof query.q === "string" ? query.q : "";
  const after = typeof query.cursor === "string" ? (productCursorCodec.decode(query.cursor) ?? undefined) : undefined;

  let q: string | undefined;
  let searchError: string | undefined;
  try {
    q = normalizeSearch(rawQ) ?? undefined;
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    searchError = `Search text must be at most ${MAX_SEARCH_LENGTH} characters, without control characters.`;
  }
  const page = searchError ? { items: [], hasMore: false } : await listProducts(getDb(), { limit: PAGE_SIZE, status, after, q });
  const last = page.items.at(-1);
  const next = page.hasMore && last ? href({ q, status, cursor: productCursorCodec.encode(last.key) }) : null;
  const filtered = Boolean(q || status);

  return (
    <OfficeShell title="Products" current="products">
      <div role="search" aria-label="Search products">
        <form method="get" action="/office" className="flex flex-col gap-3 rounded border border-gray-300 bg-white p-4 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label htmlFor="product-search" className="block text-sm font-medium">
              Search
            </label>
            <input
              id="product-search"
              type="search"
              name="q"
              defaultValue={rawQ}
              maxLength={MAX_SEARCH_LENGTH}
              aria-describedby="product-search-hint"
              className="mt-1 block w-full rounded border border-gray-400 px-3 py-2 text-base focus:border-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
            <p id="product-search-hint" className="mt-1 text-xs text-gray-600">
              Name in English or Bangla, slug or SKU. Not case-sensitive.
            </p>
          </div>
          <div>
            <label htmlFor="product-status" className="block text-sm font-medium">
              Status
            </label>
            <select
              id="product-status"
              name="status"
              defaultValue={status ?? ""}
              className="mt-1 block w-full rounded border border-gray-400 bg-white px-3 py-2 text-base focus:border-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900"
            >
              <option value="">All</option>
              <option value="draft">Draft</option>
              <option value="archived">Archived</option>
            </select>
          </div>
          <div className="flex gap-2 sm:pb-[1.375rem]">
            <button type="submit" className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2">
              Search
            </button>
            {filtered || rawQ ? (
              <Link href="/office" className="rounded border border-gray-400 bg-white px-4 py-2 text-sm hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900">
                Clear
              </Link>
            ) : null}
          </div>
        </form>
      </div>

      {searchError ? (
        <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {searchError}
        </p>
      ) : page.items.length === 0 ? (
        <p role="status" className="text-sm text-gray-700">
          {filtered ? (
            <>
              No products match {q ? <>“{q}”</> : "this filter"}
              {status ? ` among ${status} products` : ""}. <Link href="/office" className="underline">Show all products</Link>.
            </>
          ) : after ? (
            <>
              No more products. <Link href="/office" className="underline">Back to the first page</Link>.
            </>
          ) : (
            <>
              No products yet. <Link href="/office/products/new" className="underline">Create a draft product</Link>.
            </>
          )}
        </p>
      ) : (
        <ul aria-label="Products" className="divide-y divide-gray-200 rounded border border-gray-300 bg-white">
          {page.items.map((p) => (
            <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
              <Link href={`/office/products/${p.id}`} className="font-medium underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900">
                {p.nameEn ?? <span lang="bn">{p.nameBn}</span>}
                {p.nameEn && p.nameBn ? <span lang="bn" className="ml-2 font-normal text-gray-700">{p.nameBn}</span> : null}
              </Link>
              <span className="text-xs text-gray-600">
                <span className={p.status === "archived" ? "rounded bg-gray-200 px-1" : undefined}>{p.status}</span> · {p.slug} · created {formatTime(p.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {next || after ? (
        <nav aria-label="Pages" className="flex gap-4 text-sm">
          {after ? (
            <Link href={href({ q, status })} className="underline">
              First page
            </Link>
          ) : null}
          {next ? (
            <Link href={next} className="underline">
              Next page
            </Link>
          ) : null}
        </nav>
      ) : null}
    </OfficeShell>
  );
}
