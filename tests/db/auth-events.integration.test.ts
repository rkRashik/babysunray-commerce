import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/database";
import { type Auth, createAuth } from "../../src/modules/auth/auth";
import type { Principal } from "../../src/modules/auth/principal";
import { createExport } from "../../src/modules/exports/service";
import { BASE_URL, call, clearAuthState, cookieFrom, count, createTestUser, createVerifiedOwner, signIn, signInNative } from "../support/auth";
import { errorCodeOf, withFailingInserts } from "../support/fixtures";
import { createTestDb } from "../support/test-database";

// The authentication audit (migration 0017) through Better Auth's real HTTP handler against PostgreSQL. Fictional
// accounts only. Every assertion that reads auth_events also checks that no address, password, cookie or token is
// stored.

let db: Db;
let pool: Pool;
let auth: Auth;
const secret = randomBytes(32).toString("base64");
const PASSWORD = "audit fictional long password";
let n = 0;

type EventRow = { id: number; event: string; actor_type: string; actor_user_id: string | null; subject_user_id: string | null; session_id: string | null; transport: string | null; subject_digest: string | null; detail: Record<string, unknown> };
const eventsAfter = async (id: number) => (await pool.query<EventRow>("select * from auth_events where id > $1 order by id", [id])).rows;
const lastId = async () => Number((await pool.query<{ id: string | null }>("select max(id) as id from auth_events")).rows[0].id ?? 0);
// Independently computed: HMAC-SHA256 under an HKDF-derived key, never the secret itself.
const digestOf = (email: string) =>
  createHmac("sha256", Buffer.from(hkdfSync("sha256", secret, "babysunray-auth-events", "failed-sign-in-subject", 32))).update(email.trim().toLowerCase()).digest("hex");

async function newUser(role: "owner" | null = "owner") {
  n += 1;
  const email = `audit-${n}-${Date.now()}@example.test`;
  const userId = await createTestUser(pool, { email, password: PASSWORD, role });
  return { email, userId };
}
const cookieToken = (cookie: string) => decodeURIComponent(cookie.split("=")[1] ?? "").split(".")[0];
const expectNoSecrets = (rows: unknown, secrets: string[]) => {
  const text = JSON.stringify(rows);
  for (const s of secrets.filter(Boolean)) expect(text).not.toContain(s);
};

beforeAll(async () => {
  ({ db, pool } = await createTestDb(8));
  auth = createAuth(db, { secret, baseURL: BASE_URL });
  await clearAuthState(pool);
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query("delete from auth_rate_limits");
});

describe("sign-in", () => {
  it("records a browser and a native sign-in with the verified user and session, and nothing secret", async () => {
    const { email, userId } = await newUser();
    const from = await lastId();
    const browser = await signIn(auth, email, PASSWORD);
    const native = await signInNative(auth, email, PASSWORD);
    const rows = await eventsAfter(from);
    expect(rows.map((r) => [r.event, r.actor_type, r.actor_user_id, r.subject_user_id, r.transport])).toEqual([
      ["sign_in", "user", userId, userId, "browser"],
      ["sign_in", "user", userId, userId, "native"],
    ]);
    const sessions = (await pool.query<{ id: string }>("select id from auth_sessions where user_id = $1 order by created_at", [userId])).rows.map((s) => s.id);
    expect(rows.map((r) => r.session_id).sort()).toEqual([...sessions].sort());
    expectNoSecrets(rows, [email, PASSWORD, cookieToken(browser.cookie), native.token ?? ""]);
  });

  it("records failed attempts anonymously, with a keyed digest of the address and the same answer as before", async () => {
    const { email } = await newUser();
    const noAccess = await newUser(null);
    const unknown = `nobody-${Date.now()}@example.test`;
    const from = await lastId();
    const answers = [];
    for (const [address, password] of [[email, "wrong password, long enough"], [email.toUpperCase(), "wrong password again, long"], [unknown, PASSWORD], [noAccess.email, PASSWORD]]) {
      const response = await call(auth, "POST", "/sign-in/email", { body: { email: address, password } });
      answers.push([response.status, await response.text()]);
      await pool.query("delete from auth_rate_limits");
    }
    // Wrong password, unknown address and an account without access look the same to the caller.
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0][0]).toBe(401);
    const rows = await eventsAfter(from);
    expect(rows.map((r) => [r.event, r.actor_type, r.actor_user_id, r.subject_user_id, r.session_id])).toEqual(Array(4).fill(["sign_in_failed", "anonymous", null, null, null]));
    expect(rows.map((r) => r.subject_digest)).toEqual([digestOf(email), digestOf(email), digestOf(unknown), digestOf(noAccess.email)]);
    expect(rows[0].detail).toEqual({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD" });
    expectNoSecrets(rows, [email, email.toUpperCase(), unknown, noAccess.email, PASSWORD]);
    // A body that is not even an address is recorded without a digest; nothing from the body is stored.
    const odd = await lastId();
    await call(auth, "POST", "/sign-in/email", { body: { email: "x".repeat(300), password: PASSWORD } });
    expect((await eventsAfter(odd)).map((r) => [r.event, r.subject_digest])).toEqual([["sign_in_failed", null]]);
  });

  it("takes no identity, role or actor from the request", async () => {
    const victim = await newUser();
    const attacker = await newUser();
    const from = await lastId();
    await call(auth, "POST", "/sign-in/email", { body: { email: attacker.email, password: PASSWORD, userId: victim.userId, role: "owner", actorUserId: victim.userId } });
    const rows = await eventsAfter(from);
    expect(rows.every((r) => r.actor_user_id !== victim.userId && r.subject_user_id !== victim.userId)).toBe(true);
    // The database refuses rows that contradict themselves, even from a direct write.
    for (const statement of [
      "insert into auth_events (event, actor_type, detail) values ('sign_in', 'user', '{}')",
      "insert into auth_events (event, actor_type, actor_user_id, detail) values ('sign_in_failed', 'user', gen_random_uuid(), '{}')",
      "insert into auth_events (event, actor_type, subject_digest, detail) values ('password_changed', 'operator', repeat('a', 64), '{}')",
      `insert into auth_events (event, actor_type, detail) values ('access_changed', 'system', jsonb_build_object('pad', repeat('x', 2000)))`,
    ]) {
      await expect(pool.query(statement)).rejects.toThrow(/violates check constraint/);
    }
  });

  it("refuses a sign-in it cannot record: no usable session, no cookie, no token", async () => {
    const { email, userId } = await newUser();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const browser = await withFailingInserts(pool, "auth_events", () => call(auth, "POST", "/sign-in/email", { body: { email, password: PASSWORD } }));
      expect(browser.status).toBe(500);
      expect(browser.headers.getSetCookie()).toEqual([]);
      const native = await withFailingInserts(pool, "auth_events", () => signInNative(auth, email, PASSWORD));
      expect(native.response.status).toBe(500);
      expect(native.token).toBeNull();
      expect(await count(pool, "select count(*) from auth_sessions where user_id = $1", [userId])).toBe(0);
      const logged = log.mock.calls.flat().join(" ");
      expect(logged).toContain("auth_audit_failed");
      expect(logged).not.toContain(email);
    } finally {
      log.mockRestore();
    }
    // Once the audit works again, sign-in works again.
    expect((await signIn(auth, email, PASSWORD)).response.status).toBe(200);
  });
});

describe("ended sessions", () => {
  it("records a sign-out once; replaying the old cookie changes nothing", async () => {
    const { email, userId } = await newUser();
    const { cookie } = await signIn(auth, email, PASSWORD);
    const [{ id: sessionId }] = (await pool.query<{ id: string }>("select id from auth_sessions where user_id = $1", [userId])).rows;
    const from = await lastId();
    expect((await call(auth, "POST", "/sign-out", { body: {}, cookie })).status).toBe(200);
    expect((await call(auth, "POST", "/sign-out", { body: {}, cookie })).status).toBe(200);
    expect((await call(auth, "GET", "/get-session", { cookie })).status).toBe(200);
    expect((await call(auth, "POST", "/revoke-sessions", { body: {}, cookie })).status).toBe(401);
    const rows = await eventsAfter(from);
    expect(rows.map((r) => [r.event, r.actor_type, r.actor_user_id, r.subject_user_id, r.session_id, r.detail])).toEqual([["session_ended", "user", userId, userId, sessionId, { reason: "sign_out" }]]);
    expectNoSecrets(rows, [cookieToken(cookie), email]);
  });

  it("two simultaneous 'sign out everywhere' requests record every session exactly once", async () => {
    const { email, userId } = await newUser();
    const cookies = [];
    for (let i = 0; i < 4; i += 1) cookies.push((await signIn(auth, email, PASSWORD)).cookie);
    const ids = (await pool.query<{ id: string }>("select id from auth_sessions where user_id = $1", [userId])).rows.map((r) => r.id).sort();
    const from = await lastId();
    const statuses = await Promise.all([call(auth, "POST", "/revoke-sessions", { body: {}, cookie: cookies[0] }), call(auth, "POST", "/revoke-sessions", { body: {}, cookie: cookies[1] })]);
    expect(statuses.some((r) => r.status === 200)).toBe(true);
    expect(await count(pool, "select count(*) from auth_sessions where user_id = $1", [userId])).toBe(0);
    const rows = await eventsAfter(from);
    expect(rows.map((r) => r.session_id).sort()).toEqual(ids);
    expect(new Set(rows.map((r) => r.detail.reason))).toEqual(new Set(["revoked_all"]));
    expect(rows.every((r) => r.actor_type === "user" && r.actor_user_id === userId)).toBe(true);
  });

  it("revoking other sessions, and a password change that revokes them, name their reason", async () => {
    const { email, userId } = await newUser();
    const keep = (await signIn(auth, email, PASSWORD)).cookie;
    await signIn(auth, email, PASSWORD);
    const from = await lastId();
    expect((await call(auth, "POST", "/revoke-other-sessions", { body: {}, cookie: keep })).status).toBe(200);
    await signIn(auth, email, PASSWORD);
    const changed = await call(auth, "POST", "/change-password", { body: { currentPassword: PASSWORD, newPassword: `${PASSWORD} changed`, revokeOtherSessions: true }, cookie: keep });
    expect(changed.status).toBe(200);
    const rows = await eventsAfter(from);
    expect(rows.filter((r) => r.event === "session_ended").map((r) => r.detail.reason)).toEqual(expect.arrayContaining(["revoked_others", "password_changed"]));
    expect(rows.filter((r) => r.event === "password_changed").map((r) => [r.actor_user_id, r.subject_user_id, r.detail])).toEqual([[userId, userId, { revokedOtherSessions: true }]]);
    expectNoSecrets(rows, [PASSWORD, `${PASSWORD} changed`, email]);
    // A failed password change records nothing.
    const after = await lastId();
    expect((await call(auth, "POST", "/change-password", { body: { currentPassword: "not the password at all", newPassword: `${PASSWORD} again` }, cookie: cookieFrom(changed) || keep })).status).not.toBe(200);
    expect((await eventsAfter(after)).filter((r) => r.event === "password_changed")).toEqual([]);
  });

  it("an expired session found by another endpoint is recorded as an expiry, not as that endpoint's action", async () => {
    const { email, userId } = await newUser();
    const { cookie } = await signIn(auth, email, PASSWORD);
    const [{ id: sessionId }] = (await pool.query<{ id: string }>("select id from auth_sessions where user_id = $1", [userId])).rows;
    await pool.query("update auth_sessions set expires_at = now() - interval '1 minute' where id = $1", [sessionId]);
    const from = await lastId();
    expect((await call(auth, "POST", "/change-password", { body: { currentPassword: PASSWORD, newPassword: `${PASSWORD} never` }, cookie })).status).toBe(401);
    const ended = (await eventsAfter(from)).filter((r) => r.event === "session_ended");
    expect(ended.map((r) => [r.session_id, r.actor_type, r.actor_user_id, r.detail])).toEqual([[sessionId, "system", null, { reason: "expired" }]]);
    expect((await eventsAfter(from)).filter((r) => r.event === "password_changed")).toEqual([]);
  });

  it("the new session a password change creates is recorded, and refused when it cannot be", async () => {
    const { email, userId } = await newUser();
    const first = (await signIn(auth, email, PASSWORD)).cookie;
    const from = await lastId();
    const changed = await call(auth, "POST", "/change-password", { body: { currentPassword: PASSWORD, newPassword: `${PASSWORD} one`, revokeOtherSessions: true }, cookie: first });
    expect(changed.status).toBe(200);
    const [{ id: renewed }] = (await pool.query<{ id: string }>("select id from auth_sessions where user_id = $1", [userId])).rows;
    expect((await eventsAfter(from)).filter((r) => r.event === "sign_in").map((r) => [r.session_id, r.detail])).toEqual([[renewed, { via: "password_change" }]]);
    // Same change while the audit cannot be written: the password changes (Better Auth commits it first), but no
    // session survives and no cookie or token is handed out.
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const refused = await withFailingInserts(pool, "auth_events", () =>
        call(auth, "POST", "/change-password", { body: { currentPassword: `${PASSWORD} one`, newPassword: `${PASSWORD} two`, revokeOtherSessions: true }, cookie: cookieFrom(changed) }),
      );
      expect(refused.status).toBe(500);
      expect(refused.headers.getSetCookie()).toEqual([]);
      expect(await count(pool, "select count(*) from auth_sessions where user_id = $1", [userId])).toBe(0);
    } finally {
      log.mockRestore();
    }
  });

  it("a refused sign-in whose session cannot even be deleted hands out nothing and logs no token", async () => {
    const { email, userId } = await newUser();
    await pool.query("create function test_refuse_session_delete() returns trigger language plpgsql as $$ begin raise exception 'injected delete failure'; end $$");
    await pool.query("create trigger test_refuse_session_delete before delete on auth_sessions for each row execute function test_refuse_session_delete()");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warns = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const response = await withFailingInserts(pool, "auth_events", () => call(auth, "POST", "/sign-in/email", { body: { email, password: PASSWORD } }));
      expect(response.status).toBe(500);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(response.headers.get("set-auth-token")).toBeNull();
      const [{ token }] = (await pool.query<{ token: string }>("select token from auth_sessions where user_id = $1", [userId])).rows;
      const logged = [...errors.mock.calls, ...logs.mock.calls, ...warns.mock.calls].flat().map((v) => (v instanceof Error ? `${v.message} ${String(v.cause)}` : String(v))).join(" ");
      expect(logged).toContain('"auditEvent":"session_refused"');
      expect(logged).not.toContain(token);
    } finally {
      errors.mockRestore();
      logs.mockRestore();
      warns.mockRestore();
      await pool.query("drop function test_refuse_session_delete() cascade");
    }
    await pool.query("delete from auth_sessions where user_id = $1", [userId]);
  });

  it("a sign-out still signs out when its audit row cannot be written, and says so in the log", async () => {
    const { email, userId } = await newUser();
    const { cookie } = await signIn(auth, email, PASSWORD);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await withFailingInserts(pool, "auth_events", () => call(auth, "POST", "/sign-out", { body: {}, cookie }));
      expect(response.status).toBe(200);
      expect(await count(pool, "select count(*) from auth_sessions where user_id = $1", [userId])).toBe(0);
      expect(log.mock.calls.flat().join(" ")).toContain('"auditEvent":"session_ended"');
    } finally {
      log.mockRestore();
    }
  });
});

describe("access changes", () => {
  it("every grant, disable, enable and removal is recorded in the same transaction; a no-op update is not", async () => {
    const from = await lastId();
    const { email, userId } = await newUser();
    await signIn(auth, email, PASSWORD);
    await pool.query("update user_access set role = role where user_id = $1", [userId]);
    await pool.query("update user_access set disabled_at = now() where user_id = $1", [userId]);
    await pool.query("update user_access set disabled_at = null where user_id = $1", [userId]);
    await pool.query("delete from user_access where user_id = $1", [userId]);
    const rows = (await eventsAfter(from)).filter((r) => r.event === "access_changed");
    expect(rows.map((r) => [r.actor_type, r.transport, r.subject_user_id, r.detail])).toEqual([
      ["system", "database", userId, { operation: "insert", roleBefore: null, roleAfter: "owner", disabledBefore: null, disabledAfter: false, openSessions: 0 }],
      ["system", "database", userId, { operation: "update", roleBefore: "owner", roleAfter: "owner", disabledBefore: false, disabledAfter: true, openSessions: 1 }],
      ["system", "database", userId, { operation: "update", roleBefore: "owner", roleAfter: "owner", disabledBefore: true, disabledAfter: false, openSessions: 0 }],
      ["system", "database", userId, { operation: "delete", roleBefore: "owner", roleAfter: null, disabledBefore: false, disabledAfter: null, openSessions: 0 }],
    ]);
    // A change that cannot be recorded does not happen.
    const other = await newUser();
    await expect(withFailingInserts(pool, "auth_events", () => pool.query("update user_access set disabled_at = now() where user_id = $1", [other.userId]))).rejects.toThrow(/injected/);
    expect((await pool.query("select disabled_at from user_access where user_id = $1", [other.userId])).rows[0].disabled_at).toBeNull();
  });

  it("the Owner can export the audit (audited, Owner only); the file holds no address", async () => {
    const owner = await createVerifiedOwner(auth, db, pool, `audit-export-${Date.now()}@example.test`, PASSWORD);
    await call(auth, "POST", "/sign-in/email", { body: { email: "someone-else@example.test", password: PASSWORD } });
    const chunks: string[] = [];
    for await (const chunk of (await createExport(db, owner.principal, { dataset: "auth_events", format: "json", filters: {} })).chunks) chunks.push(Buffer.from(chunk).toString("utf8"));
    const file = chunks.join("");
    expect(file).toContain('"event":"sign_in_failed"');
    expect(file).not.toMatch(/@example\.test/);
    expect(await count(pool, "select count(*) from export_requests where dataset = 'auth_events' and actor_user_id = $1", [owner.userId])).toBe(1);
    expect(await errorCodeOf(createExport(db, null as unknown as Principal, { dataset: "auth_events", format: "json", filters: {} }))).toBe("UNAUTHENTICATED");
  });

  it("the audit is append-only", async () => {
    for (const statement of ["update auth_events set detail = '{}'", "delete from auth_events", "truncate auth_events"]) {
      await expect(pool.query(statement)).rejects.toThrow(/append-only/);
    }
  });
});
