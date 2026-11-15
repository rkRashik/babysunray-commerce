import { apiGet, methodNotAllowed, parsePath } from "@/api/v1/http";
import { orderPath, toOrderDto } from "@/api/v1/order-schemas";
import { getOrderDetail } from "@/modules/orders/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/v1/orders/{orderId}: the order with items, holds, history, requests, returns, quarantine and money.
export const GET = apiGet<{ orderId: string }>("orders:read", async ({ params, db }) => {
  const { orderId } = parsePath(params, orderPath);
  return { data: toOrderDto(await getOrderDetail(db, orderId)) };
});

export const { POST, PUT, PATCH, DELETE, OPTIONS } = methodNotAllowed("GET");
