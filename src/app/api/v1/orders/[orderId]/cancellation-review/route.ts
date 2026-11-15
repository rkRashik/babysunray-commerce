import { apiPost, methodNotAllowed, parsePath } from "@/api/v1/http";
import { cancellationReviewRequest, orderPath, toOrderDto } from "@/api/v1/order-schemas";
import { reviewCancellationOnce } from "@/modules/orders/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/v1/orders/{orderId}/cancellation-review: the Owner decides a customer's open cancellation request.
export const POST = apiPost<{ orderId: string }, typeof cancellationReviewRequest>(
  "orders:write",
  { body: cancellationReviewRequest, status: 200 },
  async ({ params, body, idempotencyKey, db, principal }) => {
    const { orderId } = parsePath(params, orderPath);
    const { value, replayed } = await reviewCancellationOnce(db, principal, idempotencyKey, { orderId, expectedVersion: body.version, decision: body.decision });
    return { value: toOrderDto(value), replayed };
  },
);

export const { GET, PUT, PATCH, DELETE, OPTIONS } = methodNotAllowed("POST");
