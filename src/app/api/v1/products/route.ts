import { apiGet, methodNotAllowed, parseQuery, RequestValidationError } from "@/api/v1/http";
import { DEFAULT_LIMIT, productCursorCodec, productListQuery, toProductSummaryDto } from "@/api/v1/schemas";
import { listProducts } from "@/modules/catalogue/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/v1/products: Owner-only product list (drafts and archived; nothing here is public).
export const GET = apiGet("catalog:read", async ({ url, db }) => {
  const query = parseQuery(url, productListQuery);
  const limit = query.limit ?? DEFAULT_LIMIT;
  const after = query.cursor === undefined ? undefined : productCursorCodec.decode(query.cursor);
  if (after === null) throw new RequestValidationError([{ location: "query", name: "cursor", message: "is not valid" }]);
  const page = await listProducts(db, { limit, status: query.status, after });
  const last = page.items.at(-1);
  return {
    data: page.items.map(toProductSummaryDto),
    page: { limit, nextCursor: page.hasMore && last ? productCursorCodec.encode(last.key) : null },
  };
});

export const { POST, PUT, PATCH, DELETE } = methodNotAllowed("GET");
