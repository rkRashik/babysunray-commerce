import "server-only";
import { and, asc, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import { deliveryZones, inventoryBalances, productCategories, productMedia, products, variants } from "@/db/schema";
import { assertPermission, type Principal } from "../auth/principal";
import { normalizeSearch } from "../catalogue/rules";
import { getProductWithVariants, type Product, type ProductDetail } from "../catalogue/service";
import { publishedProduct } from "../catalogue/visibility";
import { DomainError } from "../domain-error";
import { checkCustomerDetails, DELIVERY_ZONES, type DeliveryZone, type DetailsError } from "../orders/rules";
import { type CartLine, validateCartLines } from "./cart";

// The storefront's reads and cart quote, in two scopes: the private preview (every product that is not archived,
// drafts included; each exported preview function requires `storefront:preview`) and customers (published
// products only, public-catalogue.ts). The scope decides which products a query can see at all, so a public read
// never touches a draft. Nothing here writes: reads run in read-only snapshots, and the checkout simulation never
// calls submitOrder, reserves stock or sends anything.

const SNAPSHOT = { isolationLevel: "repeatable read", accessMode: "read only" } as const;
export const PREVIEW_PAGE_SIZE = 24;

export type PreviewFilters = { q?: string; category?: string; size?: string; colour?: string; inStock?: boolean; page?: number };
export type StockState = "in" | "partial" | "out";
export type PhotoRef = { id: string; width: number; height: number; altEn: string | null; altBn: string | null };
export type ProductCard = {
  id: string;
  slug: string;
  nameEn: string | null;
  nameBn: string | null;
  featured: boolean;
  minPricePaisa: number;
  maxPricePaisa: number;
  stock: StockState;
  photo: PhotoRef | null;
};
export type Facets = { categories: { slug: string; nameEn: string | null; nameBn: string | null }[]; sizes: string[]; colours: string[] };

const available = sql<number>`(${inventoryBalances.onHand} - ${inventoryBalances.reserved})::int`;
/** Which products a reader may see (`visible`, SQL on `products`) and order (by product status). */
export type CatalogueScope = { visible: SQL; orderable: (status: Product["status"]) => boolean };
export const PREVIEW_SCOPE: CatalogueScope = { visible: sql`${products.status} <> 'archived'`, orderable: (s) => s !== "archived" };
export const PUBLIC_SCOPE: CatalogueScope = { visible: publishedProduct, orderable: (s) => s === "published" };

const sellable = (scope: CatalogueScope) =>
  sql`${scope.visible} and exists (select 1 from ${variants} where ${variants.productId} = ${products.id} and ${variants.status} = 'active')`;
const escapeLike = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function filterCondition(f: PreviewFilters, scope: CatalogueScope) {
  const term = f.q === undefined ? null : normalizeSearch(f.q);
  const variantWith = (cond: ReturnType<typeof sql>) =>
    sql`exists (select 1 from ${variants} vv join ${inventoryBalances} bb on bb.variant_id = vv.id where vv.product_id = ${products.id} and vv.status = 'active' and ${cond})`;
  return and(
    sellable(scope),
    term ? sql`(normalize(${products.nameEn}, NFC) ilike ${escapeLike(term)} or normalize(${products.nameBn}, NFC) ilike ${escapeLike(term)})` : undefined,
    f.category ? sql`exists (select 1 from ${productCategories} c where c.id = ${products.categoryId} and c.slug = ${f.category})` : undefined,
    f.size ? variantWith(sql`vv.size = ${f.size}`) : undefined,
    f.colour ? variantWith(sql`vv.colour = ${f.colour}`) : undefined,
    f.inStock ? variantWith(sql`bb.on_hand - bb.reserved > 0`) : undefined,
  );
}

/** One page of products for the preview: featured first, then newest. Four queries per page, never one per product. */
export async function listPreviewProducts(db: Db, principal: Principal, filters: PreviewFilters): Promise<{ items: ProductCard[]; hasMore: boolean; page: number }> {
  assertPermission(principal, "storefront:preview");
  return listProductCards(db, filters, PREVIEW_SCOPE);
}

/** One page of product cards in `scope`. */
export async function listProductCards(db: Db, filters: PreviewFilters, scope: CatalogueScope): Promise<{ items: ProductCard[]; hasMore: boolean; page: number }> {
  const page = Number.isSafeInteger(filters.page) && (filters.page ?? 0) >= 1 && (filters.page ?? 0) <= 500 ? (filters.page as number) : 1;
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: products.id, slug: products.slug, nameEn: products.nameEn, nameBn: products.nameBn, featured: products.featured })
      .from(products)
      .where(filterCondition(filters, scope))
      .orderBy(desc(products.featured), desc(products.createdAt), desc(products.id))
      .limit(PREVIEW_PAGE_SIZE + 1)
      .offset((page - 1) * PREVIEW_PAGE_SIZE);
    const pageRows = rows.slice(0, PREVIEW_PAGE_SIZE);
    const ids = pageRows.map((r) => r.id);
    if (ids.length === 0) return { items: [], hasMore: false, page };
    const prices = await tx
      .select({
        productId: variants.productId,
        min: sql<number>`min(${variants.pricePaisa})`.mapWith(Number),
        max: sql<number>`max(${variants.pricePaisa})`.mapWith(Number),
        inStock: sql<number>`count(*) filter (where ${available} > 0)`.mapWith(Number),
        total: sql<number>`count(*)`.mapWith(Number),
      })
      .from(variants)
      .innerJoin(inventoryBalances, eq(inventoryBalances.variantId, variants.id))
      .where(and(inArray(variants.productId, ids), eq(variants.status, "active")))
      .groupBy(variants.productId);
    const photos = await tx
      .selectDistinctOn([productMedia.productId], { productId: productMedia.productId, id: productMedia.id, width: productMedia.width, height: productMedia.height, altEn: productMedia.altEn, altBn: productMedia.altBn })
      .from(productMedia)
      .where(inArray(productMedia.productId, ids))
      .orderBy(productMedia.productId, asc(productMedia.position));
    const items = pageRows.map((r): ProductCard => {
      const p = prices.find((x) => x.productId === r.id);
      const photo = photos.find((x) => x.productId === r.id);
      return {
        ...r,
        minPricePaisa: p?.min ?? 0,
        maxPricePaisa: p?.max ?? 0,
        stock: !p || p.inStock === 0 ? "out" : p.inStock < p.total ? "partial" : "in",
        photo: photo ? { id: photo.id, width: photo.width, height: photo.height, altEn: photo.altEn, altBn: photo.altBn } : null,
      };
    });
    return { items, hasMore: rows.length > PREVIEW_PAGE_SIZE, page };
  }, SNAPSHOT);
}

/** Categories that have products to show, and the sizes and colours on sale, for the filters. */
export async function previewFacets(db: Db, principal: Principal): Promise<Facets> {
  assertPermission(principal, "storefront:preview");
  return catalogueFacets(db, PREVIEW_SCOPE);
}

/** The filter options of `scope`: categories with products to show, and the sizes and colours on sale. */
export async function catalogueFacets(db: Db, scope: CatalogueScope): Promise<Facets> {
  return db.transaction(async (tx) => {
    const categories = await tx
      .selectDistinct({ slug: productCategories.slug, nameEn: productCategories.nameEn, nameBn: productCategories.nameBn })
      .from(productCategories)
      .innerJoin(products, eq(products.categoryId, productCategories.id))
      .where(sellable(scope))
      .orderBy(productCategories.slug);
    const options = await tx
      .selectDistinct({ size: variants.size, colour: variants.colour })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(and(eq(variants.status, "active"), scope.visible));
    const unique = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => v !== null))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    return { categories, sizes: unique(options.map((o) => o.size)), colours: unique(options.map((o) => o.colour)) };
  }, SNAPSHOT);
}

export type PreviewVariant = { sku: string; size: string | null; colour: string | null; pricePaisa: number; available: number };
export type ZoneRate = { code: DeliveryZone; chargePaisa: number | null };
export type PreviewProduct = { product: ProductDetail; variants: PreviewVariant[]; zones: ZoneRate[] };

/** A draft product by slug with its active SKUs, what is available of each, and the configured delivery rates. */
export async function getPreviewProduct(db: Db, principal: Principal, slug: string): Promise<PreviewProduct | null> {
  assertPermission(principal, "storefront:preview");
  return productBySlug(db, slug, PREVIEW_SCOPE);
}

/** A product of `scope` by slug (null if it is not visible there), its active SKUs and the delivery rates. */
export async function productBySlug(db: Db, slug: string, scope: CatalogueScope): Promise<PreviewProduct | null> {
  if (typeof slug !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 100) return null;
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ id: products.id }).from(products).where(and(eq(products.slug, slug), scope.visible));
    if (!row) return null;
    const product = await getProductWithVariants(tx, row.id);
    const ids = product.variants.map((v) => v.id);
    const stock = ids.length ? await tx.select({ variantId: inventoryBalances.variantId, available }).from(inventoryBalances).where(inArray(inventoryBalances.variantId, ids)) : [];
    const list = product.variants
      .filter((v) => v.status === "active")
      .map((v) => ({ sku: v.sku, size: v.size, colour: v.colour, pricePaisa: v.pricePaisa, available: Math.max(0, stock.find((s) => s.variantId === v.id)?.available ?? 0) }));
    return { product, variants: list, zones: await zoneRates(tx) };
  }, SNAPSHOT);
}

async function zoneRates(tx: Db): Promise<ZoneRate[]> {
  const rows = await tx.select().from(deliveryZones);
  return DELIVERY_ZONES.map((code) => {
    const zone = rows.find((z) => z.code === code);
    return { code, chargePaisa: zone && zone.active ? zone.chargePaisa : null };
  });
}

export type LineStatus = "ok" | "insufficient" | "unavailable" | "unknown";
export type QuotedLine = {
  sku: string;
  quantity: number;
  status: LineStatus;
  available: number;
  unitPricePaisa: number | null;
  lineTotalPaisa: number | null;
  productSlug: string | null;
  nameEn: string | null;
  nameBn: string | null;
  size: string | null;
  colour: string | null;
  photo: PhotoRef | null;
};
export type Quote = {
  lines: QuotedLine[];
  subtotalPaisa: number;
  zone: DeliveryZone | null;
  /** The configured charge, or null when the zone is not chosen, not configured or inactive. */
  deliveryChargePaisa: number | null;
  totalPaisa: number | null;
  zones: ZoneRate[];
  /** True only when every line is available as asked and the zone has a charge: what an order would need. */
  ready: boolean;
};

/**
 * Prices, names and availability of cart lines from the database now, and the delivery charge of the chosen
 * zone. Integer paisa throughout. The cart's own content (SKUs and quantities) is untrusted and validated.
 */
export async function quoteCart(db: Db, principal: Principal, input: { lines: unknown; zone?: unknown }): Promise<Quote> {
  assertPermission(principal, "storefront:preview");
  return quoteLines(db, input, PREVIEW_SCOPE);
}

/**
 * quoteCart in `scope`. For customers (`PUBLIC_SCOPE`) a SKU the scope cannot see is read as if it did not exist,
 * so no name, price or photo of an unpublished product is ever loaded into a public answer.
 */
export async function quoteLines(db: Db, input: { lines: unknown; zone?: unknown }, scope: CatalogueScope): Promise<Quote> {
  const lines = validateCartLines(input.lines);
  const zone = DELIVERY_ZONES.includes(input.zone as DeliveryZone) ? (input.zone as DeliveryZone) : null;
  return db.transaction(async (tx) => {
    const rows = lines.length
      ? await tx
          .select({
            productId: products.id,
            sku: variants.sku,
            variantStatus: variants.status,
            productStatus: products.status,
            slug: products.slug,
            nameEn: products.nameEn,
            nameBn: products.nameBn,
            size: variants.size,
            colour: variants.colour,
            pricePaisa: variants.pricePaisa,
            available,
          })
          .from(variants)
          .innerJoin(products, eq(products.id, variants.productId))
          .innerJoin(inventoryBalances, eq(inventoryBalances.variantId, variants.id))
          .where(and(inArray(variants.sku, lines.map((l) => l.sku)), scope === PUBLIC_SCOPE ? scope.visible : undefined))
      : [];
    const productIds = [...new Set(rows.map((r) => r.productId))];
    const photos = productIds.length
      ? await tx
          .selectDistinctOn([productMedia.productId], { productId: productMedia.productId, id: productMedia.id, width: productMedia.width, height: productMedia.height, altEn: productMedia.altEn, altBn: productMedia.altBn })
          .from(productMedia)
          .where(inArray(productMedia.productId, productIds))
          .orderBy(productMedia.productId, asc(productMedia.position))
      : [];
    const quoted = lines.map((line: CartLine): QuotedLine => {
      const r = rows.find((x) => x.sku === line.sku);
      if (!r) return { ...line, status: "unknown", available: 0, unitPricePaisa: null, lineTotalPaisa: null, productSlug: null, nameEn: null, nameBn: null, size: null, colour: null, photo: null };
      const orderable = r.variantStatus === "active" && scope.orderable(r.productStatus);
      const free = Math.max(0, r.available);
      const lineTotal = r.pricePaisa * line.quantity;
      if (!Number.isSafeInteger(lineTotal)) throw new DomainError("INVALID_INPUT", "The cart total is too large.");
      const photo = photos.find((p) => p.productId === r.productId);
      return {
        ...line,
        status: !orderable ? "unavailable" : free < line.quantity ? "insufficient" : "ok",
        available: orderable ? free : 0,
        unitPricePaisa: orderable ? r.pricePaisa : null,
        lineTotalPaisa: orderable ? lineTotal : null,
        productSlug: r.slug,
        nameEn: r.nameEn,
        nameBn: r.nameBn,
        size: r.size,
        colour: r.colour,
        photo: photo ? { id: photo.id, width: photo.width, height: photo.height, altEn: photo.altEn, altBn: photo.altBn } : null,
      };
    });
    const subtotalPaisa = quoted.reduce((sum, l) => sum + (l.lineTotalPaisa ?? 0), 0);
    if (!Number.isSafeInteger(subtotalPaisa)) throw new DomainError("INVALID_INPUT", "The cart total is too large.");
    const zones = await zoneRates(tx);
    const deliveryChargePaisa = zone ? (zones.find((z) => z.code === zone)?.chargePaisa ?? null) : null;
    return {
      lines: quoted,
      subtotalPaisa,
      zone,
      deliveryChargePaisa,
      totalPaisa: deliveryChargePaisa === null ? null : subtotalPaisa + deliveryChargePaisa,
      zones,
      ready: quoted.length > 0 && quoted.every((l) => l.status === "ok") && deliveryChargePaisa !== null,
    };
  }, SNAPSHOT);
}

export type CheckoutInput = { name: unknown; phone: unknown; address: unknown; zone: unknown; lines: unknown };
export type CheckoutError = DetailsError | "zone_required" | "zone_unavailable" | "cart_empty" | "cart_invalid" | "cart_stock";
export type CheckoutResult = {
  ok: boolean;
  errors: Partial<Record<"name" | "phone" | "address" | "zone" | "cart", CheckoutError>>;
  quote: Quote | null;
  /** The validated details, echoed for the simulated summary only; never stored or logged. */
  customer: { name: string; phone: string; address: string } | null;
};

/**
 * The customer checkout, simulated: the same validation an order would get (name, Bangladesh mobile number,
 * address, a configured zone, every line available) and the authoritative total, then nothing else. It never
 * creates an order, reserves stock, writes an idempotency record or contacts anyone; the reads are read-only.
 */
export async function simulateCheckout(db: Db, principal: Principal, input: CheckoutInput): Promise<CheckoutResult> {
  assertPermission(principal, "storefront:preview");
  const details = checkCustomerDetails(input);
  const errors: CheckoutResult["errors"] = { ...details.errors };
  const zoneChosen = DELIVERY_ZONES.includes(input.zone as DeliveryZone);
  if (!zoneChosen) errors.zone = "zone_required";
  let quote: Quote | null = null;
  try {
    quote = await quoteCart(db, principal, { lines: input.lines, zone: input.zone });
    if (quote.lines.length === 0) errors.cart = "cart_empty";
    else if (quote.lines.some((l) => l.status !== "ok")) errors.cart = quote.lines.some((l) => l.status === "insufficient") ? "cart_stock" : "cart_invalid";
    if (zoneChosen && quote.deliveryChargePaisa === null) errors.zone = "zone_unavailable";
  } catch (error) {
    if (!(error instanceof DomainError && error.code === "INVALID_INPUT")) throw error;
    errors.cart = "cart_invalid";
  }
  const ok = Object.keys(errors).length === 0;
  const v = details.values;
  return { ok, errors, quote, customer: ok && v ? { name: v.customerName, phone: v.customerPhone, address: v.deliveryAddress } : null };
}
