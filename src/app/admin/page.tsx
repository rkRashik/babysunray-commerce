import Link from "next/link";
import { productCursorCodec } from "@/api/v1/schemas";
import { getDb } from "@/db/client";
import { isPreparationItem, readinessFlags } from "@/modules/catalogue/preparation";
import { READINESS_ITEMS } from "@/modules/catalogue/readiness";
import { MAX_SEARCH_LENGTH, normalizeSearch, validateId } from "@/modules/catalogue/rules";
import { listCategories, listProducts } from "@/modules/catalogue/service";
import { DomainError } from "@/modules/domain-error";
import { AdminShell, formatTime } from "./_components/shell";
import { requireAdmin } from "./_lib/session";

export const metadata = { title: "Products · Admin" };

const STATUSES = ["draft", "archived"] as const;
const PAGE_SIZE = 25;
const SELECT = "of-input mt-1.5";
// Where to fix each item: the product page section or form that changes it.
const FIX: Record<string, string> = { name: "edit", description: "edit", fabric: "edit", care: "edit", category: "edit", measurements: "measurements", photo: "photos", alt: "photos", variant: "", sizes: "" };

const href = (params: Record<string, string | undefined>) => {
  const query = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => Boolean(e[1])));
  return query.size ? `/admin?${query}` : "/admin";
};

// Product list, oldest first in pages of 25: search (slug, English or Bangla name, SKU), status, category, what is
// still missing, and stock. Every filter and the page live in the URL. Each product shows how much of the advisory
// readiness checklist it meets, with links to what is missing.
export default async function ProductsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin("catalog:read");
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
    <AdminShell title="Products" current="products">
      <div role="search" aria-label="Search products">
        <form method="get" action="/admin" className="grid gap-3 of-card p-4 lg:p-5 sm:grid-cols-2 lg:grid-cols-3">
          <div className="sm:col-span-2 lg:col-span-3">
            <label htmlFor="product-search" className="block text-sm font-semibold">
              Search
            </label>
            <input id="product-search" type="search" name="q" defaultValue={rawQ} maxLength={MAX_SEARCH_LENGTH} aria-describedby="product-search-hint" className={SELECT} />
            <p id="product-search-hint" className="mt-1 text-xs text-gray-600">
              Name in English or Bangla, slug or SKU. Not case-sensitive.
            </p>
          </div>
          <div>
            <label htmlFor="product-status" className="block text-sm font-semibold">
              Status
            </label>
            <select id="product-status" name="status" defaultValue={status ?? ""} className={SELECT}>
              <option value="">All</option>
              <option value="draft">Draft</option>
              <option value="archived">Archived</option>
            </select>
          </div>
          <div>
            <label htmlFor="product-category" className="block text-sm font-semibold">
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
            <label htmlFor="product-stock" className="block text-sm font-semibold">
              Stock
            </label>
            <select id="product-stock" name="stock" defaultValue={stock ?? ""} className={SELECT}>
              <option value="">Any</option>
              <option value="in">Some units available</option>
              <option value="out">Nothing available</option>
            </select>
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <label htmlFor="product-missing" className="block text-sm font-semibold">
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
            <button type="submit" className="of-btn of-btn-primary">
              Search
            </button>
            {filtered || rawQ ? (
              <Link href="/admin" className="of-btn of-btn-line">
                Clear
              </Link>
            ) : null}
          </div>
        </form>
      </div>

      {searchError ? (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
          {searchError}
        </p>
      ) : page.items.length === 0 ? (
        <p role="status" className="text-sm text-gray-700">
          {filtered ? (
            <>
              No products match {q ? <>“{q}”</> : "these filters"}. <Link href="/admin" className="underline">Show all products</Link>.
            </>
          ) : after ? (
            <>
              No more products. <Link href="/admin" className="underline">Back to the first page</Link>.
            </>
          ) : (
            <>
              No products yet. <Link href="/admin/products/new" className="underline">Create a draft product</Link> or <Link href="/admin/import" className="underline">import a file</Link>.
            </>
          )}
        </p>
      ) : (
        <ul aria-label="Products" className="of-card divide-y divide-gray-200 overflow-hidden">
          {page.items.map((p) => {
            const f = flags.get(p.id);
            const todo = READINESS_ITEMS.filter((i) => i.basis !== "recommended" && f && !f[i.id]);
            return (
              <li key={p.id} className="space-y-1.5 px-4 py-3.5 transition-colors hover:bg-[#fbf8f3] lg:px-5" data-testid={`product-${p.slug}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Link href={`/admin/products/${p.id}`} className="inline-flex min-h-11 flex-wrap items-center text-[1.0625rem] font-bold underline-offset-4 hover:underline">
                    {p.nameEn ?? <span lang="bn">{p.nameBn}</span>}
                    {p.nameEn && p.nameBn ? <span lang="bn" className="ml-2 font-normal text-gray-700">{p.nameBn}</span> : null}
                  </Link>
                  <span className="text-xs text-gray-600">
                    <span className="of-pill mr-1" data-tone={p.status === "archived" ? "quiet" : "wait"}>
                      {p.status}
                    </span>{" "}
                    · {p.slug} · created {formatTime(p.createdAt)}
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
                            <Link href={FIX[i.id] ? `/admin/products/${p.id}/${FIX[i.id]}` : `/admin/products/${p.id}`} className="underline">
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
        <nav aria-label="Pages" className="flex gap-2 text-sm">
          {after ? (
            <Link href={href(filters)} className="of-btn of-btn-line">
              First page
            </Link>
          ) : null}
          {next ? (
            <Link href={next} className="of-btn of-btn-line">
              Next page
            </Link>
          ) : null}
        </nav>
      ) : null}
    </AdminShell>
  );
}
