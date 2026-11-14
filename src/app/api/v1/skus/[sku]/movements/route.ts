import { apiGet, methodNotAllowed, parsePath, parseQuery, RequestValidationError } from "@/api/v1/http";
import { DEFAULT_LIMIT, movementCursorCodec, movementListQuery, skuPath, toStockMovementDto } from "@/api/v1/schemas";
import { listStockMovementsPage } from "@/modules/inventory/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/v1/skus/{sku}/movements: the SKU's stock ledger, oldest first, in bounded pages.
export const GET = apiGet<{ sku: string }>("stock:read", async ({ params, url, db }) => {
  const { sku } = parsePath(params, skuPath);
  const query = parseQuery(url, movementListQuery);
  const limit = query.limit ?? DEFAULT_LIMIT;
  const afterId = query.cursor === undefined ? undefined : movementCursorCodec.decode(query.cursor);
  if (afterId === null) throw new RequestValidationError([{ location: "query", name: "cursor", message: "is not valid" }]);
  const page = await listStockMovementsPage(db, sku, { limit, afterId });
  const last = page.items.at(-1);
  return {
    data: page.items.map(toStockMovementDto),
    page: { limit, nextCursor: page.hasMore && last ? movementCursorCodec.encode(last.id) : null },
  };
});

export const { POST, PUT, PATCH, DELETE } = methodNotAllowed("GET");
