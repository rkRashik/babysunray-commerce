import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_TARGET } from "../../src/db/connection-guard.mts";
import type { Db } from "../../src/db/database";
import { bootstrapFirstOwner } from "../../src/modules/auth/owner-bootstrap.mts";
import { getBearerPrincipal, getPrincipal, requirePermission } from "../../src/modules/auth/principal";
import {
  BASE_URL,
  bearer,
  call,
  clearAuthState,
  count,
  createTestAuth,
  createTestUser,
  headersWith,
  OWNER,
  signIn,
  signInNative,
} from "../support/auth";
import { resetAndMigrate } from "../support/global-setup";
import { connectTestClient, createTestDb } from "../support/test-database";

// Gate H.2a: the Bearer transport for native clients and /api/v1, its separation from the browser cookie,
// the guard that keeps the signed token away from browsers, the database trigger that ends sessions when
// access is lost, and sign-up refusal for path spellings.

let db: Db;
let pool: Pool;
let auth: ReturnType<typeof createTestAuth>;
let ownerId: string;

beforeAll(async () => {
  await resetAndMigrate(process.env.TEST_DATABASE_URL);
  ({ db, pool } = await createTestDb(6));
  auth = createTestAuth(db);
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await clearAuthState(pool);
  const client = await connectTestClient();
  try {
    ({ userId: ownerId } = await bootstrapFirstOwner(client, TEST_TARGET, OWNER));
  } finally {
    await client.end();
  }
});

const sessions = () => count(pool, "select count(*) from auth_sessions");
const nativeToken = async () => {
  const { response, token } = await signInNative(auth, OWNER.email, OWNER.password);
  expect(response.status).toBe(200);
  return token as string;
};
const authRequest = (path: string, headers: Headers, body?: unknown) => {
  if (body !== undefined) headers.set("content-type", "application/json");
  return auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }),
  );
};

describe("Bearer transport", () => {
  it("gives a native sign-in a signed token that works only as Bearer, never on the browser path", async () => {
    const token = await nativeToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9+/=%_-]+$/);
    expect(await getBearerPrincipal(auth, db, bearer(token))).toEqual({ userId: ownerId, role: "owner" });
    // Browser-side server code ignores Authorization entirely.
    expect(await getPrincipal(auth, db, bearer(token))).toBeNull();
    await expect(requirePermission(auth, db, bearer(token), "stock:read")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("never accepts a browser cookie on the Bearer path", async () => {
    const { cookie } = await signIn(auth, OWNER.email, OWNER.password);
    expect(await getPrincipal(auth, db, headersWith(cookie))).not.toBeNull();
    expect(await getBearerPrincipal(auth, db, headersWith(cookie))).toBeNull();
    // A cookie next to a malformed Authorization header does not fall back to the cookie.
    for (const authorization of ["Bearer", "Basic abc", "Bearer  two spaces"]) {
      expect(await getBearerPrincipal(auth, db, new Headers({ cookie, authorization })), authorization).toBeNull();
    }
  });

  it("refuses malformed, tampered, oversized and foreign-secret tokens", async () => {
    const token = await nativeToken();
    const [raw, signature] = token.split(".");
    for (const bad of [
      `Bearer ${token} extra`,
      `bearer${token}`,
      `Bearer ${raw}.${signature.slice(0, -2)}AA`,
      `Bearer ${"x".repeat(32)}.${signature}`,
      `Bearer ${raw}`,
      `Bearer ${"y".repeat(600)}`,
    ]) {
      expect(await getBearerPrincipal(auth, db, new Headers({ authorization: bad })), bad.slice(0, 40)).toBeNull();
    }
    expect(await getBearerPrincipal(auth, db, new Headers())).toBeNull();
    // Another installation (another secret) does not accept it.
    expect(await getBearerPrincipal(createTestAuth(db), db, bearer(token))).toBeNull();
  });

  it("stops working when the session is signed out, revoked or expired", async () => {
    const first = await nativeToken();
    const second = await nativeToken();
    const third = await nativeToken();

    // Native sign-out: the token as Bearer, no Origin needed because no cookie is sent.
    expect((await authRequest("/sign-out", bearer(first))).status).toBe(200);
    expect(await getBearerPrincipal(auth, db, bearer(first))).toBeNull();

    const { rows } = await pool.query<{ token: string }>("select token from auth_sessions");
    const secondRaw = rows.find((r) => second.startsWith(`${r.token}.`))!.token;
    expect((await authRequest("/revoke-session", bearer(third), { token: secondRaw })).status).toBe(200);
    expect(await getBearerPrincipal(auth, db, bearer(second))).toBeNull();

    expect(await getBearerPrincipal(auth, db, bearer(third))).not.toBeNull();
    await pool.query("update auth_sessions set expires_at = now() - interval '1 second'");
    expect(await getBearerPrincipal(auth, db, bearer(third))).toBeNull();
  });
});

describe("browser token guard", () => {
  it("never sends the signed token to a browser sign-in", async () => {
    const withOrigin = await signIn(auth, OWNER.email, OWNER.password);
    expect(withOrigin.response.status).toBe(200);
    expect(withOrigin.response.headers.get("set-auth-token")).toBeNull();
    expect(withOrigin.response.headers.get("access-control-expose-headers") ?? "").not.toMatch(/set-auth-token/i);

    // Fetch Metadata without Origin: Better Auth refuses the sign-in itself, and no token is sent.
    const fetchMetadataOnly = await authRequest(
      "/sign-in/email",
      new Headers({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }),
      { email: OWNER.email, password: OWNER.password },
    );
    expect(fetchMetadataOnly.status).toBe(403);
    expect(fetchMetadataOnly.headers.get("set-auth-token")).toBeNull();
  });

  it("does not send it on a browser's session refresh either", async () => {
    const { cookie } = await signIn(auth, OWNER.email, OWNER.password);
    // Make the session due for its daily refresh, so get-session re-issues the cookie.
    await pool.query("update auth_sessions set updated_at = now() - interval '2 days', expires_at = now() + interval '1 hour'");
    const refreshed = await call(auth, "GET", "/get-session", { cookie, headers: { "sec-fetch-site": "same-origin" } });
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.getSetCookie().join(";")).toContain("session_token=");
    expect(refreshed.headers.get("set-auth-token")).toBeNull();
  });

  it("is what stops the leak: a native refresh does receive the token", async () => {
    const token = await nativeToken();
    await pool.query("update auth_sessions set updated_at = now() - interval '2 days', expires_at = now() + interval '1 hour'");
    const refreshed = await auth.handler(new Request(`${BASE_URL}/api/auth/get-session`, { headers: bearer(token) }));
    expect(refreshed.headers.get("set-auth-token")).toBe(token);
  });
});

describe("losing access ends existing sessions", () => {
  it.each([
    ["disabling", "update user_access set disabled_at = now() where user_id = $1"],
    ["removing access", "delete from user_access where user_id = $1"],
  ])("%s deletes every session, so Better Auth's self-service endpoints refuse too", async (_name, statement) => {
    const { cookie } = await signIn(auth, OWNER.email, OWNER.password);
    const token = await nativeToken();
    expect(await sessions()).toBe(2);
    await pool.query(statement, [ownerId]);
    expect(await sessions()).toBe(0);
    expect(await (await call(auth, "GET", "/get-session", { cookie })).json()).toBeNull();
    expect((await call(auth, "GET", "/list-sessions", { cookie })).status).toBe(401);
    const change = await call(auth, "POST", "/change-password", {
      body: { currentPassword: OWNER.password, newPassword: "a brand new long password" },
      cookie,
    });
    expect(change.status).toBe(401);
    expect(await getBearerPrincipal(auth, db, bearer(token))).toBeNull();
  });

  it("leaves other users' sessions, and sessions after an unrelated change, alone", async () => {
    const otherId = await createTestUser(pool, { email: "keep@example.test", password: "keep long password 1", role: "owner" });
    await signIn(auth, "keep@example.test", "keep long password 1");
    await signIn(auth, OWNER.email, OWNER.password);
    await pool.query("update user_access set updated_at = now() where user_id = $1", [ownerId]);
    await pool.query("update user_access set disabled_at = now() where user_id = $1", [otherId]);
    await pool.query("update user_access set disabled_at = now() where user_id = $1", [otherId]);
    expect(await count(pool, "select count(*) from auth_sessions where user_id = $1", [ownerId])).toBe(1);
    expect(await count(pool, "select count(*) from auth_sessions where user_id = $1", [otherId])).toBe(0);
  });
});

describe("public registration through path variants", () => {
  it("never creates an account, whatever the spelling of the sign-up path", async () => {
    const body = { email: "variant@example.test", name: "Variant", password: "a long enough password" };
    for (const p of ["/sign-up/email/", "//sign-up/email", "/sign-up%2Femail", "/SIGN-UP/EMAIL", "/sign-up/./email", "/x/../sign-up/email"]) {
      const response = await authRequest(p, new Headers({ origin: BASE_URL }), body);
      expect(response.status, p).toBeGreaterThanOrEqual(400);
      await pool.query("delete from auth_rate_limits");
    }
    expect(await count(pool, "select count(*) from auth_users where email = 'variant@example.test'")).toBe(0);
  });
});
