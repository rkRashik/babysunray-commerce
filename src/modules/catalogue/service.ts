import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  type Db,
  PG_CHECK_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  PG_UNIQUE_VIOLATION,
  pgErrorCode,
} from "@/db/database";
import { inventoryBalances, productCategories, productMeasurements, productMedia, products, variants } from "@/db/schema";
import type { Actor } from "../actor";
import { DomainError } from "../domain-error";
import { contentText, type Measurement, MEASUREMENT_POINTS, validateMeasurements } from "./content";
import { MET } from "./preparation";
import type { PreparationItem } from "./readiness";
import { normalizeSearch, normalizeSku, slugify, optionalText, validateId, validatePricePaisa, validateSlug, validateVersion } from "./rules";

export type Product = typeof products.$inferSelect;
export type Variant = typeof variants.$inferSelect;
export type Category = typeof productCategories.$inferSelect;
export type ProductMedia = typeof productMedia.$inferSelect;
/** A product with everything Admin, the API and the storefront preview show about it. */
export type ProductDetail = Product & { variants: Variant[]; measurements: Measurement[]; media: ProductMedia[]; category: Category | null };

export type NewProduct = {
  slug: string;
  nameEn?: string | null;
  nameBn?: string | null;
  descriptionEn?: string | null;
  descriptionBn?: string | null;
};

export type NewVariant = {
  productId: string;
  sku: string;
  size?: string | null;
  colour?: string | null;
  pricePaisa: number;
};

/**
 * A free web address for a new product named `name`: the name's stem, else the stem with -2, -3 … after it. A suggestion
 * only: the unique index still decides at creation, and the Owner may edit it.
 */
export async function suggestUniqueSlug(db: Db, name: string): Promise<string> {
  const base = slugify(name);
  // The stem has only a-z, 0-9 and hyphens, so nothing in it needs LIKE escaping.
  const pattern = `${base}-%`;
  const rows = await db.select({ slug: products.slug }).from(products).where(sql`${products.slug} = ${base} or ${products.slug} like ${pattern}`).limit(500);
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n <= 500; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${Date.now().toString(36)}`;
}

/** Creates a draft product. Drafts may be incomplete but need a name in at least one language. */
export async function createProduct(db: Db, input: NewProduct): Promise<Product> {
  const values = {
    slug: validateSlug(input.slug),
    nameEn: optionalText(input.nameEn, "nameEn", 200),
    nameBn: optionalText(input.nameBn, "nameBn", 200),
    descriptionEn: optionalText(input.descriptionEn, "descriptionEn", 5000),
    descriptionBn: optionalText(input.descriptionBn, "descriptionBn", 5000),
  };
  if (values.nameEn === null && values.nameBn === null) {
    throw new DomainError("INVALID_INPUT", "A product needs a name in English or Bangla.");
  }
  try {
    const [product] = await db.insert(products).values(values).returning();
    return product;
  } catch (error) {
    throw mapWriteError(error, { [PG_UNIQUE_VIOLATION]: "SLUG_TAKEN" });
  }
}

/**
 * Archives a product. Products are never deleted (requirement I-11). Archiving twice is harmless. A published
 * product is withdrawn first (publication.ts), so its removal from the shop is recorded in the publication history.
 */
export async function archiveProduct(db: Db, productId: string): Promise<Product> {
  const id = validateId(productId, "productId");
  const [product] = await db
    .update(products)
    .set({ status: "archived", version: sql`${products.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(products.id, id), sql`${products.status} <> 'published'`))
    .returning();
  if (product) return product;
  const [existing] = await db.select({ id: products.id }).from(products).where(eq(products.id, id));
  if (!existing) throw new DomainError("PRODUCT_NOT_FOUND", "Product not found.");
  throw new DomainError("PRODUCT_NOT_EDITABLE", "A published product is withdrawn from the shop before it is archived.");
}

/**
 * Creates a sellable SKU and its zero inventory balance in one transaction, for a draft product only: an archived
 * (or published) product's SKUs are not changed here. The product row is locked FOR SHARE, so it cannot be
 * archived, reviewed or published while the SKU is being added.
 */
export async function createVariant(db: Db, input: NewVariant): Promise<Variant> {
  const values = {
    productId: validateId(input.productId, "productId"),
    sku: normalizeSku(input.sku),
    size: optionalText(input.size, "size", 64),
    colour: optionalText(input.colour, "colour", 64),
    pricePaisa: validatePricePaisa(input.pricePaisa),
  };
  try {
    return await db.transaction(async (tx) => {
      const [product] = await tx.select({ status: products.status }).from(products).where(eq(products.id, values.productId)).for("share");
      if (!product) throw new DomainError("PRODUCT_NOT_FOUND", "Product not found.");
      if (product.status !== "draft") throw new DomainError("PRODUCT_NOT_EDITABLE", "Only a draft product can get a new variant.");
      const [variant] = await tx.insert(variants).values(values).returning();
      await tx.insert(inventoryBalances).values({ variantId: variant.id });
      return variant;
    });
  } catch (error) {
    throw mapWriteError(error, {
      [PG_UNIQUE_VIOLATION]: "SKU_TAKEN",
      [PG_FOREIGN_KEY_VIOLATION]: "PRODUCT_NOT_FOUND",
    });
  }
}

/** Marks a variant inactive. Variants are never deleted (requirement I-11). */
export async function deactivateVariant(db: Db, variantId: string): Promise<Variant> {
  const id = validateId(variantId, "variantId");
  return db.transaction(async (tx) => {
    // The product row first (FOR SHARE), like every other change to a product's content, so a deactivation never
    // overlaps a review or a publication. A published product's SKU may still be deactivated: it stops being sold.
    const [owner] = await tx.select({ productId: variants.productId }).from(variants).where(eq(variants.id, id));
    if (!owner) throw new DomainError("VARIANT_NOT_FOUND", "Variant not found.");
    await tx.select({ id: products.id }).from(products).where(eq(products.id, owner.productId)).for("share");
    const [variant] = await tx
      .update(variants)
      .set({ status: "inactive", version: sql`${variants.version} + 1`, updatedAt: sql`now()` })
      .where(eq(variants.id, id))
      .returning();
    return variant;
  });
}

/**
 * The editable content of a draft product. Absent: unchanged. null or blank: cleared. Slug and id never change.
 * `fabricConfirmed: true` records that the Owner confirmed the fabric statement as sent (requirement S-11);
 * any change to the fabric text without it clears an earlier confirmation.
 */
export type ProductChanges = Partial<
  Pick<NewProduct, "nameEn" | "nameBn" | "descriptionEn" | "descriptionBn"> & {
    fabricEn: string | null;
    fabricBn: string | null;
    careEn: string | null;
    careBn: string | null;
    sizeGuidanceEn: string | null;
    sizeGuidanceBn: string | null;
    categoryId: string | null;
    featured: boolean;
    fabricConfirmed: boolean;
  }
>;
/** The editable fields of a variant. Absent: unchanged; size and colour may be cleared. SKU and id never change. */
export type VariantChanges = { size?: string | null; colour?: string | null; pricePaisa?: number };

const conflict = (what: string) =>
  new DomainError("VERSION_CONFLICT", `This ${what} was changed after you loaded it. Reload it, check the current values and make your change again.`);

type ProductSet = Partial<Pick<Product, "nameEn" | "nameBn" | "descriptionEn" | "descriptionBn" | "fabricEn" | "fabricBn" | "careEn" | "careBn" | "sizeGuidanceEn" | "sizeGuidanceBn" | "categoryId" | "featured">>;

/** Locks a draft product at the expected version, or throws (not found, archived, stale). */
async function lockDraft(tx: Db, id: string, version: number): Promise<Product> {
  const [current] = await tx.select().from(products).where(eq(products.id, id)).for("update");
  if (!current) throw new DomainError("PRODUCT_NOT_FOUND", "Product not found.");
  if (current.status !== "draft") throw new DomainError("PRODUCT_NOT_EDITABLE", "Only a draft product can be edited (this one is archived or published).");
  if (current.version !== version) throw conflict("product");
  return current;
}

/** Adds one to a locked product's version: every content, measurement or photo change goes through here. */
export async function bumpProductVersion(tx: Db, id: string, set: Record<string, unknown> = {}): Promise<Product> {
  const [product] = await tx
    .update(products)
    .set({ ...set, version: sql`${products.version} + 1`, updatedAt: sql`now()` })
    .where(eq(products.id, id))
    .returning();
  return product;
}

/** Locks a draft product for a change by its id and the version the client last saw (photos, measurements). */
export async function lockDraftProduct(tx: Db, productId: string, expectedVersion: number): Promise<Product> {
  return lockDraft(tx, validateId(productId, "productId"), validateVersion(expectedVersion));
}

/**
 * Edits a draft product's content if it is still at `expectedVersion`, and adds one to its version. The row
 * is locked first, so of two edits based on the same version exactly one succeeds and the other gets
 * VERSION_CONFLICT. Archived products are not edited (and never turned back into drafts). Confirming the
 * fabric statement records the acting user and the time; it needs fabric text in at least one language.
 */
export async function updateProduct(db: Db, productId: string, expectedVersion: number, changes: ProductChanges, actor?: Actor): Promise<Product> {
  const id = validateId(productId, "productId");
  const version = validateVersion(expectedVersion);
  const set: ProductSet = {};
  for (const [field, max] of [["nameEn", 200], ["nameBn", 200], ["descriptionEn", 5000], ["descriptionBn", 5000]] as const) {
    if (changes[field] !== undefined) set[field] = optionalText(changes[field], field, max);
  }
  for (const field of ["fabricEn", "fabricBn", "careEn", "careBn", "sizeGuidanceEn", "sizeGuidanceBn"] as const) {
    if (changes[field] !== undefined) set[field] = contentText(changes[field], field);
  }
  if (changes.categoryId !== undefined) set.categoryId = changes.categoryId === null ? null : validateId(changes.categoryId, "categoryId");
  if (changes.featured !== undefined) {
    if (typeof changes.featured !== "boolean") throw new DomainError("INVALID_INPUT", "featured must be true or false.");
    set.featured = changes.featured;
  }
  if (changes.fabricConfirmed !== undefined && typeof changes.fabricConfirmed !== "boolean") throw new DomainError("INVALID_INPUT", "fabricConfirmed must be true or false.");
  if (Object.keys(set).length === 0 && changes.fabricConfirmed === undefined) throw new DomainError("INVALID_INPUT", "Nothing to change: send at least one field.");
  try {
    return await db.transaction(async (tx) => {
      const current = await lockDraft(tx, id, version);
      const next = { ...current, ...set };
      if (next.nameEn === null && next.nameBn === null) throw new DomainError("INVALID_INPUT", "A product needs a name in English or Bangla.");
      const fabricChanged = next.fabricEn !== current.fabricEn || next.fabricBn !== current.fabricBn;
      let confirmation: { fabricConfirmedAt: Date | ReturnType<typeof sql> | null; fabricConfirmedByUserId: string | null } | null = null;
      if (changes.fabricConfirmed === true) {
        if (next.fabricEn === null && next.fabricBn === null) throw new DomainError("INVALID_INPUT", "Enter the fabric statement before confirming it.");
        if (actor?.type !== "user") throw new DomainError("INVALID_INPUT", "Only a signed-in user can confirm a fabric statement.");
        confirmation = fabricChanged || current.fabricConfirmedAt === null ? { fabricConfirmedAt: sql`now()`, fabricConfirmedByUserId: actor.ref } : null;
      } else if (changes.fabricConfirmed === false || fabricChanged) {
        confirmation = { fabricConfirmedAt: null, fabricConfirmedByUserId: null };
      }
      return bumpProductVersion(tx, id, { ...set, ...(confirmation ?? {}) });
    });
  } catch (error) {
    throw mapWriteError(error, { [PG_FOREIGN_KEY_VIOLATION]: "CATEGORY_NOT_FOUND" });
  }
}

/**
 * Replaces a draft product's whole size chart (validated by validateMeasurements; an empty list removes it)
 * if the product is still at `expectedVersion`, and adds one to its version.
 */
export async function replaceMeasurements(db: Db, productId: string, expectedVersion: number, rows: { size: string; point: string; valueMm: number }[]): Promise<Product> {
  const id = validateId(productId, "productId");
  const version = validateVersion(expectedVersion);
  const measurements = validateMeasurements(rows);
  return db.transaction(async (tx) => {
    await lockDraft(tx, id, version);
    await tx.delete(productMeasurements).where(eq(productMeasurements.productId, id));
    if (measurements.length) await tx.insert(productMeasurements).values(measurements.map((m) => ({ productId: id, ...m })));
    return bumpProductVersion(tx, id);
  });
}

export type NewCategory = { slug: string; nameEn?: string | null; nameBn?: string | null };

const categoryNames = (input: { nameEn?: string | null; nameBn?: string | null }) => ({
  nameEn: optionalText(input.nameEn, "nameEn", 100),
  nameBn: optionalText(input.nameBn, "nameBn", 100),
});

/** Creates an Owner-defined category: an ASCII slug and a name in English or Bangla (or both). */
export async function createCategory(db: Db, input: NewCategory): Promise<Category> {
  const values = { slug: validateSlug(input.slug), ...categoryNames(input) };
  if (values.nameEn === null && values.nameBn === null) throw new DomainError("INVALID_INPUT", "A category needs a name in English or Bangla.");
  try {
    const [category] = await db.insert(productCategories).values(values).returning();
    return category;
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) throw new DomainError("SLUG_TAKEN", "A category with this slug already exists.");
    throw mapWriteError(error, {});
  }
}

/** Renames a category if it is still at `expectedVersion`. The slug never changes. */
export async function updateCategory(db: Db, categoryId: string, expectedVersion: number, input: { nameEn?: string | null; nameBn?: string | null }): Promise<Category> {
  const id = validateId(categoryId, "categoryId");
  const version = validateVersion(expectedVersion);
  const names = categoryNames(input);
  if (names.nameEn === null && names.nameBn === null) throw new DomainError("INVALID_INPUT", "A category needs a name in English or Bangla.");
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(productCategories).where(eq(productCategories.id, id)).for("update");
    if (!current) throw new DomainError("CATEGORY_NOT_FOUND", "Category not found.");
    if (current.version !== version) throw conflict("category");
    const [category] = await tx
      .update(productCategories)
      .set({ ...names, version: sql`${productCategories.version} + 1`, updatedAt: sql`now()` })
      .where(eq(productCategories.id, id))
      .returning();
    return category;
  });
}

export const listCategories = (db: Db) => db.select().from(productCategories).orderBy(asc(productCategories.slug));

export async function getCategory(db: Db, categoryId: string): Promise<Category> {
  const [category] = await db.select().from(productCategories).where(eq(productCategories.id, validateId(categoryId, "categoryId")));
  if (!category) throw new DomainError("CATEGORY_NOT_FOUND", "Category not found.");
  return category;
}

/**
 * Edits an active variant's size, colour and price if it is still at `expectedVersion`. The variant and its
 * product are locked together, so the product cannot be archived halfway through. Variants of archived
 * products and inactive variants are not edited. Stock is never touched here.
 */
export async function updateVariant(db: Db, variantId: string, expectedVersion: number, changes: VariantChanges): Promise<Variant> {
  const id = validateId(variantId, "variantId");
  const version = validateVersion(expectedVersion);
  const set: { size?: string | null; colour?: string | null; pricePaisa?: number } = {};
  if (changes.size !== undefined) set.size = optionalText(changes.size, "size", 64);
  if (changes.colour !== undefined) set.colour = optionalText(changes.colour, "colour", 64);
  if (changes.pricePaisa !== undefined) set.pricePaisa = validatePricePaisa(changes.pricePaisa);
  if (Object.keys(set).length === 0) throw new DomainError("INVALID_INPUT", "Nothing to change: send at least one field.");
  return db.transaction(async (tx) => {
    // Lock order for every content change: the product row first, then the variant. A single join FOR UPDATE could
    // lock the variant first and deadlock with deactivateVariant, which locks the product first.
    const [owner] = await tx.select({ productId: variants.productId }).from(variants).where(eq(variants.id, id));
    if (!owner) throw new DomainError("VARIANT_NOT_FOUND", "Variant not found.");
    await tx.select({ id: products.id }).from(products).where(eq(products.id, owner.productId)).for("share");
    const [current] = await tx
      .select({ variant: variants, productStatus: products.status })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(eq(variants.id, id))
      .for("update", { of: variants });
    if (!current) throw new DomainError("VARIANT_NOT_FOUND", "Variant not found.");
    if (current.productStatus !== "draft") throw new DomainError("VARIANT_NOT_EDITABLE", "A variant of an archived or published product cannot be edited.");
    if (current.variant.status !== "active") throw new DomainError("VARIANT_NOT_EDITABLE", "An inactive variant cannot be edited.");
    if (current.variant.version !== version) throw conflict("variant");
    const [variant] = await tx
      .update(variants)
      .set({ ...set, version: current.variant.version + 1, updatedAt: sql`now()` })
      .where(eq(variants.id, id))
      .returning();
    return variant;
  });
}

const MESSAGES = {
  SLUG_TAKEN: "A product with this slug already exists.",
  SKU_TAKEN: "A variant with this SKU already exists.",
  PRODUCT_NOT_FOUND: "Product not found.",
  CATEGORY_NOT_FOUND: "Category not found.",
} as const;

function mapWriteError(error: unknown, codes: Record<string, keyof typeof MESSAGES>): unknown {
  const sqlState = pgErrorCode(error);
  const code = sqlState ? codes[sqlState] : undefined;
  if (code) return new DomainError(code, MESSAGES[code]);
  // Validation above mirrors every CHECK constraint, so this only fires if they drift apart.
  if (sqlState === PG_CHECK_VIOLATION) return new DomainError("INVALID_INPUT", "The values are not valid.");
  return error;
}

/** Keyset position in the product list: PostgreSQL's exact created_at (microseconds) and the id. */
export type ProductKey = { createdAt: string; id: string };
export type ProductPage = { items: (Product & { key: ProductKey })[]; hasMore: boolean };

// created_at as UTC text with microseconds, so a page boundary never loses precision in a JS Date.
const createdAtKey = sql<string>`to_char(${products.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Search condition: `term` anywhere in the slug, either name or any of the product's SKUs, case-insensitive
 * (ILIKE). Both sides are NFC-normalised, so Bangla typed with combining characters matches the same text
 * stored precomposed. The term is a bound parameter; % _ and \ in it are escaped, so they match themselves.
 */
function matches(term: string) {
  const pattern = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return sql`(${products.slug} ilike ${pattern}
    or normalize(${products.nameEn}, NFC) ilike ${pattern}
    or normalize(${products.nameBn}, NFC) ilike ${pattern}
    or exists (select 1 from ${variants} where ${variants.productId} = ${products.id} and ${variants.sku} ilike ${pattern}))`;
}

/**
 * Products oldest first, ordered by (created_at, id) so rows created in the same microsecond still have a
 * fixed order. `after` continues from the last row of the previous page; filters (status, search) apply to
 * every page alike. For Admin only: products of every status; nothing here is a public read.
 * Without an index the search reads every product row, which suits a small catalogue.
 */
export async function listProducts(
  db: Db,
  options: {
    limit: number;
    status?: Product["status"];
    after?: ProductKey;
    q?: string;
    /** Only products in this category. */
    categoryId?: string;
    /** Only products that do not yet meet this readiness item (preparation.ts). */
    missing?: PreparationItem;
    /** "in": some active SKU has units available; "out": none has. */
    stock?: "in" | "out";
  },
): Promise<ProductPage> {
  const { limit, status, after, missing, stock } = options;
  const categoryId = options.categoryId === undefined ? undefined : validateId(options.categoryId, "categoryId");
  const anyAvailable = sql`exists (select 1 from ${variants} sv join ${inventoryBalances} sb on sb.variant_id = sv.id where sv.product_id = ${products.id} and sv.status = 'active' and sb.on_hand - sb.reserved > 0)`;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new DomainError("INVALID_INPUT", "limit must be 1 to 100.");
  const term = options.q === undefined ? null : normalizeSearch(options.q);
  const rows = await db
    .select({ product: products, key: createdAtKey })
    .from(products)
    .where(
      and(
        status ? eq(products.status, status) : undefined,
        term ? matches(term) : undefined,
        categoryId ? eq(products.categoryId, categoryId) : undefined,
        missing ? sql`not ${MET[missing]}` : undefined,
        // "Still missing" is a preparation list: archived products are left out unless the Archived status is chosen.
        missing && !status ? sql`${products.status} <> 'archived'` : undefined,
        stock === "in" ? anyAvailable : stock === "out" ? sql`not ${anyAvailable}` : undefined,
        after
          ? sql`(${products.createdAt}, ${products.id}) > (${after.createdAt}::timestamptz, ${validateId(after.id, "cursor")}::uuid)`
          : undefined,
      ),
    )
    .orderBy(asc(products.createdAt), asc(products.id))
    .limit(limit + 1);
  return {
    items: rows.slice(0, limit).map((r) => ({ ...r.product, key: { createdAt: r.key, id: r.product.id } })),
    hasMore: rows.length > limit,
  };
}

/** What the Admin product list shows beside each product: active-variant prices and stock, the first photo, the category. */
export type ProductListSummary = {
  activeVariants: number;
  minPricePaisa: number | null;
  maxPricePaisa: number | null;
  /** Units available to sell: on hand minus reserved, active variants only. */
  availableUnits: number;
  /** Units physically held, every variant of the product (an archived product's stock is still in the room). */
  onHandUnits: number;
  firstMediaId: string | null;
  categoryName: string | null;
};

/**
 * The list summary of these products (one page of the list), in one query whatever their number. Stock counts only
 * active variants; available is on hand minus reserved, never below zero per variant.
 */
export async function productListSummaries(db: Db, productIds: string[]): Promise<Map<string, ProductListSummary>> {
  if (productIds.length === 0) return new Map();
  const ids = productIds.map((id) => validateId(id, "productId"));
  // Spelled out: in a single-table select drizzle writes a bare "id", which a subquery would bind to its own table.
  const outerId = sql.raw(`"products"."id"`);
  const outerCategory = sql.raw(`"products"."category_id"`);
  const rows = await db
    .select({
      id: products.id,
      activeVariants: sql<number>`(select count(*) from ${variants} v where v.product_id = ${outerId} and v.status = 'active')`.mapWith(Number),
      minPricePaisa: sql<number | null>`(select min(v.price_paisa) from ${variants} v where v.product_id = ${outerId} and v.status = 'active')`,
      maxPricePaisa: sql<number | null>`(select max(v.price_paisa) from ${variants} v where v.product_id = ${outerId} and v.status = 'active')`,
      availableUnits: sql<number>`(select coalesce(sum(greatest(b.on_hand - b.reserved, 0)), 0) from ${variants} v join ${inventoryBalances} b on b.variant_id = v.id where v.product_id = ${outerId} and v.status = 'active')`.mapWith(Number),
      onHandUnits: sql<number>`(select coalesce(sum(b.on_hand), 0) from ${variants} v join ${inventoryBalances} b on b.variant_id = v.id where v.product_id = ${outerId})`.mapWith(Number),
      firstMediaId: sql<string | null>`(select m.id from ${productMedia} m where m.product_id = ${outerId} order by m.position, m.created_at limit 1)`,
      categoryName: sql<string | null>`(select coalesce(c.name_en, c.name_bn, c.slug) from ${productCategories} c where c.id = ${outerCategory})`,
    })
    .from(products)
    .where(inArray(products.id, ids));
  return new Map(
    rows.map(({ id, minPricePaisa, maxPricePaisa, ...rest }) => [
      id,
      { ...rest, minPricePaisa: minPricePaisa === null ? null : Number(minPricePaisa), maxPricePaisa: maxPricePaisa === null ? null : Number(maxPricePaisa) },
    ]),
  );
}

export async function getVariant(db: Db, variantId: string): Promise<Variant> {
  const [variant] = await db.select().from(variants).where(eq(variants.id, validateId(variantId, "variantId")));
  if (!variant) throw new DomainError("VARIANT_NOT_FOUND", "Variant not found.");
  return variant;
}

/**
 * One product with its variants (by SKU), size chart (by size, then point), photos (by position) and
 * category, read from one snapshot, one query at a time (a savepoint when `db` is already a transaction).
 */
export async function getProductWithVariants(db: Db, productId: string): Promise<ProductDetail> {
  const id = validateId(productId, "productId");
  return db.transaction(
    async (tx) => {
      const [product] = await tx.select().from(products).where(eq(products.id, id));
      if (!product) throw new DomainError("PRODUCT_NOT_FOUND", "Product not found.");
      const productVariants = await tx.select().from(variants).where(eq(variants.productId, id)).orderBy(asc(variants.sku));
      const rows = await tx.select().from(productMeasurements).where(eq(productMeasurements.productId, id));
      const media = await tx.select().from(productMedia).where(eq(productMedia.productId, id)).orderBy(asc(productMedia.position), asc(productMedia.createdAt));
      const [category] = product.categoryId ? await tx.select().from(productCategories).where(eq(productCategories.id, product.categoryId)) : [];
      const measurements = rows
        .map(({ size, point, valueMm }) => ({ size, point, valueMm }))
        .sort((a, b) => (a.size < b.size ? -1 : a.size > b.size ? 1 : MEASUREMENT_POINTS.indexOf(a.point) - MEASUREMENT_POINTS.indexOf(b.point)));
      return { ...product, variants: productVariants, measurements, media, category: category ?? null };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
