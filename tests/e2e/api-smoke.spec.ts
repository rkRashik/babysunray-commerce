import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { clearSignInLimits, E2E_OWNER, ownerPassword } from "./support";

// HTTP smoke test of /api/v1 through the running Next.js server, as a native (non-browser) client: no Origin,
// no cookies, Bearer token from the sign-in response header. Complements the route-handler contract tests.

test.beforeEach(clearSignInLimits);

test("a native client signs in, creates, edits and searches a draft over HTTP; cookies and other origins are refused", async ({ playwright, baseURL }) => {
  // Sign in from a context that is then thrown away: its cookie jar keeps the session cookie, and a request
  // carrying that cookie is treated as a browser by Better Auth (sign-out then needs an Origin). A native
  // client must keep only the Bearer token (docs/api/README.md, Authentication).
  const login = await playwright.request.newContext({ baseURL });
  const signIn = await login.post("/api/auth/sign-in/email", { data: { email: E2E_OWNER.email, password: ownerPassword() } });
  expect(signIn.status()).toBe(200);
  const token = signIn.headers()["set-auth-token"];
  expect(token).toBeTruthy();
  await login.dispose();
  const api = await playwright.request.newContext({ baseURL });
  try {
    const auth = { authorization: `Bearer ${token}` };

    const slug = `e2e-api-${Date.now().toString(36)}`;
    const created = await api.post("/api/v1/products", { headers: { ...auth, "idempotency-key": randomUUID() }, data: { slug, name: { en: "API Romper", bn: "এপিআই রম্পার" } } });
    expect(created.status()).toBe(201);
    const product = (await created.json()).data;
    expect(product.version).toBe(1);

    const key = randomUUID();
    const edit = () => api.patch(`/api/v1/products/${product.id}`, { headers: { ...auth, "idempotency-key": key }, data: { version: 1, name: { en: "API Romper Edited" } } });
    const first = await edit();
    const retry = await edit();
    expect([first.status(), retry.status()]).toEqual([200, 200]);
    expect(retry.headers()["idempotent-replayed"]).toBe("true");
    expect((await retry.json()).data.version).toBe(2);

    const stale = await api.patch(`/api/v1/products/${product.id}`, { headers: { ...auth, "idempotency-key": randomUUID() }, data: { version: 1, name: { en: "Stale" } } });
    expect([stale.status(), (await stale.json()).code]).toEqual([409, "VERSION_CONFLICT"]);

    const found = await api.get(`/api/v1/products?q=${encodeURIComponent("এপিআই রম্পার")}`, { headers: auth });
    expect(found.status()).toBe(200);
    expect((await found.json()).data.map((p: { id: string }) => p.id)).toContain(product.id);

    const cookieOnly = await api.get("/api/v1/products", { headers: { cookie: `better-auth.session_token=${token}` } });
    expect(cookieOnly.status()).toBe(401);
    const otherOrigin = await api.get("/api/v1/products", { headers: { ...auth, origin: "https://elsewhere.example" } });
    expect(otherOrigin.status()).toBe(403);
    const preflight = await api.fetch("/api/v1/products", { method: "OPTIONS", headers: { origin: "https://elsewhere.example", "access-control-request-method": "PATCH" } });
    expect(preflight.status()).toBe(405);
    for (const response of [found, cookieOnly, otherOrigin, preflight]) {
      expect(Object.keys(response.headers()).filter((h) => h.startsWith("access-control-"))).toEqual([]);
      expect(response.headers()["cache-control"]).toBe("no-store");
    }

    const signOut = await api.post("/api/auth/sign-out", { headers: auth, data: {} });
    expect(signOut.status()).toBe(200);
    expect((await api.get("/api/v1/products", { headers: auth })).status()).toBe(401);
  } finally {
    await api.dispose();
  }
});
