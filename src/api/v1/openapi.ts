import * as z from "zod";
import { apiRegistry, PROBLEM_CODES, type ProblemCode } from "./schemas";

// The OpenAPI 3.1 description of /api/v1, served at /api/v1/openapi.json. Only implemented endpoints
// appear here. Component schemas are generated from the zod schemas the handlers use; paths and
// parameters are written out below. tests/db/api-contract.integration.test.ts checks real responses
// against this document, and tests/api/openapi.test.ts validates it against the OpenAPI 3.1 schema.

export const API_VERSION = "1.0.0";

const ref = (id: string) => ({ $ref: `#/components/schemas/${id}` });

function componentSchemas(): Record<string, unknown> {
  const { schemas } = z.toJSONSchema(apiRegistry, { uri: (id) => `#/components/schemas/${id}`, io: "output" });
  // zod adds a dialect marker and an `$id` naming the component; OpenAPI 3.1 sets the dialect once and
  // the component key already names the schema (a fragment `$id` is not valid JSON Schema 2020-12).
  return Object.fromEntries(
    Object.entries(schemas).map(([id, schema]) => {
      const rest: Record<string, unknown> = { ...schema };
      delete rest.$schema;
      delete rest.$id;
      return [id, rest];
    }),
  );
}

const problemResponse = (description: string, codes: ProblemCode[]) => ({
  description: `${description} Codes: ${codes.join(", ")}.`,
  headers: { "X-Request-Id": { $ref: "#/components/headers/RequestId" } },
  content: { "application/problem+json": { schema: ref("Problem") } },
});

const ok = (description: string, schemaId: string) => ({
  description,
  headers: { "X-Request-Id": { $ref: "#/components/headers/RequestId" } },
  content: { "application/json": { schema: ref(schemaId) } },
});

const ERRORS_COMMON = {
  "401": problemResponse("Missing, invalid, expired or revoked Bearer token, or the user has no active access.", ["UNAUTHENTICATED"]),
  "403": problemResponse("The user's role does not hold the required permission.", ["FORBIDDEN"]),
  "405": problemResponse("Only GET is supported.", ["METHOD_NOT_ALLOWED"]),
  "500": problemResponse("Unexpected server error. No internal detail is returned.", ["INTERNAL_ERROR"]),
};

const limitParameter = {
  name: "limit",
  in: "query",
  required: false,
  description: "Page size. Default 25.",
  schema: { type: "integer", minimum: 1, maximum: 100, default: 25 },
};
const cursorParameter = {
  name: "cursor",
  in: "query",
  required: false,
  description: "Opaque cursor from `page.nextCursor` of the previous page.",
  schema: { type: "string", minLength: 1, maxLength: 200 },
};
const skuParameter = {
  name: "sku",
  in: "path",
  required: true,
  description: "The SKU, case-insensitive (A-Z, 0-9, hyphen, underscore).",
  schema: { type: "string", minLength: 1, maxLength: 64 },
};

const validation = problemResponse("Invalid path or query: unknown, repeated or malformed parameter.", ["VALIDATION_FAILED"]);

/** Builds the document. `serverUrl` is the installation's origin; the document itself is brand-neutral. */
export function buildOpenApiDocument(serverUrl?: string) {
  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "Commerce API",
      version: API_VERSION,
      description:
        "Owner-only, read-only API for the catalogue and stock. Every endpoint requires a Bearer token (a Better Auth " +
        "session token obtained by signing in from a non-browser client). Browser cookies are never accepted. " +
        "Compatibility rules: docs/api/README.md.",
    },
    ...(serverUrl ? { servers: [{ url: `${serverUrl}/api/v1` }] } : {}),
    security: [{ bearerAuth: [] }],
    paths: {
      "/products": {
        get: {
          operationId: "listProducts",
          summary: "List products, oldest first",
          description: "Ordered by creation time, then id. Requires `catalog:read`. Drafts and archived products only.",
          parameters: [
            limitParameter,
            cursorParameter,
            { name: "status", in: "query", required: false, schema: { type: "string", enum: ["draft", "archived"] } },
          ],
          responses: { "200": ok("A page of products.", "ProductList"), "400": validation, ...ERRORS_COMMON },
        },
      },
      "/products/{productId}": {
        get: {
          operationId: "getProduct",
          summary: "Get a product with its variants",
          description: "Requires `catalog:read`.",
          parameters: [{ name: "productId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            "200": ok("The product.", "ProductResponse"),
            "400": validation,
            "404": problemResponse("No product has this id.", ["PRODUCT_NOT_FOUND"]),
            ...ERRORS_COMMON,
          },
        },
      },
      "/skus/{sku}/stock": {
        get: {
          operationId: "getStockLevel",
          summary: "Get the on-hand stock of a SKU",
          description: "Requires `stock:read`.",
          parameters: [skuParameter],
          responses: {
            "200": ok("Current stock.", "StockLevelResponse"),
            "400": validation,
            "404": problemResponse("No variant has this SKU.", ["VARIANT_NOT_FOUND"]),
            ...ERRORS_COMMON,
          },
        },
      },
      "/skus/{sku}/movements": {
        get: {
          operationId: "listStockMovements",
          summary: "List a SKU's stock movements, oldest first",
          description: "The append-only stock ledger in id order. Requires `stock:read`.",
          parameters: [skuParameter, limitParameter, cursorParameter],
          responses: {
            "200": ok("A page of movements.", "StockMovementList"),
            "400": validation,
            "404": problemResponse("No variant has this SKU.", ["VARIANT_NOT_FOUND"]),
            ...ERRORS_COMMON,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "Signed Better Auth session token from the `set-auth-token` header of POST /api/auth/sign-in/email (non-browser clients only). " +
            "Expires and is revoked with its session (sign-out, revoke-session, disabling the user).",
        },
      },
      headers: {
        RequestId: { description: "Correlation id for this request.", schema: { type: "string", format: "uuid" } },
      },
      schemas: componentSchemas(),
    },
    "x-problem-codes": PROBLEM_CODES,
  };
}
