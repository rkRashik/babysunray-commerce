import { describe, expect, it } from "vitest";
import { readRateLimits } from "../../src/modules/rate-limit/service";

describe("API rate-limit configuration", () => {
  it("defaults to 300 reads and 60 writes per user and minute", () => {
    expect(readRateLimits({})).toEqual({ read: 300, write: 60 });
    expect(readRateLimits({ API_RATE_LIMIT_READS_PER_MINUTE: "", API_RATE_LIMIT_WRITES_PER_MINUTE: "" })).toEqual({ read: 300, write: 60 });
  });

  it("accepts whole numbers from 1 to 999999", () => {
    expect(readRateLimits({ API_RATE_LIMIT_READS_PER_MINUTE: "1", API_RATE_LIMIT_WRITES_PER_MINUTE: "999999" })).toEqual({ read: 1, write: 999999 });
  });

  it("refuses anything else, naming the variable but not the value", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "1000000", " 5", "05"]) {
      expect(() => readRateLimits({ API_RATE_LIMIT_WRITES_PER_MINUTE: bad })).toThrow(/^API_RATE_LIMIT_WRITES_PER_MINUTE must be/);
    }
  });
});
