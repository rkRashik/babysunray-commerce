import "server-only";
import type { Db } from "@/db/database";
import { actorFor, assertPermission, type Principal } from "../auth/principal";
import { type Once, runOnce } from "../idempotency/service";
import {
  archiveProduct,
  type Category,
  createCategory,
  createProduct,
  createVariant,
  deactivateVariant,
  getCategory,
  getProductWithVariants,
  getVariant,
  type NewCategory,
  type NewProduct,
  type NewVariant,
  type ProductChanges,
  type ProductDetail,
  replaceMeasurements,
  updateCategory,
  updateProduct,
  updateVariant,
  type Variant,
  type VariantChanges,
} from "./service";
import { recordProductReview } from "./review";

// Draft catalogue changes for every client (the /api/v1 routes and Admin). Each requires
// `catalog:write` and runs once per idempotency key. A replay returns the resource as it is now (a product
// may have been archived since); nothing here publishes a product (requirement I-6 is open).

type ProductWithVariants = ProductDetail;
const loadProduct = (db: Db, ref: { productId: string }) => getProductWithVariants(db, ref.productId);
const loadVariant = (db: Db, ref: { variantId: string }) => getVariant(db, ref.variantId);

export async function createProductOnce(db: Db, principal: Principal, idempotencyKey: string, input: NewProduct): Promise<Once<ProductWithVariants>> {
  const user = assertPermission(principal, "catalog:write");
  const request = {
    slug: input.slug,
    nameEn: input.nameEn ?? null,
    nameBn: input.nameBn ?? null,
    descriptionEn: input.descriptionEn ?? null,
    descriptionBn: input.descriptionBn ?? null,
  };
  return runOnce(
    db,
    { userId: user.userId, operation: "catalog.product.create", key: idempotencyKey, request },
    async (tx) => ({ productId: (await createProduct(tx, request)).id }),
    loadProduct,
  );
}

export async function createVariantOnce(db: Db, principal: Principal, idempotencyKey: string, input: NewVariant): Promise<Once<Variant>> {
  const user = assertPermission(principal, "catalog:write");
  const request = {
    productId: input.productId,
    sku: input.sku,
    size: input.size ?? null,
    colour: input.colour ?? null,
    pricePaisa: input.pricePaisa,
  };
  return runOnce(
    db,
    { userId: user.userId, operation: "catalog.variant.create", key: idempotencyKey, request },
    async (tx) => ({ variantId: (await createVariant(tx, request)).id }),
    loadVariant,
  );
}

export async function archiveProductOnce(db: Db, principal: Principal, idempotencyKey: string, productId: string): Promise<Once<ProductWithVariants>> {
  const user = assertPermission(principal, "catalog:write");
  return runOnce(
    db,
    { userId: user.userId, operation: "catalog.product.archive", key: idempotencyKey, request: { productId } },
    async (tx) => ({ productId: (await archiveProduct(tx, productId)).id }),
    loadProduct,
  );
}

/**
 * Edits a draft product's content (text, category, featured, fabric confirmation). `expectedVersion` is the
 * version the client last saw; a stale one gets VERSION_CONFLICT. A retry with the same key and request
 * returns the first result and changes nothing. A fabric confirmation names the signed-in user.
 */
export async function updateProductOnce(
  db: Db,
  principal: Principal,
  idempotencyKey: string,
  input: { productId: string; expectedVersion: number; changes: ProductChanges },
): Promise<Once<ProductWithVariants>> {
  const user = assertPermission(principal, "catalog:write");
  // Absent fields stay absent (undefined is left out of the fingerprint); null means "clear".
  const request = { productId: input.productId, expectedVersion: input.expectedVersion, changes: { ...input.changes } };
  return runOnce(
    db,
    { userId: user.userId, operation: "catalog.product.update", key: idempotencyKey, request },
    async (tx) => ({ productId: (await updateProduct(tx, request.productId, request.expectedVersion, request.changes, actorFor(user))).id }),
    loadProduct,
  );
}

/** Edits a variant's size, colour and price, with the same version and retry rules as updateProductOnce. */
export async function updateVariantOnce(
  db: Db,
  principal: Principal,
  idempotencyKey: string,
  input: { variantId: string; expectedVersion: number; changes: VariantChanges },
): Promise<Once<Variant>> {
  const user = assertPermission(principal, "catalog:write");
  const request = { variantId: input.variantId, expectedVersion: input.expectedVersion, changes: { ...input.changes } };
  return runOnce(
    db,
    { userId: user.userId, operation: "catalog.variant.update", key: idempotencyKey, request },
    async (tx) => ({ variantId: (await updateVariant(tx, request.variantId, request.expectedVersion, request.changes)).id }),
    loadVariant,
  );
}

export async function deactivateVariantOnce(db: Db, principal: Principal, idempotencyKey: string, variantId: string): Promise<Once<Variant>> {
  const user = assertPermission(principal, "catalog:write");
  return runOnce(
    db,
    { userId: user.userId, operation: "catalog.variant.deactivate", key: idempotencyKey, request: { variantId } },
    async (tx) => ({ variantId: (await deactivateVariant(tx, variantId)).id }),
    loadVariant,
  );
}

/** Replaces a draft product's size chart (millimetres), with the same version and retry rules. */
export async function replaceMeasurementsOnce(
  db: Db,
  principal: Principal,
  idempotencyKey: string,
  input: { productId: string; expectedVersion: number; measurements: { size: string; point: string; valueMm: number }[] },
): Promise<Once<ProductWithVariants>> {
  const user = assertPermission(principal, "catalog:write");
  const request = { productId: input.productId, expectedVersion: input.expectedVersion, measurements: input.measurements.map((m) => ({ size: m.size, point: m.point, valueMm: m.valueMm })) };
  return runOnce(
    db,
    { userId: user.userId, operation: "catalog.product.measurements", key: idempotencyKey, request },
    async (tx) => ({ productId: (await replaceMeasurements(tx, request.productId, request.expectedVersion, request.measurements)).id }),
    loadProduct,
  );
}

const loadCategory = (db: Db, ref: { categoryId: string }) => getCategory(db, ref.categoryId);

export async function createCategoryOnce(db: Db, principal: Principal, idempotencyKey: string, input: NewCategory): Promise<Once<Category>> {
  const user = assertPermission(principal, "catalog:write");
  const request = { slug: input.slug, nameEn: input.nameEn ?? null, nameBn: input.nameBn ?? null };
  return runOnce(
    db,
    { userId: user.userId, operation: "catalog.category.create", key: idempotencyKey, request },
    async (tx) => ({ categoryId: (await createCategory(tx, request)).id }),
    loadCategory,
  );
}

export async function updateCategoryOnce(
  db: Db,
  principal: Principal,
  idempotencyKey: string,
  input: { categoryId: string; expectedVersion: number; nameEn: string | null; nameBn: string | null },
): Promise<Once<Category>> {
  const user = assertPermission(principal, "catalog:write");
  const request = { ...input };
  return runOnce(
    db,
    { userId: user.userId, operation: "catalog.category.update", key: idempotencyKey, request },
    async (tx) => ({ categoryId: (await updateCategory(tx, request.categoryId, request.expectedVersion, request)).id }),
    loadCategory,
  );
}

/**
 * Records the Owner's internal review of a draft product's current content (review.ts). `contentSha256` is the
 * digest the Owner's screen showed; a changed product is refused (VERSION_CONFLICT). Publishes nothing.
 */
export async function reviewProductOnce(db: Db, principal: Principal, idempotencyKey: string, input: { productId: string; contentSha256: string }): Promise<Once<{ reviewId: string; productId: string }>> {
  const user = assertPermission(principal, "catalog:review");
  const request = { productId: input.productId, contentSha256: input.contentSha256 };
  return runOnce(
    db,
    { userId: user.userId, operation: "catalog.product.review", key: idempotencyKey, request },
    async (tx) => ({ ...(await recordProductReview(tx, request.productId, request.contentSha256, actorFor(user))), productId: request.productId }),
    async (_tx, ref: { reviewId: string; productId: string }) => ref,
  );
}
