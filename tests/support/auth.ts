import { randomBytes } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import type { Pool } from "pg";
import type { Db } from "../../src/db/database";
import { type Auth, createAuth } from "../../src/modules/auth/auth";
import { getPrincipal } from "../../src/modules/auth/principal";

// Fictional identities only (example.test is a reserved, non-routable domain).
export const BASE_URL = "http://localhost:3000";
export const OWNER = { email: "owner@example.test", name: "Test Owner", password: "correct horse battery staple" };

export function testSecret(): string {
  return randomBytes(32).toString("base64");
}

export function createTestAuth(db: Db, baseURL = BASE_URL): Auth {
  return createAuth(db, { secret: testSecret(), baseURL });
}

type CallOptions = { body?: unknown; cookie?: string; origin?: string | null; headers?: Record<string, string> };

/** Sends a real HTTP request through Better Auth's handler, the same one the Next.js route uses. */
export function call(auth: Auth, method: string, path: string, options: CallOptions = {}, baseURL = BASE_URL) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.cookie) headers.set("cookie", options.cookie);
  // A browser sends Origin on POST. null means "send none".
  if (options.origin !== null && method !== "GET") headers.set("origin", options.origin ?? baseURL);
  return auth.handler(
    new Request(`${baseURL}/api/auth${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  );
}

/** The `name=value` pairs a browser would send back, from a response's Set-Cookie headers. */
export function cookieFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

export async function signIn(auth: Auth, email: string, password: string, baseURL = BASE_URL) {
  const response = await call(auth, "POST", "/sign-in/email", { body: { email, password } }, baseURL);
  return { response, cookie: cookieFrom(response) };
}

export function headersWith(cookie: string): Headers {
  return new Headers({ cookie });
}

/** A further test user with a Better Auth credential. role null means no access row. */
export async function createTestUser(
  pool: Pool,
  user: { email: string; name?: string; password: string; role: "owner" | null },
): Promise<string> {
  const hash = await hashPassword(user.password);
  const { rows } = await pool.query<{ id: string }>(
    "insert into auth_users (name, email, created_at, updated_at) values ($1, $2, now(), now()) returning id",
    [user.name ?? "Test User", user.email],
  );
  const id = rows[0].id;
  await pool.query(
    `insert into auth_accounts (account_id, provider_id, user_id, password, created_at, updated_at)
     values ($1, 'credential', $2, $3, now(), now())`,
    [id, id, hash],
  );
  if (user.role) await pool.query("insert into user_access (user_id, role) values ($1, $2)", [id, user.role]);
  return id;
}

/** Removes auth rows that no ledger row references. Test database only (the pool is a verified test pool). */
export async function clearAuthState(pool: Pool): Promise<void> {
  await pool.query("delete from auth_rate_limits");
  await pool.query(
    `delete from auth_users u where not exists (select 1 from stock_movements where actor_user_id = u.id)
       and not exists (select 1 from order_events where actor_user_id = u.id)
       and not exists (select 1 from orders where created_by_user_id = u.id)
       and not exists (select 1 from delivery_zones where updated_by_user_id = u.id)
       and not exists (select 1 from payment_entries where actor_user_id = u.id)
       and not exists (select 1 from returns where created_by_user_id = u.id)
       and not exists (select 1 from cancellation_requests where reviewed_by_user_id = u.id)
       and not exists (select 1 from quarantine_items where inspected_by_user_id = u.id)
       and not exists (select 1 from export_requests where actor_user_id = u.id)
       and not exists (select 1 from stock_counts where created_by_user_id = u.id or closed_by_user_id = u.id)`,
  );
}

export async function count(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<Record<string, unknown>>(sql, params);
  return Number(Object.values(rows[0])[0]);
}

/**
 * Signs in the way a native (non-browser) client does: no Origin, no cookie, no Sec-Fetch-* headers.
 * Returns the signed Bearer token from the `set-auth-token` response header.
 */
export async function signInNative(auth: Auth, email: string, password: string) {
  const response = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
  return { response, token: response.headers.get("set-auth-token") };
}

export const bearer = (token: string) => new Headers({ authorization: `Bearer ${token}` });

/** Creates a fictional Owner, signs in through Better Auth's HTTP handler and returns the verified principal. */
export async function createVerifiedOwner(auth: Auth, db: Db, pool: Pool, email: string, password = "fictional owner long password") {
  const userId = await createTestUser(pool, { email, password, role: "owner" });
  const { cookie } = await signIn(auth, email, password);
  const principal = await getPrincipal(auth, db, headersWith(cookie));
  if (!principal) throw new Error("Test owner could not sign in.");
  return { userId, cookie, principal };
}
