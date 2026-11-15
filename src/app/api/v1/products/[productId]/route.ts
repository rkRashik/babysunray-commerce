import { apiGet, apiPost, methodNotAllowed, parsePath } from "@/api/v1/http";
import { productPath, toProductDto, updateProductRequest } from "@/api/v1/schemas";
import { updateProductOnce } from "@/modules/catalogue/operations";
import { getProductWithVariants } from "@/modules/catalogue/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/v1/products/{productId}: one product with its variants.
export const GET = apiGet<{ productId: string }>("catalog:read", async ({ params, db }) => {
  const { productId } = parsePath(params, productPath);
  return { data: toProductDto(await getProductWithVariants(db, productId)) };
});

// PATCH /api/v1/products/{productId}: edits a draft product's content (optimistic `version`).
export const PATCH = apiPost<{ productId: string }, typeof updateProductRequest>(
  "catalog:write",
  { body: updateProductRequest, status: 200 },
  async ({ params, body, idempotencyKey, db, principal }) => {
    const { productId } = parsePath(params, productPath);
    const { value, replayed } = await updateProductOnce(db, principal, idempotencyKey, {
      productId,
      expectedVersion: body.version,
      changes: {
        nameEn: body.name?.en,
        nameBn: body.name?.bn,
        descriptionEn: body.description?.en,
        descriptionBn: body.description?.bn,
        fabricEn: body.fabric?.en,
        fabricBn: body.fabric?.bn,
        fabricConfirmed: body.fabricConfirmed,
        careEn: body.care?.en,
        careBn: body.care?.bn,
        sizeGuidanceEn: body.sizeGuidance?.en,
        sizeGuidanceBn: body.sizeGuidance?.bn,
        categoryId: body.categoryId,
        featured: body.featured,
      },
    });
    return { value: toProductDto(value), replayed };
  },
);

export const { POST, PUT, DELETE, OPTIONS } = methodNotAllowed("GET, PATCH");
