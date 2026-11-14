import { apiPost, methodNotAllowed, parsePath } from "@/api/v1/http";
import { createVariantRequest, productPath, toVariantDto } from "@/api/v1/schemas";
import { createVariantOnce } from "@/modules/catalogue/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/v1/products/{productId}/variants: adds a SKU (with a zero stock balance) to a product.
export const POST = apiPost<{ productId: string }, typeof createVariantRequest>(
  "catalog:write",
  { body: createVariantRequest, status: 201 },
  async ({ params, body, idempotencyKey, db, principal }) => {
    const { productId } = parsePath(params, productPath);
    const { value, replayed } = await createVariantOnce(db, principal, idempotencyKey, { productId, ...body });
    return { value: toVariantDto(value), replayed };
  },
);

export const { GET, PUT, PATCH, DELETE, OPTIONS } = methodNotAllowed("POST");
