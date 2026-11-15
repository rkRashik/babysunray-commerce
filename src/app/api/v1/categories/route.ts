import { apiGet, apiPost, methodNotAllowed } from "@/api/v1/http";
import { createCategoryRequest, toCategoryDto } from "@/api/v1/schemas";
import { createCategoryOnce } from "@/modules/catalogue/operations";
import { listCategories } from "@/modules/catalogue/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/v1/categories: every category, by slug (a short list; not paged). POST: creates one.
export const GET = apiGet("catalog:read", async ({ db }) => ({ data: (await listCategories(db)).map(toCategoryDto) }));

export const POST = apiPost<Record<string, never>, typeof createCategoryRequest>(
  "catalog:write",
  { body: createCategoryRequest, status: 201 },
  async ({ body, idempotencyKey, db, principal }) => {
    const { value, replayed } = await createCategoryOnce(db, principal, idempotencyKey, { slug: body.slug, nameEn: body.name.en ?? null, nameBn: body.name.bn ?? null });
    return { value: toCategoryDto(value), replayed };
  },
);

export const { PUT, PATCH, DELETE, OPTIONS } = methodNotAllowed("GET, POST");
