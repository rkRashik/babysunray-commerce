import { describe, expect, it } from "vitest";
import { createCustomerAuth, CUSTOMER_BASE_PATH, customerSecret, GOOGLE_REDIRECT_PATH, readGoogleSettings } from "../../src/modules/customers/auth";
import { clientKey, trustedClientHeaders } from "../../src/modules/rate-limit/client";

// Customer sign-in settings and the instance's isolation from the Owner's (ADR-0011), and the trusted client address.

const CLIENT_ID = "123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com";
const SECRET = "a-fictional-installation-secret-with-enough-entropy-1234";

describe("Google sign-in settings", () => {
  it("are both or neither, and shaped like a Google web client", () => {
    expect(readGoogleSettings({})).toBeNull();
    expect(readGoogleSettings({ GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" })).toBeNull();
    expect(readGoogleSettings({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "fictional-secret-value-123" })).toEqual({ clientId: CLIENT_ID, clientSecret: "fictional-secret-value-123" });
    expect(() => readGoogleSettings({ GOOGLE_CLIENT_ID: CLIENT_ID })).toThrow(/set together/);
    expect(() => readGoogleSettings({ GOOGLE_CLIENT_SECRET: "fictional-secret-value-123" })).toThrow(/set together/);
    expect(() => readGoogleSettings({ GOOGLE_CLIENT_ID: "not-a-client", GOOGLE_CLIENT_SECRET: "fictional-secret-value-123" })).toThrow(/GOOGLE_CLIENT_ID/);
    expect(() => readGoogleSettings({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "short" })).toThrow(/GOOGLE_CLIENT_SECRET/);
    // Messages name the variable, never a value.
    try {
      readGoogleSettings({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "short" });
    } catch (error) {
      expect(String(error)).not.toContain("short");
      expect(String(error)).not.toContain(CLIENT_ID);
    }
  });
});

describe("the customer instance", () => {
  const auth = createCustomerAuth({} as never, { baseURL: "https://shop.example.test", secret: SECRET, google: { clientId: CLIENT_ID, clientSecret: "fictional-secret-value-123" }, email: null, env: {} });
  const options = auth.options;

  it("is Google only, never links accounts, and has its own path, cookies and secret", () => {
    expect(options.emailAndPassword?.enabled).toBe(false);
    expect(Object.keys(options.socialProviders ?? {})).toEqual(["google"]);
    expect(options.account?.accountLinking?.enabled).toBe(false);
    expect(options.basePath).toBe(CUSTOMER_BASE_PATH);
    expect(options.advanced?.cookiePrefix).toBe("bsr-customer");
    expect(options.secret).toBe(customerSecret(SECRET));
    expect(customerSecret(SECRET)).not.toBe(SECRET);
    expect(customerSecret(SECRET)).not.toBe(customerSecret(`${SECRET}x`));
  });

  it("sends Google back to the redirect URI registered for this installation, and keeps no scope beyond the defaults", () => {
    const google = options.socialProviders?.google as { redirectURI?: string; scope?: string[]; disableIdTokenSignIn?: boolean };
    expect(google.redirectURI).toBe(`https://shop.example.test${GOOGLE_REDIRECT_PATH}`);
    expect(GOOGLE_REDIRECT_PATH).toBe("/api/auth/callback/google");
    expect(google.scope).toBeUndefined();
    expect(google.disableIdTokenSignIn).toBe(true);
  });

  it("refuses an unverified address and drops every OAuth token before it is written", async () => {
    const hooks = options.databaseHooks!;
    const createUser = hooks.user!.create!.before!;
    const google = { path: "/callback/:id" } as never;
    expect(await createUser({ email: "a@example.test", emailVerified: false, name: "A" } as never, google)).toBe(false);
    expect(await createUser({ email: "a@example.test", emailVerified: true, name: "A" } as never, google)).toEqual({ data: { email: "a@example.test", emailVerified: true, name: "A" } });
    // An email sign-up starts unverified (it cannot sign in until confirmed).
    expect(await createUser({ email: "b@example.test", emailVerified: false, name: "B" } as never, { path: "/sign-up/email" } as never)).toEqual({ data: { email: "b@example.test", emailVerified: false, name: "B" } });
    const createAccount = hooks.account!.create!.before!;
    const written = (await createAccount({ providerId: "google", accountId: "1", accessToken: "t", refreshToken: "r", idToken: "i", password: "p" } as never)) as { data: Record<string, unknown> };
    expect(written.data).toMatchObject({ accessToken: null, refreshToken: null, idToken: null, password: null, accountId: "1" });
    // Without email set up there are no password accounts at all.
    expect(await createAccount({ providerId: "credential", accountId: "1" } as never)).toBe(false);
  });
});

describe("trusted client address", () => {
  const headers = new Headers({ "x-nf-client-connection-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" });

  it("is read only behind a named proxy, from that proxy's own header", () => {
    expect(trustedClientHeaders({})).toEqual([]);
    expect(trustedClientHeaders({ TRUSTED_PROXY: "netlify" })).toEqual(["x-nf-client-connection-ip"]);
    expect(() => trustedClientHeaders({ TRUSTED_PROXY: "cloudflare" })).toThrow(/TRUSTED_PROXY/);
    expect(clientKey(headers, {}, SECRET)).toBeNull();
    expect(clientKey(new Headers({ "x-forwarded-for": "198.51.100.1" }), { TRUSTED_PROXY: "netlify" }, SECRET)).toBeNull();
  });

  it("becomes an opaque per-client key, never the address", () => {
    const key = clientKey(headers, { TRUSTED_PROXY: "netlify" }, SECRET);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("203");
    expect(clientKey(new Headers({ "x-nf-client-connection-ip": "203.0.113.8" }), { TRUSTED_PROXY: "netlify" }, SECRET)).not.toBe(key);
    expect(clientKey(new Headers({ "x-nf-client-connection-ip": "2001:db8::1" }), { TRUSTED_PROXY: "netlify" }, SECRET)).toMatch(/^[0-9a-f]{64}$/);
    expect(clientKey(new Headers({ "x-nf-client-connection-ip": "not an address" }), { TRUSTED_PROXY: "netlify" }, SECRET)).toBeNull();
  });
});
