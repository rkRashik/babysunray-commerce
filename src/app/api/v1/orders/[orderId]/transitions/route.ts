import { apiPost, methodNotAllowed, parsePath } from "@/api/v1/http";
import { orderPath, toOrderDto, transitionRequest } from "@/api/v1/order-schemas";
import {
  cancelOrderOnce,
  closeOrderOnce,
  confirmOrderOnce,
  deliverOrderOnce,
  dispatchOrderOnce,
  markRtoOnce,
  packOrderOnce,
  receiveRtoOnce,
} from "@/modules/orders/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPERATIONS = {
  confirm: confirmOrderOnce,
  pack: packOrderOnce,
  dispatch: dispatchOrderOnce,
  deliver: deliverOrderOnce,
  mark_rto: markRtoOnce,
  receive_rto: receiveRtoOnce,
  cancel: cancelOrderOnce,
  close: closeOrderOnce,
};

// POST /api/v1/orders/{orderId}/transitions: one lifecycle step, checked against the transition table.
export const POST = apiPost<{ orderId: string }, typeof transitionRequest>(
  "orders:write",
  { body: transitionRequest, status: 200 },
  async ({ params, body, idempotencyKey, db, principal }) => {
    const { orderId } = parsePath(params, orderPath);
    const { value, replayed } = await OPERATIONS[body.action](db, principal, idempotencyKey, { orderId, expectedVersion: body.version });
    return { value: toOrderDto(value), replayed };
  },
);

export const { GET, PUT, PATCH, DELETE, OPTIONS } = methodNotAllowed("POST");
