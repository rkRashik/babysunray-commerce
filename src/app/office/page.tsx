import Link from "next/link";
import { productCursorCodec } from "@/api/v1/schemas";
import { getDb } from "@/db/client";
import { isPreparationItem, readinessFlags } from "@/modules/catalogue/preparation";
import { READINESS_ITEMS } from "@/modules/catalogue/readiness";
import { MAX_SEARCH_LENGTH, normalizeSearch, validateId } from "@/modules/catalogue/rules";
import { listCategories, listProducts } from "@/modules/catalogue/service";
import { DomainError } from "@/modules/domain-error";
import { OfficeShell, formatTime } from "./_components/shell";
import { requireOffice } from "./_lib/session";

export const metadata = { title: "Products · Owner Office" };

const STATUSES = ["draft", "archived"] as const;
const PAGE_SIZE = 25;
const SELECT = "mt-1 block w-full rounded border border-gray-400 bg-white px-3 py-2 text-base focus:border-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900";
// Where to fix each item: the product page section or form that changes it.
const FIX: Record<string, string> = { name: "edit", description: "edit", fabric: "edit", care: "edit", category: "edit", measurements: "measurements", photo: "photos", alt: "photos", variant: "", sizes: "" };

const href = (params: Record<string, string | undefined>) => {
  const query = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => Boolean(e[1])));
  return query.size ? `/office?${query}` : "/office";
};

// Product list, oldest first in pages of 25: search (slug, English or Bangla name, SKU), status, category, what is
// still missing, and stock. Every filter and the page live in the URL. Each product shows how much of the advisory
// readiness checklist it meets, with links to what is missing.
export default async function ProductsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOffice("catalog:read");
  const query = await searchParams;
  const one = (k: string) => (typeof query[k] === "string" ? (query[k] as string) : undefined);
  const status = STATUSES.find((s) => s === query.status);
  const rawQ = one("q") ?? "";
  const missing = isPreparationItem(one("missing")) ? (one("missing") as (typeof READINESS_ITEMS)[number]["id"]) : undefined;
  const stock = one("stock") === "in" || one("stock") === "out" ? (one("stock") as "in" | "out") : undefined;
  let categoryId: string | undefined;
  try {
    categoryId = one("category") ? validateId(one("category")!, "category") : undefined;
  } catch {
    categoryId = undefined;
  }
  const after = one("cursor") ? (productCursorCodec.decode(one("cursor")!) ?? undefined) : undefined;

  let q: string | undefined;
  let searchError: string | undefined;
  try {
    q = normalizeSearch(rawQ) ?? undefined;
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    searchError = `Search text must be at most ${MAX_SEARCH_LENGTH} characters, without control characters.`;
  }
  const db = getDb();
  const categories = await listCategories(db);
  const page = searchError ? { items: [], hasMore: false } : await listProducts(db, { limit: PAGE_SIZE, status, after, q, categoryId, missing, stock });
  const flags = await readinessFlags(db, page.items.map((p) => p.id));
  const filters = { q, status, category: categoryId, missing, stock };
  const last = page.items.at(-1);
  const next = page.hasMore && last ? href({ ...filters, cursor: productCursorCodec.encode(last.key) }) : null;
  const filtered = Boolean(q || status || categoryId || missing || stock);
  const tally = (id: string, basis: string) => {
    const items = READINESS_ITEMS.filter((i) => i.basis === basis);
    const f = flags.get(id);
    return `${items.filter((i) => f?.[i.id]).length}/${items.length}`;
  };

  return (
    <OfficeShell title="Products" current="products">
      <div role="search" aria-label="Search products">
        <form method="get" action="/office" className="grid gap-3 rounded border border-gray-300 bg-white p-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="sm:col-span-2 lg:col-span-3">
            <label htmlFor="product-search" className="block text-sm font-medium">
              Search
            </label>
            <input id="product-search" type="search" name="q" defaultValue={rawQ} maxLength={MAX_SEARCH_LENGTH} aria-describedby="product-search-hint" className={SELECT} />
            <p id="product-search-hint" className="mt-1 text-xs text-gray-600">
              Name in English or Bangla, slug or SKU. Not case-sensitive.
            </p>
          </div>
          <div>
            <label htmlFor="product-status" className="block text-sm font-medium">
              Status
            </label>
            <select id="product-status" name="status" defaultValue={status ?? ""} className={SELECT}>
              <option value="">All</option>
              <option value="draft">Draft</option>
              <option value="archived">Archived</option>
            </select>
          </div>
          <div>
            <label htmlFor="product-category" className="block text-sm font-medium">
              Category
            </label>
            <select id="product-category" name="category" defaultValue={categoryId ?? ""} className={SELECT}>
              <option value="">All</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id} lang={c.nameEn ? undefined : "bn"}>
                  {c.nameEn ?? c.nameBn ?? c.slug}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="product-stock" className="block text-sm font-medium">
              Stock
            </label>
            <select id="product-stock" name="stock" defaultValue={stock ?? ""} className={SELECT}>
              <option value="">Any</option>
              <option value="in">Some units available</option>
              <option value="out">Nothing available</option>
            </select>
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <label htmlFor="product-missing" className="block text-sm font-medium">
              Still missing
            </label>
            <select id="product-missing" name="missing" defaultValue={missing ?? ""} className={SELECT}>
              <option value="">Anything or nothing</option>
              <optgroup label="Approved requirements">
                {READINESS_ITEMS.filter((i) => i.basis === "approved").map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Proposed, waiting for your decision">
                {READINESS_ITEMS.filter((i) => i.basis === "pending").map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Suggestions">
                {READINESS_ITEMS.filter((i) => i.basis === "recommended").map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>
          <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
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
              No products match {q ? <>“{q}”</> : "these filters"}. <Link href="/office" className="underline">Show all products</Link>.
            </>
          ) : after ? (
            <>
              No more products. <Link href="/office" className="underline">Back to the first page</Link>.
            </>
          ) : (
            <>
              No products yet. <Link href="/office/products/new" className="underline">Create a draft product</Link> or <Link href="/office/import" className="underline">import a file</Link>.
            </>
          )}
        </p>
      ) : (
        <ul aria-label="Products" className="divide-y divide-gray-200 rounded border border-gray-300 bg-white">
          {page.items.map((p) => {
            const f = flags.get(p.id);
            const todo = READINESS_ITEMS.filter((i) => i.basis !== "recommended" && f && !f[i.id]);
            return (
              <li key={p.id} className="space-y-1 px-4 py-3" data-testid={`product-${p.slug}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Link href={`/office/products/${p.id}`} className="font-medium underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900">
                    {p.nameEn ?? <span lang="bn">{p.nameBn}</span>}
                    {p.nameEn && p.nameBn ? <span lang="bn" className="ml-2 font-normal text-gray-700">{p.nameBn}</span> : null}
                  </Link>
                  <span className="text-xs text-gray-600">
                    <span className={p.status === "archived" ? "rounded bg-gray-200 px-1 font-medium" : "rounded bg-amber-50 px-1"}>{p.status}</span> · {p.slug} · created {formatTime(p.createdAt)}
                  </span>
                </div>
                {p.status === "draft" ? (
                  <p className="text-xs text-gray-700" data-testid="readiness-tally">
                    Readiness (advisory): approved {tally(p.id, "approved")} · proposed {tally(p.id, "pending")} · suggestions {tally(p.id, "recommended")}
                    {todo.length ? (
                      <>
                        {" "}
                        · missing:{" "}
                        {todo.map((i, n) => (
                          <span key={i.id}>
                            {n ? ", " : ""}
                            <Link href={FIX[i.id] ? `/office/products/${p.id}/${FIX[i.id]}` : `/office/products/${p.id}`} className="underline">
                              {i.label.toLowerCase()}
                            </Link>
                          </span>
                        ))}
                      </>
                    ) : null}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {next || after ? (
        <nav aria-label="Pages" className="flex gap-4 text-sm">
          {after ? (
            <Link href={href(filters)} className="underline">
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
