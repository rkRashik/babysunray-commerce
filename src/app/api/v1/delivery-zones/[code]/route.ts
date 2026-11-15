import { apiPost, methodNotAllowed, parsePath } from "@/api/v1/http";
import { deliveryZoneRequest, toDeliveryZoneDto, zonePath } from "@/api/v1/order-schemas";
import { setDeliveryZoneOnce } from "@/modules/orders/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PUT /api/v1/delivery-zones/{code}: sets a zone's charge and whether it takes orders. Existing orders keep the
// charge they were submitted with.
export const PUT = apiPost<{ code: string }, typeof deliveryZoneRequest>(
  "settings:write",
  { body: deliveryZoneRequest, status: 200 },
  async ({ params, body, idempotencyKey, db, principal }) => {
    const { code } = parsePath(params, zonePath);
    const { value, replayed } = await setDeliveryZoneOnce(db, principal, idempotencyKey, {
      code,
      chargePaisa: body.chargePaisa,
      active: body.active,
      expectedVersion: body.version,
    });
    return { value: toDeliveryZoneDto(value), replayed };
  },
);

export const { GET, POST, PATCH, DELETE, OPTIONS } = methodNotAllowed("PUT");
