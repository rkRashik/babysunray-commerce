import { describe, expect, it } from "vitest";
import { addToCart, cartUnits, parseQuantity, removeLine, setQuantity, validateCartLines } from "../../src/modules/storefront/cart";
import { DICTIONARIES, formatTaka, isLang, localised, toBnDigits } from "../../src/modules/storefront/i18n";

describe("money in the storefront preview", () => {
  it("formats integer paisa exactly, with lakh grouping, in English or Bangla digits", () => {
    expect(formatTaka(85_000, "en")).toBe("৳ 850");
    expect(formatTaka(92_050, "en")).toBe("৳ 920.50");
    expect(formatTaka(5, "en")).toBe("৳ 0.05");
    expect(formatTaka(268_050, "en")).toBe("৳ 2,680.50");
    expect(formatTaka(12_345_678_90, "en")).toBe("৳ 1,23,45,678.90");
    expect(formatTaka(268_050, "bn")).toBe("৳ ২,৬৮০.৫০");
    expect(formatTaka(0, "bn")).toBe("৳ ০");
    // The largest exact amount stays exact (no floating point anywhere).
    expect(formatTaka(Number.MAX_SAFE_INTEGER, "en")).toBe("৳ 9,00,71,99,25,47,409.91");
  });

  it("converts digits only", () => {
    expect(toBnDigits("0-3M 42.5")).toBe("০-৩M ৪২.৫");
  });
});

describe("cart lines", () => {
  it("accepts whole quantities from 1 to 1,000, also typed in Bangla digits", () => {
    expect(parseQuantity(" 3 ")).toBe(3);
    expect(parseQuantity("৩")).toBe(3);
    expect(parseQuantity("1000")).toBe(1000);
    for (const bad of ["", "0", "-1", "1.5", "1e2", "abc", "1001", "2 3", "１"]) expect(parseQuantity(bad), bad).toBeNull();
  });

  it("validates untrusted lines: canonical SKUs, merged duplicates, bounds, and nothing malformed", () => {
    expect(validateCartLines([{ sku: " ab-1 ", quantity: 2 }, { sku: "AB-1", quantity: 3 }, { sku: "c_2", quantity: 1 }])).toEqual([
      { sku: "AB-1", quantity: 5 },
      { sku: "C_2", quantity: 1 },
    ]);
    expect(validateCartLines([])).toEqual([]);
    for (const bad of [null, "x", {}, [{ sku: "A" }], [{ sku: "A", quantity: 0 }], [{ sku: "A", quantity: 1.5 }], [{ sku: "A", quantity: "2" }], [{ sku: "ä", quantity: 1 }], [{ sku: "A", quantity: 600 }, { sku: "a", quantity: 401 }]]) {
      expect(() => validateCartLines(bad), JSON.stringify(bad)).toThrow();
    }
    expect(() => validateCartLines(Array.from({ length: 21 }, (_, i) => ({ sku: `S${i}`, quantity: 1 })))).toThrow(/at most 20/);
  });

  it("adds, changes and removes lines without touching the others", () => {
    let lines = addToCart([], "A", 2);
    lines = addToCart(lines, "B", 1);
    lines = addToCart(lines, "A", 1);
    expect(lines).toEqual([{ sku: "A", quantity: 3 }, { sku: "B", quantity: 1 }]);
    expect(setQuantity(lines, "B", 4)).toEqual([{ sku: "A", quantity: 3 }, { sku: "B", quantity: 4 }]);
    expect(removeLine(lines, "A")).toEqual([{ sku: "B", quantity: 1 }]);
    expect(cartUnits(lines)).toBe(4);
  });
});

describe("bilingual interface text", () => {
  it("has the same keys in English and Bangla, and Bangla text for every Bangla entry", () => {
    const keys = (o: object): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v).map((x) => `${k}.${x}`) : [k])).sort();
    expect(keys(DICTIONARIES.bn)).toEqual(keys(DICTIONARIES.en));
    expect(DICTIONARIES.bn.previewBanner).toMatch(/[ঀ-৿]/);
    expect(DICTIONARIES.bn.errors.phone_invalid).toMatch(/[ঀ-৿]/);
    expect(DICTIONARIES.bn.available(12)).toContain("১২");
  });

  it("never falls back to invented text: a missing language is null", () => {
    expect(localised("bn", "Soft", null)).toBeNull();
    expect(localised("en", "Soft", "নরম")).toBe("Soft");
    expect([isLang("bn"), isLang("fr"), isLang(undefined)]).toEqual([true, false, false]);
  });
});
