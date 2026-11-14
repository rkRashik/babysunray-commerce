import { apiPost, methodNotAllowed } from "@/api/v1/http";
import { stockAdjustmentRequest, toStockChangeDto } from "@/api/v1/schemas";
import { adjustStockOnce } from "@/modules/inventory/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/v1/stock-adjustments: corrects a SKU's on-hand stock up or down with a required reason.
export const POST = apiPost("stock:adjust", { body: stockAdjustmentRequest, status: 201 }, async ({ body, idempotencyKey, db, principal }) => {
  const { value, replayed } = await adjustStockOnce(db, principal, idempotencyKey, body);
  return { value: toStockChangeDto(value), replayed };
});

export const { GET, PUT, PATCH, DELETE, OPTIONS } = methodNotAllowed("POST");
