import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GUEST_CHECKOUTS_PER_MINUTE, guestCheckoutResponse } from "../../src/api/guest-checkout";
import type { Db } from "../../src/db/database";
import type { Principal } from "../../src/modules/auth/principal";
import { createProduct, createVariant, updateProduct, updateVariant } from "../../src/modules/catalogue/service";
import { receiveStock } from "../../src/modules/inventory/service";
import { publicCheckoutGate } from "../../src/modules/launch/gate";
import { type GuestCheckoutInvalid, placeGuestOrder } from "../../src/modules/orders/guest-checkout";
import { setDeliveryZoneOnce } from "../../src/modules/orders/operations";
import { getOrderDetail } from "../../src/modules/orders/queries";
import { guestView } from "../../src/modules/orders/tracking";
import { clearAuthState, count, createTestAuth, createVerifiedOwner } from "../support/auth";
import { errorCodeOf, TEST_ACTOR, withFailingInserts } from "../support/fixtures";
import { publishNow, withdrawNow } from "../support/publication";
import { createTestDb } from "../support/test-database";

// The future guest checkout service and its unrouted HTTP transport against PostgreSQL (Gate H.25). Every attempt
// is anonymous: no principal is created or passed, and the order must never name a user. Concurrency tests hold
// the contested row from another session until PostgreSQL reports every attempt blocked, so overlap is proven.
// Fictional customers only.

let db: Db;
let pool: Pool;
let owner: Principal;
let ownerId: string;
const BASE = "http://localhost:3000";
const DHAKA = 6_000;
const OUTSIDE = 12_000;
const CUSTOMER = { name: "Guest Tester", phone: "01711 000 222", address: "House 5, Road 6, Test Town" };
const key = () => randomUUID();
let counter = 0;

beforeAll(async () => {
  ({ db, pool } = await createTestDb(8));
  await clearAuthState(pool);
  ({ principal: owner, userId: ownerId } = await createVerifiedOwner(createTestAuth(db), db, pool, "guest-owner@example.test"));
  await pool.query("delete from auth_rate_limits");
  await setZone("dhaka_city", DHAKA, true);
  await setZone("outside_dhaka", OUTSIDE, true);
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  // Every test leaves stock and holds consistent.
  expect(
    await count(pool, `select count(*) from inventory_balances b where b.reserved <> coalesce((select sum(quantity) from stock_reservations r where r.variant_id = b.variant_id and r.status = 'active'), 0) or b.reserved > b.on_hand`),
  ).toBe(0);
});

async function setZone(code: "dhaka_city" | "outside_dhaka", chargePaisa: number, active: boolean) {
  const { rows } = await pool.query<{ version: number }>("select version from delivery_zones where code = $1", [code]);
  await setDeliveryZoneOnce(db, owner, key(), { code, chargePaisa, active, expectedVersion: rows[0]?.version ?? null });
}

/** A complete product with one SKU and `stock` units, published under the test rule (tests/support/publication.ts). */
async function publishedSku(stock: number, pricePaisa = 50_000, publish = true) {
  counter += 1;
  const product = await createProduct(db, { slug: `guest-p-${counter}`, nameEn: "Guest Test Romper", nameBn: "অতিথি পরীক্ষা রম্পার", descriptionEn: "Fictional.", descriptionBn: "কাল্পনিক।" });
  const variant = await createVariant(db, { productId: product.id, sku: `GUEST-${counter}`, size: "6-12M", colour: "Ivory", pricePaisa });
  if (stock > 0) await receiveStock(db, { sku: variant.sku, quantity: stock, actor: TEST_ACTOR });
  if (publish) await publishNow(db, owner, product.id);
  return { productId: product.id, variantId: variant.id, sku: variant.sku, pricePaisa };
}

type Line = { sku: string; quantity: number; unitPricePaisa: number };
const request = (lines: Line[], extra: Record<string, unknown> = {}) => {
  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unitPricePaisa, 0);
  return { customer: CUSTOMER, deliveryZone: "dhaka_city", items: lines, deliveryChargePaisa: DHAKA, totalPaisa: subtotal + DHAKA, ...extra };
};
const line = (s: { sku: string; pricePaisa: number }, quantity = 1): Line => ({ sku: s.sku, quantity, unitPricePaisa: s.pricePaisa });

const counts = async () => ({
  orders: await count(pool, "select count(*) from orders"),
  submissions: await count(pool, "select count(*) from guest_checkout_submissions"),
  tokens: await count(pool, "select count(*) from order_tracking_tokens"),
  holds: await count(pool, "select count(*) from stock_reservations"),
  users: await count(pool, "select count(*) from auth_users"),
  idempotency: await count(pool, "select count(*) from idempotency_records"),
});
const reserved = async (variantId: string) => count(pool, "select reserved from inventory_balances where variant_id = $1", [variantId]);
const fieldErrors = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as GuestCheckoutInvalid).errors;
  }
  throw new Error("Expected the checkout to be refused.");
};

/** Runs every attempt on its own connection while `lockSql` holds a row, then lets them go at once. */
async function race(lockSql: string, param: string, attempts: (racingDb: Db) => Promise<unknown>[], blocked: number) {
  const { db: racingDb, pool: racingPool } = await createTestDb(6);
  const gate = await pool.connect();
  try {
    await gate.query("begin");
    await gate.query(lockSql, [param]);
    const runs = attempts(racingDb).map((p) => p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error: error as { code?: string } })));
    const deadline = Date.now() + 10_000;
    for (;;) {
      const waiting = await count(pool, "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");
      if (waiting >= blocked) break;
      if (Date.now() > deadline) throw new Error(`Only ${waiting} of ${blocked} attempts were blocked.`);
      await new Promise((r) => setTimeout(r, 20));
    }
    await gate.query("commit");
    return await Promise.all(runs);
  } finally {
    gate.release();
    await racingPool.end();
  }
}

describe("guest checkout service", () => {
  it("creates a website order as the customer, never as a user: Pending Verification, stock held, one private link", async () => {
    const a = await publishedSku(3);
    const before = await counts();
    const result = await placeGuestOrder(db, key(), request([line(a, 2)]));
    expect(result.replayed).toBe(false);
    expect(result.trackingToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.order).toMatchObject({ orderStatus: "pending_verification", deliveryZone: "dhaka_city", subtotalPaisa: 100_000, deliveryChargePaisa: DHAKA, totalPaisa: 100_000 + DHAKA });
    // The customer's answer carries no contact data.
    expect(JSON.stringify(result.order)).not.toMatch(/Guest Tester|01711|House 5/);

    const [{ id }] = (await pool.query<{ id: string }>("select order_id as id from guest_checkout_submissions order by created_at desc limit 1")).rows;
    const detail = await getOrderDetail(db, id);
    expect(detail).toMatchObject({ source: "website", createdByUserId: null, customerPhone: "01711000222", orderStatus: "pending_verification" });
    expect(detail.events.map((e) => [e.event, e.actorType, e.actorRef, e.actorUserId])).toEqual([
      ["submitted", "customer", "guest-checkout", null],
      ["tracking_link_created", "customer", "guest-checkout", null],
    ]);
    expect(await reserved(a.variantId)).toBe(2);
    expect(await count(pool, "select count(*) from order_events where order_id = $1 and actor_user_id = $2", [id, ownerId])).toBe(0);

    const after = await counts();
    expect(after).toMatchObject({ orders: before.orders + 1, submissions: before.submissions + 1, tokens: before.tokens + 1, users: before.users, idempotency: before.idempotency });
    expect((await guestView(db, result.trackingToken))?.reference).toBe(result.order.reference);
    // The submission row holds digests only.
    const { rows } = await pool.query("select key_hash, request_mac, order_id from guest_checkout_submissions where order_id = $1", [id]);
    expect(JSON.stringify(rows)).not.toMatch(/Guest|01711|House|GUEST-/);
  });

  it("refuses an Owner actor, role, user id or order source in the request, and creates nothing", async () => {
    const a = await publishedSku(2);
    const before = await counts();
    for (const extra of [{ actor: { type: "user", ref: ownerId } }, { role: "owner" }, { createdByUserId: ownerId }, { source: "whatsapp" }]) {
      expect(await fieldErrors(placeGuestOrder(db, key(), request([line(a)], extra)))).toContainEqual({ field: "request", code: "unknown_field" });
    }
    const nested = request([line(a)]);
    expect(await fieldErrors(placeGuestOrder(db, key(), { ...nested, customer: { ...CUSTOMER, userId: ownerId } }))).toContainEqual({ field: "customer", code: "unknown_field" });
    expect(await counts()).toEqual(before);
  });

  it("validates every field and names the fields only", async () => {
    const a = await publishedSku(2);
    const before = await counts();
    expect(await fieldErrors(placeGuestOrder(db, key(), request([line(a)], { customer: { ...CUSTOMER, phone: "02 9112233" } })))).toEqual([{ field: "customer.phone", code: "phone_invalid" }]);
    expect(await fieldErrors(placeGuestOrder(db, key(), request([line(a)], { customer: { ...CUSTOMER, name: "x".repeat(101) } })))).toEqual([{ field: "customer.name", code: "name_too_long" }]);
    expect(await fieldErrors(placeGuestOrder(db, key(), request([line(a)], { customer: { ...CUSTOMER, address: " " } })))).toEqual([{ field: "customer.address", code: "address_required" }]);
    for (const quantity of [0, -1, 1.5, 1001]) {
      expect(await fieldErrors(placeGuestOrder(db, key(), request([{ ...line(a), quantity }])))).toContainEqual({ field: "items.0.quantity", code: "quantity_invalid" });
    }
    expect(await fieldErrors(placeGuestOrder(db, key(), request([line(a), { ...line(a), sku: a.sku.toLowerCase() }])))).toContainEqual({ field: "items.1.sku", code: "sku_repeated" });
    expect(await fieldErrors(placeGuestOrder(db, key(), request([{ ...line(a), sku: "bad sku!" }])))).toContainEqual({ field: "items.0.sku", code: "sku_invalid" });
    expect(await fieldErrors(placeGuestOrder(db, key(), request(Array.from({ length: 21 }, (_, i) => ({ sku: `X-${i}`, quantity: 1, unitPricePaisa: 1 })))))).toContainEqual({ field: "items", code: "invalid" });
    expect(await fieldErrors(placeGuestOrder(db, key(), request([line(a)], { deliveryZone: "sylhet" })))).toContainEqual({ field: "deliveryZone", code: "invalid" });
    expect(await fieldErrors(placeGuestOrder(db, key(), request([line(a)], { totalPaisa: 0.5 })))).toContainEqual({ field: "totalPaisa", code: "amount_invalid" });
    expect(await fieldErrors(placeGuestOrder(db, key(), "not an object"))).toEqual([{ field: "request", code: "invalid" }]);
    expect(await counts()).toEqual(before);
  });

  it("refuses a missing, short or malformed key before anything else", async () => {
    const a = await publishedSku(1);
    for (const bad of [undefined, "", "short-key", "x".repeat(31), "has space".padEnd(40, "x"), "é".repeat(40), "x".repeat(129)]) {
      expect(await fieldErrors(placeGuestOrder(db, bad, request([line(a)])))).toEqual([{ field: "idempotencyKey", code: "key_invalid" }]);
    }
    expect(await reserved(a.variantId)).toBe(0);
  });

  it("the same key after a lost response returns the same order, creates no second link and keeps the first link working", async () => {
    const a = await publishedSku(2);
    const k = key();
    const first = await placeGuestOrder(db, k, request([line(a)]));
    const before = await counts();
    const retry = await placeGuestOrder(db, k, request([line(a)]));
    expect(retry).toMatchObject({ replayed: true, trackingToken: null, order: { reference: first.order.reference } });
    expect(await counts()).toEqual(before);
    expect(await reserved(a.variantId)).toBe(1);
    expect((await guestView(db, first.trackingToken))?.reference).toBe(first.order.reference);
    // A cosmetic difference that normalises to the same order is the same request.
    expect((await placeGuestOrder(db, k, request([{ ...line(a), sku: ` ${a.sku.toLowerCase()} ` }]))).replayed).toBe(true);
  });

  it("the same key with a different request is refused and changes nothing", async () => {
    const a = await publishedSku(3);
    const k = key();
    await placeGuestOrder(db, k, request([line(a)]));
    const before = await counts();
    expect(await errorCodeOf(placeGuestOrder(db, k, request([line(a, 2)])))).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await errorCodeOf(placeGuestOrder(db, k, request([line(a)], { customer: { ...CUSTOMER, name: "Another Tester" } })))).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await counts()).toEqual(before);
    expect(await reserved(a.variantId)).toBe(1);
  });

  it("two customers racing for the last unit: exactly one order, the other refused with nothing left behind", async () => {
    const a = await publishedSku(1);
    const before = await counts();
    const outcomes = await race("select 1 from inventory_balances where variant_id = $1 for update", a.variantId, (racing) => [placeGuestOrder(racing, key(), request([line(a)])), placeGuestOrder(racing, key(), request([line(a)]))], 2);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok).map((o) => (o as { error: { code?: string } }).error.code)).toEqual(["INSUFFICIENT_STOCK"]);
    expect(await counts()).toMatchObject({ orders: before.orders + 1, submissions: before.submissions + 1, tokens: before.tokens + 1 });
    expect(await reserved(a.variantId)).toBe(1);
  });

  it("a retry while the first attempt is still in its transaction waits, then replays the one order", async () => {
    const a = await publishedSku(2);
    const k = key();
    const before = await counts();
    // The first attempt blocks on the stock row after claiming the key; the retry blocks on the claimed key.
    const outcomes = await race("select 1 from inventory_balances where variant_id = $1 for update", a.variantId, (racing) => [placeGuestOrder(racing, k, request([line(a)])), placeGuestOrder(racing, k, request([line(a)]))], 2);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    const values = outcomes.map((o) => (o as { value: { replayed: boolean; order: { reference: string }; trackingToken: string | null } }).value);
    expect(values.map((v) => v.replayed).sort()).toEqual([false, true]);
    expect(new Set(values.map((v) => v.order.reference)).size).toBe(1);
    expect(values.filter((v) => v.trackingToken !== null)).toHaveLength(1);
    expect(await counts()).toMatchObject({ orders: before.orders + 1, submissions: before.submissions + 1, tokens: before.tokens + 1 });
    expect(await reserved(a.variantId)).toBe(1);
  });

  it("a two-SKU order with one short line creates no order, hold, link or submission", async () => {
    const a = await publishedSku(5);
    const b = await publishedSku(1);
    const before = await counts();
    expect(await errorCodeOf(placeGuestOrder(db, key(), request([line(a, 2), line(b, 2)])))).toBe("INSUFFICIENT_STOCK");
    expect(await counts()).toEqual(before);
    expect([await reserved(a.variantId), await reserved(b.variantId)]).toEqual([0, 0]);
  });

  it("refuses when a price, the stock or the delivery charge changed after the cart was shown", async () => {
    const a = await publishedSku(2, 40_000);
    const shown = request([line(a)]);
    // A published product's price cannot change: withdraw, edit, review and publish again.
    await withdrawNow(db, owner, a.productId);
    await updateVariant(db, a.variantId, 1, { pricePaisa: 45_000 });
    await publishNow(db, owner, a.productId);
    const before = await counts();
    expect(await errorCodeOf(placeGuestOrder(db, key(), shown))).toBe("QUOTE_CHANGED");
    expect(await counts()).toEqual(before);
    expect(await reserved(a.variantId)).toBe(0);

    const b = await publishedSku(1);
    const forB = request([line(b)]);
    await placeGuestOrder(db, key(), request([line(b)]));
    expect(await errorCodeOf(placeGuestOrder(db, key(), forB))).toBe("INSUFFICIENT_STOCK");

    const c = await publishedSku(2);
    const forC = request([line(c)]);
    await setZone("dhaka_city", DHAKA + 1_000, true);
    try {
      expect(await errorCodeOf(placeGuestOrder(db, key(), forC))).toBe("QUOTE_CHANGED");
      await setZone("dhaka_city", DHAKA, false);
      expect(await errorCodeOf(placeGuestOrder(db, key(), forC))).toBe("DELIVERY_ZONE_UNAVAILABLE");
    } finally {
      await setZone("dhaka_city", DHAKA, true);
    }
    expect(await reserved(c.variantId)).toBe(0);
    // The client's numbers are never used: the right ones go through.
    expect((await placeGuestOrder(db, key(), forC)).order.totalPaisa).toBe(c.pricePaisa + DHAKA);
  });

  it("orders only active SKUs of published products; draft, withdrawn, inactive and unknown SKUs get one answer", async () => {
    const draft = await publishedSku(2, 50_000, false);
    const before = await counts();
    const refusals = [];
    refusals.push(await errorCodeOf(placeGuestOrder(db, key(), request([line(draft)]))));
    const a = await publishedSku(2);
    await withdrawNow(db, owner, a.productId);
    await updateProduct(db, a.productId, 3, { careEn: "Fictional care text." }); // created 1, published 2, withdrawn 3
    refusals.push(await errorCodeOf(placeGuestOrder(db, key(), request([line(a)]))));
    refusals.push(await errorCodeOf(placeGuestOrder(db, key(), request([{ sku: "GUEST-UNKNOWN", quantity: 1, unitPricePaisa: 1 }]))));
    const inactive = await publishedSku(2);
    await pool.query("update variants set status = 'inactive' where id = $1", [inactive.variantId]);
    refusals.push(await errorCodeOf(placeGuestOrder(db, key(), request([line(inactive)]))));
    expect(refusals).toEqual(Array(4).fill("VARIANT_NOT_ORDERABLE"));
    const { orders, submissions, tokens, holds } = before;
    expect(await counts()).toMatchObject({ orders, submissions, tokens, holds });
    // Published again after its review: orderable.
    await publishNow(db, owner, a.productId);
    expect((await placeGuestOrder(db, key(), request([line(a)]))).replayed).toBe(false);
  });

  it("rolls everything back when the database fails mid-transaction, and the same key then works", async () => {
    const a = await publishedSku(2);
    const k = key();
    const before = await counts();
    expect(await errorCodeOf(withFailingInserts(pool, "order_tracking_tokens", () => placeGuestOrder(db, k, request([line(a)]))))).toBe("P0001");
    expect(await counts()).toEqual(before);
    expect(await reserved(a.variantId)).toBe(0);
    const retried = await placeGuestOrder(db, k, request([line(a)]));
    expect(retried.replayed).toBe(false);
    expect(retried.trackingToken).not.toBeNull();
  });

  it("a committed submission can never be changed or deleted", async () => {
    const a = await publishedSku(1);
    await placeGuestOrder(db, key(), request([line(a)]));
    await expect(pool.query("update guest_checkout_submissions set request_mac = repeat('0', 64)")).rejects.toThrow(/not allowed/);
    await expect(pool.query("update guest_checkout_submissions set order_id = null")).rejects.toThrow(/not allowed/);
    await expect(pool.query("delete from guest_checkout_submissions")).rejects.toThrow(/not allowed/);
    await expect(pool.query("truncate guest_checkout_submissions")).rejects.toThrow(/append-only/);
  });
});

describe("guest checkout transport (unrouted, test harness only)", () => {
  const open = () => ({ open: true });
  const post = (body: unknown, headers: Record<string, string> = {}, gate = open) =>
    guestCheckoutResponse(
      new Request(`${BASE}/checkout`, { method: "POST", headers: { origin: BASE, "content-type": "application/json", "idempotency-key": key(), ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }),
      { db, baseUrl: BASE, gate },
    );

  it("with the real launch gate, refuses before reading anything, whatever the policy state", async () => {
    const a = await publishedSku(1);
    const before = await counts();
    const reviewed = { delivery: "reviewed", returns: "reviewed", privacy: "reviewed", checkout_notices: "reviewed" } as const;
    const realGate = () => publicCheckoutGate({ policies: reviewed, deliveryZonesConfigured: true, reviewedProducts: 1 });
    const response = await post(request([line(a)]), {}, realGate);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "checkout_closed" });
    expect(await counts()).toEqual(before);
  });

  it("creates the order once over HTTP: 201 with the token, then 200 replayed without it", async () => {
    const a = await publishedSku(2);
    const k = key();
    const first = await post(request([line(a)]), { "idempotency-key": k });
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("referrer-policy")).toBe("no-referrer");
    expect(first.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await first.json()) as { data: { trackingToken: string | null; order: { reference: string } } };
    expect(body.data.trackingToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const replay = await post(request([line(a)]), { "idempotency-key": `"${k}"` });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(((await replay.json()) as { data: { trackingToken: string | null } }).data.trackingToken).toBeNull();
  });

  it("refuses other origins, media types, missing keys, oversized and malformed bodies, and other methods", async () => {
    const a = await publishedSku(1);
    const before = await counts();
    expect((await post(request([line(a)]), { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(request([line(a)]), { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(request([line(a)]), { "idempotency-key": "too-short" })).status).toBe(400);
    expect((await post(`{"customer":"${"x".repeat(70_000)}"}`)).status).toBe(413);
    expect((await post("{not json")).status).toBe(400);
    const get = await guestCheckoutResponse(new Request(`${BASE}/checkout`, { method: "GET" }), { db, baseUrl: BASE, gate: open });
    expect(get.status).toBe(405);
    expect(await counts()).toEqual(before);
  });

  it("answers validation and business failures with field names and fixed messages, never the customer's data", async () => {
    const a = await publishedSku(1);
    const invalid = await post(request([line(a)], { customer: { ...CUSTOMER, phone: "12345" } }));
    expect(invalid.status).toBe(400);
    const text = await invalid.text();
    expect(text).toContain("customer.phone");
    expect(text).not.toMatch(/Guest Tester|12345|House 5/);
    const changed = await post(request([{ ...line(a), unitPricePaisa: a.pricePaisa - 1 }], { totalPaisa: a.pricePaisa - 1 + DHAKA }));
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: "quote_changed" });
  });

  it("accepts at most GUEST_CHECKOUTS_PER_MINUTE well-formed submissions a minute from everyone together", async () => {
    const a = await publishedSku(3);
    await pool.query("delete from tracking_rate_limits where bucket = 'checkout'");
    // Malformed requests are refused before the counter and do not use it up.
    for (let i = 0; i < 3; i += 1) expect((await post("{not json")).status).toBe(400);
    // Well-formed JSON that fails the field checks does not count either.
    for (let i = 0; i < 3; i += 1) expect((await post({})).status).toBe(400);
    for (let i = 0; i < 3; i += 1) expect((await post({})).status).toBe(400);
    expect(await count(pool, "select count(*) from tracking_rate_limits where bucket = 'checkout'")).toBe(0);
    await pool.query("insert into tracking_rate_limits (bucket, window_start, count) values ('checkout', date_trunc('minute', now()), $1)", [GUEST_CHECKOUTS_PER_MINUTE - 1]);
    const before = await counts();
    const last = await post(request([line(a)]));
    expect(last.status).toBe(201);
    const limited = await post(request([line(a)]));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(await limited.json()).toMatchObject({ error: "rate_limited" });
    expect(await counts()).toMatchObject({ orders: before.orders + 1, holds: before.holds + 1 });
    await pool.query("delete from tracking_rate_limits where bucket = 'checkout'");
  });

  it("an unexpected failure says the order was not recorded and logs no customer data or token", async () => {
    const a = await publishedSku(1);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await withFailingInserts(pool, "orders", () => post(request([line(a)])));
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: "internal" });
      const logged = log.mock.calls.flat().join(" ");
      expect(logged).toContain("guest_checkout_failed");
      expect(logged).not.toMatch(/Guest Tester|01711|House 5|GUEST-/);
    } finally {
      log.mockRestore();
    }
  });
});
