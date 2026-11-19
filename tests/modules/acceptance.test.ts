import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Founder acceptance (ADR-0011): the pass is a signed, expiring credential that only this installation can issue; the
// access decision opens the shop only for a verified pass, an active Owner and a staging-marked database, and decides
// "closed" without any database work when there is no valid pass.

const role = vi.fn<(db: unknown, userId: string) => Promise<"owner" | null>>();
vi.mock("../../src/modules/auth/access", () => ({ findActiveRole: (db: unknown, userId: string) => role(db, userId) }));

const { ACCEPTANCE_COOKIE, forgetStagingMarker, isStagingDatabase, issuePass, PASS_HOURS, passFromCookieHeader, shopAccess, STAGING_MARKER, verifyPass } = await import("../../src/modules/launch/acceptance");

const SECRET = "a-fictional-installation-secret-with-enough-entropy-1234";
const OWNER = randomUUID();
const now = Date.UTC(2026, 10, 19, 6, 0, 0);

/** A database that answers only the marker query; any other use fails the test. */
const markerDb = (marker: string | null) => {
  const execute = vi.fn(async () => ({ rows: [{ marker }] }));
  return { db: { execute } as never, execute };
};
const untouchable = () => {
  throw new Error("the database was touched");
};

beforeEach(() => {
  forgetStagingMarker();
  role.mockReset();
});

describe("acceptance pass", () => {
  it("verifies for its Owner until it expires, and not after", () => {
    const pass = issuePass(SECRET, OWNER, now);
    expect(verifyPass(SECRET, pass.value, now)).toEqual({ userId: OWNER });
    expect(verifyPass(SECRET, pass.value, now + PASS_HOURS * 3_600_000 - 1000)).toEqual({ userId: OWNER });
    expect(verifyPass(SECRET, pass.value, now + PASS_HOURS * 3_600_000 + 1000)).toBeNull();
    expect(pass.expiresAt.getTime()).toBe(now + PASS_HOURS * 3_600_000);
  });

  it("refuses a forged, altered, foreign or malformed pass", () => {
    const { value } = issuePass(SECRET, OWNER, now);
    const [v, user, exp, nonce, sig] = value.split(".");
    expect(verifyPass(`${SECRET}x`, value, now)).toBeNull();
    expect(verifyPass(SECRET, [v, randomUUID(), exp, nonce, sig].join("."), now)).toBeNull();
    expect(verifyPass(SECRET, [v, user, String(Number(exp) + 3600), nonce, sig].join("."), now)).toBeNull();
    expect(verifyPass(SECRET, [v, user, exp, `${nonce}A`, sig].join("."), now)).toBeNull();
    expect(verifyPass(SECRET, [v, user, exp, nonce, `${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`].join("."), now)).toBeNull();
    expect(verifyPass(SECRET, ["v2", user, exp, nonce, sig].join("."), now)).toBeNull();
    for (const bad of [undefined, null, "", "x", "a.b.c.d.e", `${value}.extra`, "x".repeat(400)]) expect(verifyPass(SECRET, bad, now)).toBeNull();
  });

  it("is read from the Cookie header by name only", () => {
    expect(passFromCookieHeader(`other=1; ${ACCEPTANCE_COOKIE}=abc.def; more=2`)).toBe("abc.def");
    expect(passFromCookieHeader(`x${ACCEPTANCE_COOKIE}=nope`)).toBeUndefined();
    expect(passFromCookieHeader(null)).toBeUndefined();
  });
});

describe("shop access", () => {
  it("is closed without a pass, or with an invalid one, before any database work", async () => {
    const forged = issuePass("another-installation-secret-with-enough-entropy-99", OWNER, Date.now()).value;
    for (const pass of [undefined, "", "garbage", forged]) {
      expect(await shopAccess({ db: untouchable, secret: () => SECRET }, pass)).toBe("closed");
    }
    expect(role).not.toHaveBeenCalled();
  });

  it("opens for acceptance only with a valid pass, the staging marker and an active Owner", async () => {
    const pass = issuePass(SECRET, OWNER).value;
    const staging = markerDb(STAGING_MARKER);
    role.mockResolvedValue("owner");
    expect(await shopAccess({ db: () => staging.db, secret: () => SECRET }, pass)).toBe("acceptance");
    expect(role).toHaveBeenCalledWith(staging.db, OWNER);

    // The Owner lost access (disabled): closed.
    role.mockResolvedValue(null);
    expect(await shopAccess({ db: () => staging.db, secret: () => SECRET }, pass)).toBe("closed");
  });

  it("stays closed on any database that is not marked staging (development, production)", async () => {
    const pass = issuePass(SECRET, OWNER).value;
    role.mockResolvedValue("owner");
    for (const marker of [null, "babysunray:production", "babysunray:staging "]) {
      forgetStagingMarker();
      const { db } = markerDb(marker);
      expect(await shopAccess({ db: () => db, secret: () => SECRET }, pass)).toBe("closed");
    }
    expect(role).not.toHaveBeenCalled();
  });

  it("reads the marker from PostgreSQL and keeps it for a minute", async () => {
    const { db, execute } = markerDb(STAGING_MARKER);
    expect(await isStagingDatabase(db, now)).toBe(true);
    expect(await isStagingDatabase(db, now + 30_000)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await isStagingDatabase(db, now + 61_000)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
