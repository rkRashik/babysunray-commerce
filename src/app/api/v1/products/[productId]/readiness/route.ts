import { apiGet, methodNotAllowed, parsePath } from "@/api/v1/http";
import { productPath, toReadinessDto } from "@/api/v1/schemas";
import { evaluateReadiness } from "@/modules/catalogue/readiness";
import { getProductWithVariants } from "@/modules/catalogue/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/v1/products/{productId}/readiness: the advisory publishing checklist. Read-only; publishes nothing.
export const GET = apiGet<{ productId: string }>("catalog:read", async ({ params, db }) => {
  const { productId } = parsePath(params, productPath);
  const product = await getProductWithVariants(db, productId);
  return { data: toReadinessDto(product.id, evaluateReadiness(product)) };
});

export const { POST, PUT, PATCH, DELETE, OPTIONS } = methodNotAllowed("GET");
