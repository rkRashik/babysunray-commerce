import { describe, expect, it } from "vitest";
import { assertSafeTestDatabaseUrl } from "./test-database";

describe("assertSafeTestDatabaseUrl", () => {
  it("accepts a local database whose name ends in _test", () => {
    const url = "postgresql://user:pass@localhost:5432/example_test";
    expect(assertSafeTestDatabaseUrl(url)).toBe(url);
  });

  it("rejects a missing or malformed value", () => {
    expect(() => assertSafeTestDatabaseUrl(undefined)).toThrow("not set");
    expect(() => assertSafeTestDatabaseUrl("not a url")).toThrow("valid URL");
  });

  it("rejects a non-PostgreSQL scheme", () => {
    expect(() => assertSafeTestDatabaseUrl("mysql://u:p@localhost/x_test")).toThrow("scheme");
  });

  it("rejects a remote host", () => {
    expect(() => assertSafeTestDatabaseUrl("postgresql://u:p@db.example.com/x_test")).toThrow(
      "local host",
    );
  });

  it("rejects a database name that does not end in _test", () => {
    expect(() => assertSafeTestDatabaseUrl("postgresql://u:p@localhost/example_dev")).toThrow(
      "_test",
    );
  });
});
