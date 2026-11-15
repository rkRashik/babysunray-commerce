import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../../src/api/v1/openapi";
import { movementCursorCodec, PROBLEM_CODES, productCursorCodec } from "../../src/api/v1/schemas";

// The document is valid OpenAPI 3.1 and internally consistent. Its agreement with real responses is
// checked in tests/db/api.integration.test.ts.

describe("OpenAPI document", () => {
  it("validates against the official OpenAPI 3.1 schema, with every reference resolvable", async () => {
    const validator = new Validator();
    // The validator resolves references in place; give it a copy so shared parameter objects stay intact.
    const result = await validator.validate(structuredClone(buildOpenApiDocument("https://shop.example.test")));
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
    expect(validator.version).toBe("3.1");
    expect(validator.resolveRefs()).toBeTruthy();
  });

  it("would catch a broken document (the validator is not a no-op)", async () => {
    const doc = buildOpenApiDocument();
    const broken = { ...doc, paths: { "/products": { get: { ...doc.paths["/products"].get, responses: { "200": { content: {} } } } } } };
    expect((await new Validator().validate(broken)).valid).toBe(false);
  });

  it("requires Bearer authentication everywhere and documents exactly the implemented operations", () => {
    const doc = buildOpenApiDocument();
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    const operations = Object.entries(doc.paths).flatMap(([path, item]) => Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`));
    expect(operations.sort()).toEqual(
      [
        "GET /products",
        "POST /products",
        "GET /products/{productId}",
        "PATCH /products/{productId}",
        "PUT /products/{productId}/measurements",
        "GET /products/{productId}/readiness",
        "GET /categories",
        "POST /categories",
        "PATCH /variants/{variantId}",
        "GET /orders",
        "POST /orders",
        "GET /orders/{orderId}",
        "POST /orders/{orderId}/transitions",
        "POST /orders/{orderId}/cancellation-review",
        "POST /orders/{orderId}/payments",
        "POST /orders/{orderId}/rto-charge",
        "POST /orders/{orderId}/returns",
        "POST /orders/{orderId}/returns/{returnId}/steps",
        "POST /orders/{orderId}/inspections/{quarantineItemId}",
        "POST /orders/{orderId}/tracking-link",
        "POST /orders/{orderId}/tracking-link/revoke",
        "GET /delivery-zones",
        "PUT /delivery-zones/{code}",
        "POST /products/{productId}/variants",
        "POST /products/{productId}/archive",
        "POST /variants/{variantId}/deactivate",
        "POST /stock-receipts",
        "POST /stock-adjustments",
        "GET /skus/{sku}/stock",
        "GET /skus/{sku}/movements",
      ].sort(),
    );
    for (const [path, item] of Object.entries(doc.paths) as [string, Record<string, { responses: object; parameters?: unknown[] }>][]) {
      for (const [method, operation] of Object.entries(item)) {
        const statuses = Object.keys(operation.responses);
        expect(statuses, `${method} ${path}`).toEqual(expect.arrayContaining(["400", "401", "403", "405", "429", "500"]));
        if (method === "post") {
          expect(statuses, path).toEqual(expect.arrayContaining(["413", "415", "422"]));
          expect(operation.parameters, path).toContainEqual({ $ref: "#/components/parameters/IdempotencyKey" });
        }
      }
    }
    expect(doc.components.parameters.IdempotencyKey).toMatchObject({ in: "header", required: true });
  });

  it("documents money as integer paisa and request bodies as closed objects", () => {
    const schemas = buildOpenApiDocument().components.schemas as Record<string, { additionalProperties?: boolean; properties: Record<string, { type?: string; description?: string }> }>;
    expect(schemas.Variant.properties.pricePaisa).toMatchObject({ type: "integer", description: expect.stringContaining("paisa") });
    expect(schemas.CreateVariantRequest.properties.pricePaisa).toMatchObject({ type: "integer", description: expect.stringContaining("paisa") });
    for (const id of ["StockReceiptRequest", "StockAdjustmentRequest", "CreateProductRequest", "CreateVariantRequest", "EmptyRequest"]) {
      expect(schemas[id].additionalProperties, id).toBe(false);
    }
    expect(JSON.stringify(schemas.StockReceiptRequest)).not.toMatch(/actor|userId|role/);
  });

  it("publishes every problem code and contains no brand or installation data", () => {
    const doc = buildOpenApiDocument();
    expect(doc["x-problem-codes"]).toEqual(PROBLEM_CODES);
    expect(JSON.stringify(doc)).not.toMatch(/babysunray|localhost|example\.test/i);
  });
});

describe("cursors", () => {
  it("round-trip and reject tampering", () => {
    const key = { createdAt: "2026-01-01T00:00:00.000001Z", id: "3f8a6c1e-2b4d-4e6f-8a1b-2c3d4e5f6a7b" };
    expect(productCursorCodec.decode(productCursorCodec.encode(key))).toEqual(key);
    expect(movementCursorCodec.decode(movementCursorCodec.encode(42))).toBe(42);
    for (const bad of ["", "!!!", Buffer.from("{}").toString("base64url"), Buffer.from('{"i":0}').toString("base64url")]) {
      expect(productCursorCodec.decode(bad)).toBeNull();
      expect(movementCursorCodec.decode(bad)).toBeNull();
    }
    // Millisecond precision is not accepted: the key must be PostgreSQL's exact microsecond value.
    expect(productCursorCodec.decode(Buffer.from(JSON.stringify({ c: "2026-01-01T00:00:00.000Z", i: key.id })).toString("base64url"))).toBeNull();
  });
});
