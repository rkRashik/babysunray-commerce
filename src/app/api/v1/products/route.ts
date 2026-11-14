import { apiGet, apiPost, methodNotAllowed, parseQuery, RequestValidationError } from "@/api/v1/http";
import { createProductRequest, DEFAULT_LIMIT, productCursorCodec, productListQuery, toProductDto, toProductSummaryDto } from "@/api/v1/schemas";
import { createProductOnce } from "@/modules/catalogue/operations";
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

// POST /api/v1/products: creates a draft product (never published).
export const POST = apiPost("catalog:write", { body: createProductRequest, status: 201 }, async ({ body, idempotencyKey, db, principal }) => {
  const { value, replayed } = await createProductOnce(db, principal, idempotencyKey, {
    slug: body.slug,
    nameEn: body.name.en,
    nameBn: body.name.bn,
    descriptionEn: body.description?.en,
    descriptionBn: body.description?.bn,
  });
  return { value: toProductDto(value), replayed };
});

export const { PUT, PATCH, DELETE, OPTIONS } = methodNotAllowed("GET, POST");
