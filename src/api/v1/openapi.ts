import * as z from "zod";
// Registers the order schemas in apiRegistry before the components are generated.
import "./order-schemas";
import { apiRegistry, PROBLEM_CODES, type ProblemCode } from "./schemas";

// The OpenAPI 3.1 description of /api/v1, served at /api/v1/openapi.json. Only implemented endpoints
// appear here. Component schemas are generated from the zod schemas the handlers use; paths and
// parameters are written out below. tests/db/api*.integration.test.ts check real responses against this
// document, and tests/api/openapi.test.ts validates it against the OpenAPI 3.1 schema.

export const API_VERSION = "1.5.0";

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

/** A POST or PATCH operation: every write shares the Idempotency-Key header, body handling and error responses. */
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

const ORDER = "docs/product/order-policy-decisions.md";
const orderId = uuidParameter("orderId");
const orderWrite = (w: Omit<Write, "ok" | "notFound"> & { ok?: Write["ok"]; notFound?: ProblemCode[] }) =>
  write({ ok: { status: "200", description: "The order as it is now.", schemaId: "OrderResponse" }, notFound: ["ORDER_NOT_FOUND"], ...w });

// Orders (added in 1.3.0). Rules and the transition table: docs/product/order-policy-decisions.md.
function orderPaths() {
  return {
    "/orders": {
      get: read("GET, POST", {
        operationId: "listOrders",
        summary: "List orders, newest first",
        description: "Requires `orders:read`. Contact details are returned to the Owner but cannot be searched, so they never travel in a URL.",
        parameters: [
          limitParameter,
          cursorParameter,
          { name: "status", in: "query", required: false, schema: { type: "string", enum: ["pending_verification", "verification_expired", "confirmed", "cancelled", "closed"] } },
          { name: "attention", in: "query", required: false, description: "`true`: only orders past their verification deadline, expired, or with an open cancellation request.", schema: { type: "string", enum: ["true"] } },
          { name: "number", in: "query", required: false, description: "Order reference, e.g. ORD-000042 or 42.", schema: { type: "string", minLength: 1, maxLength: 20 } },
        ],
        responses: { "200": ok("A page of orders.", "OrderList") },
      }),
      post: write({
        operationId: "createOrder",
        summary: "Create an Owner-assisted order (Messenger, WhatsApp, other)",
        description: `Starts Pending Verification and reserves every line in the same transaction, or creates nothing (no backorders). Prices, delivery charge and total are computed on the server from the catalogue and the zone's active configured charge. See ${ORDER}.`,
        permission: "orders:write",
        request: { schemaId: "CreateOrderRequest", required: true },
        ok: { status: "201", description: "The created order.", schemaId: "OrderResponse" },
        notFound: ["VARIANT_NOT_FOUND"],
        conflict: ["INSUFFICIENT_STOCK", "DELIVERY_ZONE_UNAVAILABLE", "VARIANT_NOT_ORDERABLE"],
        allow: "GET, POST",
      }),
    },
    "/orders/{orderId}": {
      get: read("GET", {
        operationId: "getOrder",
        summary: "Get an order with its items, holds, history and money",
        description: "Requires `orders:read`.",
        parameters: [orderId],
        responses: { "200": ok("The order.", "OrderResponse"), "404": problemResponse("No order has this id.", ["ORDER_NOT_FOUND"]) },
      }),
    },
    "/orders/{orderId}/transitions": {
      post: orderWrite({
        operationId: "transitionOrder",
        summary: "Confirm, pack, dispatch, deliver, mark RTO, receive RTO, cancel or close",
        description: `One step of the transition table (${ORDER}, section 2); anything else is 409 INVALID_TRANSITION. A late confirmation reserves again and may answer INSUFFICIENT_STOCK. Dispatch turns the holds into on-hand deductions once.`,
        permission: "orders:write",
        parameters: [orderId],
        request: { schemaId: "OrderTransitionRequest", required: true },
        conflict: ["INVALID_TRANSITION", "VERSION_CONFLICT", "INSUFFICIENT_STOCK"],
        allow: "POST",
      }),
    },
    "/orders/{orderId}/cancellation-review": {
      post: orderWrite({
        operationId: "reviewCancellation",
        summary: "Approve or reject a customer's cancellation request",
        description: "Approval cancels the order and releases its holds exactly once; rejection changes nothing else.",
        permission: "orders:write",
        parameters: [orderId],
        request: { schemaId: "CancellationReviewRequest", required: true },
        conflict: ["INVALID_TRANSITION", "VERSION_CONFLICT"],
        allow: "POST",
      }),
    },
    "/orders/{orderId}/payments": {
      post: orderWrite({
        operationId: "recordPayment",
        summary: "Record a courier collection or a settlement",
        description: "Manual COD accounting: collection after dispatch, at most the expected COD in total; settlement at most what was collected. Partial amounts are allowed.",
        permission: "payments:record",
        parameters: [orderId],
        request: { schemaId: "PaymentRequest", required: true },
        ok: { status: "201", description: "The order with the new totals.", schemaId: "OrderResponse" },
        conflict: ["INVALID_TRANSITION", "VERSION_CONFLICT", "PAYMENT_LIMIT_EXCEEDED"],
        allow: "POST",
      }),
    },
    "/orders/{orderId}/rto-charge": {
      post: orderWrite({
        operationId: "recordRtoCharge",
        summary: "Record the courier's RTO charge",
        description: "The actual charge, kept apart from the order total.",
        permission: "payments:record",
        parameters: [orderId],
        request: { schemaId: "RtoChargeRequest", required: true },
        conflict: ["INVALID_TRANSITION", "VERSION_CONFLICT"],
        allow: "POST",
      }),
    },
    "/orders/{orderId}/returns": {
      post: orderWrite({
        operationId: "createReturn",
        summary: "Open a return or exchange request",
        description: "Within 7 days of delivery, one open request per order, at most the delivered and not yet returned quantity. Return shipping responsibility follows the reason.",
        permission: "orders:write",
        parameters: [orderId],
        request: { schemaId: "CreateReturnRequest", required: true },
        ok: { status: "201", description: "The order with the new request.", schemaId: "OrderResponse" },
        conflict: ["INVALID_TRANSITION", "VERSION_CONFLICT"],
        allow: "POST",
      }),
    },
    "/orders/{orderId}/returns/{returnId}/steps": {
      post: orderWrite({
        operationId: "advanceReturn",
        summary: "Receive, approve, reject, refund or complete a return",
        description:
          "receive: the goods go into quarantine. approve/reject: only after every returned item is inspected. refund (payments:record): an approved return, bKash, Nagad or bank transfer, at most the money collected and not refunded and at most the goods' value. complete: an exchange, or a return where nothing was collected.",
        permission: "orders:write",
        parameters: [orderId, uuidParameter("returnId")],
        request: { schemaId: "ReturnStepRequest", required: true },
        notFound: ["ORDER_NOT_FOUND", "RETURN_NOT_FOUND"],
        conflict: ["INVALID_TRANSITION", "VERSION_CONFLICT", "PAYMENT_LIMIT_EXCEEDED"],
        allow: "POST",
      }),
    },
    "/orders/{orderId}/inspections/{quarantineItemId}": {
      post: orderWrite({
        operationId: "inspectQuarantineItem",
        summary: "Inspect a returned or RTO item",
        description: "restock: exactly one return_restock ledger row makes it sellable again. reject: it stays out of stock. Decided once.",
        permission: "stock:receive",
        parameters: [orderId, uuidParameter("quarantineItemId")],
        request: { schemaId: "InspectionRequest", required: true },
        notFound: ["ORDER_NOT_FOUND", "QUARANTINE_ITEM_NOT_FOUND"],
        conflict: ["INVALID_TRANSITION", "VERSION_CONFLICT"],
        allow: "POST",
      }),
    },
    "/orders/{orderId}/tracking-link": {
      post: orderWrite({
        operationId: "createTrackingLink",
        summary: "Create a guest tracking link",
        description: "Revokes the previous link. The token appears in this answer only (a replay returns `token: null`); only its SHA-256 digest is stored. The link is `/track#t=<token>`; it works until revoked or 30 days after the order is closed.",
        permission: "orders:write",
        parameters: [orderId],
        request: { schemaId: "EmptyRequest", required: false },
        ok: { status: "201", description: "The new link's token.", schemaId: "TrackingLinkResponse" },
        allow: "POST",
      }),
    },
    "/orders/{orderId}/tracking-link/revoke": {
      post: orderWrite({
        operationId: "revokeTrackingLink",
        summary: "Revoke the order's guest tracking link",
        description: "The link stops working at once. Revoking when there is none changes nothing.",
        permission: "orders:write",
        parameters: [orderId],
        request: { schemaId: "EmptyRequest", required: false },
        allow: "POST",
      }),
    },
    "/delivery-zones": {
      get: read("GET", {
        operationId: "listDeliveryZones",
        summary: "List the configured delivery zones",
        description: "Requires `orders:read`. A zone that was never configured is absent and takes no orders.",
        responses: { "200": ok("The configured zones.", "DeliveryZoneList") },
      }),
    },
    "/delivery-zones/{code}": {
      put: write({
        operationId: "setDeliveryZone",
        summary: "Set a zone's delivery charge",
        description: "Dhaka City or Outside Dhaka. Send `version: null` the first time, then the version you last read. Existing orders keep the charge they were submitted with.",
        permission: "settings:write",
        parameters: [{ name: "code", in: "path", required: true, schema: { type: "string", enum: ["dhaka_city", "outside_dhaka"] } }],
        request: { schemaId: "DeliveryZoneRequest", required: true },
        ok: { status: "200", description: "The zone as it is now.", schemaId: "DeliveryZoneResponse" },
        conflict: ["VERSION_CONFLICT"],
        allow: "PUT",
      }),
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
        "Owner-only API for the draft catalogue, physical stock and internal (Owner-assisted) orders. Every endpoint requires a Bearer token (a Better Auth " +
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
          description: "Ordered by creation time, then id. Requires `catalog:read`. Every status: draft, published (none while no publication rule is approved) and archived.",
          parameters: [
            limitParameter,
            cursorParameter,
            { name: "status", in: "query", required: false, schema: { type: "string", enum: ["draft", "published", "archived"] } },
            {
              name: "q",
              in: "query",
              required: false,
              description:
                "Search text (added in 1.2.0): matches anywhere in the slug, the English or Bangla name, or any SKU of the product, case-insensitively. " +
                "Unicode NFC-normalised, trimmed, inner spaces collapsed; empty means no search. % and _ match themselves. At most 100 characters; control characters are refused.",
              schema: { type: "string", maxLength: 100 },
            },
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
        get: read("GET, PATCH", {
          operationId: "getProduct",
          summary: "Get a product with its variants",
          description: "Requires `catalog:read`.",
          parameters: [uuidParameter("productId")],
          responses: {
            "200": ok("The product.", "ProductResponse"),
            "404": problemResponse("No product has this id.", ["PRODUCT_NOT_FOUND"]),
          },
        }),
        patch: write({
          operationId: "updateProduct",
          summary: "Edit a draft product's content",
          description:
            "Partial update of names, descriptions and (since 1.4.0) fabric, care, size guidance, category and featured: a field left out keeps its value; " +
            "null or an empty string clears it. Changing the fabric text clears an earlier fabric confirmation unless `fabricConfirmed` is true in the same request. " +
            "An unknown category is 404 CATEGORY_NOT_FOUND. Send the `version` you last read; " +
            "if the product changed since, nothing is saved and the answer is 409 VERSION_CONFLICT (read it again and retry). " +
            "Archived products cannot be edited (409 PRODUCT_NOT_EDITABLE). Slug, id and status never change here; at least one name must remain.",
          permission: "catalog:write",
          parameters: [uuidParameter("productId")],
          request: { schemaId: "UpdateProductRequest", required: true },
          ok: { status: "200", description: "The product as it is now.", schemaId: "ProductResponse" },
          notFound: ["PRODUCT_NOT_FOUND", "CATEGORY_NOT_FOUND"],
          conflict: ["VERSION_CONFLICT", "PRODUCT_NOT_EDITABLE"],
          allow: "GET, PATCH",
        }),
      },
      "/products/{productId}/measurements": {
        put: write({
          operationId: "replaceMeasurements",
          summary: "Replace a draft product's size chart",
          description:
            "Added in 1.4.0. Sends the whole chart in whole millimetres: one value per size and measuring point; an empty list removes it. " +
            "Send the product `version` you last read; a stale one gets 409 VERSION_CONFLICT and nothing changes.",
          permission: "catalog:write",
          parameters: [uuidParameter("productId")],
          request: { schemaId: "ReplaceMeasurementsRequest", required: true },
          ok: { status: "200", description: "The product as it is now.", schemaId: "ProductResponse" },
          notFound: ["PRODUCT_NOT_FOUND"],
          conflict: ["VERSION_CONFLICT", "PRODUCT_NOT_EDITABLE"],
          allow: "PUT",
        }),
      },
      "/products/{productId}/readiness": {
        get: read("GET", {
          operationId: "getProductReadiness",
          summary: "Advisory publishing checklist for a product",
          description:
            "Added in 1.4.0. Requires `catalog:read`. Read-only: it never publishes anything and is not an approval to publish (no publish operation exists). " +
            "Each item names its basis: an approved requirement, a proposed rule waiting for the founder, or an engineering recommendation.",
          parameters: [uuidParameter("productId")],
          responses: {
            "200": ok("The checklist.", "ReadinessResponse"),
            "404": problemResponse("No product has this id.", ["PRODUCT_NOT_FOUND"]),
          },
        }),
      },
      "/categories": {
        get: read("GET, POST", {
          operationId: "listCategories",
          summary: "List product categories",
          description: "Added in 1.4.0. Requires `catalog:read`. Every category, ordered by slug (a short list, not paged).",
          responses: { "200": ok("The categories.", "CategoryList") },
        }),
        post: write({
          operationId: "createCategory",
          summary: "Create a product category",
          description: "Added in 1.4.0. A slug (never changes) and a name in English or Bangla.",
          permission: "catalog:write",
          request: { schemaId: "CreateCategoryRequest", required: true },
          ok: { status: "201", description: "The created category.", schemaId: "CategoryResponse" },
          conflict: ["SLUG_TAKEN"],
          allow: "GET, POST",
        }),
      },
      "/products/{productId}/variants": {
        post: write({
          operationId: "createVariant",
          summary: "Add a variant (SKU) to a product",
          description: "The SKU is stored uppercase and must be unique; its stock balance starts at zero. Only a draft product gets new variants (409 PRODUCT_NOT_EDITABLE otherwise).",
          permission: "catalog:write",
          parameters: [uuidParameter("productId")],
          request: { schemaId: "CreateVariantRequest", required: true },
          ok: { status: "201", description: "The created variant.", schemaId: "VariantResponse" },
          notFound: ["PRODUCT_NOT_FOUND"],
          conflict: ["SKU_TAKEN", "PRODUCT_NOT_EDITABLE"],
          allow: "POST",
        }),
      },
      "/products/{productId}/archive": {
        post: write({
          operationId: "archiveProduct",
          summary: "Archive a product",
          description: "Products are never deleted. Archiving an archived product changes nothing. A published product must be withdrawn first (409 PRODUCT_NOT_EDITABLE).",
          permission: "catalog:write",
          parameters: [uuidParameter("productId")],
          request: { schemaId: "EmptyRequest", required: false },
          ok: { status: "200", description: "The product as it is now.", schemaId: "ProductResponse" },
          notFound: ["PRODUCT_NOT_FOUND"],
          conflict: ["PRODUCT_NOT_EDITABLE"],
          allow: "POST",
        }),
      },
      "/variants/{variantId}": {
        patch: write({
          operationId: "updateVariant",
          summary: "Edit a variant's size, colour and price",
          description:
            "Partial update of an active variant of a draft product: a field left out keeps its value; size and colour can be cleared with null or \"\". " +
            "Send the `version` you last read (from the product); a stale one gets 409 VERSION_CONFLICT and nothing is saved. " +
            "Inactive variants and variants of archived products cannot be edited (409 VARIANT_NOT_EDITABLE). SKU, id, status and stock never change here.",
          permission: "catalog:write",
          parameters: [uuidParameter("variantId")],
          request: { schemaId: "UpdateVariantRequest", required: true },
          ok: { status: "200", description: "The variant as it is now.", schemaId: "VariantResponse" },
          notFound: ["VARIANT_NOT_FOUND"],
          conflict: ["VERSION_CONFLICT", "VARIANT_NOT_EDITABLE"],
          allow: "PATCH",
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
      ...orderPaths(),
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
