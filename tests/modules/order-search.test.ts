import { describe, expect, it } from "vitest";
import { classifyOrderSearch } from "../../src/modules/orders/queries";

// The Admin order search box: one field for an order number, a Bangladesh mobile number or part of a name.
// Fictional values only.

describe("classifyOrderSearch", () => {
  it("reads a Bangladesh mobile number in any common form as the normalized number", () => {
    for (const raw of ["01712345678", "+8801712345678", "8801712345678", "0171-234 5678", " 01712 345678 ", "০১৭১২৩৪৫৬৭৮"]) {
      expect(classifyOrderSearch(raw)).toEqual({ kind: "phone", phone: "01712345678" });
    }
  });

  it("reads an order number with or without its prefix", () => {
    expect(classifyOrderSearch("ORD-000042")).toEqual({ kind: "number", number: 42 });
    expect(classifyOrderSearch("ord-42")).toEqual({ kind: "number", number: 42 });
    expect(classifyOrderSearch("#42")).toEqual({ kind: "number", number: 42 });
    expect(classifyOrderSearch("42")).toEqual({ kind: "number", number: 42 });
  });

  it("treats anything else of two or more characters as part of a name, in English or Bangla", () => {
    expect(classifyOrderSearch("Rahim")).toEqual({ kind: "name", name: "Rahim" });
    expect(classifyOrderSearch("  রহিম ")).toEqual({ kind: "name", name: "রহিম" });
    expect(classifyOrderSearch("50% off")).toEqual({ kind: "name", name: "50% off" });
  });

  it("refuses empty, too short, too long, control-character and digit-only terms that are no phone or order number", () => {
    for (const raw of ["", "   ", "a", "x".repeat(101), "ab\u0000c", "0171", "1234567890123", "+44 20 7946 0000", null, 42]) {
      expect(classifyOrderSearch(raw)).toBeNull();
    }
  });
});
