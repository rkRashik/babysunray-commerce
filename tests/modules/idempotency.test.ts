import { describe, expect, it } from "vitest";
import { canonicalJson, requestFingerprint, validateIdempotencyKey } from "../../src/modules/idempotency/service";

describe("request fingerprints", () => {
  it("ignore key order and undefined fields, and differ for any changed value", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, "x"], c: null }, z: undefined })).toBe('{"a":{"c":null,"d":[1,"x"]},"b":1}');
    const base = requestFingerprint("stock.receive", { sku: "A", quantity: 1, reason: null });
    expect(requestFingerprint("stock.receive", { reason: null, quantity: 1, sku: "A" })).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    for (const other of [
      requestFingerprint("stock.receive", { sku: "A", quantity: 2, reason: null }),
      requestFingerprint("stock.receive", { sku: "A", quantity: 1, reason: "x" }),
      requestFingerprint("stock.adjust", { sku: "A", quantity: 1, reason: null }),
      requestFingerprint("stock.receive", { sku: "A", quantity: "1", reason: null }),
    ]) {
      expect(other).not.toBe(base);
    }
  });

  it("refuse values that are not plain JSON data", () => {
    for (const bad of [new Date(), Number.NaN, Infinity, BigInt(1), () => 1, new Map()]) {
      expect(() => canonicalJson({ v: bad })).toThrow();
    }
  });
});

describe("idempotency keys", () => {
  it("accept UUIDs and similar tokens, and refuse anything else", () => {
    expect(validateIdempotencyKey("3f8a6c1e-2b4d-4e6f-8a1b-2c3d4e5f6a7b")).toBe("3f8a6c1e-2b4d-4e6f-8a1b-2c3d4e5f6a7b");
    expect(validateIdempotencyKey("01HZX3Y4ABCDEFGHJKMNPQRSTV")).toBe("01HZX3Y4ABCDEFGHJKMNPQRSTV");
    for (const bad of [undefined, 42, "", "too-short", "a".repeat(129), "with space 1234567890", "quote\"d-key-1234567"]) {
      expect(() => validateIdempotencyKey(bad)).toThrow();
    }
  });
});
