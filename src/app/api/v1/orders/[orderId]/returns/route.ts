import { apiPost, methodNotAllowed, parsePath } from "@/api/v1/http";
import { createReturnRequest, orderPath, toOrderDto } from "@/api/v1/order-schemas";
import { createReturnOnce } from "@/modules/orders/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/v1/orders/{orderId}/returns: a return or exchange request within 7 days of delivery.
export const POST = apiPost<{ orderId: string }, typeof createReturnRequest>(
  "orders:write",
  { body: createReturnRequest, status: 201 },
  async ({ params, body, idempotencyKey, db, principal }) => {
    const { orderId } = parsePath(params, orderPath);
    const { value, replayed } = await createReturnOnce(db, principal, idempotencyKey, {
      orderId,
      expectedVersion: body.version,
      kind: body.kind,
      reason: body.reason,
      items: body.items,
      note: body.note ?? null,
    });
    return { value: toOrderDto(value), replayed };
  },
);

export const { GET, PUT, PATCH, DELETE, OPTIONS } = methodNotAllowed("POST");
