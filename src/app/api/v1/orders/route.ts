import { apiGet, apiPost, methodNotAllowed, parseQuery, RequestValidationError } from "@/api/v1/http";
import { createOrderRequest, orderListQuery, toOrderDto, toOrderSummaryDto } from "@/api/v1/order-schemas";
import { DEFAULT_LIMIT, productCursorCodec } from "@/api/v1/schemas";
import { submitOrderOnce } from "@/modules/orders/operations";
import { listOrders } from "@/modules/orders/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The order cursor has the same shape as the product cursor: (created_at, id), opaque to clients.
const cursorCodec = productCursorCodec;

// GET /api/v1/orders: Owner-only order list, newest first.
export const GET = apiGet("orders:read", async ({ url, db }) => {
  const query = parseQuery(url, orderListQuery);
  const limit = query.limit ?? DEFAULT_LIMIT;
  const after = query.cursor === undefined ? undefined : cursorCodec.decode(query.cursor);
  if (after === null) throw new RequestValidationError([{ location: "query", name: "cursor", message: "is not valid" }]);
  const page = await listOrders(db, { limit, status: query.status, attention: query.attention === "true", number: query.number, after });
  const last = page.items.at(-1);
  return { data: page.items.map(toOrderSummaryDto), page: { limit, nextCursor: page.hasMore && last ? cursorCodec.encode(last.key) : null } };
});

// POST /api/v1/orders: an Owner-assisted order (Messenger, WhatsApp, other). Reserves stock or creates nothing.
export const POST = apiPost("orders:write", { body: createOrderRequest, status: 201 }, async ({ body, idempotencyKey, db, principal }) => {
  const { value, replayed } = await submitOrderOnce(db, principal, idempotencyKey, {
    source: body.source,
    customerName: body.customer.name,
    customerPhone: body.customer.phone,
    deliveryAddress: body.deliveryAddress,
    deliveryZone: body.deliveryZone,
    note: body.note ?? null,
    items: body.items,
    paymentMethod: body.paymentMethod,
  });
  return { value: toOrderDto(value), replayed };
});

export const { PUT, PATCH, DELETE, OPTIONS } = methodNotAllowed("GET, POST");
