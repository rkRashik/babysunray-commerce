import { apiGet, methodNotAllowed } from "@/api/v1/http";
import { toDeliveryZoneDto } from "@/api/v1/order-schemas";
import { listDeliveryZones } from "@/modules/orders/delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/v1/delivery-zones: the configured zones. A zone that was never configured is absent.
export const GET = apiGet("orders:read", async ({ db }) => ({ data: (await listDeliveryZones(db)).map(toDeliveryZoneDto) }));

export const { POST, PUT, PATCH, DELETE, OPTIONS } = methodNotAllowed("GET");
