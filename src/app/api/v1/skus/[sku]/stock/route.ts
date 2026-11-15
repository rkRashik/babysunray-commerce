import { apiGet, methodNotAllowed, parsePath } from "@/api/v1/http";
import { skuPath } from "@/api/v1/schemas";
import { normalizeSku } from "@/modules/catalogue/rules";
import { getStockLevel } from "@/modules/inventory/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/v1/skus/{sku}/stock: on-hand, reserved for orders, and available.
export const GET = apiGet<{ sku: string }>("stock:read", async ({ params, db }) => {
  const sku = normalizeSku(parsePath(params, skuPath).sku);
  const level = await getStockLevel(db, sku);
  return { data: { sku, variantId: level.variantId, onHand: level.onHand, reserved: level.reserved, available: level.available } };
});

export const { POST, PUT, PATCH, DELETE, OPTIONS } = methodNotAllowed("GET");
