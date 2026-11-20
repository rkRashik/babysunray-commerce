import "server-only";
import { inArray } from "drizzle-orm";
import type { Db } from "@/db/database";
import { products } from "@/db/schema";
import { assertPermission, type Principal } from "../auth/principal";
import { DomainError, invalidInput } from "../domain-error";
import { archiveProductOnce, updateProductOnce } from "./operations";
import { validateId } from "./rules";

// Bulk catalogue steps for the product list: the same single-product operations, one product at a time, each in its own
// transaction with its own idempotency key. A product that cannot take the step (it changed, it is not a draft any more)
// comes back as a failed result and never stops or undoes the others. Only steps on draft products and only reversible or
// one-product-at-a-time-safe ones are offered: setting a category, and archiving. Publishing stays one product at a time,
// after its own review.

export type ProductBulkAction = { kind: "archive" } | { kind: "category"; categoryId: string | null };
export type ProductBulkItem = { productId: string; expectedVersion: number };
export type ProductBulkResult = { productId: string; name: string; ok: boolean; message: string };
export const MAX_BULK_PRODUCTS = 50;

export async function bulkProducts(db: Db, principal: Principal, batchKey: string, action: ProductBulkAction, items: ProductBulkItem[]): Promise<ProductBulkResult[]> {
  assertPermission(principal, "catalog:write");
  if (items.length === 0) throw invalidInput("products", "select at least one product");
  if (items.length > MAX_BULK_PRODUCTS) throw invalidInput("products", `at most ${MAX_BULK_PRODUCTS} at a time`);
  const ids = items.map((i) => validateId(i.productId, "productId"));
  if (new Set(ids).size !== ids.length) throw invalidInput("products", "a product appears twice");
  if (!/^[A-Za-z0-9_.:-]{8,64}$/.test(batchKey)) throw invalidInput("batch", "is not valid");
  const category = action.kind === "category" ? (action.categoryId === null ? null : validateId(action.categoryId, "categoryId")) : null;

  const known = new Map((await db.select({ id: products.id, nameEn: products.nameEn, nameBn: products.nameBn, slug: products.slug, version: products.version }).from(products).where(inArray(products.id, ids))).map((r) => [r.id, r]));
  const results: ProductBulkResult[] = [];
  for (const item of items) {
    const row = known.get(item.productId);
    const name = row ? (row.nameEn ?? row.nameBn ?? row.slug) : "Product";
    const key = `bulk:${batchKey}:${item.productId}`;
    try {
      // Archiving takes no version of its own: check the one the Owner's list showed, like every other change.
      if (action.kind === "archive" && row && row.version !== item.expectedVersion) throw new DomainError("VERSION_CONFLICT", "This product changed after you loaded the list. Reload it and try again.");
      if (action.kind === "archive") await archiveProductOnce(db, principal, key, item.productId);
      else await updateProductOnce(db, principal, key, { productId: item.productId, expectedVersion: item.expectedVersion, changes: { categoryId: category } });
      results.push({ productId: item.productId, name, ok: true, message: action.kind === "archive" ? "Archived." : category === null ? "Category removed." : "Category set." });
    } catch (error) {
      if (error instanceof DomainError) results.push({ productId: item.productId, name, ok: false, message: error.message });
      else {
        console.error("A bulk product step failed unexpectedly.", action.kind, (error as { code?: string })?.code ?? "");
        results.push({ productId: item.productId, name, ok: false, message: "This product could not be updated. Check it, then try again." });
      }
    }
  }
  return results;
}
