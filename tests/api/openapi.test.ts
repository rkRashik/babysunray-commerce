import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../../src/api/v1/openapi";
import { movementCursorCodec, PROBLEM_CODES, productCursorCodec } from "../../src/api/v1/schemas";

// The document is valid OpenAPI 3.1 and internally consistent. Its agreement with real responses is
// checked in tests/db/api.integration.test.ts.

describe("OpenAPI document", () => {
  it("validates against the official OpenAPI 3.1 schema, with every reference resolvable", async () => {
    const validator = new Validator();
    const result = await validator.validate(buildOpenApiDocument("https://shop.example.test"));
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

  it("requires Bearer authentication everywhere and documents only GET operations", () => {
    const doc = buildOpenApiDocument();
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    for (const [path, item] of Object.entries(doc.paths)) {
      expect(Object.keys(item), path).toEqual(["get"]);
      expect(Object.keys(item.get.responses), path).toEqual(expect.arrayContaining(["200", "400", "401", "403", "405", "500"]));
    }
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
