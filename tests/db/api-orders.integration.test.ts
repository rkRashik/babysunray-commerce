import { randomUUID } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/database";
import { receiveStock } from "../../src/modules/inventory/service";
import { dhakaToday } from "../../src/modules/orders/rules";
import { BASE_URL, clearAuthState, count, createTestAuth, createTestUser, signIn, signInNative } from "../support/auth";
import { createTestVariant, TEST_ACTOR } from "../support/fixtures";
import { createTestDb } from "../support/test-database";

// The order endpoints of /api/v1 through the real route handlers against PostgreSQL. Every response is checked
// against the published OpenAPI document (status documented, content type and body match). Fictional data only.

const state = vi.hoisted(() => ({ db: undefined as unknown, auth: undefined as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/modules/auth/server", () => ({ getAuth: () => state.auth }));

type RouteModule = Partial<Record<string, (r: Request, c: { params: Promise<never> }) => Promise<Response>>>;
const load = async (p: Promise<unknown>) => (await p) as RouteModule;
const ORDER_ROUTES: Record<string, RouteModule> = {
  "/orders": await load(import("../../src/app/api/v1/orders/route")),
  "/orders/{orderId}": await load(import("../../src/app/api/v1/orders/[orderId]/route")),
  "/orders/{orderId}/transitions": await load(import("../../src/app/api/v1/orders/[orderId]/transitions/route")),
  "/orders/{orderId}/cancellation-review": await load(import("../../src/app/api/v1/orders/[orderId]/cancellation-review/route")),
  "/orders/{orderId}/payments": await load(import("../../src/app/api/v1/orders/[orderId]/payments/route")),
  "/orders/{orderId}/rto-charge": await load(import("../../src/app/api/v1/orders/[orderId]/rto-charge/route")),
  "/orders/{orderId}/returns": await load(import("../../src/app/api/v1/orders/[orderId]/returns/route")),
  "/orders/{orderId}/returns/{returnId}/steps": await load(import("../../src/app/api/v1/orders/[orderId]/returns/[returnId]/steps/route")),
  "/orders/{orderId}/inspections/{quarantineItemId}": await load(import("../../src/app/api/v1/orders/[orderId]/inspections/[quarantineItemId]/route")),
  "/orders/{orderId}/tracking-link": await load(import("../../src/app/api/v1/orders/[orderId]/tracking-link/route")),
  "/orders/{orderId}/tracking-link/revoke": await load(import("../../src/app/api/v1/orders/[orderId]/tracking-link/revoke/route")),
  "/delivery-zones": await load(import("../../src/app/api/v1/delivery-zones/route")),
  "/delivery-zones/{code}": await load(import("../../src/app/api/v1/delivery-zones/[code]/route")),
  "/skus/{sku}/stock": await load(import("../../src/app/api/v1/skus/[sku]/stock/route")),
};
const openApiRoute = await import("../../src/app/api/v1/openapi.json/route");

const OWNER = { email: "api-orders-owner@example.test", password: "api orders owner long password" };
const CUSTOMER = { name: "Test Customer", phone: "01711000003" };
const today = dhakaToday();

let db: Db;
let pool: Pool;
let token: string;
let doc: { paths: Record<string, Record<string, { responses: Record<string, { content: Record<string, { schema: { $ref: string } }> }> }>> };
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);

beforeAll(async () => {
  ({ db, pool } = await createTestDb(6));
  const auth = createTestAuth(db);
  Object.assign(state, { db, auth });
  doc = await openApiRoute.GET().json();
  ajv.addSchema(doc, "openapi");
  await clearAuthState(pool);
  await createTestUser(pool, { ...OWNER, role: "owner" });
  token = (await signInNative(auth, OWNER.email, OWNER.password)).token!;
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query("delete from auth_rate_limits");
  await pool.query("delete from api_rate_limits");
});

type Call = { method?: string; path: string; template: string; params?: Record<string, string>; token?: string | null; key?: string | null; body?: unknown; headers?: Record<string, string> };

async function call({ method = "POST", path, template, params = {}, token: t = token, key = randomUUID(), body, headers = {} }: Call) {
  const h = new Headers(headers);
  if (t) h.set("authorization", `Bearer ${t}`);
  if (key && method !== "GET") h.set("idempotency-key", key);
  if (body !== undefined) h.set("content-type", "application/json");
  const response = await ORDER_ROUTES[template][method]!(
    new Request(`${BASE_URL}/api/v1${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }),
    { params: Promise.resolve(params) as Promise<never> },
  );
  const json = await response.json();
  expect(response.headers.get("cache-control")).toBe("no-store");
  for (const [name] of response.headers) expect(name).not.toMatch(/^access-control-/);
  if (response.status !== 405) {
    const documented = doc.paths[template][method.toLowerCase()].responses[String(response.status)];
    expect(documented, `${method} ${template} documents ${response.status}`).toBeDefined();
    const [type] = Object.keys(documented.content);
    expect(response.headers.get("content-type")).toContain(type);
    const validate = ajv.getSchema(`openapi#/components/schemas/${documented.content[type].schema.$ref.split("/").at(-1)}`)!;
    expect(validate(json), JSON.stringify(validate.errors)).toBe(true);
  }
  return { status: response.status, body: json, response };
}

const orderCall = (orderId: string, suffix: string, template: string, body?: unknown, extra: Partial<Call> = {}) =>
  call({ path: `/orders/${orderId}${suffix}`, template, params: { orderId }, body, ...extra });
const transition = async (orderId: string, action: string, version: number) =>
  orderCall(orderId, "/transitions", "/orders/{orderId}/transitions", { action, version });

async function sku(stock: number) {
  const { variant } = await createTestVariant(db, "apiord");
  await receiveStock(db, { sku: variant.sku, quantity: stock, actor: TEST_ACTOR });
  return variant.sku;
}

async function configureZones() {
  const { body } = await call({ method: "GET", path: "/delivery-zones", template: "/delivery-zones" });
  for (const code of ["dhaka_city", "outside_dhaka"]) {
    const current = body.data.find((z: { code: string }) => z.code === code);
    const res = await call({ method: "PUT", path: `/delivery-zones/${code}`, template: "/delivery-zones/{code}", params: { code }, body: { chargePaisa: 6_000, active: true, version: current?.version ?? null } });
    expect(res.status).toBe(200);
  }
}

const create = (items: { sku: string; quantity: number }[], extra: Record<string, unknown> = {}, key = randomUUID()) =>
  call({ path: "/orders", template: "/orders", key, body: { source: "whatsapp", customer: CUSTOMER, deliveryAddress: "House 3, Test Road", deliveryZone: "dhaka_city", items, ...extra } });

describe("order API", () => {
  it("runs a whole order: create, confirm, pack, dispatch, deliver, collect, settle, close", async () => {
    await configureZones();
    const s = await sku(3);
    const created = await create([{ sku: s.toLowerCase(), quantity: 2 }]);
    expect(created.status).toBe(201);
    const order = created.body.data;
    expect(order).toMatchObject({ orderStatus: "pending_verification", paymentStatus: "unpaid", deliveryChargePaisa: 6_000, reference: expect.stringMatching(/^ORD-\d{6}$/) });
    const stock = await call({ method: "GET", path: `/skus/${s}/stock`, template: "/skus/{sku}/stock", params: { sku: s } });
    expect(stock.body.data).toMatchObject({ onHand: 3, reserved: 2, available: 1 });

    let version = order.version;
    for (const action of ["confirm", "pack", "dispatch", "deliver"]) {
      const res = await transition(order.id, action, version);
      expect(res.status, action).toBe(200);
      version = res.body.data.version;
    }
    const pay = async (kind: string, amountPaisa: number) => {
      const res = await orderCall(order.id, "/payments", "/orders/{orderId}/payments", { kind, amountPaisa, occurredOn: today, version, reference: "Slip 9" });
      expect(res.status).toBe(201);
      version = res.body.data.version;
      return res.body.data;
    };
    expect(await pay("collected", order.totalPaisa)).toMatchObject({ paymentStatus: "collected" });
    expect(await pay("settled", order.totalPaisa)).toMatchObject({ paymentStatus: "settled" });
    // Settled, but the 7-day return window is still open: closing is refused until it has ended.
    const early = await transition(order.id, "close", version);
    expect([early.status, early.body.code]).toEqual([409, "INVALID_TRANSITION"]);
    await pool.query("update orders set delivered_at = now() - interval '7 days 1 minute' where id = $1", [order.id]);
    const closed = await transition(order.id, "close", version);
    expect(closed.body.data).toMatchObject({ orderStatus: "closed", fulfilmentStatus: "delivered" });
    const after = await call({ method: "GET", path: `/skus/${s}/stock`, template: "/skus/{sku}/stock", params: { sku: s } });
    expect(after.body.data).toMatchObject({ onHand: 1, reserved: 0, available: 1 });

    const list = await call({ method: "GET", path: `/orders?number=${order.reference}`, template: "/orders" });
    expect(list.body.data.map((o: { id: string }) => o.id)).toEqual([order.id]);
    const detail = await call({ method: "GET", path: `/orders/${order.id}`, template: "/orders/{orderId}", params: { orderId: order.id } });
    expect(detail.body.data.events.map((e: { event: string }) => e.event)).toEqual(["submitted", "confirmed", "packed", "dispatched", "delivered", "cod_collected", "cod_settled", "closed"]);
  });

  it("answers replays, stale versions, invalid transitions, short stock and bad input with documented problems", async () => {
    const s = await sku(1);
    const key = randomUUID();
    const first = await create([{ sku: s, quantity: 1 }], {}, key);
    const again = await create([{ sku: s, quantity: 1 }], {}, key);
    expect(again.response.headers.get("idempotent-replayed")).toBe("true");
    expect(again.body.data.id).toBe(first.body.data.id);
    expect((await create([{ sku: s, quantity: 2 }], {}, key)).body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await create([{ sku: s, quantity: 1 }])).body.code).toBe("INSUFFICIENT_STOCK");
    const id = first.body.data.id;
    expect((await transition(id, "dispatch", first.body.data.version)).body.code).toBe("INVALID_TRANSITION");
    expect((await transition(id, "confirm", first.body.data.version + 7)).body.code).toBe("VERSION_CONFLICT");
    for (const body of [
      { source: "website", customer: CUSTOMER, deliveryAddress: "x", deliveryZone: "dhaka_city", items: [{ sku: s, quantity: 1 }] },
      { source: "whatsapp", customer: CUSTOMER, deliveryAddress: "x", deliveryZone: "dhaka_city", items: [{ sku: s, quantity: 1 }], totalPaisa: 1 },
      { source: "whatsapp", customer: { ...CUSTOMER, phone: "12345" }, deliveryAddress: "x", deliveryZone: "dhaka_city", items: [{ sku: s, quantity: 1 }] },
      { source: "whatsapp", customer: CUSTOMER, deliveryAddress: "x", deliveryZone: "sylhet", items: [{ sku: s, quantity: 1 }] },
      { source: "whatsapp", customer: CUSTOMER, deliveryAddress: "x", deliveryZone: "dhaka_city", items: [] },
    ]) {
      const res = await call({ path: "/orders", template: "/orders", body });
      expect([res.status, res.body.code], JSON.stringify(body)).toEqual([400, "VALIDATION_FAILED"]);
    }
    const unknown = randomUUID();
    expect((await call({ method: "GET", path: `/orders/${unknown}`, template: "/orders/{orderId}", params: { orderId: unknown } })).body.code).toBe("ORDER_NOT_FOUND");
    expect((await transition(unknown, "confirm", 1)).body.code).toBe("ORDER_NOT_FOUND");
    expect((await call({ method: "GET", path: "/orders?number=abc", template: "/orders" })).status).toBe(400);
    expect((await call({ method: "GET", path: "/orders?phone=01711000003", template: "/orders" })).status).toBe(400);
  });

  it("handles cancellation review, RTO, returns, inspection, refunds and tracking links", async () => {
    const s = await sku(5);
    const { body: c1 } = await create([{ sku: s, quantity: 2 }]);
    let order = (await transition(c1.data.id, "confirm", c1.data.version)).body.data;
    const link = await orderCall(order.id, "/tracking-link", "/orders/{orderId}/tracking-link");
    expect(link.status).toBe(201);
    expect(link.body.data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const { guestCancel } = await import("../../src/modules/orders/tracking");
    await guestCancel(db, link.body.data.token, "request");
    order = (await call({ method: "GET", path: `/orders/${order.id}`, template: "/orders/{orderId}", params: { orderId: order.id } })).body.data;
    const review = await orderCall(order.id, "/cancellation-review", "/orders/{orderId}/cancellation-review", { decision: "reject", version: order.version });
    expect(review.body.data.cancellationRequests.map((r: { status: string }) => r.status)).toEqual(["rejected"]);
    const revoked = await orderCall(order.id, "/tracking-link/revoke", "/orders/{orderId}/tracking-link/revoke");
    expect(revoked.body.data.trackingLink).toBeNull();

    let v = review.body.data.version;
    for (const action of ["pack", "dispatch", "mark_rto", "receive_rto"]) v = (await transition(order.id, action, v)).body.data.version;
    const charge = await orderCall(order.id, "/rto-charge", "/orders/{orderId}/rto-charge", { chargePaisa: 5_000, version: v });
    const item = charge.body.data.quarantine[0];
    const inspected = await call({
      path: `/orders/${order.id}/inspections/${item.id}`,
      template: "/orders/{orderId}/inspections/{quarantineItemId}",
      params: { orderId: order.id, quarantineItemId: item.id },
      body: { outcome: "restock", note: "Sealed", version: charge.body.data.version },
    });
    expect(inspected.body.data.quarantine[0].status).toBe("restocked");

    const { body: c2 } = await create([{ sku: s, quantity: 1 }]);
    let v2 = c2.data.version;
    for (const action of ["confirm", "pack", "dispatch", "deliver"]) v2 = (await transition(c2.data.id, action, v2)).body.data.version;
    v2 = (await orderCall(c2.data.id, "/payments", "/orders/{orderId}/payments", { kind: "collected", amountPaisa: c2.data.totalPaisa, occurredOn: today, version: v2 })).body.data.version;
    const ret = await orderCall(c2.data.id, "/returns", "/orders/{orderId}/returns", { kind: "return", reason: "wrong_or_defective", items: [{ orderItemId: c2.data.items[0].id, quantity: 1 }], version: v2 });
    expect(ret.status).toBe(201);
    const returnId = ret.body.data.returns[0].id;
    const stepCall = (body: Record<string, unknown>) =>
      call({ path: `/orders/${c2.data.id}/returns/${returnId}/steps`, template: "/orders/{orderId}/returns/{returnId}/steps", params: { orderId: c2.data.id, returnId }, body });
    const received = await stepCall({ step: "receive", returnShippingCostPaisa: 7_000, version: ret.body.data.version });
    expect((await stepCall({ step: "approve", version: received.body.data.version })).body.code).toBe("INVALID_TRANSITION");
    const q = received.body.data.quarantine[0];
    const rejected = await call({
      path: `/orders/${c2.data.id}/inspections/${q.id}`,
      template: "/orders/{orderId}/inspections/{quarantineItemId}",
      params: { orderId: c2.data.id, quarantineItemId: q.id },
      body: { outcome: "reject", version: received.body.data.version },
    });
    const approved = await stepCall({ step: "approve", version: rejected.body.data.version });
    expect((await stepCall({ step: "refund", amountPaisa: c2.data.totalPaisa, method: "bkash", occurredOn: today, version: approved.body.data.version })).body.code).toBe("PAYMENT_LIMIT_EXCEEDED");
    const refunded = await stepCall({ step: "refund", amountPaisa: c2.data.items[0].lineTotalPaisa, method: "bkash", occurredOn: today, reference: "TX-9", version: approved.body.data.version });
    expect(refunded.body.data).toMatchObject({ returnStatus: "resolved", refundedPaisa: c2.data.items[0].lineTotalPaisa });
    expect((await stepCall({ step: "refund", amountPaisa: 1, method: "cash", occurredOn: today, version: 1 })).status).toBe(400);
  });

  it("refuses unauthenticated, cookie-only and cross-origin requests on every order endpoint, before reading input", async () => {
    const id = randomUUID();
    const params = { orderId: id, returnId: id, quarantineItemId: id, code: "dhaka_city", sku: "ANY" };
    const auth = createTestAuth(db);
    const { cookie } = await signIn(auth, OWNER.email, OWNER.password);
    for (const [template, module] of Object.entries(ORDER_ROUTES)) {
      for (const method of ["GET", "POST", "PUT"]) {
        const handler = module[method];
        if (!handler) continue;
        const probe = await handler(new Request(`${BASE_URL}/api/v1/x`, { method }), { params: Promise.resolve(params) as Promise<never> });
        if (probe.status === 405) continue;
        expect(probe.status, `${method} ${template} without a token`).toBe(401);
        const withCookie = await handler(new Request(`${BASE_URL}/api/v1/x`, { method, headers: { cookie, "content-type": "application/json" }, body: method === "GET" ? undefined : "{" }), {
          params: Promise.resolve(params) as Promise<never>,
        });
        expect(withCookie.status, `${method} ${template} with only a cookie`).toBe(401);
        const otherOrigin = await handler(new Request(`${BASE_URL}/api/v1/x`, { method, headers: { authorization: `Bearer ${token}`, origin: "https://elsewhere.example" } }), {
          params: Promise.resolve(params) as Promise<never>,
        });
        expect(otherOrigin.status, `${method} ${template} from another origin`).toBe(403);
      }
      const options = await module.OPTIONS!(new Request(`${BASE_URL}/api/v1/x`, { method: "OPTIONS", headers: { origin: "https://elsewhere.example" } }), { params: Promise.resolve(params) as Promise<never> });
      expect(options.status).toBe(405);
      expect([...options.headers.keys()].filter((h) => h.startsWith("access-control-"))).toEqual([]);
    }
    expect(await count(pool, "select count(*) from orders where id = $1", [id])).toBe(0);
  });

  it("refuses a missing or stale delivery-zone version and an out-of-range charge", async () => {
    const zone = (await call({ method: "GET", path: "/delivery-zones", template: "/delivery-zones" })).body.data[0];
    const put = (body: unknown) => call({ method: "PUT", path: `/delivery-zones/${zone.code}`, template: "/delivery-zones/{code}", params: { code: zone.code }, body });
    expect((await put({ chargePaisa: 1, active: true, version: null })).body.code).toBe("VERSION_CONFLICT");
    expect((await put({ chargePaisa: 1, active: true, version: zone.version + 3 })).body.code).toBe("VERSION_CONFLICT");
    expect((await put({ chargePaisa: 1_000_001, active: true, version: zone.version })).status).toBe(400);
    expect((await put({ chargePaisa: 1, active: "yes", version: zone.version })).status).toBe(400);
    const other = await call({ method: "PUT", path: "/delivery-zones/sylhet", template: "/delivery-zones/{code}", params: { code: "sylhet" }, body: { chargePaisa: 1, active: true, version: null } });
    expect(other.status).toBe(400);
  });
});
