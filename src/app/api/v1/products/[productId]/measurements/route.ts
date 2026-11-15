import { apiPost, methodNotAllowed, parsePath } from "@/api/v1/http";
import { productPath, replaceMeasurementsRequest, toProductDto } from "@/api/v1/schemas";
import { replaceMeasurementsOnce } from "@/modules/catalogue/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PUT /api/v1/products/{productId}/measurements: replaces a draft product's whole size chart (millimetres).
export const PUT = apiPost<{ productId: string }, typeof replaceMeasurementsRequest>(
  "catalog:write",
  { body: replaceMeasurementsRequest, status: 200 },
  async ({ params, body, idempotencyKey, db, principal }) => {
    const { productId } = parsePath(params, productPath);
    const { value, replayed } = await replaceMeasurementsOnce(db, principal, idempotencyKey, { productId, expectedVersion: body.version, measurements: body.measurements });
    return { value: toProductDto(value), replayed };
  },
);

export const { GET, POST, PATCH, DELETE, OPTIONS } = methodNotAllowed("PUT");
