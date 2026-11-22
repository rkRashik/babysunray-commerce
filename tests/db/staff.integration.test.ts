import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/database";
import { getPrincipal, type Principal } from "../../src/modules/auth/principal";
import { ROLES, roleHasPermission, STAFF_ROLES } from "../../src/modules/auth/permissions";
import {
  changeStaffRoleOnce,
  inviteStaffOnce,
  redeemStaffLink,
  revokeStaffLinkOnce,
  revokeStaffSessionsOnce,
  sendPasswordLinkOnce,
  setStaffEnabledOnce,
  staffLinkView,
  staffOverview,
} from "../../src/modules/auth/staff";
import { DomainError } from "../../src/modules/domain-error";
import { adjustStockOnce, applyStockCountOnce, receiveStockOnce, recordCountsOnce, startStockCountOnce } from "../../src/modules/inventory/operations";
import { createProductOnce } from "../../src/modules/catalogue/operations";
import { confirmOrderOnce, packOrderOnce, recordPaymentOnce, returnStepOnce, setDeliveryZoneOnce, submitOrderOnce } from "../../src/modules/orders/operations";
import { verifyAdvanceOnce } from "../../src/modules/orders/advance";
import { getOrderDetail } from "../../src/modules/orders/queries";
import { dhakaToday } from "../../src/modules/orders/rules";
import { savePaymentMethodOnce } from "../../src/modules/settings/payments";
import { bearer, BASE_URL, clearAuthState, count, createTestAuth, createVerifiedOwner, headersWith, signIn, signInNative } from "../support/auth";
import { createTestVariant } from "../support/fixtures";
import { createTestDb } from "../support/test-database";

// Staff & access (ADR-0013) against PostgreSQL and Better Auth's real handler: invitations and set-password links (once,
// expiring, never for an existing account or an Owner), what each role may and may not do through the operations and the
// API, role changes, disabling, ending sessions, and the audit trail naming the Owner. Fictional people only.

const state = vi.hoisted(() => ({ db: undefined as unknown, auth: undefined as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/modules/auth/server", () => ({ getAuth: () => state.auth }));
const paymentsRoute = await import("../../src/app/api/v1/orders/[orderId]/payments/route");
const ordersRoute = await import("../../src/app/api/v1/orders/route");

let db: Db;
let pool: Pool;
let auth: ReturnType<typeof createTestAuth>;
let owner: Principal;
let ownerId: string;
const key = () => randomUUID();
const NO_EMAIL = { send: null, baseUrl: BASE_URL, storeName: "Test Shop" };
const PASSWORD = "a long staff password for tests";
let counter = 0;

beforeAll(async () => {
  ({ db, pool } = await createTestDb(6));
  auth = createTestAuth(db);
  Object.assign(state, { db, auth });
  await clearAuthState(pool);
  ({ principal: owner, userId: ownerId } = await createVerifiedOwner(auth, db, pool, "staff-owner@example.test"));
  const zones = await pool.query<{ code: string; version: number }>("select code, version from delivery_zones");
  const version = (code: string) => zones.rows.find((z) => z.code === code)?.version ?? null;
  await setDeliveryZoneOnce(db, owner, key(), { code: "dhaka_city", chargePaisa: 6_000, active: true, expectedVersion: version("dhaka_city") });
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  // Sign-in and link limits are storewide; each test starts fresh (test database only).
  await pool.query("delete from auth_rate_limits");
  await pool.query("delete from tracking_rate_limits where bucket = 'staff-invite'");
});

/** Invites a fresh fictional address, accepts the invitation and signs in: the staff member's verified principal. */
async function newStaff(role: (typeof STAFF_ROLES)[number]) {
  counter += 1;
  const email = `staff-${counter}-${role}@example.test`;
  const invited = await inviteStaffOnce(db, owner, key(), { email, role }, NO_EMAIL);
  expect(invited.emailed).toBe(false);
  await redeemStaffLink(db, { token: invited.token, name: `Test ${role} ${counter}`, password: PASSWORD });
  const { cookie } = await signIn(auth, email, PASSWORD);
  const principal = await getPrincipal(auth, db, headersWith(cookie));
  if (!principal) throw new Error("Staff could not sign in.");
  const { rows } = await pool.query<{ id: string }>("select id from auth_users where email = $1", [email]);
  return { email, cookie, principal, userId: rows[0].id };
}

const forbidden = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof DomainError ? error.code : String(error);
  }
  return "allowed";
};

async function pendingOrder() {
  const { variant } = await createTestVariant(db, "stf");
  await receiveStockOnce(db, owner, key(), { sku: variant.sku, quantity: 5 });
  const { value } = await submitOrderOnce(db, owner, key(), {
    source: "whatsapp",
    customerName: "Staff Test Customer",
    customerPhone: "01711000321",
    deliveryAddress: "House 3, Road 4, Test Area",
    deliveryZone: "dhaka_city",
    items: [{ sku: variant.sku, quantity: 1 }],
  });
  return { order: value, sku: variant.sku };
}

describe("roles", () => {
  it("give the Owner every permission and each staff role only its own, never staff management", () => {
    for (const p of ["users:manage", "payments:verify", "payments:record", "settings:write", "exports:create", "policies:publish", "catalog:publish", "acceptance:run"] as const) {
      expect(roleHasPermission("owner", p)).toBe(true);
      for (const role of STAFF_ROLES) expect(roleHasPermission(role, p), `${role} ${p}`).toBe(false);
    }
    expect(roleHasPermission("orders", "orders:write")).toBe(true);
    expect(roleHasPermission("orders", "catalog:write")).toBe(false);
    expect(roleHasPermission("catalogue", "catalog:review")).toBe(false);
    expect(roleHasPermission("inventory", "stock:adjust")).toBe(false);
    expect(roleHasPermission("manager", "stock:adjust")).toBe(true);
    expect(roleHasPermission("manager", "returns:decide")).toBe(false);
    expect(ROLES[0]).toBe("owner");
  });
});

describe("invitations", () => {
  it("create a staff account once, with the invited role, and the person signs in with their own password", async () => {
    const staff = await newStaff("orders");
    expect(staff.principal.role).toBe("orders");
    expect(await count(pool, "select count(*) from user_access where user_id = $1 and role = 'orders' and disabled_at is null", [staff.userId])).toBe(1);
    // Only the digest of the link is stored; the password is a scrypt hash, never the password.
    expect(await count(pool, "select count(*) from staff_invitations where email = $1 and token_sha256 ~ '^[0-9a-f]{64}$' and accepted_at is not null and user_id = $2", [staff.email, staff.userId])).toBe(1);
    expect(await count(pool, "select count(*) from auth_accounts where user_id = $1 and password like '%' || $2 || '%'", [staff.userId, PASSWORD])).toBe(0);
    // The audit names the Owner as the inviter and the new person as the one who joined; no email address is stored.
    expect(await count(pool, "select count(*) from auth_events where event = 'staff_invited' and actor_user_id = $1 and detail->>'role' = 'orders'", [ownerId])).toBeGreaterThan(0);
    expect(await count(pool, "select count(*) from auth_events where event = 'staff_joined' and actor_user_id = $1 and subject_user_id = $1", [staff.userId])).toBe(1);
    expect(await count(pool, "select count(*) from auth_events where detail::text like '%' || $1 || '%'", [staff.email])).toBe(0);
  });

  it("work once: a used, revoked, replaced or expired link is refused with one answer", async () => {
    counter += 1;
    const email = `once-${counter}@example.test`;
    const first = await inviteStaffOnce(db, owner, key(), { email, role: "catalogue" }, NO_EMAIL);
    const second = await inviteStaffOnce(db, owner, key(), { email, role: "inventory" }, NO_EMAIL);
    // A new link for the same address revokes the old one.
    expect(await forbidden(staffLinkView(db, first.token))).toBe("INVALID_INPUT");
    expect((await staffLinkView(db, second.token)).roleLabel).toBe("Inventory Staff");
    await redeemStaffLink(db, { token: second.token, name: "Once Tester", password: PASSWORD });
    expect(await forbidden(redeemStaffLink(db, { token: second.token, name: "Again", password: PASSWORD }))).toBe("INVALID_INPUT");
    expect(await count(pool, "select count(*) from auth_users where email = $1", [email])).toBe(1);

    const revoked = await inviteStaffOnce(db, owner, key(), { email: `revoked-${counter}@example.test`, role: "orders" }, NO_EMAIL);
    await revokeStaffLinkOnce(db, owner, key(), { invitationId: revoked.invitationId });
    expect(await forbidden(redeemStaffLink(db, { token: revoked.token, name: "Revoked", password: PASSWORD }))).toBe("INVALID_INPUT");

    const expired = await inviteStaffOnce(db, owner, key(), { email: `expired-${counter}@example.test`, role: "orders" }, NO_EMAIL);
    await pool.query("update staff_invitations set created_at = now() - interval '4 days', expires_at = now() - interval '1 minute' where id = $1", [expired.invitationId]);
    expect(await forbidden(redeemStaffLink(db, { token: expired.token, name: "Late", password: PASSWORD }))).toBe("INVALID_INPUT");
    expect(await forbidden(redeemStaffLink(db, { token: "not-a-token", name: "Guess", password: PASSWORD }))).toBe("INVALID_INPUT");
  });

  it("are refused for an address with an Admin account (the Owner's included) and for anything but a staff role", async () => {
    expect(await forbidden(inviteStaffOnce(db, owner, key(), { email: "staff-owner@example.test", role: "orders" }, NO_EMAIL))).toBe("INVALID_INPUT");
    expect(await forbidden(inviteStaffOnce(db, owner, key(), { email: "would-be-owner@example.test", role: "owner" }, NO_EMAIL))).toBe("INVALID_INPUT");
    expect(await count(pool, "select count(*) from staff_invitations where email = 'would-be-owner@example.test'")).toBe(0);
    // The database refuses an Owner invitation even from a direct write.
    expect(await forbidden(pool.query("insert into staff_invitations (kind, email, role, token_sha256, expires_at, created_by_user_id) values ('invite', 'x@example.test', 'owner', repeat('a', 64), now() + interval '1 hour', $1)", [ownerId]))).not.toBe("allowed");
  });

  it("an email invitation is sent by email and its link is not handed back; a failed send hands it back once", async () => {
    const sent: { to: string; text: string }[] = [];
    counter += 1;
    const emailed = await inviteStaffOnce(db, owner, key(), { email: `mailed-${counter}@example.test`, role: "orders" }, { ...NO_EMAIL, send: async (m) => void sent.push({ to: m.to, text: m.text }) });
    expect(emailed).toMatchObject({ emailed: true, token: null });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(new RegExp(`${BASE_URL}/admin/invite#t=[A-Za-z0-9_-]{43}`));
    const failing = await inviteStaffOnce(db, owner, key(), { email: `unsent-${counter}@example.test`, role: "orders" }, { ...NO_EMAIL, send: async () => Promise.reject(new Error("down")) });
    expect(failing.emailed).toBe(false);
    expect(failing.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The same request again (a lost answer) never shows a token twice.
    const k = key();
    const once = await inviteStaffOnce(db, owner, k, { email: `replay-${counter}@example.test`, role: "orders" }, NO_EMAIL);
    const replay = await inviteStaffOnce(db, owner, k, { email: `replay-${counter}@example.test`, role: "orders" }, NO_EMAIL);
    expect(once.token).not.toBeNull();
    expect(replay).toMatchObject({ invitationId: once.invitationId, token: null });
  });
});

describe("what each role can do", () => {
  it("Orders Staff verify and pack orders, but cannot touch money, stock, products, settings or staff", async () => {
    const staff = await newStaff("orders");
    const { order } = await pendingOrder();
    const confirmed = await confirmOrderOnce(db, staff.principal, key(), { orderId: order.id, expectedVersion: order.version });
    await packOrderOnce(db, staff.principal, key(), { orderId: order.id, expectedVersion: confirmed.value.version });
    expect((await getOrderDetail(db, order.id)).fulfilmentStatus).toBe("packed");
    // History names the staff member who acted, not the Owner.
    expect(await count(pool, "select count(*) from order_events where order_id = $1 and event = 'packed' and actor_user_id = $2", [order.id, staff.userId])).toBe(1);

    const current = await getOrderDetail(db, order.id);
    expect(await forbidden(recordPaymentOnce(db, staff.principal, key(), { orderId: order.id, expectedVersion: current.version, kind: "collected", amountPaisa: 100, occurredOn: dhakaToday() }))).toBe("FORBIDDEN");
    expect(await forbidden(verifyAdvanceOnce(db, staff.principal, key(), { orderId: order.id, expectedVersion: current.version, advancePaymentId: null, method: "bkash", reference: "TESTREF01", amountPaisa: 100, receivedOn: dhakaToday() }))).toBe("FORBIDDEN");
    expect(await forbidden(adjustStockOnce(db, staff.principal, key(), { sku: current.items[0].sku, quantityDelta: -1, reason: "Test" }))).toBe("FORBIDDEN");
    expect(await forbidden(createProductOnce(db, staff.principal, key(), { slug: `staff-${counter}`, nameEn: "Not allowed" }))).toBe("FORBIDDEN");
    expect(await forbidden(savePaymentMethodOnce(db, staff.principal, key(), { method: "bkash", expectedVersion: 0, enabled: false, approved: false, accountName: null, accountNumber: null, accountKind: null, bankName: null, branchName: null, routingNumber: null, instructionsEn: null, instructionsBn: null }))).toBe("FORBIDDEN");
    expect(await forbidden(inviteStaffOnce(db, staff.principal, key(), { email: "friend@example.test", role: "manager" }, NO_EMAIL))).toBe("FORBIDDEN");
    expect(await forbidden(staffOverview(db, staff.principal))).toBe("FORBIDDEN");
    expect(await forbidden(changeStaffRoleOnce(db, staff.principal, key(), { userId: staff.userId, fromRole: "orders", toRole: "manager" }))).toBe("FORBIDDEN");
  });

  it("the API answers 403 to a staff Bearer token for what its role lacks, and serves what it holds", async () => {
    const staff = await newStaff("orders");
    const { token } = await signInNative(auth, staff.email, PASSWORD);
    const { order } = await pendingOrder();
    const call = (route: typeof paymentsRoute, path: string, method: "GET" | "POST", body?: unknown, params: Record<string, string> = {}) =>
      (route as unknown as Record<string, (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>>)[method](
        new Request(`${BASE_URL}/api/v1${path}`, { method, headers: { ...Object.fromEntries(bearer(token!)), ...(body ? { "content-type": "application/json", "idempotency-key": key() } : {}) }, body: body ? JSON.stringify(body) : undefined }),
        { params: Promise.resolve(params) },
      );
    expect((await call(ordersRoute as unknown as typeof paymentsRoute, "/orders", "GET")).status).toBe(200);
    const pay = await call(paymentsRoute, `/orders/${order.id}/payments`, "POST", { kind: "collected", amountPaisa: 100, occurredOn: dhakaToday(), version: order.version }, { orderId: order.id });
    expect(pay.status).toBe(403);
    expect((await pay.json()).code).toBe("FORBIDDEN");
  });

  it("Inventory Staff receive and count stock; applying the count waits for a Manager", async () => {
    const staff = await newStaff("inventory");
    const manager = await newStaff("manager");
    const { variant } = await createTestVariant(db, "inv");
    await receiveStockOnce(db, staff.principal, key(), { sku: variant.sku, quantity: 4 });
    const started = await startStockCountOnce(db, staff.principal, key(), { scope: "selected", skus: [variant.sku] });
    const counted = await recordCountsOnce(db, staff.principal, key(), { countId: started.value.id, expectedVersion: started.value.version, entries: [{ variantId: variant.id, counted: 3 }] });
    expect(await forbidden(applyStockCountOnce(db, staff.principal, key(), { countId: counted.value.id, expectedVersion: counted.value.version, reason: "Shelf count" }))).toBe("FORBIDDEN");
    expect(await forbidden(adjustStockOnce(db, staff.principal, key(), { sku: variant.sku, quantityDelta: -1, reason: "Test" }))).toBe("FORBIDDEN");
    const applied = await applyStockCountOnce(db, manager.principal, key(), { countId: counted.value.id, expectedVersion: counted.value.version, reason: "Shelf count" });
    expect(applied.value.status).toBe("applied");
  });

  it("a Manager cannot decide returns, record money, publish, manage staff or change settings", async () => {
    const manager = await newStaff("manager");
    for (const p of ["returns:decide", "payments:record", "payments:verify", "catalog:publish", "users:manage", "settings:write", "exports:create", "policies:publish"] as const) {
      expect(roleHasPermission(manager.principal.role, p), p).toBe(false);
    }
    expect(await forbidden(returnStepOnce(db, manager.principal, key(), { orderId: randomUUID(), returnId: randomUUID(), expectedVersion: 1, step: "approve" }))).toBe("FORBIDDEN");
  });
});

describe("changing access", () => {
  it("a role change applies to the very next request, and the Owner's own access can never be changed here", async () => {
    const staff = await newStaff("orders");
    await changeStaffRoleOnce(db, owner, key(), { userId: staff.userId, fromRole: "orders", toRole: "catalogue" });
    const after = await getPrincipal(auth, db, headersWith(staff.cookie));
    expect(after?.role).toBe("catalogue");
    expect(await forbidden(confirmOrderOnce(db, after!, key(), { orderId: randomUUID(), expectedVersion: 1 }))).toBe("FORBIDDEN");
    // The role the Owner saw must still be current (a stale page is refused).
    expect(await forbidden(changeStaffRoleOnce(db, owner, key(), { userId: staff.userId, fromRole: "orders", toRole: "manager" }))).toBe("VERSION_CONFLICT");
    expect(await count(pool, "select count(*) from auth_events where event = 'staff_role_changed' and actor_user_id = $1 and subject_user_id = $2 and detail->>'roleAfter' = 'catalogue'", [ownerId, staff.userId])).toBe(1);
    // Nothing here targets the Owner: no role change, no disabling, no session ending, no password link.
    expect(await forbidden(changeStaffRoleOnce(db, owner, key(), { userId: ownerId, fromRole: "manager", toRole: "orders" }))).toBe("FORBIDDEN");
    expect(await forbidden(setStaffEnabledOnce(db, owner, key(), { userId: ownerId, enabled: false }))).toBe("FORBIDDEN");
    expect(await forbidden(revokeStaffSessionsOnce(db, owner, key(), { userId: ownerId }))).toBe("FORBIDDEN");
    expect(await forbidden(sendPasswordLinkOnce(db, owner, key(), { userId: ownerId }, NO_EMAIL))).toBe("FORBIDDEN");
    expect(await count(pool, "select count(*) from user_access where user_id = $1 and role = 'owner' and disabled_at is null", [ownerId])).toBe(1);
  });

  it("disabling signs the person out everywhere and refuses sign-in; re-enabling lets them sign in again", async () => {
    const staff = await newStaff("orders");
    await setStaffEnabledOnce(db, owner, key(), { userId: staff.userId, enabled: false });
    expect(await getPrincipal(auth, db, headersWith(staff.cookie))).toBeNull();
    expect(await count(pool, "select count(*) from auth_sessions where user_id = $1", [staff.userId])).toBe(0);
    expect((await signIn(auth, staff.email, PASSWORD)).response.status).toBe(401);
    await setStaffEnabledOnce(db, owner, key(), { userId: staff.userId, enabled: true });
    expect((await signIn(auth, staff.email, PASSWORD)).response.status).toBe(200);
    expect(await count(pool, "select count(*) from auth_events where event in ('staff_disabled', 'staff_enabled') and actor_user_id = $1 and subject_user_id = $2", [ownerId, staff.userId])).toBe(2);
  });

  it("ending sessions stops every existing cookie and token at once; the password still works", async () => {
    const staff = await newStaff("manager");
    const { token } = await signInNative(auth, staff.email, PASSWORD);
    const ended = await revokeStaffSessionsOnce(db, owner, key(), { userId: staff.userId });
    expect(ended.value.ended).toBeGreaterThanOrEqual(2);
    expect(await getPrincipal(auth, db, headersWith(staff.cookie))).toBeNull();
    expect(await auth.api.getSession({ headers: bearer(token!), query: { disableCookieCache: true } })).toBeNull();
    expect((await signIn(auth, staff.email, PASSWORD)).response.status).toBe(200);
  });

  it("a set-password link replaces the password once and ends the old sessions", async () => {
    const staff = await newStaff("catalogue");
    const link = await sendPasswordLinkOnce(db, owner, key(), { userId: staff.userId }, NO_EMAIL);
    expect((await staffLinkView(db, link.token)).kind).toBe("password");
    const next = "a different long password for tests";
    await redeemStaffLink(db, { token: link.token, password: next });
    expect(await getPrincipal(auth, db, headersWith(staff.cookie))).toBeNull();
    expect((await signIn(auth, staff.email, PASSWORD)).response.status).toBe(401);
    expect((await signIn(auth, staff.email, next)).response.status).toBe(200);
    expect(await forbidden(redeemStaffLink(db, { token: link.token, password: PASSWORD }))).toBe("INVALID_INPUT");
  });

  it("the overview lists everyone with access, the links and the history, to the Owner only", async () => {
    const overview = await staffOverview(db, owner);
    expect(overview.members[0].role).toBe("owner");
    expect(overview.members.some((m) => m.role !== "owner")).toBe(true);
    expect(overview.history.some((e) => e.event === "staff_invited" && e.actorName !== null)).toBe(true);
  });
});
