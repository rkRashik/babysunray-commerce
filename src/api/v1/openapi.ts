import * as z from "zod";
import { apiRegistry, PROBLEM_CODES, type ProblemCode } from "./schemas";

// The OpenAPI 3.1 description of /api/v1, served at /api/v1/openapi.json. Only implemented endpoints
// appear here. Component schemas are generated from the zod schemas the handlers use; paths and
// parameters are written out below. tests/db/api*.integration.test.ts check real responses against this
// document, and tests/api/openapi.test.ts validates it against the OpenAPI 3.1 schema.

export const API_VERSION = "1.1.0";

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

const REQUEST_ID = { "X-Request-Id": { $ref: "#/components/headers/RequestId" } };

const problemResponse = (description: string, codes: ProblemCode[], headers: Record<string, unknown> = {}) => ({
  description: `${description} Codes: ${codes.join(", ")}.`,
  headers: { ...REQUEST_ID, ...headers },
  content: { "application/problem+json": { schema: ref("Problem") } },
});

const ok = (description: string, schemaId: string, headers: Record<string, unknown> = {}) => ({
  description,
  headers: { ...REQUEST_ID, ...headers },
  content: { "application/json": { schema: ref(schemaId) } },
});

// Responses every endpoint can give.
const ERRORS_COMMON = {
  "401": problemResponse("Missing, invalid, expired or revoked Bearer token, or the user has no active access.", ["UNAUTHENTICATED"]),
  "403": problemResponse(
    "The user's role does not hold the required permission, or the request came from a browser on another origin (no CORS).",
    ["FORBIDDEN", "ORIGIN_NOT_ALLOWED"],
  ),
  "429": problemResponse("Too many requests from this user in the current one-minute window.", ["RATE_LIMITED"], {
    "Retry-After": { description: "Seconds until the window resets.", schema: { type: "integer", minimum: 1 } },
  }),
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
const uuidParameter = (name: string) => ({ name, in: "path", required: true, schema: { type: "string", format: "uuid" } });
const idempotencyKeyParameter = { $ref: "#/components/parameters/IdempotencyKey" };

const validation = problemResponse("Invalid path or query: unknown, repeated or malformed parameter.", ["VALIDATION_FAILED"]);

const read = (allow: string, operation: Record<string, unknown> & { responses: Record<string, unknown> }) => ({
  ...operation,
  responses: { ...operation.responses, "400": validation, "405": problemResponse(`Allowed: ${allow}.`, ["METHOD_NOT_ALLOWED"]), ...ERRORS_COMMON },
});

type Write = {
  operationId: string;
  summary: string;
  description: string;
  permission: string;
  parameters?: unknown[];
  request: { schemaId: string; required: boolean };
  ok: { status: "200" | "201"; description: string; schemaId: string };
  notFound?: ProblemCode[];
  conflict?: ProblemCode[];
  allow: string;
};

/** A POST operation: every write shares the Idempotency-Key header, body handling and error responses. */
function write(w: Write) {
  return {
    operationId: w.operationId,
    summary: w.summary,
    description: `${w.description} Requires \`${w.permission}\`. Runs once per Idempotency-Key and user; a retry with the same key and body returns the first result with \`Idempotent-Replayed: true\`.`,
    parameters: [...(w.parameters ?? []), idempotencyKeyParameter],
    requestBody: {
      required: w.request.required,
      content: { "application/json": { schema: ref(w.request.schemaId) } },
    },
    responses: {
      [w.ok.status]: ok(w.ok.description, w.ok.schemaId, {
        "Idempotent-Replayed": { description: "`true` when this is the stored result of an earlier request with the same key.", schema: { type: "string", enum: ["true"] } },
      }),
      "400": problemResponse("Invalid path or body, malformed JSON, or a missing or malformed Idempotency-Key.", [
        "VALIDATION_FAILED",
        "MALFORMED_JSON",
        "IDEMPOTENCY_KEY_REQUIRED",
      ]),
      ...(w.notFound ? { "404": problemResponse("The referenced resource does not exist.", w.notFound) } : {}),
      "405": problemResponse(`Allowed: ${w.allow}.`, ["METHOD_NOT_ALLOWED"]),
      ...(w.conflict ? { "409": problemResponse("The change conflicts with current data.", w.conflict) } : {}),
      "413": problemResponse("The body is larger than 64 KiB.", ["PAYLOAD_TOO_LARGE"]),
      "415": problemResponse("A body was sent with a media type other than application/json (UTF-8).", ["UNSUPPORTED_MEDIA_TYPE"]),
      "422": problemResponse("The Idempotency-Key was already used by this user for a different request.", ["IDEMPOTENCY_KEY_REUSED"]),
      ...ERRORS_COMMON,
    },
  };
}

/** Builds the document. `serverUrl` is the installation's origin; the document itself is brand-neutral. */
export function buildOpenApiDocument(serverUrl?: string) {
  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "Commerce API",
      version: API_VERSION,
      description:
        "Owner-only API for the draft catalogue and physical stock. Every endpoint requires a Bearer token (a Better Auth " +
        "session token obtained by signing in from a non-browser client). Browser cookies are never accepted and no CORS " +
        "access is granted. Writes require an Idempotency-Key. Money is integer paisa; times are UTC (ISO 8601). " +
        "Compatibility rules: docs/api/README.md.",
    },
    ...(serverUrl ? { servers: [{ url: `${serverUrl}/api/v1` }] } : {}),
    security: [{ bearerAuth: [] }],
    paths: {
      "/products": {
        get: read("GET, POST", {
          operationId: "listProducts",
          summary: "List products, oldest first",
          description: "Ordered by creation time, then id. Requires `catalog:read`. Drafts and archived products only.",
          parameters: [
            limitParameter,
            cursorParameter,
            { name: "status", in: "query", required: false, schema: { type: "string", enum: ["draft", "archived"] } },
          ],
          responses: { "200": ok("A page of products.", "ProductList") },
        }),
        post: write({
          operationId: "createProduct",
          summary: "Create a draft product",
          description: "The product starts as `draft` with no variants. Nothing is published.",
          permission: "catalog:write",
          request: { schemaId: "CreateProductRequest", required: true },
          ok: { status: "201", description: "The created product.", schemaId: "ProductResponse" },
          conflict: ["SLUG_TAKEN"],
          allow: "GET, POST",
        }),
      },
      "/products/{productId}": {
        get: read("GET", {
          operationId: "getProduct",
          summary: "Get a product with its variants",
          description: "Requires `catalog:read`.",
          parameters: [uuidParameter("productId")],
          responses: {
            "200": ok("The product.", "ProductResponse"),
            "404": problemResponse("No product has this id.", ["PRODUCT_NOT_FOUND"]),
          },
        }),
      },
      "/products/{productId}/variants": {
        post: write({
          operationId: "createVariant",
          summary: "Add a variant (SKU) to a product",
          description: "The SKU is stored uppercase and must be unique; its stock balance starts at zero.",
          permission: "catalog:write",
          parameters: [uuidParameter("productId")],
          request: { schemaId: "CreateVariantRequest", required: true },
          ok: { status: "201", description: "The created variant.", schemaId: "VariantResponse" },
          notFound: ["PRODUCT_NOT_FOUND"],
          conflict: ["SKU_TAKEN"],
          allow: "POST",
        }),
      },
      "/products/{productId}/archive": {
        post: write({
          operationId: "archiveProduct",
          summary: "Archive a product",
          description: "Products are never deleted. Archiving an archived product changes nothing.",
          permission: "catalog:write",
          parameters: [uuidParameter("productId")],
          request: { schemaId: "EmptyRequest", required: false },
          ok: { status: "200", description: "The product as it is now.", schemaId: "ProductResponse" },
          notFound: ["PRODUCT_NOT_FOUND"],
          allow: "POST",
        }),
      },
      "/variants/{variantId}/deactivate": {
        post: write({
          operationId: "deactivateVariant",
          summary: "Deactivate a variant",
          description: "Variants are never deleted; an inactive SKU keeps its stock and history and can still receive stock.",
          permission: "catalog:write",
          parameters: [uuidParameter("variantId")],
          request: { schemaId: "EmptyRequest", required: false },
          ok: { status: "200", description: "The variant as it is now.", schemaId: "VariantResponse" },
          notFound: ["VARIANT_NOT_FOUND"],
          allow: "POST",
        }),
      },
      "/stock-receipts": {
        post: write({
          operationId: "receiveStock",
          summary: "Receive physical stock for a SKU",
          description: "Adds the units to the SKU's on-hand stock and records a ledger row with the signed-in user as actor. Inactive SKUs may receive stock.",
          permission: "stock:receive",
          request: { schemaId: "StockReceiptRequest", required: true },
          ok: { status: "201", description: "The recorded movement and the resulting on-hand stock.", schemaId: "StockChangeResponse" },
          notFound: ["VARIANT_NOT_FOUND"],
          conflict: ["STOCK_LIMIT_EXCEEDED"],
          allow: "POST",
        }),
      },
      "/stock-adjustments": {
        post: write({
          operationId: "adjustStock",
          summary: "Adjust a SKU's stock with a reason",
          description: "Changes on-hand stock up or down and records a ledger row with the reason and the signed-in user. Stock never goes below zero.",
          permission: "stock:adjust",
          request: { schemaId: "StockAdjustmentRequest", required: true },
          ok: { status: "201", description: "The recorded movement and the resulting on-hand stock.", schemaId: "StockChangeResponse" },
          notFound: ["VARIANT_NOT_FOUND"],
          conflict: ["INSUFFICIENT_STOCK", "STOCK_LIMIT_EXCEEDED"],
          allow: "POST",
        }),
      },
      "/skus/{sku}/stock": {
        get: read("GET", {
          operationId: "getStockLevel",
          summary: "Get the on-hand stock of a SKU",
          description: "Requires `stock:read`.",
          parameters: [skuParameter],
          responses: {
            "200": ok("Current stock.", "StockLevelResponse"),
            "404": problemResponse("No variant has this SKU.", ["VARIANT_NOT_FOUND"]),
          },
        }),
      },
      "/skus/{sku}/movements": {
        get: read("GET", {
          operationId: "listStockMovements",
          summary: "List a SKU's stock movements, oldest first",
          description: "The append-only stock ledger in id order. Requires `stock:read`.",
          parameters: [skuParameter, limitParameter, cursorParameter],
          responses: {
            "200": ok("A page of movements.", "StockMovementList"),
            "404": problemResponse("No variant has this SKU.", ["VARIANT_NOT_FOUND"]),
          },
        }),
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
      parameters: {
        IdempotencyKey: {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          description:
            "Client-generated, unique per operation (a UUID is suitable), 16 to 128 characters of A-Z, a-z, 0-9, `_ . : -`, " +
            "optionally in double quotes. Scoped to the signed-in user. Reuse it only to retry the same request.",
          schema: { type: "string", minLength: 16, maxLength: 130 },
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
