import "server-only";
import type { Db } from "@/db/database";
import { assertPermission, type Principal } from "../auth/principal";
import { type Once, runOnce } from "../idempotency/service";
import {
  archiveProduct,
  createProduct,
  createVariant,
  deactivateVariant,
  getProductWithVariants,
  getVariant,
  type NewProduct,
  type NewVariant,
  type Product,
  type ProductChanges,
  updateProduct,
  updateVariant,
  type Variant,
  type VariantChanges,
} from "./service";

// Draft catalogue changes for every client (the /api/v1 routes and the Owner Office). Each requires
// `catalog:write` and runs once per idempotency key. A replay returns the resource as it is now (a product
// may have been archived since); nothing here publishes a product (requirement I-6 is open).

type ProductWithVariants = Product & { variants: Variant[] };
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
 * Edits a draft product's text. `expectedVersion` is the version the client last saw; a stale one gets
 * VERSION_CONFLICT. A retry with the same key and request returns the first result and changes nothing.
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
    async (tx) => ({ productId: (await updateProduct(tx, request.productId, request.expectedVersion, request.changes)).id }),
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
