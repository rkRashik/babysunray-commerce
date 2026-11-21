import { randomUUID } from "node:crypto";
import { ImageOff, Plus, Search, Upload, X } from "lucide-react";
import Link from "next/link";
import { productCursorCodec } from "@/api/v1/schemas";
import { getDb } from "@/db/client";
import { roleHasPermission } from "@/modules/auth/permissions";
import {
  isPreparationItem,
  readinessFlags,
} from "@/modules/catalogue/preparation";
import { publicationRuleFor } from "@/modules/catalogue/publication";
import {
  type PreparationItem,
  READINESS_ITEMS,
} from "@/modules/catalogue/readiness";
import {
  MAX_SEARCH_LENGTH,
  normalizeSearch,
  validateId,
} from "@/modules/catalogue/rules";
import {
  listCategories,
  listProducts,
  type Product,
  productListSummaries,
  type ProductListSummary,
} from "@/modules/catalogue/service";
import { DomainError } from "@/modules/domain-error";
import { bdt } from "./orders/_components/labels";
import { ProductBulkBar } from "./products/_components/product-bulk-bar";
import { AutoFilterForm } from "./_components/auto-submit";
import { ActionPanel } from "./_components/panel";
import { ScrollArea } from "./_components/scroll-area";
import { AdminShell } from "./_components/shell";
import { requireAdmin } from "./_lib/session";

export const metadata = { title: "Products · Admin" };

const STATUSES = ["draft", "published", "archived"] as const;
const STATUS_TEXT: Record<Product["status"], { label: string; tone: string }> =
  {
    draft: { label: "Draft", tone: "wait" },
    published: { label: "Published", tone: "ok" },
    archived: { label: "Archived", tone: "quiet" },
  };
const PAGE_SIZE = 25;
const FIELD = "of-input mt-1.5";

const href = (params: Record<string, string | undefined>) => {
  const query = new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => Boolean(e[1])),
  );
  return query.size ? `/admin?${query}` : "/admin";
};

const taka = (paisa: number) => bdt(paisa).replace("৳ ", "");
const price = (s: ProductListSummary | undefined) => {
  if (!s || s.minPricePaisa === null || s.maxPricePaisa === null) return "—";
  return s.minPricePaisa === s.maxPricePaisa
    ? bdt(s.minPricePaisa)
    : `${bdt(s.minPricePaisa)} – ${taka(s.maxPricePaisa)}`;
};

/** The product's names: the one that exists first, and the other language's name or a plain note that it is missing (never the slug). */
function Names({ p }: { p: Product }) {
  if (p.nameEn) {
    return (
      <>
        <span className="of-row-title block font-semibold break-words">
          {p.nameEn}
        </span>
        {p.nameBn ? (
          <span lang="bn" className="block text-xs text-gray-600 break-words">
            {p.nameBn}
          </span>
        ) : (
          <span className="block text-xs text-amber-900">
            Bangla name missing
          </span>
        )}
      </>
    );
  }
  if (p.nameBn) {
    return (
      <>
        <span
          lang="bn"
          className="of-row-title block font-semibold break-words"
        >
          {p.nameBn}
        </span>
        <span className="block text-xs text-amber-900">
          English name missing
        </span>
      </>
    );
  }
  return (
    <span className="of-row-title block font-semibold text-gray-700">
      Untitled product
    </span>
  );
}

function Thumb({ mediaId }: { mediaId: string | null }) {
  return mediaId ? (
    // The Owner-only media route (never a storage URL); Next.js image optimisation would fetch it without the session.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/admin/media/${mediaId}?w=320`}
      alt=""
      width={48}
      height={48}
      loading="lazy"
      decoding="async"
      className="h-12 w-12 shrink-0 rounded-lg border border-gray-200 bg-gray-100 object-cover"
    />
  ) : (
    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-dashed border-gray-300 bg-[#fbf8f3] text-gray-400">
      <ImageOff aria-hidden="true" size={18} />
      <span className="sr-only">No photo</span>
    </span>
  );
}

/** Stock for sale and stock in the room, told apart: an archived product holds stock but is not for sale. */
function stockText(
  p: Product,
  s: ProductListSummary | undefined,
): { main: string; tone: "ok" | "bad" | "quiet"; sub: string } {
  if (!s) return { main: "—", tone: "quiet", sub: "" };
  const skus = `${s.activeVariants} active ${s.activeVariants === 1 ? "SKU" : "SKUs"}`;
  const room = `${s.onHandUnits} on hand`;
  if (p.status === "archived")
    return {
      main: "Not for sale",
      tone: "quiet",
      sub: s.onHandUnits > 0 ? room : "No stock",
    };
  if (s.activeVariants === 0)
    return {
      main: "No active SKU",
      tone: "quiet",
      sub: s.onHandUnits > 0 ? room : "",
    };
  if (s.availableUnits > 0)
    return {
      main: `${s.availableUnits} for sale`,
      tone: "ok",
      sub: `${room} · ${skus}`,
    };
  return { main: "Out of stock", tone: "bad", sub: `${room} · ${skus}` };
}

/** A compact readiness indicator; the details stay on the product and preparation pages. */
function Readiness({
  product,
  missing,
}: {
  product: Product;
  missing: string[] | null;
}) {
  if (product.status !== "draft" || missing === null)
    return <span className="text-sm text-gray-500">—</span>;
  if (missing.length === 0)
    return (
      <span className="of-pill" data-tone="ok" data-testid="product-readiness">
        Information complete
      </span>
    );
  return (
    <Link
      href={`/admin/products/${product.id}`}
      className="of-pill no-underline"
      data-tone="wait"
      data-testid="product-readiness"
      title={`Missing: ${missing.join("; ")}`}
    >
      {missing.length} missing
      <span className="sr-only">: {missing.join("; ")}</span>
    </Link>
  );
}

// Product list, oldest first in pages of 25: search (slug, English or Bangla name, SKU), status, category, what is
// still missing, and stock. Filters apply as they change and, with the page, live in the URL (a product name is not personal
// data). Two more bounded queries per page (summaries and readiness flags), whatever the page's size.
export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const principal = await requireAdmin("catalog:read");
  const canWrite = roleHasPermission(principal.role, "catalog:write");
  const query = await searchParams;
  const one = (k: string) =>
    typeof query[k] === "string" ? (query[k] as string) : undefined;
  const status = STATUSES.find((s) => s === query.status);
  const rawQ = one("q") ?? "";
  const missing = isPreparationItem(one("missing"))
    ? (one("missing") as PreparationItem)
    : undefined;
  const stock =
    one("stock") === "in" || one("stock") === "out"
      ? (one("stock") as "in" | "out")
      : undefined;
  let categoryId: string | undefined;
  try {
    categoryId = one("category")
      ? validateId(one("category")!, "category")
      : undefined;
  } catch {
    categoryId = undefined;
  }
  const after = one("cursor")
    ? (productCursorCodec.decode(one("cursor")!) ?? undefined)
    : undefined;

  let q: string | undefined;
  let searchError: string | undefined;
  try {
    q = normalizeSearch(rawQ) ?? undefined;
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    searchError = `Search text must be at most ${MAX_SEARCH_LENGTH} characters, without control characters.`;
  }
  const db = getDb();
  // Independent reads side by side: categories with the page of products, then flags, summaries and the rule.
  const [categories, page] = await Promise.all([
    listCategories(db),
    searchError
      ? Promise.resolve({ items: [] as Product[], hasMore: false } as Awaited<
          ReturnType<typeof listProducts>
        >)
      : listProducts(db, {
          limit: PAGE_SIZE,
          status,
          after,
          q,
          categoryId,
          missing,
          stock,
        }),
  ]);
  const ids = page.items.map((p) => p.id);
  const [flags, summaries, rule] = await Promise.all([
    readinessFlags(db, ids),
    productListSummaries(db, ids),
    page.items.some((p) => p.status === "draft")
      ? publicationRuleFor(db)
      : Promise.resolve(null),
  ]);
  // What "complete" means: the basic product information plus the publication requirements in force, else the proposed ones.
  const required = new Set<string>(
    READINESS_ITEMS.filter(
      (i) => i.basis === "approved" || (!rule && i.basis === "pending"),
    ).map((i) => i.id),
  );
  for (const id of rule?.items ?? []) required.add(id);
  const missingFor = (id: string) => {
    const f = flags.get(id);
    return f
      ? READINESS_ITEMS.filter((i) => required.has(i.id) && !f[i.id]).map(
          (i) => i.label,
        )
      : null;
  };
  const filters = { q, status, category: categoryId, missing, stock };
  const last = page.items.at(-1);
  const next =
    page.hasMore && last
      ? href({ ...filters, cursor: productCursorCodec.encode(last.key) })
      : null;
  const filtered = Boolean(q || status || categoryId || missing || stock);
  const category = categories.find((c) => c.id === categoryId);
  // The filters in use, each removable on its own.
  const active = [
    q ? { key: "q", text: `Search: ${q}` } : null,
    status
      ? { key: "status", text: `Status: ${STATUS_TEXT[status].label}` }
      : null,
    category
      ? {
          key: "category",
          text: `Category: ${category.nameEn ?? category.nameBn ?? category.slug}`,
        }
      : null,
    stock
      ? { key: "stock", text: stock === "in" ? "In stock" : "Out of stock" }
      : null,
    missing
      ? {
          key: "missing",
          text: `Missing: ${READINESS_ITEMS.find((i) => i.id === missing)?.label ?? missing}`,
        }
      : null,
  ].filter((x): x is { key: string; text: string } => x !== null);
  // Counted from the chips shown, so the button and the chips always agree (an unknown category shows neither).
  const more = active.filter(
    (a) => a.key === "category" || a.key === "stock" || a.key === "missing",
  ).length;
  const bulkable = canWrite && page.items.some((p) => p.status === "draft");

  return (
    <AdminShell
      title="Products"
      current="products"
      wide
      actions={
        <>
          <Link href="/admin/import" className="of-btn of-btn-line">
            <Upload aria-hidden="true" size={18} />
            Import products
          </Link>
          <Link href="/admin/products/new" className="of-btn of-btn-primary">
            <Plus aria-hidden="true" size={18} strokeWidth={2} />
            Add product
          </Link>
        </>
      }
    >
      <div className="space-y-3">
        <div role="search" aria-label="Search products">
          <AutoFilterForm action="/admin" className="space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-[minmax(14rem,1fr)_10rem_auto] sm:items-end">
              <div className="col-span-2 sm:col-span-1">
                <label
                  htmlFor="product-search"
                  className="block text-sm font-semibold"
                >
                  Search
                </label>
                <div className="relative mt-1.5">
                  <Search
                    aria-hidden="true"
                    size={18}
                    className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-gray-500"
                  />
                  <input
                    id="product-search"
                    type="search"
                    name="q"
                    defaultValue={rawQ}
                    maxLength={MAX_SEARCH_LENGTH}
                    placeholder="Name, slug or SKU"
                    aria-describedby="product-search-hint"
                    className="of-input pl-10"
                  />
                </div>
                <p id="product-search-hint" className="sr-only">
                  Name in English or Bangla, slug or SKU. Not case-sensitive.
                  Results update as you type.
                </p>
              </div>
              <div>
                <label
                  htmlFor="product-status"
                  className="block text-sm font-semibold"
                >
                  Status
                </label>
                <select
                  id="product-status"
                  name="status"
                  defaultValue={status ?? ""}
                  className={FIELD}
                >
                  <option value="">All</option>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_TEXT[s].label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-end">
                <button
                  type="submit"
                  className="of-btn of-btn-ink w-full sm:w-auto"
                >
                  Search
                </button>
              </div>
            </div>
            {/* Less frequent filters wait behind one button; it opens by itself while one of them is in use. */}
            <ActionPanel
              label={more ? `More filters (${more} in use)` : "More filters"}
              open={more > 0}
            >
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label
                    htmlFor="product-category"
                    className="block text-sm font-semibold"
                  >
                    Category
                  </label>
                  <select
                    id="product-category"
                    name="category"
                    defaultValue={categoryId ?? ""}
                    className={FIELD}
                  >
                    <option value="">All</option>
                    {categories.map((c) => (
                      <option
                        key={c.id}
                        value={c.id}
                        lang={c.nameEn ? undefined : "bn"}
                      >
                        {c.nameEn ?? c.nameBn ?? c.slug}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="product-stock"
                    className="block text-sm font-semibold"
                  >
                    Stock
                  </label>
                  <select
                    id="product-stock"
                    name="stock"
                    defaultValue={stock ?? ""}
                    className={FIELD}
                  >
                    <option value="">All</option>
                    <option value="in">In stock</option>
                    <option value="out">Out of stock</option>
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="product-missing"
                    className="block text-sm font-semibold"
                  >
                    Still missing
                  </label>
                  <select
                    id="product-missing"
                    name="missing"
                    defaultValue={missing ?? ""}
                    className={FIELD}
                  >
                    <option value="">All</option>
                    {READINESS_ITEMS.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </ActionPanel>
          </AutoFilterForm>
        </div>
        {active.length || filtered || rawQ ? (
          <div className="flex flex-wrap items-center gap-2">
            <ul aria-label="Filters in use" className="flex flex-wrap gap-2">
              {active.map((a) => (
                <li key={a.key}>
                  <Link
                    href={href({ ...filters, [a.key]: undefined })}
                    className="of-chip"
                    aria-label={`Remove filter: ${a.text}`}
                  >
                    {a.text}
                    <X aria-hidden="true" size={15} />
                  </Link>
                </li>
              ))}
            </ul>
            <Link href="/admin" className="of-btn of-btn-line of-btn-sm">
              Clear
            </Link>
          </div>
        ) : null}
      </div>

      {searchError ? (
        <p
          role="alert"
          className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800"
        >
          {searchError}
        </p>
      ) : page.items.length === 0 ? (
        <div role="status" className="of-card px-5 py-10 text-center">
          {filtered ? (
            <>
              <p className="font-semibold">
                No products match {q ? <>“{q}”</> : "these filters"}
              </p>
              <p className="mt-1 text-sm text-gray-600">
                <Link href="/admin" className="underline">
                  Show all products
                </Link>
              </p>
            </>
          ) : after ? (
            <p className="font-semibold">
              No more products.{" "}
              <Link href="/admin" className="underline">
                Back to the first page
              </Link>
              .
            </p>
          ) : (
            <>
              <p className="font-semibold">No products yet</p>
              <p className="mt-1 text-sm text-gray-600">
                <Link href="/admin/products/new" className="underline">
                  Create a draft product
                </Link>{" "}
                or{" "}
                <Link href="/admin/import" className="underline">
                  import a file
                </Link>
                .
              </p>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="of-card hidden overflow-hidden lg:block">
            <ScrollArea
              label="Products table"
              hint="Scroll sideways for more columns. The actions stay in view."
            >
              <table className="of-table" aria-label="Products">
                <thead>
                  <tr>
                    {bulkable ? (
                      <th scope="col" className="w-10">
                        <input
                          type="checkbox"
                          className="of-check"
                          data-select-all
                          aria-label="Select every draft product on this page"
                        />
                      </th>
                    ) : null}
                    <th scope="col">Product</th>
                    <th scope="col">Status</th>
                    <th scope="col">Category</th>
                    <th scope="col" className="num">
                      Price
                    </th>
                    <th scope="col">Stock</th>
                    <th scope="col">Information</th>
                    <th scope="col" className="of-sticky-end">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((p) => {
                    const s = summaries.get(p.id);
                    const st = stockText(p, s);
                    return (
                      <tr key={p.id} data-testid={`product-${p.slug}`}>
                        {bulkable ? (
                          <td>
                            {p.status === "draft" ? (
                              <input
                                type="checkbox"
                                className="of-check"
                                form="products-bulk"
                                name="product"
                                value={`${p.id}:${p.version}`}
                                aria-label={`Select ${p.nameEn ?? p.nameBn ?? "product"}`}
                              />
                            ) : null}
                          </td>
                        ) : null}
                        <td>
                          <Link
                            prefetch={false}
                            href={`/admin/products/${p.id}`}
                            className="of-row-link flex items-center gap-3"
                          >
                            <Thumb mediaId={s?.firstMediaId ?? null} />
                            <span className="min-w-0 max-w-72">
                              <Names p={p} />
                            </span>
                          </Link>
                        </td>
                        <td>
                          <span
                            className="of-pill"
                            data-tone={STATUS_TEXT[p.status].tone}
                          >
                            {STATUS_TEXT[p.status].label}
                          </span>
                        </td>
                        <td className="text-sm text-gray-700">
                          {s?.categoryName ?? (
                            <span className="text-gray-500">—</span>
                          )}
                        </td>
                        <td className="num">{price(s)}</td>
                        <td>
                          <span
                            className={`block text-sm font-semibold ${st.tone === "bad" ? "text-red-800" : st.tone === "quiet" ? "text-gray-700" : ""}`}
                          >
                            {st.main}
                          </span>
                          {st.sub ? (
                            <span className="block text-xs text-gray-600">
                              {st.sub}
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <Readiness product={p} missing={missingFor(p.id)} />
                        </td>
                        <td className="of-sticky-end">
                          <div className="flex justify-end">
                            <Link
                              prefetch={false}
                              href={
                                p.status === "draft"
                                  ? `/admin/products/${p.id}/edit`
                                  : `/admin/products/${p.id}`
                              }
                              className="of-btn of-btn-line of-btn-sm"
                              aria-label={`${p.status === "draft" ? "Edit" : "View"}: ${p.nameEn ?? p.nameBn ?? "product"}`}
                            >
                              {p.status === "draft" ? "Edit" : "View"}
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollArea>
          </div>
          <ul
            aria-label="Products"
            className="of-card divide-y divide-gray-200 overflow-hidden lg:hidden"
          >
            {page.items.map((p) => {
              const s = summaries.get(p.id);
              const st = stockText(p, s);
              const missingItems = missingFor(p.id);
              return (
                <li key={p.id}>
                  {/* On a phone the whole row is one large link; the details are on the product page. */}
                  <Link
                    prefetch={false}
                    href={`/admin/products/${p.id}`}
                    className="of-row-link flex gap-3 px-4 py-3 hover:bg-[#fdfaf5] focus-visible:bg-[#fdfaf5]"
                  >
                    <Thumb mediaId={s?.firstMediaId ?? null} />
                    <span className="min-w-0 flex-1 space-y-1">
                      <Names p={p} />
                      <span className="block text-sm font-semibold tabular-nums">
                        {price(s)}
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5 text-xs">
                        <span
                          className="of-pill"
                          data-tone={STATUS_TEXT[p.status].tone}
                        >
                          {STATUS_TEXT[p.status].label}
                        </span>
                        {p.status === "draft" && missingItems ? (
                          <span
                            className="of-pill"
                            data-tone={missingItems.length ? "wait" : "ok"}
                          >
                            {missingItems.length
                              ? `${missingItems.length} missing`
                              : "Information complete"}
                          </span>
                        ) : null}
                      </span>
                      <span
                        className={`block text-xs ${st.tone === "bad" ? "font-semibold text-red-800" : "text-gray-700"}`}
                      >
                        {st.main}
                        {st.sub ? (
                          <span className="text-gray-600"> · {st.sub}</span>
                        ) : null}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {bulkable ? (
            <ProductBulkBar
              batch={randomUUID()}
              categories={categories.map((c) => ({
                id: c.id,
                name: c.nameEn ?? c.nameBn ?? c.slug,
                bn: !c.nameEn,
              }))}
            />
          ) : null}
        </>
      )}
      {next || after ? (
        <nav aria-label="Pages" className="flex gap-2 text-sm">
          {after ? (
            <Link href={href(filters)} className="of-btn of-btn-line of-btn-sm">
              First page
            </Link>
          ) : null}
          {next ? (
            <Link href={next} className="of-btn of-btn-line of-btn-sm">
              Next page
            </Link>
          ) : null}
        </nav>
      ) : null}
    </AdminShell>
  );
}
