import { buildOpenApiDocument } from "@/api/v1/openapi";

export const runtime = "nodejs";
export const dynamic = "force-static";

// GET /api/v1/openapi.json: the API description. Public: it contains no data, only the contract.
export function GET() {
  return Response.json(buildOpenApiDocument(), { headers: { "cache-control": "public, max-age=300" } });
}
