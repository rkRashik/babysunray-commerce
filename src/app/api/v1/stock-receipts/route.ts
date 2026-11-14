import { apiPost, methodNotAllowed } from "@/api/v1/http";
import { stockReceiptRequest, toStockChangeDto } from "@/api/v1/schemas";
import { receiveStockOnce } from "@/modules/inventory/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/v1/stock-receipts: adds received physical units to a SKU (inactive SKUs included).
export const POST = apiPost("stock:receive", { body: stockReceiptRequest, status: 201 }, async ({ body, idempotencyKey, db, principal }) => {
  const { value, replayed } = await receiveStockOnce(db, principal, idempotencyKey, body);
  return { value: toStockChangeDto(value), replayed };
});

export const { GET, PUT, PATCH, DELETE, OPTIONS } = methodNotAllowed("POST");
