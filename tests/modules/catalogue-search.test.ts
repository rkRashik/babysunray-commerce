import { describe, expect, it } from "vitest";
import { MAX_SEARCH_LENGTH, normalizeSearch, validateVersion } from "../../src/modules/catalogue/rules";

describe("normalizeSearch", () => {
  it("trims, collapses inner whitespace and treats blank as no search", () => {
    expect(normalizeSearch("  cotton   romper \t")).toBe("cotton romper");
    expect(normalizeSearch("")).toBeNull();
    expect(normalizeSearch("   ")).toBeNull();
  });

  it("normalises Bangla to NFC, so decomposed and precomposed input are the same term", () => {
    const precomposed = "কো"; // কো, with ো as one code point
    const decomposed = "কো"; // ক + ে + া
    expect(normalizeSearch(decomposed)).toBe(precomposed);
    expect(normalizeSearch("সুতির রম্পার")).toBe("সুতির রম্পার".normalize("NFC"));
  });

  it("keeps SQL and LIKE characters as text (escaping happens in the query)", () => {
    for (const raw of ["' or 1=1 --", "%", "_", "\\", "a%b_c"]) expect(normalizeSearch(raw)).toBe(raw);
  });

  it("refuses control characters and terms over the limit", () => {
    expect(() => normalizeSearch("romper\u0000")).toThrow("q must not contain control characters");
    expect(() => normalizeSearch("a\u001bb")).toThrow("control characters");
    expect(normalizeSearch("x".repeat(MAX_SEARCH_LENGTH))).toHaveLength(MAX_SEARCH_LENGTH);
    expect(() => normalizeSearch("x".repeat(MAX_SEARCH_LENGTH + 1))).toThrow("at most 100 characters");
  });
});

describe("validateVersion", () => {
  it("accepts positive whole numbers only", () => {
    expect(validateVersion(1)).toBe(1);
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 31]) expect(() => validateVersion(bad)).toThrow("version must be a positive whole number");
  });
});
