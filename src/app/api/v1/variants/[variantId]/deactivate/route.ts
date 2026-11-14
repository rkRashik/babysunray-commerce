import { apiPost, methodNotAllowed, parsePath } from "@/api/v1/http";
import { emptyRequest, toVariantDto, variantPath } from "@/api/v1/schemas";
import { deactivateVariantOnce } from "@/modules/catalogue/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/v1/variants/{variantId}/deactivate: marks a SKU inactive. It keeps its stock and history.
export const POST = apiPost<{ variantId: string }, typeof emptyRequest>(
  "catalog:write",
  { body: emptyRequest, status: 200 },
  async ({ params, idempotencyKey, db, principal }) => {
    const { variantId } = parsePath(params, variantPath);
    const { value, replayed } = await deactivateVariantOnce(db, principal, idempotencyKey, variantId);
    return { value: toVariantDto(value), replayed };
  },
);

export const { GET, PUT, PATCH, DELETE, OPTIONS } = methodNotAllowed("POST");
