import { SearchX, X } from "lucide-react";
import Link from "next/link";
import { getDb } from "@/db/client";
import { DomainError } from "@/modules/domain-error";
import { dictionary, type Lang, localised } from "@/modules/storefront/i18n";
import { type CatalogueScope, catalogueFacets, listProductCards, type PreviewFilters } from "@/modules/storefront/service";
import { FilterSheet } from "../filter-sheet";
import { base, listQuery, Localised, ProductGrid, type Surface } from "../parts";

type Props = { lang: Lang; surface: Surface; scope: CatalogueScope; query: Record<string, string | string[] | undefined> };

const one = (v: string | string[] | undefined) => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 100) : undefined);

// Product list with search and filters, all in the URL (a plain GET form, so it works without script and pages can be
// shared). Categories are chips above the list; size, colour and stock are in the filter sheet; each
// active filter is a chip that removes it. 24 per page, featured first, then newest. The service offers no other order,
// so there is no sort control.
export async function ProductsView({ lang, surface, scope, query }: Props) {
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
  const facets = await catalogueFacets(db, scope);
  const result = await listProductCards(db, filters, scope).catch((error: unknown) => {
    // A search term with control characters or over 100 characters: show no results instead of failing.
    if (error instanceof DomainError && error.code === "INVALID_INPUT") return { items: [], hasMore: false, page: 1 };
    throw error;
  });
  const category = facets.categories.find((c) => c.slug === filters.category);
  const categoryName = category ? (localised(lang, category.nameEn, category.nameBn) ?? localised(lang === "en" ? "bn" : "en", category.nameEn, category.nameBn) ?? category.slug) : null;
  const title = filters.q ? t.searchResults(filters.q) : (categoryName ?? t.shopAll);
  const current = { q: filters.q, category: filters.category, size: filters.size, colour: filters.colour, stock: filters.inStock ? "in" : undefined };
  const href = (changes: Partial<typeof current> & { page?: number }) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...current, ...changes })) if (v && k !== "page") next.set(k, String(v));
    if (changes.page && changes.page > 1) next.set("page", String(changes.page));
    return `${base(lang, surface)}/products${next.size ? `?${next}` : ""}`;
  };
  const sheetFilters = [filters.size, filters.colour, filters.inStock ? "in" : undefined].filter(Boolean).length;
  const chips = [
    filters.q ? { label: `“${filters.q}”`, href: href({ q: undefined }) } : null,
    filters.size ? { label: t.chosen(t.size, filters.size), href: href({ size: undefined }) } : null,
    filters.colour ? { label: t.chosen(t.colour, filters.colour), href: href({ colour: undefined }) } : null,
    filters.inStock ? { label: t.inStockOnly, href: href({ stock: undefined }) } : null,
  ].filter((c) => c !== null);
  const filtered = chips.length > 0 || Boolean(filters.category);
  const legend = "mb-3 font-semibold";

  return (
    <div>
      <h1 className="sf-display text-[2.125rem] lg:text-[3.25rem]">{title}</h1>

      {facets.categories.length ? (
        <ul aria-label={t.categories} className="sf-rail mt-4 gap-2 pb-1 lg:mt-6">
          {[{ slug: "", nameEn: t.shopAll, nameBn: t.shopAll }, ...facets.categories].map((c) => (
            <li key={c.slug || "all"}>
              <Link href={href({ category: c.slug || undefined, page: 1 })} aria-current={(filters.category ?? "") === c.slug ? "page" : undefined} className="sf-chip">
                <Localised lang={lang} en={c.nameEn} bn={c.nameBn} />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="sticky top-16 z-20 -mx-4 mt-3 flex items-center justify-between gap-3 border-b border-sf-line bg-sf-paper/95 px-4 py-2.5 backdrop-blur-md lg:top-20 lg:mx-0 lg:px-0">
        <FilterSheet lang={lang} active={sheetFilters}>
          <form method="get" action={`${base(lang, surface)}/products`} aria-label={t.filters} className="flex min-h-0 flex-1 flex-col">
            {filters.q ? <input type="hidden" name="q" value={filters.q} /> : null}
            {filters.category ? <input type="hidden" name="category" value={filters.category} /> : null}
            <div className="sf-sheet-body space-y-7">
              {facets.sizes.length ? (
                <fieldset>
                  <legend className={legend}>{t.size}</legend>
                  <div className="flex flex-wrap gap-2">
                    {["", ...facets.sizes].map((s) => (
                      <label key={s || "any"} className="sf-chip">
                        <input type="radio" name="size" value={s} defaultChecked={(filters.size ?? "") === s} className="sr-only" />
                        {s || t.anySize}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              {facets.colours.length ? (
                <fieldset>
                  <legend className={legend}>{t.colour}</legend>
                  <div className="flex flex-wrap gap-2">
                    {["", ...facets.colours].map((c) => (
                      <label key={c || "any"} className="sf-chip">
                        <input type="radio" name="colour" value={c} defaultChecked={(filters.colour ?? "") === c} className="sr-only" />
                        {c || t.anyColour}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              <label className="sf-choice justify-between font-semibold">
                {t.inStockOnly}
                <input type="checkbox" name="stock" value="in" defaultChecked={filters.inStock} className="h-6 w-6 accent-sf-ink" />
              </label>
            </div>
            <div className="sf-sheet-foot">
              <Link href={href({ size: undefined, colour: undefined, stock: undefined })} className="sf-btn sf-btn-ghost flex-1">
                {t.clearFilters}
              </Link>
              <button type="submit" className="sf-btn flex-[1.4]">
                {t.applyFilters}
              </button>
            </div>
          </form>
        </FilterSheet>
        <p role="status" className="text-[0.9375rem] text-sf-ink-2" data-testid="result-count">
          {result.items.length === 0 ? "" : t.results(result.items.length, result.hasMore)}
        </p>
      </div>

      {chips.length ? (
        <ul aria-label={t.filters} className="mt-3 flex flex-wrap gap-2">
          {chips.map((c) => (
            <li key={c.href}>
              <Link href={c.href} className="sf-chip gap-1.5 border-sf-ink bg-sf-sun-soft pe-3 text-[0.875rem]" aria-label={t.removeFilter(c.label)}>
                {c.label}
                <X aria-hidden="true" size={16} strokeWidth={2} />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-6 lg:mt-8">
        {result.items.length ? (
          <ProductGrid products={result.items} lang={lang} surface={surface} label={title} from={listQuery(href({ page: result.page }).split("?")[1])} priorityCount={4} />
        ) : (
          <div className="sf-card flex flex-col items-center px-6 py-12 text-center">
            <span aria-hidden="true" className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full bg-sf-sun-soft text-sf-sun-deep">
              <SearchX size={28} strokeWidth={1.5} />
            </span>
            <p className="mx-auto max-w-md text-lg font-semibold" data-testid="no-results">
              {filtered ? t.noMatches : t.noProducts}
            </p>
            {filtered ? (
              <Link href={`${base(lang, surface)}/products`} className="sf-btn mt-6">
                {t.clearFilters}
              </Link>
            ) : null}
          </div>
        )}
      </div>

      {result.page > 1 || result.hasMore ? (
        <nav aria-label={t.pages} className="mt-10 flex justify-center gap-3">
          {result.page > 1 ? (
            <Link href={href({ page: result.page - 1 })} className="sf-btn sf-btn-ghost">
              {t.previousPage}
            </Link>
          ) : null}
          {result.hasMore ? (
            <Link href={href({ page: result.page + 1 })} className="sf-btn sf-btn-ghost">
              {t.nextPage}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
