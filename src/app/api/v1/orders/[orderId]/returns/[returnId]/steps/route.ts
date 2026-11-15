import { apiPost, methodNotAllowed, parsePath } from "@/api/v1/http";
import { returnPath, returnStepRequest, toOrderDto } from "@/api/v1/order-schemas";
import { returnStepOnce } from "@/modules/orders/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/v1/orders/{orderId}/returns/{returnId}/steps: receive, approve, reject, refund or complete. The
// operation checks the step's own permission (orders:write, or payments:record for a refund).
export const POST = apiPost<{ orderId: string; returnId: string }, typeof returnStepRequest>(
  "orders:write",
  { body: returnStepRequest, status: 200 },
  async ({ params, body, idempotencyKey, db, principal }) => {
    const { orderId, returnId } = parsePath(params, returnPath);
    const { version, ...step } = body;
    const { value, replayed } = await returnStepOnce(db, principal, idempotencyKey, { orderId, returnId, expectedVersion: version, ...step });
    return { value: toOrderDto(value), replayed };
  },
);

export const { GET, PUT, PATCH, DELETE, OPTIONS } = methodNotAllowed("POST");
