import { apiGet, methodNotAllowed, parsePath } from "@/api/v1/http";
import { productPath, toProductDto } from "@/api/v1/schemas";
import { getProductWithVariants } from "@/modules/catalogue/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/v1/products/{productId}: one product with its variants.
export const GET = apiGet<{ productId: string }>("catalog:read", async ({ params, db }) => {
  const { productId } = parsePath(params, productPath);
  return { data: toProductDto(await getProductWithVariants(db, productId)) };
});

export const { POST, PUT, PATCH, DELETE, OPTIONS } = methodNotAllowed("GET");
