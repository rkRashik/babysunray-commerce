import { apiPost, methodNotAllowed, parsePath } from "@/api/v1/http";
import { orderPath, rtoChargeRequest, toOrderDto } from "@/api/v1/order-schemas";
import { recordRtoChargeOnce } from "@/modules/orders/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/v1/orders/{orderId}/rto-charge: the actual courier RTO charge, kept apart from the order total.
export const POST = apiPost<{ orderId: string }, typeof rtoChargeRequest>(
  "payments:record",
  { body: rtoChargeRequest, status: 200 },
  async ({ params, body, idempotencyKey, db, principal }) => {
    const { orderId } = parsePath(params, orderPath);
    const { value, replayed } = await recordRtoChargeOnce(db, principal, idempotencyKey, { orderId, expectedVersion: body.version, chargePaisa: body.chargePaisa });
    return { value: toOrderDto(value), replayed };
  },
);

export const { GET, PUT, PATCH, DELETE, OPTIONS } = methodNotAllowed("POST");
