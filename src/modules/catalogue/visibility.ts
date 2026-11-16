import "server-only";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import { products, variants } from "@/db/schema";
import { normalizeSku } from "./rules";

// What a customer may see or order (Gate H.32): only published products, and of them only active SKUs. One
// definition for the public catalogue (src/modules/storefront/public-catalogue.ts) and the guest checkout, so
// nothing can be ordered that is not shown, and nothing draft, archived or withdrawn is ever shown. No product is
// published while no publication rule is approved (publication.ts), so today both see nothing.

/** SQL condition on `products`: the product is published. */
export const publishedProduct = sql`${products.status} = 'published'`;

/**
 * SKUs (canonical) among `skus` that a customer may not order: unknown, inactive, or of a product that is not
 * published. The products are locked FOR SHARE, so a withdrawal or archive cannot commit while the caller's
 * transaction relies on the answer.
 */
export async function skusNotOrderableByCustomers(tx: Db, skus: string[]): Promise<string[]> {
  const wanted = [...new Set(skus.map((s) => normalizeSku(s)))];
  if (wanted.length === 0) return [];
  const rows = await tx
    .select({ sku: variants.sku, variantStatus: variants.status, productStatus: products.status })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(inArray(variants.sku, wanted))
    .for("share", { of: products });
  const orderable = new Set(rows.filter((r) => r.variantStatus === "active" && r.productStatus === "published").map((r) => r.sku));
  return wanted.filter((s) => !orderable.has(s));
}
