import { beforeEach, describe, expect, it, vi } from "vitest";

// The Admin's "Test database (staging)" notice (src/app/admin/_lib/staging.ts): shown only for the exact staging marker
// read from the database itself; never for a production-marked, unmarked or unreadable database. Fake databases only.

vi.mock("@/db/client", () => ({
  getDb: () => {
    throw new Error("DATABASE_URL is not set");
  },
}));

const { forgetStagingMarker } = await import("../../src/modules/launch/acceptance");
const { stagingDatabase } = await import("../../src/app/admin/_lib/staging");

const markerDb = (marker: string | null) => () => ({ execute: vi.fn(async () => ({ rows: [{ marker }] })) }) as never;

beforeEach(() => forgetStagingMarker());

describe("staging notice", () => {
  it("is shown for a database carrying the staging marker", async () => {
    expect(await stagingDatabase(markerDb("babysunray:staging"))).toBe(true);
  });

  it.each([["production marker", "babysunray:production"], ["no marker", null], ["a near miss", "babysunray:staging "], ["another comment", "staging"]])("is not shown for %s", async (_, marker) => {
    expect(await stagingDatabase(markerDb(marker))).toBe(false);
  });

  it("is not shown when the database cannot be reached or is not configured", async () => {
    const failing = () => ({ execute: vi.fn(async () => Promise.reject(new Error("connection refused"))) }) as never;
    expect(await stagingDatabase(failing)).toBe(false);
    forgetStagingMarker();
    // The default connection (here: not configured) throws before any query.
    expect(await stagingDatabase()).toBe(false);
  });
});
