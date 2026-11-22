import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/database";
import { getPrincipal } from "../../src/modules/auth/principal";
import { createCustomerAuth, GOOGLE_REDIRECT_PATH } from "../../src/modules/customers/auth";
import { clearAuthState, count, createTestAuth, createTestUser, headersWith } from "../support/auth";
import { createTestDb } from "../support/test-database";

// The boundaries of the existing customer Google sign-in (ADR-0011), with fictional client settings and no network: only
// the start of the flow and the callback's refusals can be exercised without a real Google account. A real sign-in with
// Google is part of the founder's manual acceptance (docs/operations/acceptance.md), not of this test.

const BASE = "http://localhost:3000";
const GOOGLE = { clientId: "123456789012-abcdefghijklmnop.apps.googleusercontent.com", clientSecret: "fictional-client-secret-0123456789" };
let db: Db;
let pool: Pool;
const customers = () => createCustomerAuth(db, { baseURL: BASE, secret: "a-fictional-installation-secret-with-enough-entropy-1234", google: GOOGLE, email: null, env: {} });

async function startSignIn(body: Record<string, unknown>, origin: string | null = BASE, cookie?: string) {
  await pool.query("delete from customer_rate_limits");
  return customers().handler(
    new Request(`${BASE}/api/customer-auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ provider: "google", disableRedirect: true, ...body }),
    }),
  );
}

beforeAll(async () => {
  ({ db, pool } = await createTestDb(4));
  await clearAuthState(pool);
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query("delete from customer_rate_limits");
});

describe("customer Google sign-in", () => {
  it("starts at Google with the registered redirect URI and minimal scopes, keeping its state on the server", async () => {
    const before = await count(pool, "select count(*) from customer_verifications");
    const response = await startSignIn({ callbackURL: "/en/checkout", errorCallbackURL: "/en/order?signin=failed" });
    expect(response.status).toBe(200);
    const url = new URL(((await response.json()) as { url: string }).url);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe(`${BASE}${GOOGLE_REDIRECT_PATH}`);
    expect(url.searchParams.get("client_id")).toBe(GOOGLE.clientId);
    expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual(["email", "openid", "profile"]);
    expect(url.searchParams.get("state")).toMatch(/.{16,}/);
    expect(url.searchParams.get("prompt")).toBe("select_account");
    // The state (with the return path) is kept in the database, so it cannot be altered by the browser.
    expect(await count(pool, "select count(*) from customer_verifications")).toBe(before + 1);
  });

  it("refuses a return or error address on another site, and a browser request from another origin", async () => {
    for (const callbackURL of ["https://evil.example/steal", "//evil.example/steal", "http://localhost:3001/x"]) {
      const response = await startSignIn({ callbackURL });
      expect(response.status, callbackURL).toBe(403);
    }
    expect((await startSignIn({ callbackURL: "/en", errorCallbackURL: "https://evil.example/" })).status).toBe(403);
    // A browser on another site sends its cookies along: refused (Better Auth's origin check guards cookie-bearing requests).
    expect((await startSignIn({ callbackURL: "/en" }, "https://evil.example", "bsr-customer.session_token=x")).status).toBe(403);
  });

  it("a callback without the state it issued signs nobody in and lands on the error page", async () => {
    const users = await count(pool, "select count(*) from customer_users");
    const response = await customers().handler(new Request(`${BASE}/api/customer-auth/callback/google?code=fictional&state=${randomUUID()}`, { method: "GET" }));
    expect([302, 303, 307]).toContain(response.status);
    expect(response.headers.get("location") ?? "").toMatch(/error|signin=failed/);
    expect(response.headers.getSetCookie().some((c) => c.startsWith("bsr-customer") && /session_token=[^;]+/.test(c))).toBe(false);
    expect(await count(pool, "select count(*) from customer_users")).toBe(users);
  });

  it("a customer session never opens Admin, even for an address that is a staff member's", async () => {
    const email = `google-staff-${randomUUID()}@example.test`;
    await createTestUser(pool, { email, password: "a long staff password for tests", role: "orders" });
    const customer = await pool.query<{ id: string }>("insert into customer_users (name, email, email_verified) values ('Same Address', $1, true) returning id", [email]);
    const token = randomUUID();
    await pool.query("insert into customer_sessions (token, user_id, expires_at, updated_at) values ($1, $2, now() + interval '1 day', now())", [token, customer.rows[0].id]);
    const admin = createTestAuth(db);
    // Whatever customer cookie is presented, the Admin instance (its own cookie name and secret) finds no principal.
    for (const cookie of [`bsr-customer.session_token=${token}`, `better-auth.session_token=${token}`]) {
      expect(await getPrincipal(admin, db, headersWith(cookie))).toBeNull();
    }
  });
});
