import "server-only";
import { randomUUID } from "node:crypto";
import * as z from "zod";
import { type Db, pgErrorCode } from "@/db/database";
import { DomainError } from "@/modules/domain-error";
import { DELIVERY_ZONES } from "@/modules/orders/rules";
import { getPublicProduct, listPublicProducts, MAX_PUBLIC_PAGE, publicFacets, quotePublicCart } from "@/modules/storefront/public-catalogue";
import { ApiProblem, readBody } from "./v1/http";

// The future public catalogue transport (Gate H.33), prepared but NOT ROUTED: no file under src/app imports it (a unit
// test checks), so no request reaches it. Tests call it directly. Opening it needs route files that pass the real
// launch gate (src/modules/launch/gate.ts, which refuses in this version) in the gate that opens the shop.
//
// The contract is the same family as the other public transports (guest checkout, tracking): JSON answers,
// `{ data }` on success and `{ error, message }` with a stable code and a fixed message on failure, never echoed
// input; `X-Request-Id` on every answer; no CORS. Order of checks: method, the gate (closed: answered before any
// database work), origin (none, or the site's own), then strictly validated input, then the service. Responses
// say `no-store` for now: a caching policy depends on hosting.

export type PublicDeps = { db: Db; baseUrl: string; gate: () => { open: boolean } };
export type PublicResource = { kind: "products" } | { kind: "product"; slug: string } | { kind: "facets" } | { kind: "quote" };

const HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-type": "application/json; charset=utf-8",
};
const MAX_QUOTE_BYTES = 8 * 1024;

const answer = (requestId: string, status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...HEADERS, "x-request-id": requestId, ...headers } });
const refusal = (requestId: string, status: number, error: string, message: string, headers: Record<string, string> = {}) => answer(requestId, status, { error, message }, headers);

const text = (max: number) => z.string().max(max);
const listQuery = z.strictObject({
  q: text(100).optional(),
  category: text(100).optional(),
  size: text(64).optional(),
  colour: text(64).optional(),
  inStock: z.enum(["true", "false"]).optional(),
  page: z.string().regex(/^[1-9][0-9]{0,2}$/).optional(),
});
const quoteBody = z.strictObject({
  lines: z.array(z.strictObject({ sku: text(64), quantity: z.number() })).max(20),
  zone: z.enum(DELIVERY_ZONES).nullable().optional(),
});
const JSON_TYPE = /^application\/json\s*(;\s*charset\s*=\s*("?)utf-8\2\s*)?$/i;

/** Query string → object; repeated parameters are refused like unknown ones. */
function queryOf(url: URL): Record<string, string> | null {
  const raw: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(raw, key)) return null;
    raw[key] = value;
  }
  return raw;
}

const BAD_REQUEST = "The request is not valid.";

export async function publicCatalogueResponse(request: Request, resource: PublicResource, deps: PublicDeps): Promise<Response> {
  const requestId = randomUUID();
  const method = resource.kind === "quote" ? "POST" : "GET";
  if (request.method !== method) return refusal(requestId, 405, "method_not_allowed", `Use ${method}.`, { allow: method });
  if (!deps.gate().open) return refusal(requestId, 503, "shop_closed", "The online shop is not open yet. Please contact the shop.");
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== deps.baseUrl) return refusal(requestId, 403, "forbidden", "This request is not allowed.");
  try {
    if (resource.kind === "quote") {
      if (!JSON_TYPE.test(request.headers.get("content-type") ?? "")) return refusal(requestId, 415, "unsupported_media_type", "Send the cart as application/json (UTF-8).");
      let raw: unknown;
      try {
        raw = JSON.parse((await readBody(request, MAX_QUOTE_BYTES)) ?? "");
      } catch (error) {
        if (error instanceof ApiProblem && error.code === "PAYLOAD_TOO_LARGE") return refusal(requestId, 413, "too_large", "The cart is too large.");
        return refusal(requestId, 400, "bad_request", BAD_REQUEST);
      }
      const body = quoteBody.safeParse(raw);
      if (!body.success) return refusal(requestId, 400, "bad_request", BAD_REQUEST);
      return answer(requestId, 200, { data: await quotePublicCart(deps.db, { lines: body.data.lines, zone: body.data.zone ?? null }) });
    }
    const query = queryOf(new URL(request.url));
    if (resource.kind === "products") {
      const parsed = query && listQuery.safeParse(query);
      if (!parsed?.success) return refusal(requestId, 400, "bad_request", BAD_REQUEST);
      const q = parsed.data;
      const list = await listPublicProducts(deps.db, { q: q.q, category: q.category, size: q.size, colour: q.colour, inStock: q.inStock === "true" ? true : undefined, page: q.page ? Number(q.page) : 1 });
      return answer(requestId, 200, { data: list.items, page: { number: list.page, hasMore: list.hasMore, maxPage: MAX_PUBLIC_PAGE } });
    }
    if (query === null || Object.keys(query).length > 0) return refusal(requestId, 400, "bad_request", BAD_REQUEST);
    if (resource.kind === "facets") return answer(requestId, 200, { data: await publicFacets(deps.db) });
    // Unknown, draft, withdrawn and archived products all get this same answer.
    const product = await getPublicProduct(deps.db, resource.slug);
    return product ? answer(requestId, 200, { data: product }) : refusal(requestId, 404, "not_found", "This product is not available.");
  } catch (error) {
    if (error instanceof DomainError && error.code === "INVALID_INPUT") return refusal(requestId, 400, "bad_request", BAD_REQUEST);
    console.error(JSON.stringify({ level: "error", event: "public_catalogue_failed", requestId, errorName: error instanceof Error ? error.name : typeof error, sqlState: pgErrorCode(error) ?? null }));
    return refusal(requestId, 500, "internal", "Something went wrong. Please try again.");
  }
}
