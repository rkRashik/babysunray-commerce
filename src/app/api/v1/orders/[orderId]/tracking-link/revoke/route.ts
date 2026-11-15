import { apiPost, methodNotAllowed, parsePath } from "@/api/v1/http";
import { orderPath, toOrderDto } from "@/api/v1/order-schemas";
import { emptyRequest } from "@/api/v1/schemas";
import { revokeTrackingLinkOnce } from "@/modules/orders/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/v1/orders/{orderId}/tracking-link/revoke: the order's link stops working at once.
export const POST = apiPost<{ orderId: string }, typeof emptyRequest>(
  "orders:write",
  { body: emptyRequest, status: 200 },
  async ({ params, idempotencyKey, db, principal }) => {
    const { orderId } = parsePath(params, orderPath);
    const { value, replayed } = await revokeTrackingLinkOnce(db, principal, idempotencyKey, { orderId });
    return { value: toOrderDto(value), replayed };
  },
);

export const { GET, PUT, PATCH, DELETE, OPTIONS } = methodNotAllowed("POST");
