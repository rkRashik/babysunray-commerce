import { apiPost, methodNotAllowed, parsePath } from "@/api/v1/http";
import { orderPath } from "@/api/v1/order-schemas";
import { emptyRequest } from "@/api/v1/schemas";
import { createTrackingLinkOnce } from "@/modules/orders/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/v1/orders/{orderId}/tracking-link: a new guest tracking link (the old one stops working). The token
// is in this answer only; responses are never cached (Cache-Control: no-store).
export const POST = apiPost<{ orderId: string }, typeof emptyRequest>(
  "orders:write",
  { body: emptyRequest, status: 201 },
  async ({ params, idempotencyKey, db, principal }) => {
    const { orderId } = parsePath(params, orderPath);
    const { value, replayed } = await createTrackingLinkOnce(db, principal, idempotencyKey, { orderId });
    return { value: { orderId: value.orderId, token: value.token }, replayed };
  },
);

export const { GET, PUT, PATCH, DELETE, OPTIONS } = methodNotAllowed("POST");
