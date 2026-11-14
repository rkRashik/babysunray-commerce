import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type Actor, issueUserActor, validateActor } from "../../src/modules/actor";
import { validateOwnerInput } from "../../src/modules/auth/owner-bootstrap.mts";
import { PERMISSIONS, type Permission, type Role, roleHasPermission } from "../../src/modules/auth/permissions";
import { readAuthSettings } from "../../src/modules/auth/settings";

const SECRET = randomBytes(32).toString("base64");
const env = (overrides: Record<string, string | undefined> = {}) => ({
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: "http://localhost:3000",
  NODE_ENV: "development",
  ...overrides,
});

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected a failure.");
}

describe("readAuthSettings", () => {
  it("accepts a random secret and a local development origin", () => {
    expect(readAuthSettings(env())).toEqual({ secret: SECRET, baseURL: "http://localhost:3000" });
    expect(readAuthSettings(env({ BETTER_AUTH_URL: "https://shop.example.test/", NODE_ENV: "production" })).baseURL).toBe(
      "https://shop.example.test",
    );
  });

  it.each([
    ["a missing secret", { BETTER_AUTH_SECRET: undefined }, "BETTER_AUTH_SECRET is not set"],
    ["the placeholder", { BETTER_AUTH_SECRET: `CHANGE_ME_${SECRET}` }, "placeholder"],
    ["a short secret", { BETTER_AUTH_SECRET: "Sh0rt-but-varied!" }, "at least 32 random characters"],
    ["a low-entropy secret", { BETTER_AUTH_SECRET: "ab".repeat(30) }, "at least 32 random characters"],
  ])("refuses %s without printing it", (_name, overrides, expected) => {
    const message = messageOf(() => readAuthSettings(env(overrides)));
    expect(message).toContain(expected);
    if (overrides.BETTER_AUTH_SECRET) expect(message).not.toContain(overrides.BETTER_AUTH_SECRET);
  });

  it.each([
    ["a missing URL", undefined, "development", "BETTER_AUTH_URL is not set"],
    ["a malformed URL", "not a url", "development", "not a valid URL"],
    ["a path", "http://localhost:3000/shop", "development", "origin only"],
    ["a query", "http://localhost:3000/?x=1", "development", "origin only"],
    ["credentials", "https://user:pw@shop.example.test", "production", "origin only"],
    ["plain http on a public host", "http://shop.example.test", "development", "must use https"],
    ["plain http in production", "http://localhost:3000", "production", "must use https"],
    ["another scheme", "ftp://localhost", "development", "must use https"],
  ])("refuses %s", (_name, url, nodeEnv, expected) => {
    expect(messageOf(() => readAuthSettings(env({ BETTER_AUTH_URL: url, NODE_ENV: nodeEnv })))).toContain(expected);
  });

  it.each(["BETTER_AUTH_TRUSTED_ORIGINS", "BETTER_AUTH_SECRETS", "BETTER_AUTH_TELEMETRY"])(
    "refuses %s, which Better Auth would apply behind this validation",
    (name) => {
      expect(messageOf(() => readAuthSettings(env({ [name]: "https://evil.example" })))).toContain(`${name} is not supported`);
    },
  );
});

describe("permissions", () => {
  it("gives the owner every named permission", () => {
    for (const permission of PERMISSIONS) expect(roleHasPermission("owner", permission)).toBe(true);
  });

  it("refuses unknown permissions and roles", () => {
    expect(roleHasPermission("owner", "orders:refund" as Permission)).toBe(false);
    expect(roleHasPermission("admin" as Role, "catalog:read")).toBe(false);
    expect(roleHasPermission("__proto__" as Role, "catalog:read")).toBe(false);
  });
});

describe("validateOwnerInput", () => {
  const ok = { email: " Owner@Example.TEST ", name: " Test Owner ", password: " fifteen chars! " };

  it("normalises the email and name and keeps the password exactly", () => {
    expect(validateOwnerInput(ok)).toEqual({ email: "owner@example.test", name: "Test Owner", password: " fifteen chars! " });
    expect(validateOwnerInput({ ...ok, password: "x".repeat(128) }).password).toHaveLength(128);
  });

  it.each([
    ["14 characters", { ...ok, password: "fourteen chars" }],
    ["129 characters", { ...ok, password: "y".repeat(129) }],
    ["a missing password", { ...ok, password: undefined as unknown as string }],
    ["an email with spaces", { ...ok, email: "owner @example.test" }],
    ["an email without a domain", { ...ok, email: "owner@" }],
    ["a 101-character name", { ...ok, name: "n".repeat(101) }],
  ])("rejects %s without echoing values", (_name, input) => {
    const message = messageOf(() => validateOwnerInput(input));
    if (input.password) expect(message).not.toContain(input.password);
    expect(message).not.toContain("owner@");
  });
});

describe("user actors", () => {
  it("accepts only actors issued by the authorisation boundary", () => {
    const id = randomUUID();
    const issued = issueUserActor(id);
    expect(validateActor(issued)).toBe(issued);
    expect(Object.isFrozen(issued)).toBe(true);
    expect(() => validateActor({ type: "user", ref: id } as Actor)).toThrow("verified session");
    expect(() => validateActor({ ...issued })).toThrow("verified session");
  });

  it("refuses to issue an actor for anything but a canonical user id", () => {
    for (const bad of ["", "owner", "Owner@example.test", randomUUID().toUpperCase(), `${randomUUID()} `]) {
      expect(() => issueUserActor(bad)).toThrow("canonical user id");
    }
  });
});
