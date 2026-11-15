import * as z from "zod";
import { MEASUREMENT_POINTS } from "@/modules/catalogue/content";
import type { ReadinessItem } from "@/modules/catalogue/readiness";
import type { Category, Product, ProductDetail, ProductKey, Variant } from "@/modules/catalogue/service";
import type { StockOperationResult } from "@/modules/inventory/operations";
import type { StockMovement } from "@/modules/inventory/service";

// Wire formats of /api/v1. These schemas are the single source for the response DTOs, the input
// validation and the OpenAPI document (openapi.ts); a contract test checks real responses against that
// document. Changing a field here is an API change (docs/api/README.md, Versioning).

/** The named schemas published as OpenAPI components. Kept apart from zod's global registry. */
export const apiRegistry = z.registry<{ id: string; description?: string }>();

export const PROBLEM_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "VALIDATION_FAILED",
  "PRODUCT_NOT_FOUND",
  "VARIANT_NOT_FOUND",
  "ROUTE_NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "INTERNAL_ERROR",
  // Added in 1.1.0 with the write endpoints, request limits and the origin policy.
  "ORIGIN_NOT_ALLOWED",
  "MALFORMED_JSON",
  "IDEMPOTENCY_KEY_REQUIRED",
  "IDEMPOTENCY_KEY_REUSED",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "RATE_LIMITED",
  "SLUG_TAKEN",
  "SKU_TAKEN",
  "INSUFFICIENT_STOCK",
  "STOCK_LIMIT_EXCEEDED",
  // Added in 1.2.0 with draft editing.
  "VERSION_CONFLICT",
  "PRODUCT_NOT_EDITABLE",
  "VARIANT_NOT_EDITABLE",
  // Added in 1.3.0 with orders.
  "ORDER_NOT_FOUND",
  "RETURN_NOT_FOUND",
  "QUARANTINE_ITEM_NOT_FOUND",
  "INVALID_TRANSITION",
  "DELIVERY_ZONE_UNAVAILABLE",
  "VARIANT_NOT_ORDERABLE",
  "PAYMENT_LIMIT_EXCEEDED",
  // Added in 1.4.0 with product content and categories.
  "CATEGORY_NOT_FOUND",
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

export const problemSchema = z
  .object({
    type: z.string().meta({ description: "Always about:blank; use `code`." }),
    title: z.string(),
    status: z.int(),
    code: z.enum(PROBLEM_CODES),
    requestId: z.uuid().meta({ description: "Also in the X-Request-Id header. Quote it when reporting a problem." }),
    detail: z.string().optional(),
    errors: z
      .array(
        z.object({
          location: z.enum(["query", "path", "body"]),
          name: z.string(),
          message: z.string(),
        }),
      )
      .optional(),
  })
  .register(apiRegistry, { id: "Problem", description: "RFC 9457 problem details with a stable `code`." });

const timestamp = z.iso.datetime().meta({ description: "UTC, ISO 8601." });
const version = z.int().min(1).meta({ description: "Changes with every update. Send it back as `version` when editing." });
const localised = z.object({ en: z.string().nullable(), bn: z.string().nullable() });

export const variantSchema = z
  .object({
    id: z.uuid(),
    sku: z.string(),
    size: z.string().nullable(),
    colour: z.string().nullable(),
    pricePaisa: z.int().min(1).meta({ description: "Integer paisa (1 BDT = 100 paisa)." }),
    status: z.enum(["active", "inactive"]),
    version,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .register(apiRegistry, { id: "Variant" });

export const productSummarySchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    status: z.enum(["draft", "archived"]),
    name: localised,
    version,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .register(apiRegistry, { id: "ProductSummary" });

export const categorySchema = z
  .object({ id: z.uuid(), slug: z.string(), name: localised, version, createdAt: timestamp, updatedAt: timestamp })
  .register(apiRegistry, { id: "Category", description: "An Owner-defined product category (added in 1.4.0)." });

export const measurementSchema = z
  .object({
    size: z.string().meta({ description: "The size label, as on the product's variants." }),
    point: z.enum(MEASUREMENT_POINTS),
    valueMm: z.int().min(1).max(3000).meta({ description: "Whole millimetres; shown to people as centimetres with at most one decimal." }),
  })
  .register(apiRegistry, { id: "Measurement" });

export const photoSchema = z
  .object({
    id: z.uuid(),
    position: z.int().min(0).meta({ description: "0 is shown first." }),
    contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    width: z.int().min(1),
    height: z.int().min(1),
    byteSize: z.int().min(1),
    sha256: z.string().meta({ description: "SHA-256 of the stored file (hex)." }),
    alt: localised.meta({ description: "Descriptions for people who cannot see the photo." }),
  })
  .register(apiRegistry, {
    id: "Photo",
    description: "A product photo's metadata (added in 1.4.0). Uploading and viewing photos happen in the Owner Office only; there is no API for the files yet.",
  });

export const productSchema = productSummarySchema
  .extend({
    description: localised,
    variants: z.array(variantSchema),
    // Added in 1.4.0.
    category: categorySchema.nullable(),
    fabric: z.object({ en: z.string().nullable(), bn: z.string().nullable(), confirmedAt: timestamp.nullable().meta({ description: "When the Owner confirmed the statement; null if never or changed since." }) }),
    care: localised,
    sizeGuidance: localised,
    featured: z.boolean(),
    measurements: z.array(measurementSchema),
    photos: z.array(photoSchema),
  })
  .register(apiRegistry, { id: "Product" });

export const readinessSchema = z
  .object({
    productId: z.uuid(),
    advisory: z.literal(true).meta({ description: "Always true: this checklist never publishes anything and is not an approval to publish." }),
    items: z.array(
      z.object({
        id: z.string(),
        basis: z.enum(["approved", "pending", "recommended"]).meta({ description: "approved: an approved requirement; pending: a proposed rule awaiting the founder; recommended: engineering advice." }),
        met: z.boolean(),
        source: z.string().meta({ description: "The requirement IDs it rests on." }),
        label: z.string(),
        detail: z.string(),
      }),
    ),
  })
  .register(apiRegistry, { id: "Readiness" });

export const stockLevelSchema = z
  .object({
    sku: z.string(),
    variantId: z.uuid(),
    onHand: z.int().min(0).meta({ description: "Physical units in stock." }),
    reserved: z.int().min(0).meta({ description: "Units held for orders not yet dispatched (added in 1.3.0)." }),
    available: z.int().min(0).meta({ description: "onHand minus reserved: what a new order can take (added in 1.3.0)." }),
  })
  .register(apiRegistry, { id: "StockLevel" });

export const stockMovementSchema = z
  .object({
    id: z.int().min(1),
    type: z.enum(["receipt", "adjustment", "dispatch", "return_restock"]).meta({ description: "dispatch and return_restock were added in 1.3.0; the list may grow." }),
    quantityDelta: z.int(),
    reason: z.string().nullable(),
    actor: z.object({
      type: z.enum(["system", "user"]),
      ref: z.string().meta({ description: "A system label, or the user's immutable id. Never a name or email." }),
    }),
    createdAt: timestamp,
  })
  .register(apiRegistry, { id: "StockMovement" });

const pageSchema = z
  .object({
    limit: z.int(),
    nextCursor: z.string().nullable().meta({ description: "Pass as `cursor` for the next page; null on the last page." }),
  })
  .register(apiRegistry, { id: "Page" });

export const stockChangeSchema = z
  .object({
    sku: z.string(),
    variantId: z.uuid(),
    onHand: z.int().min(0).meta({ description: "On-hand stock right after this change." }),
    movement: stockMovementSchema,
  })
  .register(apiRegistry, { id: "StockChange" });

export const productListSchema = z.object({ data: z.array(productSummarySchema), page: pageSchema }).register(apiRegistry, { id: "ProductList" });
export const productResponseSchema = z.object({ data: productSchema }).register(apiRegistry, { id: "ProductResponse" });
export const readinessResponseSchema = z.object({ data: readinessSchema }).register(apiRegistry, { id: "ReadinessResponse" });
export const categoryResponseSchema = z.object({ data: categorySchema }).register(apiRegistry, { id: "CategoryResponse" });
export const categoryListSchema = z.object({ data: z.array(categorySchema) }).register(apiRegistry, { id: "CategoryList" });
export const variantResponseSchema = z.object({ data: variantSchema }).register(apiRegistry, { id: "VariantResponse" });
export const stockChangeResponseSchema = z.object({ data: stockChangeSchema }).register(apiRegistry, { id: "StockChangeResponse" });
export const stockLevelResponseSchema = z.object({ data: stockLevelSchema }).register(apiRegistry, { id: "StockLevelResponse" });
export const stockMovementListSchema = z
  .object({ data: z.array(stockMovementSchema), page: pageSchema })
  .register(apiRegistry, { id: "StockMovementList" });

// Inputs. Query values arrive as strings; objects are strict, so an unknown parameter is an error.
const limit = z
  .string()
  .regex(/^[0-9]{1,3}$/)
  .transform(Number)
  .pipe(z.int().min(1).max(100))
  .optional()
  .meta({ description: "Page size, 1 to 100. Default 25." });
const cursor = z.string().min(1).max(200).optional().meta({ description: "Opaque; from `page.nextCursor`." });

export const DEFAULT_LIMIT = 25;
export const productListQuery = z.strictObject({
  limit,
  cursor,
  status: z.enum(["draft", "archived"]).optional(),
  q: z.string().max(100).optional().meta({ description: "Search text, at most 100 characters." }),
});
export const movementListQuery = z.strictObject({ limit, cursor });
export const productPath = z.strictObject({ productId: z.uuid() });
export const skuPath = z.strictObject({ sku: z.string().min(1).max(64).meta({ description: "Case-insensitive." }) });

export const variantPath = z.strictObject({ variantId: z.uuid() });

// Request bodies. Strict: an unknown field is an error. Bounds are the technical limits the services and
// CHECK constraints enforce; the services still validate formats (SKU, slug) and business rules.
const optionalText = (max: number) => z.string().max(max).nullable().optional();
const MAX_QUANTITY = 2_147_483_647;

export const stockReceiptRequest = z
  .strictObject({
    sku: z.string().min(1).max(64).meta({ description: "Case-insensitive." }),
    quantity: z.int().min(1).max(MAX_QUANTITY).meta({ description: "Units received." }),
    reason: optionalText(500).meta({ description: "Optional note, at most 500 characters." }),
  })
  .register(apiRegistry, { id: "StockReceiptRequest" });

export const stockAdjustmentRequest = z
  .strictObject({
    sku: z.string().min(1).max(64).meta({ description: "Case-insensitive." }),
    quantityDelta: z
      .int()
      .min(-MAX_QUANTITY)
      .max(MAX_QUANTITY)
      .refine((n) => n !== 0)
      .meta({ description: "Non-zero; negative removes stock. Stock never goes below zero.", not: { const: 0 } }),
    reason: z.string().min(1).max(500).meta({ description: "Required (who and why is audited)." }),
  })
  .register(apiRegistry, { id: "StockAdjustmentRequest" });

const localisedInput = (max: number) => z.strictObject({ en: optionalText(max), bn: optionalText(max) });
export const createProductRequest = z
  .strictObject({
    slug: z.string().min(1).max(100).meta({ description: "Lowercase ASCII letters, digits and single hyphens." }),
    name: localisedInput(200).meta({ description: "At least one of en or bn." }),
    description: localisedInput(5000).optional(),
  })
  .register(apiRegistry, { id: "CreateProductRequest" });

export const createVariantRequest = z
  .strictObject({
    sku: z.string().min(1).max(64).meta({ description: "1-64 of A-Z, 0-9, hyphen, underscore; stored uppercase." }),
    size: optionalText(64),
    colour: optionalText(64),
    pricePaisa: z.int().min(1).max(Number.MAX_SAFE_INTEGER).meta({ description: "Integer paisa (1 BDT = 100 paisa)." }),
  })
  .register(apiRegistry, { id: "CreateVariantRequest" });

const expectedVersion = z.int().min(1).max(2_147_483_647).meta({ description: "The `version` you last read. A stale one is refused with VERSION_CONFLICT." });
const editableText = (max: number) => z.string().max(max).nullable().optional();
const localisedEdit = (max: number) =>
  z.strictObject({ en: editableText(max), bn: editableText(max) }).meta({ description: "Leave a language out to keep it; null or \"\" clears it." });

export const updateProductRequest = z
  .strictObject({
    version: expectedVersion,
    name: localisedEdit(200).optional(),
    description: localisedEdit(5000).optional(),
    // Added in 1.4.0.
    fabric: localisedEdit(1000).optional().meta({ description: "Changing either language clears an earlier confirmation unless fabricConfirmed is true." }),
    fabricConfirmed: z.boolean().optional().meta({ description: "true: you confirm the fabric statement as it will be after this change (only with evidence); false: withdraw it." }),
    care: localisedEdit(1000).optional(),
    sizeGuidance: localisedEdit(1000).optional(),
    categoryId: z.uuid().nullable().optional().meta({ description: "A category id, or null for none." }),
    featured: z.boolean().optional(),
  })
  .meta({ description: "Partial update of a draft product's content. Slug and status do not change here. At least one name must remain." })
  .register(apiRegistry, { id: "UpdateProductRequest" });

export const replaceMeasurementsRequest = z
  .strictObject({
    version: expectedVersion,
    measurements: z
      .array(z.strictObject({ size: z.string().min(1).max(64), point: z.enum(MEASUREMENT_POINTS), valueMm: z.int().min(1).max(3000) }))
      .max(240)
      .meta({ description: "The whole size chart: one value per size and point, at most 30 sizes. An empty list removes it." }),
  })
  .register(apiRegistry, { id: "ReplaceMeasurementsRequest" });

export const createCategoryRequest = z
  .strictObject({
    slug: z.string().min(1).max(100).meta({ description: "Lowercase ASCII letters, digits and single hyphens; never changes." }),
    name: localisedInput(100).meta({ description: "At least one of en or bn." }),
  })
  .register(apiRegistry, { id: "CreateCategoryRequest" });

export const updateVariantRequest = z
  .strictObject({
    version: expectedVersion,
    size: editableText(64).meta({ description: "Leave out to keep; null or \"\" clears." }),
    colour: editableText(64).meta({ description: "Leave out to keep; null or \"\" clears." }),
    pricePaisa: z.int().min(1).max(Number.MAX_SAFE_INTEGER).optional().meta({ description: "Integer paisa (1 BDT = 100 paisa)." }),
  })
  .meta({ description: "Partial update of an active variant. SKU, status and stock do not change here." })
  .register(apiRegistry, { id: "UpdateVariantRequest" });

/** Archive and deactivate take no input: no body, or an empty JSON object. */
export const emptyRequest = z.strictObject({}).optional().register(apiRegistry, { id: "EmptyRequest" });

// Opaque cursors: base64url JSON, validated on the way back in.
const productCursor = z.strictObject({ c: z.iso.datetime({ precision: 6 }), i: z.uuid() });
const movementCursor = z.strictObject({ i: z.int().min(1) });

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function decode<S extends z.ZodType>(raw: string, schema: S): z.output<S> | null {
  try {
    const result = schema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
export const productCursorCodec = {
  encode: (key: ProductKey) => encode({ c: key.createdAt, i: key.id }),
  decode: (raw: string): ProductKey | null => {
    const value = decode(raw, productCursor);
    return value ? { createdAt: value.c, id: value.i } : null;
  },
};
export const movementCursorCodec = {
  encode: (id: number) => encode({ i: id }),
  decode: (raw: string): number | null => decode(raw, movementCursor)?.i ?? null,
};

// DTO mappers: only these fields leave the server.
export const toVariantDto = (v: Variant): z.infer<typeof variantSchema> => ({
  id: v.id,
  sku: v.sku,
  size: v.size,
  colour: v.colour,
  pricePaisa: v.pricePaisa,
  status: v.status,
  version: v.version,
  createdAt: v.createdAt.toISOString(),
  updatedAt: v.updatedAt.toISOString(),
});

export const toProductSummaryDto = (p: Product): z.infer<typeof productSummarySchema> => ({
  id: p.id,
  slug: p.slug,
  status: p.status,
  name: { en: p.nameEn, bn: p.nameBn },
  version: p.version,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

export const toCategoryDto = (c: Category): z.infer<typeof categorySchema> => ({
  id: c.id,
  slug: c.slug,
  name: { en: c.nameEn, bn: c.nameBn },
  version: c.version,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

export const toProductDto = (p: ProductDetail): z.infer<typeof productSchema> => ({
  ...toProductSummaryDto(p),
  description: { en: p.descriptionEn, bn: p.descriptionBn },
  variants: p.variants.map(toVariantDto),
  category: p.category ? toCategoryDto(p.category) : null,
  fabric: { en: p.fabricEn, bn: p.fabricBn, confirmedAt: p.fabricConfirmedAt?.toISOString() ?? null },
  care: { en: p.careEn, bn: p.careBn },
  sizeGuidance: { en: p.sizeGuidanceEn, bn: p.sizeGuidanceBn },
  featured: p.featured,
  measurements: p.measurements,
  photos: p.media.map((m) => ({ id: m.id, position: m.position, contentType: m.contentType, width: m.width, height: m.height, byteSize: m.byteSize, sha256: m.sha256, alt: { en: m.altEn, bn: m.altBn } })),
});

export const toReadinessDto = (productId: string, items: ReadinessItem[]): z.infer<typeof readinessSchema> => ({ productId, advisory: true, items });

export const toStockMovementDto = (m: StockMovement): z.infer<typeof stockMovementSchema> => ({
  id: m.id,
  type: m.movementType,
  quantityDelta: m.quantityDelta,
  reason: m.reason,
  actor: { type: m.actorType, ref: m.actorRef },
  createdAt: m.createdAt.toISOString(),
});

export const toStockChangeDto = (r: StockOperationResult): z.infer<typeof stockChangeSchema> => ({
  sku: r.sku,
  variantId: r.variantId,
  onHand: r.onHand,
  movement: toStockMovementDto(r.movement),
});
