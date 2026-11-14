import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_TARGET } from "../../src/db/connection-guard.mts";
import type { Db } from "../../src/db/database";
import { DISABLED_PATHS, ENABLED_PATHS } from "../../src/modules/auth/auth";
import { bootstrapFirstOwner } from "../../src/modules/auth/owner-bootstrap.mts";
import { getPrincipal, requirePermission, requirePrincipal } from "../../src/modules/auth/principal";
import type { Permission } from "../../src/modules/auth/permissions";
import {
  BASE_URL,
  call,
  clearAuthState,
  cookieFrom,
  count,
  createTestAuth,
  createTestUser,
  headersWith,
  OWNER,
  signIn,
} from "../support/auth";
import { resetAndMigrate } from "../support/global-setup";
import { connectTestClient, createTestDb } from "../support/test-database";

// Authentication and authorisation through Better Auth's real HTTP handler, against PostgreSQL. Each test
// starts with one fictional Owner, a fresh rate-limit table and no sessions.

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

const principalOf = (cookie: string) => getPrincipal(auth, db, headersWith(cookie));
const sessions = () => count(pool, "select count(*) from auth_sessions");

async function ownerCookie(): Promise<string> {
  const { response, cookie } = await signIn(auth, OWNER.email, OWNER.password);
  expect(response.status).toBe(200);
  return cookie;
}

describe("public registration", () => {
  it("cannot create an account over HTTP", async () => {
    const response = await call(auth, "POST", "/sign-up/email", {
      body: { email: "intruder@example.test", name: "Intruder", password: "a long enough password" },
    });
    expect(response.status).toBe(404);
    expect(await count(pool, "select count(*) from auth_users")).toBe(1);
  });

  it("is refused by Better Auth itself as well, so removing the path block would not open it", async () => {
    await expect(
      auth.api.signUpEmail({ body: { email: "intruder@example.test", name: "Intruder", password: "a long enough password" } }),
    ).rejects.toMatchObject({ body: { code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" } });
    expect(await count(pool, "select count(*) from auth_users")).toBe(1);
  });
});

describe("endpoint surface", () => {
  it("lists every Better Auth endpoint as either enabled or disabled", () => {
    const registered = Object.values(auth.api)
      .map((endpoint) => (endpoint as { path?: string }).path)
      .filter((p): p is string => typeof p === "string")
      .sort();
    expect(registered).toEqual([...ENABLED_PATHS, ...DISABLED_PATHS].sort());
    expect(ENABLED_PATHS.filter((p) => DISABLED_PATHS.includes(p))).toEqual([]);
  });

  it("answers 404 on every disabled path, also for a signed-in Owner", async () => {
    const cookie = await ownerCookie();
    for (const p of DISABLED_PATHS.filter((p) => !p.includes(":"))) {
      for (const method of ["GET", "POST"]) {
        expect((await call(auth, method, p, { body: method === "POST" ? {} : undefined, cookie })).status, `${method} ${p}`).toBe(404);
      }
    }
  });

  it("gives no session through the parameterised social and reset callbacks", async () => {
    for (const p of ["/callback/google", "/reset-password/made-up-token"]) {
      const response = await call(auth, "GET", p);
      expect(response.status, p).not.toBe(200);
      expect(response.headers.getSetCookie().join(";")).not.toContain("session_token");
    }
    expect(await sessions()).toBe(0);
  });

  it("refuses the raw session token as a Bearer token, and Bearer on the browser path", async () => {
    await ownerCookie();
    // get-session and list-sessions return this raw token in their JSON; it must not be a credential.
    const { rows } = await pool.query("select token from auth_sessions");
    const response = await call(auth, "GET", "/get-session", { headers: { authorization: `Bearer ${rows[0].token}` } });
    expect(await response.json()).toBeNull();
    expect(await getPrincipal(auth, db, new Headers({ authorization: `Bearer ${rows[0].token}` }))).toBeNull();
  });
});

describe("sign-in", () => {
  it("establishes a database session with a signed, HttpOnly, SameSite=Lax cookie", async () => {
    const { response } = await signIn(auth, OWNER.email.toUpperCase(), OWNER.password);
    expect(response.status).toBe(200);
    const [setCookie] = response.headers.getSetCookie().filter((c) => c.startsWith("better-auth.session_token="));
    expect(setCookie).toMatch(/; HttpOnly/i);
    expect(setCookie).toMatch(/; SameSite=Lax/i);
    expect(setCookie).toMatch(/; Path=\//i);
    expect(setCookie).toMatch(/; Max-Age=\d+/i);
    // Plain http on localhost is development only; see the https case below.
    expect(setCookie).not.toMatch(/; Secure/i);
    expect(response.headers.getSetCookie().join(";")).not.toContain("session_data");
    const { rows } = await pool.query("select user_id, token, expires_at from auth_sessions");
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(ownerId);
    // The cookie carries the token plus an HMAC signature, not the bare token.
    expect(decodeURIComponent(setCookie.split(";")[0].split("=")[1])).toMatch(new RegExp(`^${rows[0].token}\\.`));
  });

  it("marks the cookie Secure with the __Secure- prefix when the site runs on https", async () => {
    const httpsAuth = createTestAuth(db, "https://shop.example.test");
    const { response } = await signIn(httpsAuth, OWNER.email, OWNER.password, "https://shop.example.test");
    expect(response.status).toBe(200);
    const [setCookie] = response.headers.getSetCookie().filter((c) => c.includes("session_token="));
    expect(setCookie).toMatch(/^__Secure-better-auth\.session_token=/);
    expect(setCookie).toMatch(/; Secure/i);
    expect(setCookie).toMatch(/; HttpOnly/i);
  });

  it("refuses a wrong password and an unknown email with the same generic answer and no session", async () => {
    const wrong = await signIn(auth, OWNER.email, "not the right password");
    const unknown = await signIn(auth, "nobody@example.test", OWNER.password);
    expect(wrong.response.status).toBe(401);
    expect(unknown.response.status).toBe(401);
    const [a, b] = [await wrong.response.json(), await unknown.response.json()];
    expect(a).toEqual(b);
    expect(a.code).toBe("INVALID_EMAIL_OR_PASSWORD");
    expect(wrong.cookie).not.toContain("session_token");
    expect(await sessions()).toBe(0);
  });

  it("writes no email, password or token to the logs", async () => {
    const lines: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" "))),
    );
    try {
      await signIn(auth, OWNER.email, "not the right password");
      await signIn(auth, "nobody@example.test", "another wrong password");
      const cookie = await ownerCookie();
      await call(auth, "POST", "/sign-out", { body: {}, cookie, origin: "https://evil.example" });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const { rows } = await pool.query("select token from auth_sessions");
    const logged = lines.join("\n");
    for (const secret of [OWNER.email, "nobody@example.test", OWNER.password, "not the right password", ...rows.map((r) => r.token)]) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe("sessions", () => {
  it("reads a verified principal from the session cookie", async () => {
    expect(await principalOf(await ownerCookie())).toEqual({ userId: ownerId, role: "owner" });
  });

  it("refuses a missing, malformed, tampered or unsigned cookie", async () => {
    const cookie = await ownerCookie();
    const { rows } = await pool.query("select token from auth_sessions");
    const [name, value] = cookie.split("; ").find((c) => c.startsWith("better-auth.session_token="))!.split("=");
    const signature = decodeURIComponent(value).split(".").slice(1).join(".");
    for (const bad of [
      "",
      `${name}=garbage`,
      `${name}=${rows[0].token}`,
      `${name}=${encodeURIComponent(`${rows[0].token}.${signature.slice(0, -2)}AA`)}`,
      `${name}=${encodeURIComponent(`${"x".repeat(32)}.${signature}`)}`,
    ]) {
      expect(await principalOf(bad), bad).toBeNull();
    }
    await expect(requirePrincipal(auth, db, new Headers())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("refuses an expired session", async () => {
    const cookie = await ownerCookie();
    await pool.query("update auth_sessions set expires_at = now() - interval '1 second'");
    expect(await principalOf(cookie)).toBeNull();
  });

  it("ends the session on sign-out", async () => {
    const cookie = await ownerCookie();
    const response = await call(auth, "POST", "/sign-out", { body: {}, cookie });
    expect(response.status).toBe(200);
    expect(await sessions()).toBe(0);
    expect(await principalOf(cookie)).toBeNull();
  });

  it("revokes one other session, and all other sessions, at once", async () => {
    const first = await ownerCookie();
    const second = await ownerCookie();
    const third = await ownerCookie();
    const listed = await (await call(auth, "GET", "/list-sessions", { cookie: first })).json();
    expect(listed).toHaveLength(3);
    const { rows } = await pool.query<{ token: string }>("select token from auth_sessions order by created_at");
    const secondToken = rows.find((r) => second.includes(r.token))!.token;

    expect((await call(auth, "POST", "/revoke-session", { body: { token: secondToken }, cookie: first })).status).toBe(200);
    expect(await principalOf(second)).toBeNull();
    expect(await principalOf(first)).not.toBeNull();
    expect(await principalOf(third)).not.toBeNull();

    expect((await call(auth, "POST", "/revoke-other-sessions", { body: {}, cookie: first })).status).toBe(200);
    expect(await principalOf(third)).toBeNull();
    expect(await principalOf(first)).not.toBeNull();
    expect(await sessions()).toBe(1);
  });

  it("cannot revoke another user's session", async () => {
    const otherId = await createTestUser(pool, { email: "other@example.test", password: "other long password 1", role: "owner" });
    const otherCookie = (await signIn(auth, "other@example.test", "other long password 1")).cookie;
    const ownerSession = await ownerCookie();
    const { rows } = await pool.query("select token from auth_sessions where user_id = $1", [ownerId]);
    await call(auth, "POST", "/revoke-session", { body: { token: rows[0].token }, cookie: otherCookie });
    expect(await principalOf(ownerSession)).toEqual({ userId: ownerId, role: "owner" });
    expect(otherId).not.toBe(ownerId);
  });
});

describe("cross-origin requests", () => {
  it("refuses a cookie-authenticated state change from another origin, or with no origin", async () => {
    const cookie = await ownerCookie();
    expect((await call(auth, "POST", "/sign-out", { body: {}, cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await call(auth, "POST", "/sign-out", { body: {}, cookie, origin: null })).status).toBe(403);
    expect((await call(auth, "POST", "/sign-out", { body: {}, cookie, origin: "null" })).status).toBe(403);
    expect(await principalOf(cookie)).not.toBeNull();
  });

  it("refuses a sign-in posted from another origin or by a cross-site navigation", async () => {
    const evil = await call(auth, "POST", "/sign-in/email", {
      body: { email: OWNER.email, password: OWNER.password },
      origin: "https://evil.example",
    });
    expect(evil.status).toBe(403);
    const navigation = await call(auth, "POST", "/sign-in/email", {
      body: { email: OWNER.email, password: OWNER.password },
      origin: null,
      headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    });
    expect(navigation.status).toBe(403);
    expect(await sessions()).toBe(0);
  });
});

describe("authorisation", () => {
  it("grants the Owner its permissions", async () => {
    const cookie = await ownerCookie();
    for (const permission of ["catalog:read", "catalog:write", "stock:read", "stock:receive", "stock:adjust", "users:manage"] as const) {
      expect(await requirePermission(auth, db, headersWith(cookie), permission)).toEqual({ userId: ownerId, role: "owner" });
    }
  });

  it("refuses a permission the role does not hold", async () => {
    const cookie = await ownerCookie();
    await expect(
      requirePermission(auth, db, headersWith(cookie), "orders:refund" as Permission),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses an anonymous request for any permission", async () => {
    await expect(requirePermission(auth, db, new Headers(), "stock:read")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("does not let a user without access sign in, whatever the request claims", async () => {
    await createTestUser(pool, { email: "noaccess@example.test", password: "no access password 1", role: null });
    const response = await call(auth, "POST", "/sign-in/email", {
      body: { email: "noaccess@example.test", password: "no access password 1", role: "owner", userId: ownerId },
      headers: { "x-role": "owner", "x-user-id": ownerId },
    });
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("INVALID_EMAIL_OR_PASSWORD");
    expect(await sessions()).toBe(0);
    expect(await getPrincipal(auth, db, new Headers({ "x-role": "owner", "x-user-id": ownerId }))).toBeNull();
  });

  it("ends a disabled user's access at once and refuses new sign-ins", async () => {
    const cookie = await ownerCookie();
    await pool.query("update user_access set disabled_at = now() where user_id = $1", [ownerId]);
    expect(await principalOf(cookie)).toBeNull();
    await expect(requirePermission(auth, db, headersWith(cookie), "stock:read")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const again = await signIn(auth, OWNER.email, OWNER.password);
    expect(again.response.status).toBe(401);
    expect((await again.response.json()).code).toBe("INVALID_EMAIL_OR_PASSWORD");
  });

  it("drops permissions as soon as the role is removed, with no stale session state", async () => {
    const cookie = await ownerCookie();
    expect(await requirePermission(auth, db, headersWith(cookie), "stock:adjust")).toBeTruthy();
    await pool.query("delete from user_access where user_id = $1", [ownerId]);
    await expect(requirePermission(auth, db, headersWith(cookie), "stock:adjust")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("rate limiting", () => {
  afterEach(async () => {
    await pool.query("delete from auth_rate_limits");
  });

  it("throttles sign-in after three attempts in ten seconds, even with the right password", async () => {
    for (let i = 0; i < 3; i++) expect((await signIn(auth, OWNER.email, `wrong password ${i}`)).response.status).toBe(401);
    const blocked = await signIn(auth, OWNER.email, OWNER.password);
    expect(blocked.response.status).toBe(429);
    expect(Number(blocked.response.headers.get("x-retry-after"))).toBeGreaterThan(0);
    expect(await sessions()).toBe(0);
  });

  it("is not bypassed by rotating X-Forwarded-For", async () => {
    const attempt = (ip: string) =>
      call(auth, "POST", "/sign-in/email", { body: { email: OWNER.email, password: "wrong password" }, headers: { "x-forwarded-for": ip } });
    for (const ip of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) expect((await attempt(ip)).status).toBe(401);
    expect((await attempt("203.0.113.4")).status).toBe(429);
  });

  it("is shared through PostgreSQL by separate application instances", async () => {
    for (let i = 0; i < 3; i++) await signIn(auth, OWNER.email, "wrong password");
    const otherProcess = createTestAuth(db);
    expect((await signIn(otherProcess, OWNER.email, OWNER.password)).response.status).toBe(429);
  });

  it("stores only the client address, path and counters", async () => {
    for (let i = 0; i < 2; i++) await signIn(auth, OWNER.email, "a wrong password");
    const { rows } = await pool.query("select * from auth_rate_limits");
    expect(rows.map((r) => r.key)).toEqual(["127.0.0.1|/sign-in/email"]);
    expect(Object.keys(rows[0]).sort()).toEqual(["count", "id", "key", "last_request"]);
    expect(JSON.stringify(rows)).not.toMatch(/example\.test|password/);
  });

  it("does not block other endpoints when sign-in is throttled", async () => {
    const cookie = await ownerCookie();
    for (let i = 0; i < 2; i++) await signIn(auth, OWNER.email, "wrong password");
    expect((await signIn(auth, OWNER.email, OWNER.password)).response.status).toBe(429);
    const session = await call(auth, "GET", "/get-session", { cookie });
    expect(session.status).toBe(200);
    expect((await session.json()).user.id).toBe(ownerId);
  });
});

describe("Next.js route", () => {
  it("serves Better Auth's handler at /api/auth", async () => {
    vi.resetModules();
    vi.doMock("@/modules/auth/server", () => ({ getAuth: () => auth }));
    try {
      const route = await import("../../src/app/api/auth/[...all]/route");
      const response = await route.POST(
        new Request(`${BASE_URL}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE_URL },
          body: JSON.stringify({ email: OWNER.email, password: OWNER.password }),
        }),
      );
      expect(response.status).toBe(200);
      const cookie = cookieFrom(response);
      const session = await route.GET(new Request(`${BASE_URL}/api/auth/get-session`, { headers: { cookie } }));
      expect((await session.json()).user.id).toBe(ownerId);
      const signUp = await route.POST(
        new Request(`${BASE_URL}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE_URL },
          body: JSON.stringify({ email: "x@example.test", name: "X", password: "a long enough password" }),
        }),
      );
      expect(signUp.status).toBe(404);
    } finally {
      vi.doUnmock("@/modules/auth/server");
    }
  });
});
