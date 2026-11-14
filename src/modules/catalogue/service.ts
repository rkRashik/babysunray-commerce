import "server-only";
import { eq, sql } from "drizzle-orm";
import {
  type Db,
  PG_CHECK_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  PG_UNIQUE_VIOLATION,
  pgErrorCode,
} from "@/db/database";
import { inventoryBalances, products, variants } from "@/db/schema";
import { DomainError } from "../domain-error";
import { normalizeSku, optionalText, validateId, validatePricePaisa, validateSlug } from "./rules";

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
    .set({ status: "archived", updatedAt: sql`now()` })
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
    .set({ status: "inactive", updatedAt: sql`now()` })
    .where(eq(variants.id, validateId(variantId, "variantId")))
    .returning();
  if (!variant) throw new DomainError("VARIANT_NOT_FOUND", "Variant not found.");
  return variant;
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
