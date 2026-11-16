import "server-only";
import type { Db } from "@/db/database";
import type { MeasurementPoint } from "../catalogue/content";
import { normalizeSearch } from "../catalogue/rules";
import { DomainError } from "../domain-error";
import type { DeliveryZone } from "../orders/rules";
import { catalogueFacets, type Facets, listProductCards, type PhotoRef, PREVIEW_PAGE_SIZE, productBySlug, PUBLIC_SCOPE, quoteLines, type StockState } from "./service";

// Customer-facing catalogue reads (Gate H.33): published products only (PUBLIC_SCOPE in service.ts, the same rule
// as the guest checkout, src/modules/catalogue/visibility.ts). These take no principal: anyone may call them, so
// each answer is an explicit allowlist: no ids except photo ids, no versions, no user ids, no exact stock counts
// (whether to show them is a business decision; only in or out of stock is shown), and the fabric statement only
// once the Owner confirmed it (S-11). No product can be published while no publication rule is approved, so today
// every list is empty and every slug unknown. Not routed: the dormant transport is src/api/public-catalogue.ts.

export const PUBLIC_PAGE_SIZE = PREVIEW_PAGE_SIZE;
/** Deepest page a public list serves (offset paging; a bound on the work one request can cause). */
export const MAX_PUBLIC_PAGE = 100;

type Localised = { en: string | null; bn: string | null };
export type PublicPhoto = { id: string; width: number; height: number; alt: Localised };
export type PublicProductCard = { slug: string; name: Localised; featured: boolean; pricePaisa: { min: number; max: number }; stock: StockState; photo: PublicPhoto | null };
export type PublicFilters = { q?: string; category?: string; size?: string; colour?: string; inStock?: boolean; page?: number };

const photo = (p: PhotoRef | { id: string; width: number; height: number; altEn: string | null; altBn: string | null }): PublicPhoto => ({
  id: p.id,
  width: p.width,
  height: p.height,
  alt: { en: p.altEn, bn: p.altBn },
});

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LABEL = /^[^\u0000-\u001f\u007f]{1,64}$/;

/** Validates untrusted filters: bounded text, a slug-shaped category, a page from 1 to MAX_PUBLIC_PAGE. */
export function validatePublicFilters(raw: PublicFilters): PublicFilters {
  const page = raw.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PUBLIC_PAGE) throw new DomainError("INVALID_INPUT", `page must be a whole number from 1 to ${MAX_PUBLIC_PAGE}.`);
  if (raw.category !== undefined && (!SLUG.test(raw.category) || raw.category.length > 100)) throw new DomainError("INVALID_INPUT", "category is not valid.");
  for (const [name, value] of [["size", raw.size], ["colour", raw.colour]] as const) {
    if (value !== undefined && !LABEL.test(value)) throw new DomainError("INVALID_INPUT", `${name} is not valid.`);
  }
  const q = raw.q === undefined ? undefined : normalizeSearch(raw.q) || undefined;
  return { ...raw, q, page };
}

/** One page of published products: featured first, then newest. */
export async function listPublicProducts(db: Db, raw: PublicFilters): Promise<{ items: PublicProductCard[]; page: number; hasMore: boolean }> {
  const filters = validatePublicFilters(raw);
  const result = await listProductCards(db, filters, PUBLIC_SCOPE);
  return {
    page: result.page,
    hasMore: result.hasMore,
    items: result.items.map((c) => ({
      slug: c.slug,
      name: { en: c.nameEn, bn: c.nameBn },
      featured: c.featured,
      pricePaisa: { min: c.minPricePaisa, max: c.maxPricePaisa },
      stock: c.stock,
      photo: c.photo ? photo(c.photo) : null,
    })),
  };
}

/** Categories with published products, and the sizes and colours on sale, for filters. */
export async function publicFacets(db: Db): Promise<{ categories: { slug: string; name: Localised }[]; sizes: string[]; colours: string[] }> {
  const facets: Facets = await catalogueFacets(db, PUBLIC_SCOPE);
  return { categories: facets.categories.map((c) => ({ slug: c.slug, name: { en: c.nameEn, bn: c.nameBn } })), sizes: facets.sizes, colours: facets.colours };
}

export type PublicProduct = {
  slug: string;
  name: Localised;
  description: Localised;
  category: { slug: string; name: Localised } | null;
  fabric: Localised | null;
  care: Localised;
  sizeGuidance: Localised;
  measurements: { size: string; point: MeasurementPoint; valueMm: number }[];
  photos: PublicPhoto[];
  variants: { sku: string; size: string | null; colour: string | null; pricePaisa: number; inStock: boolean }[];
  deliveryZones: { code: DeliveryZone; chargePaisa: number }[];
};

/** A published product by slug, or null for any slug a customer may not see (unknown, draft, withdrawn, archived). */
export async function getPublicProduct(db: Db, slug: string): Promise<PublicProduct | null> {
  const found = await productBySlug(db, slug, PUBLIC_SCOPE);
  if (!found) return null;
  const p = found.product;
  return {
    slug: p.slug,
    name: { en: p.nameEn, bn: p.nameBn },
    description: { en: p.descriptionEn, bn: p.descriptionBn },
    category: p.category ? { slug: p.category.slug, name: { en: p.category.nameEn, bn: p.category.nameBn } } : null,
    fabric: p.fabricConfirmedAt ? { en: p.fabricEn, bn: p.fabricBn } : null,
    care: { en: p.careEn, bn: p.careBn },
    sizeGuidance: { en: p.sizeGuidanceEn, bn: p.sizeGuidanceBn },
    measurements: p.measurements.map((m) => ({ size: m.size, point: m.point, valueMm: m.valueMm })),
    photos: p.media.map(photo),
    variants: found.variants.map((v) => ({ sku: v.sku, size: v.size, colour: v.colour, pricePaisa: v.pricePaisa, inStock: v.available > 0 })),
    deliveryZones: found.zones.flatMap((z) => (z.chargePaisa === null ? [] : [{ code: z.code, chargePaisa: z.chargePaisa }])),
  };
}

export type PublicQuoteLine = {
  sku: string;
  quantity: number;
  /** ok: orderable as asked; insufficient: not enough in stock now; unavailable: not sold (unknown, unpublished or inactive). */
  status: "ok" | "insufficient" | "unavailable";
  unitPricePaisa: number | null;
  lineTotalPaisa: number | null;
  productSlug: string | null;
  name: Localised | null;
  size: string | null;
  colour: string | null;
};
export type PublicQuote = {
  lines: PublicQuoteLine[];
  subtotalPaisa: number;
  deliveryZone: DeliveryZone | null;
  deliveryChargePaisa: number | null;
  totalPaisa: number | null;
  /** True only when every line is orderable as asked and the zone has a charge. */
  ready: boolean;
};

/**
 * The server's prices, availability and delivery charge for a cart, in integer paisa. A quote is not a promise:
 * the guest checkout prices the order again and refuses it (QUOTE_CHANGED) if anything the customer was shown
 * changed, and stock is held only when an order is placed.
 */
export async function quotePublicCart(db: Db, input: { lines: unknown; zone?: unknown }): Promise<PublicQuote> {
  const quote = await quoteLines(db, input, PUBLIC_SCOPE);
  return {
    lines: quote.lines.map((l) => {
      const sold = l.status === "ok" || l.status === "insufficient";
      return {
        sku: l.sku,
        quantity: l.quantity,
        status: sold ? (l.status as "ok" | "insufficient") : "unavailable",
        unitPricePaisa: sold ? l.unitPricePaisa : null,
        lineTotalPaisa: sold ? l.lineTotalPaisa : null,
        productSlug: sold ? l.productSlug : null,
        name: sold ? { en: l.nameEn, bn: l.nameBn } : null,
        size: sold ? l.size : null,
        colour: sold ? l.colour : null,
      };
    }),
    subtotalPaisa: quote.subtotalPaisa,
    deliveryZone: quote.zone,
    deliveryChargePaisa: quote.deliveryChargePaisa,
    totalPaisa: quote.totalPaisa,
    ready: quote.ready,
  };
}
