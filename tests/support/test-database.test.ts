import { describe, expect, it } from "vitest";
import { assertSafeTestDatabaseUrl } from "./test-database";

const SAFE = "postgresql://babysunray_test:pass@localhost:5432/babysunray_test";

describe("assertSafeTestDatabaseUrl", () => {
  it("accepts the local babysunray_test database and role", () => {
    expect(assertSafeTestDatabaseUrl(SAFE)).toBe(SAFE);
    const ipv6 = "postgres://babysunray_test:pass@[::1]/babysunray_test";
    expect(assertSafeTestDatabaseUrl(ipv6)).toBe(ipv6);
  });

  it("rejects a missing or malformed value", () => {
    expect(() => assertSafeTestDatabaseUrl(undefined)).toThrow("not set");
    expect(() => assertSafeTestDatabaseUrl("not a url")).toThrow("valid URL");
  });

  it("rejects a non-PostgreSQL scheme", () => {
    expect(() => assertSafeTestDatabaseUrl("mysql://babysunray_test:p@localhost/babysunray_test")).toThrow("scheme");
  });

  it("rejects a remote host", () => {
    expect(() =>
      assertSafeTestDatabaseUrl("postgresql://babysunray_test:p@db.example.com/babysunray_test"),
    ).toThrow("local host");
  });

  it("rejects query parameters that could redirect the connection", () => {
    expect(() => assertSafeTestDatabaseUrl(`${SAFE}?host=db.example.com`)).toThrow("query parameters");
  });

  it("rejects any database other than babysunray_test", () => {
    expect(() => assertSafeTestDatabaseUrl("postgresql://babysunray_test:p@localhost/babysunray_dev")).toThrow(
      "babysunray_test database",
    );
    expect(() => assertSafeTestDatabaseUrl("postgresql://babysunray_test:p@localhost/other_test")).toThrow(
      "babysunray_test database",
    );
  });

  it("rejects any role other than babysunray_test", () => {
    expect(() => assertSafeTestDatabaseUrl("postgresql://postgres:p@localhost/babysunray_test")).toThrow(
      "babysunray_test role",
    );
  });

  it("rejects a DATABASE_URL that identifies the test database", () => {
    expect(() => assertSafeTestDatabaseUrl(SAFE, SAFE)).toThrow("same database");
    expect(() => assertSafeTestDatabaseUrl(SAFE, "not a url")).toThrow("DATABASE_URL");
    const dev = "postgresql://babysunray_dev:p@localhost/babysunray_dev";
    expect(assertSafeTestDatabaseUrl(SAFE, dev)).toBe(SAFE);
  });
});
