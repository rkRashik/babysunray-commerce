import { apiPost, methodNotAllowed, parsePath } from "@/api/v1/http";
import { emptyRequest, productPath, toProductDto } from "@/api/v1/schemas";
import { archiveProductOnce } from "@/modules/catalogue/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/v1/products/{productId}/archive: archives a product. Nothing is deleted; archiving twice is harmless.
export const POST = apiPost<{ productId: string }, typeof emptyRequest>(
  "catalog:write",
  { body: emptyRequest, status: 200 },
  async ({ params, idempotencyKey, db, principal }) => {
    const { productId } = parsePath(params, productPath);
    const { value, replayed } = await archiveProductOnce(db, principal, idempotencyKey, productId);
    return { value: toProductDto(value), replayed };
  },
);

export const { GET, PUT, PATCH, DELETE, OPTIONS } = methodNotAllowed("POST");
