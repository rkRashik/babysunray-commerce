import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/database";
import { receiveStock } from "../../src/modules/inventory/service";
import { BASE_URL, clearAuthState, count, createTestAuth, createTestUser, signIn } from "../support/auth";
import { createTestVariant, TEST_ACTOR } from "../support/fixtures";
import { createTestDb } from "../support/test-database";

// Owner Office order Server Actions and the public guest-tracking endpoints, called as Next.js calls them,
// against PostgreSQL. Fictional data only.

const state = vi.hoisted(() => ({ db: undefined as unknown, auth: undefined as unknown, headers: new Headers() }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/modules/auth/server", () => ({ getAuth: () => state.auth }));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  },
}));

const actions = await import("../../src/app/office/orders/actions");
const trackRoute = await import("../../src/app/api/track/route");
const cancelRoute = await import("../../src/app/api/track/cancel/route");

const OWNER = { email: "office-orders@example.test", password: "office orders long password" };
let db: Db;
let pool: Pool;
let cookie: string;

beforeAll(async () => {
  ({ db, pool } = await createTestDb(6));
  const auth = createTestAuth(db);
  Object.assign(state, { db, auth });
  await clearAuthState(pool);
  await createTestUser(pool, { ...OWNER, role: "owner" });
  ({ cookie } = await signIn(auth, OWNER.email, OWNER.password));
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query("delete from auth_rate_limits");
  await pool.query("delete from tracking_rate_limits");
  state.headers = new Headers({ cookie });
});

type Action = (s: object, f: FormData) => Promise<{ error?: string; link?: string; values?: Record<string, string> }>;
async function submit(action: Action, fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries({ idempotencyKey: randomUUID(), ...fields })) form.append(k, v);
  try {
    return { state: await action({}, form) };
  } catch (error) {
    const url = (error as { url?: string }).url;
    if (url) return { redirect: url };
    throw error;
  }
}

async function zones() {
  const rows = (await pool.query<{ code: string; version: number }>("select code, version from delivery_zones")).rows;
  for (const code of ["dhaka_city", "outside_dhaka"]) {
    const version = rows.find((r) => r.code === code)?.version;
    expect(await submit(actions.setDeliveryZoneAction, { code, chargeTaka: "60", active: "on", version: version ? String(version) : "" })).toEqual({ redirect: "/office/settings/delivery?done=zone-saved" });
  }
}

const orderFields = (sku: string, extra: Record<string, string> = {}) => ({
  source: "messenger",
  customerName: "Test Customer",
  customerPhone: "01911000004",
  deliveryAddress: "Flat 2, Test Lane",
  deliveryZone: "dhaka_city",
  sku0: sku.toLowerCase(),
  qty0: "2",
  ...extra,
});

async function newOrder() {
  const { variant } = await createTestVariant(db, "offord");
  await receiveStock(db, { sku: variant.sku, quantity: 3, actor: TEST_ACTOR });
  const created = await submit(actions.createOrderAction, orderFields(variant.sku));
  const orderId = created.redirect!.split("/")[3].split("?")[0];
  return { orderId, sku: variant.sku };
}
const version = async (orderId: string) => (await pool.query("select version from orders where id = $1", [orderId])).rows[0].version as number;

describe("Office order actions", () => {
  it("create an order (stock reserved, totals from the server), then confirm; a stale tab is refused", async () => {
    await zones();
    const { orderId, sku } = await newOrder();
    const { rows } = await pool.query("select order_status, subtotal_paisa, delivery_charge_paisa, total_paisa, customer_phone from orders where id = $1", [orderId]);
    expect(rows[0]).toMatchObject({ order_status: "pending_verification", delivery_charge_paisa: "6000", customer_phone: "01911000004" });
    expect(Number(rows[0].total_paisa)).toBe(Number(rows[0].subtotal_paisa) + 6000);
    expect((await pool.query("select reserved from inventory_balances b join variants v on v.id = b.variant_id where v.sku = $1", [sku])).rows[0].reserved).toBe(2);
    const v = String(await version(orderId));
    expect(await submit(actions.orderTransitionAction, { orderId, version: v, action: "confirm" })).toEqual({ redirect: `/office/orders/${orderId}?done=confirm` });
    const stale = await submit(actions.orderTransitionAction, { orderId, version: v, action: "cancel" });
    expect(stale.state?.error).toMatch(/changed after you loaded it/);
  });

  it("shows readable errors and keeps what was typed when an order cannot be taken", async () => {
    const { variant } = await createTestVariant(db, "offbad");
    const short = await submit(actions.createOrderAction, orderFields(variant.sku));
    expect(short.state?.error).toMatch(/Not enough stock/);
    expect(short.state?.values).toMatchObject({ customerName: "Test Customer", sku0: variant.sku.toLowerCase(), qty0: "2" });
    expect((await submit(actions.createOrderAction, orderFields(variant.sku, { customerPhone: "12345" }))).state?.error).toMatch(/^Phone must be a Bangladesh mobile number/);
    expect((await submit(actions.createOrderAction, orderFields(variant.sku, { sku0: "", qty0: "" }))).state?.error).toBe("Add at least one SKU and quantity.");
    expect((await submit(actions.createOrderAction, orderFields(variant.sku, { source: "website" }))).state?.error).toBe("Choose a source.");
  });

  it("records collection and settlement in Taka, exactly in paisa", async () => {
    const { orderId } = await newOrder();
    for (const action of ["confirm", "pack", "dispatch", "deliver"]) {
      expect((await submit(actions.orderTransitionAction, { orderId, version: String(await version(orderId)), action })).redirect).toContain(`done=${action}`);
    }
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(new Date());
    expect((await submit(actions.recordPaymentAction, { orderId, version: String(await version(orderId)), kind: "collected", amountTaka: "100.55", occurredOn: today })).redirect).toContain("done=payment");
    const bad = await submit(actions.recordPaymentAction, { orderId, version: String(await version(orderId)), kind: "settled", amountTaka: "100.56", occurredOn: today });
    expect(bad.state?.error).toMatch(/more settled and deducted than the courier has collected/);
    expect((await pool.query("select cod_collected_paisa, payment_status from orders where id = $1", [orderId])).rows[0]).toEqual({ cod_collected_paisa: "10055", payment_status: "partially_collected" });
  });

  it("answers a new tracking link in the form state only, never in a URL", async () => {
    const { orderId } = await newOrder();
    const result = await submit(actions.createTrackingLinkAction, { orderId });
    expect(result.redirect).toBeUndefined();
    expect(result.state?.link).toMatch(new RegExp(`^${BASE_URL}/track#t=[A-Za-z0-9_-]{43}$`));
    expect(await count(pool, "select count(*) from order_tracking_tokens where order_id = $1 and revoked_at is null", [orderId])).toBe(1);
    expect(await submit(actions.revokeTrackingLinkAction, { orderId })).toEqual({ redirect: `/office/orders/${orderId}?done=link-revoked` });
  });

  it("every order action sends an anonymous caller to sign-in and changes nothing", async () => {
    const { orderId } = await newOrder();
    state.headers = new Headers();
    const before = await version(orderId);
    for (const [action, fields] of [
      [actions.createOrderAction, orderFields("ANY")],
      [actions.orderTransitionAction, { orderId, version: String(before), action: "cancel" }],
      [actions.reviewCancellationAction, { orderId, version: String(before), decision: "approve" }],
      [actions.recordPaymentAction, { orderId, version: String(before), kind: "collected", amountTaka: "1", occurredOn: "2026-01-01" }],
      [actions.rtoChargeAction, { orderId, version: String(before), chargeTaka: "1" }],
      [actions.createReturnAction, { orderId, version: String(before) }],
      [actions.returnStepAction, { orderId, version: String(before), returnId: randomUUID(), step: "receive" }],
      [actions.inspectAction, { orderId, version: String(before), quarantineItemId: randomUUID(), outcome: "restock" }],
      [actions.createTrackingLinkAction, { orderId }],
      [actions.revokeTrackingLinkAction, { orderId }],
      [actions.setDeliveryZoneAction, { code: "dhaka_city", chargeTaka: "1", version: "" }],
    ] as [Action, Record<string, string>][]) {
      expect(await submit(action, fields)).toEqual({ redirect: "/office/login" });
    }
    expect(await version(orderId)).toBe(before);
  });
});

describe("guest tracking endpoints", () => {
  const post = (route: { POST: (r: Request) => Promise<Response> }, path: string, body: unknown, headers: Record<string, string> = {}) =>
    route.POST(new Request(`${BASE_URL}${path}`, { method: "POST", headers: { origin: BASE_URL, "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }));

  async function linkFor(orderId: string) {
    const link = (await submit(actions.createTrackingLinkAction, { orderId })).state!.link!;
    return link.split("#t=")[1];
  }

  it("shows the masked order for a live token, with no-store, no-referrer and noindex; nothing else", async () => {
    const { orderId } = await newOrder();
    const token = await linkFor(orderId);
    const res = await post(trackRoute, "/api/track", { token });
    expect(res.status).toBe(200);
    for (const [name, value] of [["cache-control", "no-store"], ["referrer-policy", "no-referrer"], ["x-robots-tag", "noindex, nofollow"]]) expect(res.headers.get(name)).toBe(value);
    const text = await res.text();
    expect(JSON.parse(text).data).toMatchObject({ customer: { name: "T***", phone: "019******04" }, orderStatus: "pending_verification", canCancel: true });
    for (const secret of ["Test Customer", "01911000004", "Flat 2", orderId]) expect(text).not.toContain(secret);
  });

  it("answers every unusable token the same way, refuses other origins and bodies, and logs no token", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { orderId } = await newOrder();
      const token = await linkFor(orderId);
      const bodies = await Promise.all(["x".repeat(43), "", token.slice(0, 42)].map(async (t) => {
        const r = await post(trackRoute, "/api/track", { token: t });
        return [r.status, await r.text()];
      }));
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
      expect(bodies[0][0]).toBe(404);
      expect((await post(trackRoute, "/api/track", { token }, { origin: "https://elsewhere.example" })).status).toBe(403);
      expect((await post(trackRoute, "/api/track", { token }, { "content-type": "text/plain" })).status).toBe(415);
      expect((await post(trackRoute, "/api/track", "{bad")).status).toBe(400);
      expect((await post(trackRoute, "/api/track", { token, extra: 1 })).status).toBe(400);
      expect((await post(trackRoute, "/api/track", { token: "x".repeat(3000) })).status).toBe(413);
      // Bytes, not characters: 700 Bangla letters are 2,100 bytes.
      expect((await post(trackRoute, "/api/track", { token: "ক".repeat(700) })).status).toBe(413);
      for (const route of [trackRoute, cancelRoute]) {
        // A streamed body with no Content-Length is refused once it passes the limit, not read to the end.
        let sent = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            sent += 1024;
            controller.enqueue(new Uint8Array(1024).fill(32));
            if (sent >= 1_000_000) controller.close();
          },
        });
        const request = new Request(`${BASE_URL}/api/track`, { method: "POST", headers: { origin: BASE_URL, "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
        expect((await route.POST(request)).status).toBe(413);
        expect(sent).toBeLessThan(16_384);
      }
      for (const spy of [errors, logs]) for (const callArgs of spy.mock.calls) expect(JSON.stringify(callArgs)).not.toContain(token);
    } finally {
      errors.mockRestore();
      logs.mockRestore();
    }
  });

  it("limits unknown tokens globally without ever blocking a live link; malformed ones cost no lookup", async () => {
    const { orderId } = await newOrder();
    const token = await linkFor(orderId);
    const failures = () => count(pool, "select coalesce(sum(count), 0) from tracking_rate_limits where bucket = 'failure'");
    for (const bad of ["x", "", "y".repeat(44), "not a token at all"]) expect((await post(trackRoute, "/api/track", { token: bad })).status).toBe(404);
    expect(await failures()).toBe(0);
    const unknown = [];
    for (let i = 0; i < 31; i += 1) unknown.push((await post(trackRoute, "/api/track", { token: `${"y".repeat(42)}${i % 10}` })).status);
    expect(unknown.slice(0, 30).every((st) => st === 404)).toBe(true);
    expect(unknown[30]).toBe(429);
    // Someone else's failed guesses never lock the customer out of a live link, nor its cancellation.
    expect((await post(trackRoute, "/api/track", { token })).status).toBe(200);
    expect((await post(cancelRoute, "/api/track/cancel", { token: `${"z".repeat(42)}1`, action: "cancel" })).status).toBe(429);
  });

  it("gives every live link its own per-minute limit, so one link's traffic never affects another", async () => {
    const first = await linkFor((await newOrder()).orderId);
    const second = await linkFor((await newOrder()).orderId);
    const statuses = [];
    for (let i = 0; i < 31; i += 1) statuses.push((await post(trackRoute, "/api/track", { token: first })).status);
    expect(statuses.slice(0, 30).every((st) => st === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect((await post(trackRoute, "/api/track", { token: second })).status).toBe(200);
    // Buckets are keyed by the link's id, never by the token or its digest.
    const buckets = (await pool.query<{ bucket: string }>("select bucket from tracking_rate_limits")).rows.map((r) => r.bucket);
    for (const bucket of buckets) for (const t of [first, second]) expect(bucket).not.toContain(t.slice(0, 12));
    expect(buckets.filter((b) => b.startsWith("link:"))).toHaveLength(2);
    await pool.query("delete from tracking_rate_limits");
    expect((await post(trackRoute, "/api/track", { token: first })).status).toBe(200);
  });

  it("lets the customer cancel while pending, request when confirmed, and nothing after dispatch", async () => {
    const { orderId } = await newOrder();
    const token = await linkFor(orderId);
    const cancelled = await post(cancelRoute, "/api/track/cancel", { token, action: "cancel" });
    expect((await cancelled.json()).data).toMatchObject({ orderStatus: "cancelled", canCancel: false });

    const second = await newOrder();
    const t2 = await linkFor(second.orderId);
    for (const action of ["confirm", "pack"]) await submit(actions.orderTransitionAction, { orderId: second.orderId, version: String(await version(second.orderId)), action });
    expect((await post(cancelRoute, "/api/track/cancel", { token: t2, action: "cancel" })).status).toBe(409);
    const requested = await post(cancelRoute, "/api/track/cancel", { token: t2, action: "request", reason: "Changed my mind" });
    expect((await requested.json()).data).toMatchObject({ cancellationRequested: true, orderStatus: "confirmed" });
    await submit(actions.reviewCancellationAction, { orderId: second.orderId, version: String(await version(second.orderId)), decision: "reject" });
    await submit(actions.orderTransitionAction, { orderId: second.orderId, version: String(await version(second.orderId)), action: "dispatch" });
    expect((await post(cancelRoute, "/api/track/cancel", { token: t2, action: "request" })).status).toBe(409);
  });
});
