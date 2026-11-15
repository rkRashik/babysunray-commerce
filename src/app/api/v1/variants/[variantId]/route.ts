import { apiPost, methodNotAllowed, parsePath } from "@/api/v1/http";
import { toVariantDto, updateVariantRequest, variantPath } from "@/api/v1/schemas";
import { updateVariantOnce } from "@/modules/catalogue/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PATCH /api/v1/variants/{variantId}: edits an active variant's size, colour and price (optimistic `version`).
// The SKU, status and stock never change here.
export const PATCH = apiPost<{ variantId: string }, typeof updateVariantRequest>(
  "catalog:write",
  { body: updateVariantRequest, status: 200 },
  async ({ params, body, idempotencyKey, db, principal }) => {
    const { variantId } = parsePath(params, variantPath);
    const { value, replayed } = await updateVariantOnce(db, principal, idempotencyKey, {
      variantId,
      expectedVersion: body.version,
      changes: { size: body.size, colour: body.colour, pricePaisa: body.pricePaisa },
    });
    return { value: toVariantDto(value), replayed };
  },
);

export const { GET, POST, PUT, DELETE, OPTIONS } = methodNotAllowed("PATCH");
