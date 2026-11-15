import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { DomainError } from "@/modules/domain-error";
import { dictionary, isLang, localised } from "@/modules/storefront/i18n";
import { listPreviewProducts, type PreviewFilters, previewFacets } from "@/modules/storefront/service";
import { requireOffice } from "../../../_lib/session";
import { base, ProductGrid } from "../../_components/parts";

type Props = { params: Promise<{ lang: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (v: string | string[] | undefined) => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 100) : undefined);
const SELECT = "mt-1 block min-h-11 w-full rounded-sm border border-sf-line bg-white px-3 text-base";

// Product list with search and filters, all in the URL (a plain GET form, so it works without script and
// pages can be shared within the Office). 24 per page, featured first, then newest.
export default async function PreviewProducts({ params, searchParams }: Props) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const principal = await requireOffice("storefront:preview");
  const query = await searchParams;
  const t = dictionary(lang);
  const db = getDb();
  const filters: PreviewFilters = {
    q: one(query.q),
    category: one(query.category),
    size: one(query.size),
    colour: one(query.colour),
    inStock: query.stock === "in",
    page: /^[0-9]{1,3}$/.test(one(query.page) ?? "") ? Number(query.page) : 1,
  };
  const facets = await previewFacets(db, principal);
  const result = await listPreviewProducts(db, principal, filters).catch((error: unknown) => {
    // A search term with control characters or over 100 characters: show no results instead of failing.
    if (error instanceof DomainError && error.code === "INVALID_INPUT") return { items: [], hasMore: false, page: 1 };
    throw error;
  });
  const category = facets.categories.find((c) => c.slug === filters.category);
  const title = category ? (localised(lang, category.nameEn, category.nameBn) ?? category.slug) : t.shopAll;
  const filtered = Boolean(filters.q || filters.category || filters.size || filters.colour || filters.inStock);
  const pageHref = (page: number) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ q: filters.q, category: filters.category, size: filters.size, colour: filters.colour, stock: filters.inStock ? "in" : undefined })) if (v) next.set(k, v);
    if (page > 1) next.set("page", String(page));
    return `${base(lang)}/products${next.size ? `?${next}` : ""}`;
  };

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold">{title}</h1>
      <details className="rounded-sm border border-sf-line bg-white p-4" open={filtered}>
        <summary className="cursor-pointer font-medium">{t.filters}</summary>
        <form method="get" action={`${base(lang)}/products`} className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5" aria-label={t.filters}>
          <div className="lg:col-span-2">
            <label htmlFor="sf-q" className="text-sm font-medium">
              {t.searchLabel}
            </label>
            <input id="sf-q" type="search" name="q" maxLength={100} defaultValue={filters.q ?? ""} placeholder={t.searchPlaceholder} className={SELECT} />
          </div>
          <div>
            <label htmlFor="sf-category" className="text-sm font-medium">
              {t.category}
            </label>
            <select id="sf-category" name="category" defaultValue={filters.category ?? ""} className={SELECT}>
              <option value="">{t.anyCategory}</option>
              {facets.categories.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {localised(lang, c.nameEn, c.nameBn) ?? localised(lang === "en" ? "bn" : "en", c.nameEn, c.nameBn) ?? c.slug}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="sf-size" className="text-sm font-medium">
              {t.size}
            </label>
            <select id="sf-size" name="size" defaultValue={filters.size ?? ""} className={SELECT}>
              <option value="">{t.anySize}</option>
              {facets.sizes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="sf-colour" className="text-sm font-medium">
              {t.colour}
            </label>
            <select id="sf-colour" name="colour" defaultValue={filters.colour ?? ""} className={SELECT}>
              <option value="">{t.anyColour}</option>
              {facets.colours.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="flex min-h-11 items-center gap-2 sm:col-span-2 lg:col-span-5">
            <input id="sf-stock" type="checkbox" name="stock" value="in" defaultChecked={filters.inStock} className="h-5 w-5 accent-sf-cocoa" />
            <label htmlFor="sf-stock">{t.inStockOnly}</label>
          </div>
          <div className="flex flex-wrap items-center gap-4 sm:col-span-2 lg:col-span-5">
            <button type="submit" className="min-h-11 rounded-sm bg-sf-cocoa px-5 font-semibold text-sf-ivory">
              {t.applyFilters}
            </button>
            {filtered ? (
              <Link href={`${base(lang)}/products`} className="font-medium text-sf-tan underline underline-offset-4">
                {t.clearFilters}
              </Link>
            ) : null}
          </div>
        </form>
      </details>

      <p role="status" className="text-sf-umber" data-testid="result-count">
        {result.items.length === 0 ? (filtered ? t.noMatches : t.noProducts) : t.results(result.items.length, result.hasMore)}
      </p>
      {result.items.length ? <ProductGrid products={result.items} lang={lang} label={title} /> : null}
      {result.page > 1 || result.hasMore ? (
        <nav aria-label={t.pages} className="flex gap-6">
          {result.page > 1 ? (
            <Link href={pageHref(result.page - 1)} className="inline-flex min-h-11 items-center font-medium underline underline-offset-4">
              {t.previousPage}
            </Link>
          ) : null}
          {result.hasMore ? (
            <Link href={pageHref(result.page + 1)} className="inline-flex min-h-11 items-center font-medium underline underline-offset-4">
              {t.nextPage}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
