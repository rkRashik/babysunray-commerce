import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  type Db,
  PG_CHECK_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  PG_UNIQUE_VIOLATION,
  pgErrorCode,
} from "@/db/database";
import { inventoryBalances, products, variants } from "@/db/schema";
import { DomainError } from "../domain-error";
import { normalizeSearch, normalizeSku, optionalText, validateId, validatePricePaisa, validateSlug, validateVersion } from "./rules";

export type Product = typeof products.$inferSelect;
export type Variant = typeof variants.$inferSelect;

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

/** Archives a product. Products are never deleted (requirement I-11). Archiving twice is harmless. */
export async function archiveProduct(db: Db, productId: string): Promise<Product> {
  const [product] = await db
    .update(products)
    .set({ status: "archived", version: sql`${products.version} + 1`, updatedAt: sql`now()` })
    .where(eq(products.id, validateId(productId, "productId")))
    .returning();
  if (!product) throw new DomainError("PRODUCT_NOT_FOUND", "Product not found.");
  return product;
}

/** Creates a sellable SKU and its zero inventory balance in one transaction. */
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
  const [variant] = await db
    .update(variants)
    .set({ status: "inactive", version: sql`${variants.version} + 1`, updatedAt: sql`now()` })
    .where(eq(variants.id, validateId(variantId, "variantId")))
    .returning();
  if (!variant) throw new DomainError("VARIANT_NOT_FOUND", "Variant not found.");
  return variant;
}

/** The editable text of a draft product. Absent: unchanged. null or blank: cleared. Slug and id never change. */
export type ProductChanges = Partial<Pick<NewProduct, "nameEn" | "nameBn" | "descriptionEn" | "descriptionBn">>;
/** The editable fields of a variant. Absent: unchanged; size and colour may be cleared. SKU and id never change. */
export type VariantChanges = { size?: string | null; colour?: string | null; pricePaisa?: number };

const conflict = (what: string) =>
  new DomainError("VERSION_CONFLICT", `This ${what} was changed after you loaded it. Reload it, check the current values and make your change again.`);

/**
 * Edits a draft product's names and descriptions if it is still at `expectedVersion`, and adds one to its
 * version. The row is locked first, so of two edits based on the same version exactly one succeeds and the
 * other gets VERSION_CONFLICT. Archived products are not edited (and never turned back into drafts).
 */
export async function updateProduct(db: Db, productId: string, expectedVersion: number, changes: ProductChanges): Promise<Product> {
  const id = validateId(productId, "productId");
  const version = validateVersion(expectedVersion);
  const set: { nameEn?: string | null; nameBn?: string | null; descriptionEn?: string | null; descriptionBn?: string | null } = {};
  for (const [field, max] of [["nameEn", 200], ["nameBn", 200], ["descriptionEn", 5000], ["descriptionBn", 5000]] as const) {
    if (changes[field] !== undefined) set[field] = optionalText(changes[field], field, max);
  }
  if (Object.keys(set).length === 0) throw new DomainError("INVALID_INPUT", "Nothing to change: send at least one field.");
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(products).where(eq(products.id, id)).for("update");
    if (!current) throw new DomainError("PRODUCT_NOT_FOUND", "Product not found.");
    if (current.status !== "draft") throw new DomainError("PRODUCT_NOT_EDITABLE", "An archived product cannot be edited.");
    if (current.version !== version) throw conflict("product");
    const next = { ...current, ...set };
    if (next.nameEn === null && next.nameBn === null) throw new DomainError("INVALID_INPUT", "A product needs a name in English or Bangla.");
    const [product] = await tx
      .update(products)
      .set({ ...set, version: current.version + 1, updatedAt: sql`now()` })
      .where(eq(products.id, id))
      .returning();
    return product;
  });
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
    const [current] = await tx
      .select({ variant: variants, productStatus: products.status })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(eq(variants.id, id))
      .for("update");
    if (!current) throw new DomainError("VARIANT_NOT_FOUND", "Variant not found.");
    if (current.productStatus !== "draft") throw new DomainError("VARIANT_NOT_EDITABLE", "A variant of an archived product cannot be edited.");
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
 * every page alike. For the Owner Office only: every product here is a draft or archived, and none is public.
 * Without an index the search reads every product row, which suits a small catalogue.
 */
export async function listProducts(
  db: Db,
  options: { limit: number; status?: Product["status"]; after?: ProductKey; q?: string },
): Promise<ProductPage> {
  const { limit, status, after } = options;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new DomainError("INVALID_INPUT", "limit must be 1 to 100.");
  const term = options.q === undefined ? null : normalizeSearch(options.q);
  const rows = await db
    .select({ product: products, key: createdAtKey })
    .from(products)
    .where(
      and(
        status ? eq(products.status, status) : undefined,
        term ? matches(term) : undefined,
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

export async function getVariant(db: Db, variantId: string): Promise<Variant> {
  const [variant] = await db.select().from(variants).where(eq(variants.id, validateId(variantId, "variantId")));
  if (!variant) throw new DomainError("VARIANT_NOT_FOUND", "Variant not found.");
  return variant;
}

/** One product with its variants (ordered by SKU). */
export async function getProductWithVariants(db: Db, productId: string): Promise<Product & { variants: Variant[] }> {
  const id = validateId(productId, "productId");
  const [product] = await db.select().from(products).where(eq(products.id, id));
  if (!product) throw new DomainError("PRODUCT_NOT_FOUND", "Product not found.");
  const productVariants = await db.select().from(variants).where(eq(variants.productId, id)).orderBy(asc(variants.sku));
  return { ...product, variants: productVariants };
}
