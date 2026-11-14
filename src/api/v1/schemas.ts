import * as z from "zod";
import type { Product, ProductKey, Variant } from "@/modules/catalogue/service";
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
          location: z.enum(["query", "path"]),
          name: z.string(),
          message: z.string(),
        }),
      )
      .optional(),
  })
  .register(apiRegistry, { id: "Problem", description: "RFC 9457 problem details with a stable `code`." });

const timestamp = z.iso.datetime().meta({ description: "UTC, ISO 8601." });
const localised = z.object({ en: z.string().nullable(), bn: z.string().nullable() });

export const variantSchema = z
  .object({
    id: z.uuid(),
    sku: z.string(),
    size: z.string().nullable(),
    colour: z.string().nullable(),
    pricePaisa: z.int().min(1).meta({ description: "Integer paisa (1 BDT = 100 paisa)." }),
    status: z.enum(["active", "inactive"]),
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
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .register(apiRegistry, { id: "ProductSummary" });

export const productSchema = productSummarySchema
  .extend({ description: localised, variants: z.array(variantSchema) })
  .register(apiRegistry, { id: "Product" });

export const stockLevelSchema = z
  .object({ sku: z.string(), variantId: z.uuid(), onHand: z.int().min(0) })
  .register(apiRegistry, { id: "StockLevel" });

export const stockMovementSchema = z
  .object({
    id: z.int().min(1),
    type: z.enum(["receipt", "adjustment"]),
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

export const productListSchema = z.object({ data: z.array(productSummarySchema), page: pageSchema }).register(apiRegistry, { id: "ProductList" });
export const productResponseSchema = z.object({ data: productSchema }).register(apiRegistry, { id: "ProductResponse" });
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
export const productListQuery = z.strictObject({ limit, cursor, status: z.enum(["draft", "archived"]).optional() });
export const movementListQuery = z.strictObject({ limit, cursor });
export const productPath = z.strictObject({ productId: z.uuid() });
export const skuPath = z.strictObject({ sku: z.string().min(1).max(64).meta({ description: "Case-insensitive." }) });

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
  createdAt: v.createdAt.toISOString(),
  updatedAt: v.updatedAt.toISOString(),
});

export const toProductSummaryDto = (p: Product): z.infer<typeof productSummarySchema> => ({
  id: p.id,
  slug: p.slug,
  status: p.status,
  name: { en: p.nameEn, bn: p.nameBn },
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

export const toProductDto = (p: Product & { variants: Variant[] }): z.infer<typeof productSchema> => ({
  ...toProductSummaryDto(p),
  description: { en: p.descriptionEn, bn: p.descriptionBn },
  variants: p.variants.map(toVariantDto),
});

export const toStockMovementDto = (m: StockMovement): z.infer<typeof stockMovementSchema> => ({
  id: m.id,
  type: m.movementType,
  quantityDelta: m.quantityDelta,
  reason: m.reason,
  actor: { type: m.actorType, ref: m.actorRef },
  createdAt: m.createdAt.toISOString(),
});
