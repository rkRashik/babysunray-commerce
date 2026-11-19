import { beforeEach, describe, expect, it, vi } from "vitest";

// The shop's HTTP doors (ADR-0011) with the real access check and no acceptance pass: the checkout answers 503 and the
// customer sign-in answers 404, both before any database work. Allowlisting: only three customer-auth endpoints exist.

const touched = vi.fn();
vi.mock("@/db/client", () => ({
  getDb: () => {
    touched("database");
    throw new Error("the database was touched");
  },
}));

const { POST: checkout, GET: checkoutGet } = await import("../../src/app/api/shop/checkout/route");
const { POST: customerPost, GET: customerGet } = await import("../../src/app/api/customer-auth/[...all]/route");
const { GET: googleCallback } = await import("../../src/app/api/auth/callback/google/route");
const { customerRouteAllowed } = await import("../../src/modules/customers/auth");

const ORIGIN = "https://shop.example.test";
const order = JSON.stringify({ customer: { name: "Fictional", phone: "01711000000", address: "Fictional Road" }, deliveryZone: "dhaka_city", items: [{ sku: "X-1", quantity: 1, unitPricePaisa: 100 }], deliveryChargePaisa: 0, totalPaisa: 100 });

beforeEach(() => {
  touched.mockClear();
  process.env.BETTER_AUTH_SECRET = "a-fictional-installation-secret-with-enough-entropy-1234";
  process.env.BETTER_AUTH_URL = ORIGIN;
});

describe("POST /api/shop/checkout without an acceptance pass", () => {
  it("answers 503 shop closed and never touches the database, whatever the body, key or cookies", async () => {
    for (const cookie of [undefined, "bsr_acceptance=forged.pass", "bsr_acceptance=v1.00000000-0000-4000-8000-000000000000.9999999999.AAAA.BBBB"]) {
      const response = await checkout(
        new Request(`${ORIGIN}/api/shop/checkout`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN, "idempotency-key": crypto.randomUUID(), ...(cookie ? { cookie } : {}) },
          body: order,
        }),
      );
      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: string }).error).toBe("checkout_closed");
    }
    expect((await checkoutGet(new Request(`${ORIGIN}/api/shop/checkout`))).status).toBe(405);
    expect(touched).not.toHaveBeenCalled();
  });
});

describe("customer sign-in doors", () => {
  it("allow only the listed endpoints, never account linking, deletion or token reads", () => {
    for (const r of ["POST /sign-in/social", "GET /callback/google", "POST /sign-out", "POST /sign-up/email", "POST /sign-in/email", "GET /verify-email", "POST /request-password-reset", "GET /reset-password/abcdefgh1234", "POST /reset-password", "POST /change-password", "POST /update-user"]) {
      expect(customerRouteAllowed(r), r).toBe(true);
    }
    for (const r of ["POST /link-social", "POST /delete-user", "GET /list-accounts", "POST /get-access-token", "GET /get-session", "POST /change-email", "GET /reset-password/x", "GET /reset-password/abc/def", "POST /unlink-account"]) {
      expect(customerRouteAllowed(r), r).toBe(false);
    }
  });

  it("answer 404 without an acceptance pass, for allowed and other paths alike, without database work", async () => {
    const calls = [
      customerPost(new Request(`${ORIGIN}/api/customer-auth/sign-in/social`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: '{"provider":"google"}' })),
      customerPost(new Request(`${ORIGIN}/api/customer-auth/sign-out`, { method: "POST", headers: { origin: ORIGIN } })),
      customerPost(new Request(`${ORIGIN}/api/customer-auth/sign-in/email`, { method: "POST", headers: { origin: ORIGIN } })),
      customerPost(new Request(`${ORIGIN}/api/customer-auth/sign-up/email`, { method: "POST", headers: { origin: ORIGIN } })),
      customerGet(new Request(`${ORIGIN}/api/customer-auth/get-session`)),
      customerGet(new Request(`${ORIGIN}/api/customer-auth/list-accounts`)),
      googleCallback(new Request(`${ORIGIN}/api/auth/callback/google?code=x&state=y`)),
    ];
    for (const response of await Promise.all(calls)) expect(response.status).toBe(404);
    expect(touched).not.toHaveBeenCalled();
  });
});
