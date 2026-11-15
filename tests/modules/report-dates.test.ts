import { describe, expect, it } from "vitest";
import { dhakaDayStart, parseDateRange, rangeInstants } from "../../src/modules/reports/dates";
import { parseLowStockThreshold } from "../../src/modules/reports/dashboard";

// Report date ranges: Dhaka calendar dates, both inclusive, as a half-open UTC interval.

describe("parseDateRange", () => {
  it("defaults to the first of this month up to today (Dhaka)", () => {
    expect(parseDateRange(undefined, undefined, "2026-11-15")).toEqual({ from: "2026-11-01", to: "2026-11-15" });
  });

  it("accepts a single day and a full year", () => {
    expect(parseDateRange("2026-03-01", "2026-03-01")).toEqual({ from: "2026-03-01", to: "2026-03-01" });
    expect(parseDateRange("2025-01-01", "2025-12-31").to).toBe("2025-12-31");
  });

  it.each([
    ["2026-02-30", "2026-03-01"],
    ["2026-13-01", "2026-12-01"],
    ["15-11-2026", "2026-11-16"],
    ["2026-11-16", "2026-11-15"],
    ["2024-01-01", "2026-01-01"],
  ])("refuses %s to %s", (from, to) => {
    expect(() => parseDateRange(from, to)).toThrow();
  });
});

describe("Dhaka day boundaries", () => {
  it("starts a Dhaka day at 18:00 UTC of the previous day", () => {
    expect(dhakaDayStart("2026-11-15").toISOString()).toBe("2026-11-14T18:00:00.000Z");
  });

  it("covers the whole last day and nothing of the next (month and year boundaries)", () => {
    const november = rangeInstants({ from: "2026-11-01", to: "2026-11-30" });
    expect(november.start.toISOString()).toBe("2026-10-31T18:00:00.000Z");
    expect(november.end.toISOString()).toBe("2026-11-30T18:00:00.000Z");
    const lastInstant = new Date("2026-11-30T17:59:59.999Z"); // 23:59:59.999 on 30 November in Dhaka
    expect(lastInstant >= november.start && lastInstant < november.end).toBe(true);
    const nextMidnight = new Date("2026-11-30T18:00:00.000Z"); // 00:00 on 1 December in Dhaka
    expect(nextMidnight < november.end).toBe(false);
    expect(rangeInstants({ from: "2026-12-31", to: "2026-12-31" }).end.toISOString()).toBe("2026-12-31T18:00:00.000Z");
  });

  it("handles a leap day", () => {
    expect(rangeInstants({ from: "2028-02-29", to: "2028-02-29" }).end.toISOString()).toBe("2028-02-29T18:00:00.000Z");
  });
});

describe("low-stock threshold (Owner-chosen, view only)", () => {
  it("is empty by default and accepts whole numbers", () => {
    expect(parseLowStockThreshold(undefined)).toBeNull();
    expect(parseLowStockThreshold("")).toBeNull();
    expect(parseLowStockThreshold("5")).toBe(5);
  });
  it.each(["0", "-1", "2.5", "abc", "1000000"])("refuses %s", (raw) => {
    expect(() => parseLowStockThreshold(raw)).toThrow();
  });
});
