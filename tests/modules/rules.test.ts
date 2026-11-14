import { describe, expect, it } from "vitest";
import { validateActor } from "../../src/modules/actor";
import {
  normalizeSku,
  optionalText,
  validateId,
  validatePricePaisa,
  validateSlug,
} from "../../src/modules/catalogue/rules";
import { DomainError } from "../../src/modules/domain-error";
import {
  MAX_STOCK_QUANTITY,
  validateAdjustmentDelta,
  validateReason,
  validateReceiptQuantity,
} from "../../src/modules/inventory/rules";
import type { Actor } from "../../src/modules/actor";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof DomainError ? error.code : "NOT_A_DOMAIN_ERROR";
  }
  return undefined;
}

describe("normalizeSku", () => {
  it("trims surrounding whitespace and uppercases", () => {
    expect(normalizeSku("  bs-romper-01\t")).toBe("BS-ROMPER-01");
    expect(normalizeSku("Bs-Romper-01")).toBe("BS-ROMPER-01");
  });

  it("accepts uppercase letters, digits, hyphens and underscores", () => {
    expect(normalizeSku("BABY-001")).toBe("BABY-001");
    expect(normalizeSku("baby-001")).toBe("BABY-001");
    expect(normalizeSku("  BABY_002  ")).toBe("BABY_002");
    expect(normalizeSku("-_-")).toBe("-_-");
  });

  it("rejects internal spaces and other symbols", () => {
    for (const bad of ["BABY 003", "A/B", "A.B", "A+B", "A\tB", "A\nB", "A\u0000B", "A B"]) {
      expect(codeOf(() => normalizeSku(bad))).toBe("INVALID_INPUT");
    }
  });

  it("rejects Unicode letters instead of converting them", () => {
    // toUpperCase() would turn "ß" into "SS" and pass; only a-z may be converted.
    for (const bad of ["BABYß", "baß", "বেবি-১", "BABYÉ", "é", "ＡBC", "ı"]) {
      expect(codeOf(() => normalizeSku(bad))).toBe("INVALID_INPUT");
    }
  });

  it("rejects empty and too long SKUs and keeps the 64-character bound", () => {
    expect(codeOf(() => normalizeSku("   "))).toBe("INVALID_INPUT");
    expect(codeOf(() => normalizeSku(""))).toBe("INVALID_INPUT");
    expect(codeOf(() => normalizeSku("A".repeat(65)))).toBe("INVALID_INPUT");
    expect(normalizeSku("A".repeat(64))).toHaveLength(64);
    expect(codeOf(() => normalizeSku(42 as unknown as string))).toBe("INVALID_INPUT");
  });
});

describe("catalogue values", () => {
  it("accepts lowercase hyphenated slugs only", () => {
    expect(validateSlug(" cotton-romper-2 ")).toBe("cotton-romper-2");
    for (const bad of ["", "Cotton", "a--b", "-a", "a_b", "a".repeat(101)]) {
      expect(codeOf(() => validateSlug(bad))).toBe("INVALID_INPUT");
    }
  });

  it("treats blank optional text as missing and enforces length", () => {
    expect(optionalText(undefined, "x", 5)).toBeNull();
    expect(optionalText("   ", "x", 5)).toBeNull();
    expect(optionalText(" নরম ", "x", 5)).toBe("নরম");
    expect(codeOf(() => optionalText("abcdef", "x", 5))).toBe("INVALID_INPUT");
  });

  it("accepts prices only as positive safe integers of paisa", () => {
    expect(validatePricePaisa(1)).toBe(1);
    expect(validatePricePaisa(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    for (const bad of [0, -100, 10.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      expect(codeOf(() => validatePricePaisa(bad))).toBe("INVALID_INPUT");
    }
  });

  it("accepts UUID identifiers only", () => {
    expect(validateId("0B9E6F0A-1C2D-4E5F-8A9B-0C1D2E3F4A5B", "id")).toBe("0b9e6f0a-1c2d-4e5f-8a9b-0c1d2e3f4a5b");
    expect(codeOf(() => validateId("1", "id"))).toBe("INVALID_INPUT");
  });
});

describe("inventory values", () => {
  it("accepts receipts of at least one whole unit", () => {
    expect(validateReceiptQuantity(1)).toBe(1);
    expect(validateReceiptQuantity(MAX_STOCK_QUANTITY)).toBe(MAX_STOCK_QUANTITY);
    for (const bad of [0, -1, 1.5, MAX_STOCK_QUANTITY + 1]) {
      expect(codeOf(() => validateReceiptQuantity(bad))).toBe("INVALID_INPUT");
    }
  });

  it("accepts non-zero whole adjustments in both directions", () => {
    expect(validateAdjustmentDelta(-3)).toBe(-3);
    expect(validateAdjustmentDelta(2)).toBe(2);
    for (const bad of [0, 0.5, -MAX_STOCK_QUANTITY - 1]) {
      expect(codeOf(() => validateAdjustmentDelta(bad))).toBe("INVALID_INPUT");
    }
  });

  it("requires a non-blank reason when asked", () => {
    expect(validateReason("  counted shelf  ", true)).toBe("counted shelf");
    expect(validateReason(undefined, false)).toBeNull();
    expect(validateReason("  ", false)).toBeNull();
    expect(codeOf(() => validateReason(undefined, true))).toBe("INVALID_INPUT");
    expect(codeOf(() => validateReason("   ", true))).toBe("INVALID_INPUT");
    expect(codeOf(() => validateReason("x".repeat(501), false))).toBe("INVALID_INPUT");
  });
});

describe("validateActor", () => {
  it("accepts a named system source", () => {
    expect(validateActor({ type: "system", ref: "seed:dev" })).toEqual({ type: "system", ref: "seed:dev" });
  });

  it("rejects user actors and free-text references", () => {
    expect(codeOf(() => validateActor({ type: "user", ref: "owner" } as unknown as Actor))).toBe("INVALID_INPUT");
    expect(codeOf(() => validateActor({ type: "system", ref: "Jane Doe" }))).toBe("INVALID_INPUT");
    expect(codeOf(() => validateActor({ type: "system", ref: "" }))).toBe("INVALID_INPUT");
    expect(codeOf(() => validateActor(undefined as unknown as Actor))).toBe("INVALID_INPUT");
  });
});
