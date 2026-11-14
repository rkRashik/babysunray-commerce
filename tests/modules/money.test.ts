import { describe, expect, it } from "vitest";
import { formatPaisa, parseTakaToPaisa } from "../../src/modules/money";

describe("Taka text and integer paisa", () => {
  it("parses whole and decimal Taka exactly", () => {
    expect(parseTakaToPaisa("850")).toBe(85_000);
    expect(parseTakaToPaisa(" 850.5 ")).toBe(85_050);
    expect(parseTakaToPaisa("850.05")).toBe(85_005);
    expect(parseTakaToPaisa("0.29")).toBe(29); // 0.29 * 100 is 28.999... in floating point
    expect(parseTakaToPaisa("1.15")).toBe(115);
    expect(parseTakaToPaisa("90071992547409.91")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("refuses anything that is not a plain amount", () => {
    for (const bad of ["", "abc", "-5", "+5", "5.", ".5", "5.123", "1,000", "৳500", "1e3", "90071992547409.92", "1 000"]) {
      expect(() => parseTakaToPaisa(bad), bad).toThrow();
    }
  });

  it("formats paisa as Taka with two decimals", () => {
    expect(formatPaisa(85_050)).toBe("850.50");
    expect(formatPaisa(5)).toBe("0.05");
    expect(formatPaisa(100)).toBe("1.00");
    expect(formatPaisa(-250)).toBe("-2.50");
  });
});
