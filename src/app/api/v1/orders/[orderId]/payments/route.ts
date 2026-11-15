import { apiPost, methodNotAllowed, parsePath } from "@/api/v1/http";
import { orderPath, paymentRequest, toOrderDto } from "@/api/v1/order-schemas";
import { recordPaymentOnce } from "@/modules/orders/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/v1/orders/{orderId}/payments: a courier collection or a settlement to the Owner, recorded by hand.
export const POST = apiPost<{ orderId: string }, typeof paymentRequest>(
  "payments:record",
  { body: paymentRequest, status: 201 },
  async ({ params, body, idempotencyKey, db, principal }) => {
    const { orderId } = parsePath(params, orderPath);
    const { value, replayed } = await recordPaymentOnce(db, principal, idempotencyKey, {
      orderId,
      expectedVersion: body.version,
      kind: body.kind,
      amountPaisa: body.amountPaisa,
      occurredOn: body.occurredOn,
      reference: body.reference ?? null,
    });
    return { value: toOrderDto(value), replayed };
  },
);

export const { GET, PUT, PATCH, DELETE, OPTIONS } = methodNotAllowed("POST");
