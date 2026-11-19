import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/database";
import { getPrincipal } from "../../src/modules/auth/principal";
import { completeSetup, recoverOwner, recoveryCodesLeft, startSetup } from "../../src/modules/auth/setup";
import { createCustomerAuth } from "../../src/modules/customers/auth";
import type { EmailMessage } from "../../src/modules/email/service";
import { clearAuthState, cookieFrom, count, createTestAuth, createVerifiedOwner, signIn } from "../support/auth";
import { errorCodeOf } from "../support/fixtures";
import { createTestDb } from "../support/test-database";

// First-time Admin setup, Owner recovery and customer email accounts (ADR-0012) against PostgreSQL. Fictional identities only.

let db: Db;
let pool: Pool;
const TOKEN = "a-fictional-setup-grant-with-more-than-32-characters";
const env = { ADMIN_SETUP_TOKEN: TOKEN };
const BASE = "http://localhost:3000";

beforeAll(async () => {
  ({ db, pool } = await createTestDb(6));
  await clearAuthState(pool);
});
afterAll(async () => {
  await pool?.end();
});
beforeEach(async () => {
  await pool.query("delete from tracking_rate_limits where bucket in ('admin-setup', 'admin-recovery')");
});

const noActiveOwner = () => pool.query("update user_access set disabled_at = now() where disabled_at is null");
const email = () => `owner-${randomUUID()}@example.test`;
const PASSWORD = "a fictional long owner password";

describe("first-time Admin setup", () => {
  it("is closed while an Owner has active access, whatever the grant", async () => {
    await createVerifiedOwner(createTestAuth(db), db, pool, `existing-${randomUUID()}@example.test`);
    expect(await errorCodeOf(startSetup(db, { token: TOKEN, email: email() }, { env, send: null, storeName: "Shop" }))).toBe("FORBIDDEN");
    expect(await errorCodeOf(completeSetup(db, { token: TOKEN, email: email(), name: "X", password: PASSWORD }, { env, emailRequired: false }))).toBe("FORBIDDEN");
  });

  it("needs the exact setup grant, and is refused without one configured", async () => {
    await noActiveOwner();
    for (const token of ["", "wrong", `${TOKEN}x`, null]) expect(await errorCodeOf(startSetup(db, { token, email: email() }, { env, send: null, storeName: "Shop" }))).toBe("FORBIDDEN");
    expect(await errorCodeOf(startSetup(db, { token: "short", email: email() }, { env: { ADMIN_SETUP_TOKEN: "short" }, send: null, storeName: "Shop" }))).toBe("FORBIDDEN");
  });

  it("creates exactly one Owner under concurrent attempts, with audit and recovery codes, and then closes", async () => {
    await noActiveOwner();
    const before = await count(pool, "select count(*) from user_access");
    const attempts = await Promise.allSettled([0, 1, 2].map(() => completeSetup(db, { token: TOKEN, email: email(), name: "Fictional Owner", password: PASSWORD }, { env, emailRequired: false })));
    const created = attempts.filter((a) => a.status === "fulfilled");
    expect(created).toHaveLength(1);
    expect(await count(pool, "select count(*) from user_access")).toBe(before + 1);
    const { userId, recoveryCodes, emailVerified } = (created[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof completeSetup>>>).value;
    expect(recoveryCodes).toHaveLength(10);
    expect(emailVerified).toBe(false);
    expect(await recoveryCodesLeft(db, userId)).toBe(10);
    expect(await count(pool, "select count(*) from auth_events where event = 'owner_created' and subject_user_id = $1 and transport = 'browser'", [userId])).toBe(1);
    // No code is stored in the clear.
    expect(await count(pool, "select count(*) from owner_recovery_codes where code_sha256 = any($1)", [recoveryCodes])).toBe(0);
    expect(await errorCodeOf(completeSetup(db, { token: TOKEN, email: email(), name: "Again", password: PASSWORD }, { env, emailRequired: false }))).toBe("FORBIDDEN");
  });

  it("with email set up, needs the code sent to the address, and the new Owner can sign in", async () => {
    await noActiveOwner();
    const sent: EmailMessage[] = [];
    const address = email();
    expect(await startSetup(db, { token: TOKEN, email: address }, { env, send: async (m) => void sent.push(m), storeName: "Shop" })).toEqual({ codeSent: true });
    const code = /(\d{6})/.exec(sent[0].text)?.[1];
    expect(sent[0].to).toBe(address);
    expect(await errorCodeOf(completeSetup(db, { token: TOKEN, email: address, name: "Owner", password: PASSWORD, code: code === "000000" ? "111111" : "000000" }, { env, emailRequired: true }))).toBe("INVALID_INPUT");
    const result = await completeSetup(db, { token: TOKEN, email: address, name: "Owner", password: PASSWORD, code }, { env, emailRequired: true });
    expect(result.emailVerified).toBe(true);
    const auth = createTestAuth(db);
    const fresh = "a different fictional long password";
    // Better Auth allows 3 sign-ins per 10 seconds per client; each step starts with fresh counters (test database only).
    const signInNow = async (password: string) => {
      await pool.query("delete from auth_rate_limits");
      return signIn(auth, address, password);
    };
    const { response, cookie } = await signInNow(PASSWORD);
    expect(response.status).toBe(200);
    expect((await getPrincipal(auth, db, new Headers({ cookie })))?.role).toBe("owner");

    // Recovery: one code, once; the old password stops working and every session ends.
    await recoverOwner(db, { email: address, code: result.recoveryCodes[0], password: fresh });
    expect(await getPrincipal(auth, db, new Headers({ cookie }))).toBeNull();
    expect((await signInNow(PASSWORD)).response.status).toBe(401);
    expect((await signInNow(fresh)).response.status).toBe(200);
    expect(await errorCodeOf(recoverOwner(db, { email: address, code: result.recoveryCodes[0], password: PASSWORD }))).toBe("INVALID_INPUT");
    expect(await errorCodeOf(recoverOwner(db, { email: email(), code: result.recoveryCodes[1], password: PASSWORD }))).toBe("INVALID_INPUT");
    expect(await recoveryCodesLeft(db, result.userId)).toBe(9);
  });
});

describe("customer email accounts", () => {
  const sent: EmailMessage[] = [];
  const customers = () => createCustomerAuth(db, { baseURL: BASE, secret: "a-fictional-installation-secret-with-enough-entropy-1234", google: null, email: async (m) => void sent.push(m), env: {} });
  const call = async (auth: ReturnType<typeof customers>, method: string, path: string, body?: unknown, cookie?: string) => {
    await pool.query("delete from customer_rate_limits");
    return auth.handler(
      new Request(path.startsWith("http") ? path : `${BASE}/api/customer-auth${path}`, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...(method === "GET" ? {} : { origin: BASE }), ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  };
  const linkIn = (m: EmailMessage) => /(http\S+)/.exec(m.text)![1];

  it("signs up with a verified address only, never reveals an existing one, resets the password by email, and is never an Owner", async () => {
    const auth = customers();
    const address = `customer-${randomUUID()}@example.test`;
    const password = "fictional customer pw";
    expect((await call(auth, "POST", "/sign-up/email", { name: "Fictional Customer", email: address, password, callbackURL: "/en/account" })).status).toBe(200);
    expect(sent.at(-1)!.to).toBe(address);
    // Unverified: no sign-in.
    const early = await call(auth, "POST", "/sign-in/email", { email: address, password });
    expect(early.status).toBe(403);
    // A second sign-up with the same address answers the same and creates nothing.
    const users = await count(pool, "select count(*) from customer_users where email = $1", [address]);
    expect((await call(auth, "POST", "/sign-up/email", { name: "Someone Else", email: address, password: "another fictional pw", callbackURL: "/en/account" })).status).toBe(200);
    expect(await count(pool, "select count(*) from customer_users where email = $1", [address])).toBe(users);
    // Confirming the address signs the customer in.
    const verify = await call(auth, "GET", linkIn(sent.find((m) => m.to === address && /confirm/i.test(m.subject))!));
    expect(verify.status).toBe(302);
    const signedIn = await call(auth, "POST", "/sign-in/email", { email: address, password });
    expect(signedIn.status).toBe(200);
    const cookie = cookieFrom(signedIn);
    // A customer session is never an Owner principal, and the password hash is the only secret stored.
    expect(await getPrincipal(createTestAuth(db), db, new Headers({ cookie }))).toBeNull();
    expect(await count(pool, "select count(*) from customer_accounts a join customer_users u on u.id = a.user_id where u.email = $1 and a.provider_id = 'credential' and a.password is not null and a.access_token is null", [address])).toBe(1);

    // Forgot password: the emailed link leads to a token; the new password works, the old one and the old session do not.
    expect((await call(auth, "POST", "/request-password-reset", { email: address, redirectTo: "/en/account/reset" })).status).toBe(200);
    const resetLink = await call(auth, "GET", linkIn(sent.filter((m) => m.to === address).at(-1)!));
    const token = new URL(resetLink.headers.get("location")!, BASE).searchParams.get("token");
    expect(token).toBeTruthy();
    const fresh = "a new fictional pw";
    expect((await call(auth, "POST", "/reset-password", { newPassword: fresh, token })).status).toBe(200);
    expect((await call(auth, "POST", "/sign-in/email", { email: address, password })).status).toBe(401);
    expect((await call(auth, "POST", "/sign-in/email", { email: address, password: fresh })).status).toBe(200);
    expect((await call(auth, "POST", "/reset-password", { newPassword: "yet another pw x", token })).status).toBe(400);
    expect(await count(pool, "select count(*) from customer_sessions s join customer_users u on u.id = s.user_id where u.email = $1 and s.token = $2", [address, decodeURIComponent(cookie.split("=")[1].split(".")[0])])).toBe(0);
    // An unknown address gets the same answer and no email.
    const before = sent.length;
    expect((await call(auth, "POST", "/request-password-reset", { email: `nobody-${randomUUID()}@example.test`, redirectTo: "/en/account/reset" })).status).toBe(200);
    expect(sent.length).toBe(before);
  });
});
