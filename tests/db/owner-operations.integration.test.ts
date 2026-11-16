import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import readXlsxFile from "read-excel-file/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/database";
import type { Principal } from "../../src/modules/auth/principal";
import { countExportRows, createExport, validateExport } from "../../src/modules/exports/service";
import { getStockCount, parseSkuList } from "../../src/modules/inventory/counts";
import { applyStockCountOnce, discardStockCountOnce, recordCountsOnce, startStockCountOnce } from "../../src/modules/inventory/operations";
import { getStockLevel, receiveStock } from "../../src/modules/inventory/service";
import {
  cancelOrderOnce,
  confirmOrderOnce,
  dispatchOrderOnce,
  markRtoOnce,
  packOrderOnce,
  receiveRtoOnce,
  recordPaymentOnce,
  setDeliveryZoneOnce,
  submitOrderOnce,
} from "../../src/modules/orders/operations";
import { getOrderDetail, listOrders } from "../../src/modules/orders/queries";
import { dhakaToday } from "../../src/modules/orders/rules";
import { getDashboard } from "../../src/modules/reports/dashboard";
import { getPickingList } from "../../src/modules/reports/picking";
import { getCodReconciliation, getPeriodReport } from "../../src/modules/reports/summary";
import { clearAuthState, count, createTestAuth, createVerifiedOwner } from "../support/auth";
import { createTestVariant, TEST_ACTOR } from "../support/fixtures";
import { createTestDb } from "../support/test-database";

// Owner operations against PostgreSQL: dashboard and reports (exact paisa, Dhaka date boundaries, no double
// counting), exports (permission, audit, snapshot consistency under concurrent writes, real XLSX) and physical
// stock counts (every acceptance case of requirement I-8). Fictional data only.

let db: Db;
let pool: Pool;
let owner: Principal;

const CUSTOMER = { customerName: "Test Customer", customerPhone: "01711000099", deliveryAddress: "House 1, Road 2, Test Area", deliveryZone: "dhaka_city" as const };
const key = () => randomUUID();
const today = dhakaToday();

beforeAll(async () => {
  ({ db, pool } = await createTestDb(8));
  const auth = createTestAuth(db);
  await clearAuthState(pool);
  ({ principal: owner } = await createVerifiedOwner(auth, db, pool, "ops-owner@example.test"));
  await pool.query("delete from auth_rate_limits");
  const zones = await pool.query<{ code: string; version: number }>("select code, version from delivery_zones");
  const version = (code: string) => zones.rows.find((z) => z.code === code)?.version ?? null;
  await setDeliveryZoneOnce(db, owner, key(), { code: "dhaka_city", chargePaisa: 6_000, active: true, expectedVersion: version("dhaka_city") });
  await setDeliveryZoneOnce(db, owner, key(), { code: "outside_dhaka", chargePaisa: 12_000, active: true, expectedVersion: version("outside_dhaka") });
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  // Global invariants, checked between tests: reserved matches the active holds and on-hand equals the ledger.
  expect(
    await count(pool, `select count(*) from inventory_balances b
       where b.reserved <> coalesce((select sum(quantity) from stock_reservations r where r.variant_id = b.variant_id and r.status = 'active'), 0)
          or b.reserved > b.on_hand
          or b.on_hand <> coalesce((select sum(quantity_delta) from stock_movements m where m.variant_id = b.variant_id), 0)`),
  ).toBe(0);
});

async function newSku(stock: number) {
  const { variant } = await createTestVariant(db, "ownops");
  if (stock > 0) await receiveStock(db, { sku: variant.sku, quantity: stock, actor: TEST_ACTOR });
  return { sku: variant.sku, variantId: variant.id };
}

const submit = (items: { sku: string; quantity: number }[], source: "whatsapp" | "messenger" = "whatsapp") =>
  submitOrderOnce(db, owner, key(), { source, ...CUSTOMER, items }).then((r) => r.value);
const v = async (orderId: string) => (await getOrderDetail(db, orderId)).version;
const step = async (op: (db: Db, p: Principal, k: string, i: { orderId: string; expectedVersion: number }) => Promise<unknown>, orderId: string) =>
  op(db, owner, key(), { orderId, expectedVersion: await v(orderId) });
const pay = async (orderId: string, kind: "collected" | "settled", amountPaisa: number) =>
  recordPaymentOnce(db, owner, key(), { orderId, expectedVersion: await v(orderId), kind, amountPaisa, occurredOn: today });

async function dispatched(items: { sku: string; quantity: number }[]) {
  const order = await submit(items);
  await step(confirmOrderOnce, order.id);
  await step(packOrderOnce, order.id);
  await step(dispatchOrderOnce, order.id);
  return order.id;
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of chunks) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}

describe("period report and COD reconciliation", () => {
  it("counts a multi-item order once, keeps partial payments exact and reconciles entries with orders", async () => {
    const a = await newSku(10);
    const b = await newSku(10);
    const range = { from: today, to: today };
    const before = await getPeriodReport(db, range);

    const id = await dispatched([
      { sku: a.sku, quantity: 2 },
      { sku: b.sku, quantity: 1 },
    ]);
    const total = (await getOrderDetail(db, id)).totalPaisa; // 3 × 850 BDT + 60 BDT delivery
    expect(total).toBe(3 * 85_000 + 6_000);
    await pay(id, "collected", 100_001);
    await pay(id, "collected", total - 100_001);
    await pay(id, "settled", 50_000);
    const cancelled = await submit([{ sku: a.sku, quantity: 1 }], "messenger");
    await step(cancelOrderOnce, cancelled.id);

    const after = await getPeriodReport(db, range);
    expect(after.received.total.count - before.received.total.count).toBe(2);
    expect(after.received.total.amountPaisa - before.received.total.amountPaisa).toBe(total + 85_000 + 6_000);
    expect((after.received.bySource.messenger?.count ?? 0) - (before.received.bySource.messenger?.count ?? 0)).toBe(1);
    expect((after.received.byOrderStatus.cancelled?.count ?? 0) - (before.received.byOrderStatus.cancelled?.count ?? 0)).toBe(1);
    expect(after.money.collected.amountPaisa - before.money.collected.amountPaisa).toBe(total);
    expect(after.money.collected.count - before.money.collected.count).toBe(2);
    expect(after.money.settled.amountPaisa - before.money.settled.amountPaisa).toBe(50_000);
    expect(after.stock.dispatches.amountPaisa - before.stock.dispatches.amountPaisa).toBe(-3);
    // Equation: collected − settled = held by the courier; entries agree with the running totals.
    const o = after.outstanding;
    expect(o.reconciled).toBe(true);
    expect(o.heldByCourier.amountPaisa).toBe(o.ledger.collectedPaisa - o.ledger.settledPaisa - o.ledger.deductedPaisa);
    expect(o.heldByCourier.amountPaisa - before.outstanding.heldByCourier.amountPaisa).toBe(total - 50_000);

    const cod = await getCodReconciliation(db);
    const row = cod.rows.find((r) => r.id === id);
    expect(row).toMatchObject({ totalPaisa: total, collectedPaisa: total, settledPaisa: 50_000, awaitingCollectionPaisa: 0, heldByCourierPaisa: total - 50_000 });
    expect(JSON.stringify(cod.rows)).not.toContain(CUSTOMER.customerPhone);
  });

  it("includes the last instant of the end date and nothing of the next day (Dhaka time)", async () => {
    const s = await newSku(5);
    const lastOfJanuary = await submit([{ sku: s.sku, quantity: 1 }]);
    const firstOfFebruary = await submit([{ sku: s.sku, quantity: 1 }]);
    // 31 Jan 2031 23:59:59.999 and 1 Feb 2031 00:00:00.000 in Dhaka (test database only).
    await pool.query("update orders set created_at = '2031-01-31T17:59:59.999Z' where id = $1", [lastOfJanuary.id]);
    await pool.query("update orders set created_at = '2031-01-31T18:00:00.000Z' where id = $1", [firstOfFebruary.id]);
    const january = await getPeriodReport(db, { from: "2031-01-01", to: "2031-01-31" });
    const february = await getPeriodReport(db, { from: "2031-02-01", to: "2031-02-28" });
    expect(january.received.total.count).toBe(1);
    expect(february.received.total.count).toBe(1);
    const filtered = validateExport({ dataset: "orders", format: "json", filters: { from: "2031-01-31", to: "2031-01-31" } });
    expect(await countExportRows(db, filtered)).toBe(1);
  });
});

describe("dashboard", () => {
  it("shows each work queue from the same definition as the order list, and zero-available SKUs", async () => {
    const s = await newSku(1);
    const order = await submit([{ sku: s.sku, quantity: 1 }]);
    await step(confirmOrderOnce, order.id);
    const d = await getDashboard(db, { lowStockThreshold: 3 });
    const toPack = d.queues.find((q) => q.queue === "to_pack");
    const listed = await listOrders(db, { limit: 100, queue: "to_pack" });
    expect(toPack?.count).toBeGreaterThanOrEqual(1);
    expect(listed.items.some((o) => o.id === order.id)).toBe(true);
    expect(toPack?.count).toBe(await count(pool, "select count(*) from orders where order_status = 'confirmed' and fulfilment_status = 'unfulfilled'"));
    expect(d.stock.zeroAvailable.items.some((i) => i.sku === s.sku) || d.stock.zeroAvailable.count > d.stock.zeroAvailable.items.length).toBe(true);
    expect(d.stock.low?.threshold).toBe(3);
    expect(d.unconfiguredZones).toEqual([]);
    const picking = await getPickingList(db);
    expect(picking.orders.some((o) => o.id === order.id)).toBe(true);
    expect(JSON.stringify(picking)).not.toContain(CUSTOMER.customerPhone);
    expect(JSON.stringify(picking)).not.toContain(CUSTOMER.deliveryAddress);
  });
});

describe("exports", () => {
  it("requires a verified principal and records every request with safe metadata only", async () => {
    const fake = Object.freeze({ userId: "00000000-0000-0000-0000-000000000000", role: "owner" as const });
    await expect(createExport(db, fake, { dataset: "orders", format: "csv", filters: {} })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const audits = await count(pool, "select count(*) from export_requests");
    const file = await createExport(db, owner, { dataset: "orders", format: "csv", filters: { source: "whatsapp", from: "2020-01-01", to: "2020-12-31" } });
    await collect(file.chunks);
    expect(await count(pool, "select count(*) from export_requests")).toBe(audits + 1);
    const { rows } = await pool.query("select actor_user_id, dataset, format, scope, filters from export_requests order by id desc limit 1");
    expect(rows[0]).toEqual({ actor_user_id: owner.userId, dataset: "orders", format: "csv", scope: "filtered", filters: { source: "whatsapp", from: "2020-01-01", to: "2020-12-31" } });
    expect(file.filename).toMatch(/^orders-filtered-\d{8}-\d{6}Z\.csv$/);
    await expect(pool.query("delete from export_requests")).rejects.toThrow(/append-only/);
  });

  it("exports every matching row (not a page), with Bangla text, text phone numbers and exact amounts in XLSX", async () => {
    const s = await newSku(3);
    const order = await submit([{ sku: s.sku, quantity: 2 }]);
    const file = await createExport(db, owner, { dataset: "orders", format: "xlsx", filters: {} });
    const sheets = await readXlsxFile(await collect(file.chunks));
    const [header, ...rows] = sheets[0].data;
    expect(rows).toHaveLength(await count(pool, "select count(*) from orders"));
    const row = rows.find((r) => r[header.indexOf("order_id")] === order.id) as unknown[];
    expect(row[header.indexOf("customer_phone")]).toBe("01711000099");
    expect(row[header.indexOf("total_paisa")]).toBe(2 * 85_000 + 6_000);
    expect(row[header.indexOf("items_total_paisa")]).toBe(row[header.indexOf("subtotal_paisa")]);
    expect(sheets[1].data.find((r) => r[0] === "Scope")?.[1]).toBe("Complete export (every record)");

    const items = await createExport(db, owner, { dataset: "order_items", format: "json", filters: {} });
    const parsed = JSON.parse((await collect(items.chunks)).toString("utf8"));
    const line = parsed.records.find((r: { order_id: string }) => r.order_id === order.id);
    expect(line).toMatchObject({ sku: s.sku, product_name_bn: "পরীক্ষামূলক রম্পার", unit_price_paisa: 85_000, quantity: 2, line_total_paisa: 170_000 });
    expect(parsed).toMatchObject({ schemaVersion: 1, dataset: "order_items", scope: "complete", timeZone: "Asia/Dhaka" });
    expect(Date.parse(parsed.createdAt)).not.toBeNaN();
  });

  it("never contains credentials: no session, password or tracking-token data in any dataset", async () => {
    const secrets = await pool.query<{ v: string }>(
      "select token as v from auth_sessions union all select password from auth_accounts where password is not null union all select token_hash from order_tracking_tokens",
    );
    for (const dataset of ["orders", "order_events", "export_requests", "payments", "delivery_zones"]) {
      const text = (await collect((await createExport(db, owner, { dataset, format: "json", filters: {} })).chunks)).toString("utf8");
      for (const { v: secret } of secrets.rows) expect(text).not.toContain(secret);
    }
  });

  it("reads one snapshot: rows committed while the export is being read are not in it", async () => {
    const s = await newSku(0);
    // 1,200 fictional receipt rows (more than two cursor batches), straight into the test database.
    await pool.query(
      `with ins as (insert into stock_movements (variant_id, movement_type, quantity_delta, actor_type, actor_ref)
         select $1, 'receipt', 1, 'system', 'integration-test' from generate_series(1, 1200) returning 1)
       update inventory_balances set on_hand = on_hand + (select count(*) from ins) where variant_id = $1`,
      [s.variantId],
    );
    const expected = await count(pool, "select count(*) from stock_movements");
    const file = await createExport(db, owner, { dataset: "stock_movements", format: "json", filters: {} });
    // Read until the first batch of records has arrived: the snapshot is open and the cursor has more to give.
    const head: Buffer[] = [];
    while (!Buffer.concat(head).includes('{"movement_id":')) {
      const next = await file.chunks.next();
      if (next.done) throw new Error("Export ended early.");
      head.push(Buffer.from(next.value));
    }
    const concurrent = await receiveStock(db, { sku: s.sku, quantity: 1, actor: TEST_ACTOR });
    const rest = await collect(file.chunks);
    const parsed = JSON.parse(Buffer.concat([...head, rest]).toString("utf8"));
    expect(parsed.records.length).toBeGreaterThan(1000); // more than one cursor batch
    expect(parsed.records).toHaveLength(expected);
    expect(parsed.records.some((r: { movement_id: number }) => r.movement_id === concurrent.movement.id)).toBe(false);
    expect(await count(pool, "select count(*) from stock_movements")).toBe(expected + 1);
  });

  it("rolls back and releases its connection when the reader stops early", async () => {
    const file = await createExport(db, owner, { dataset: "stock_movements", format: "csv", filters: {} });
    await file.chunks.next();
    await file.chunks.return(undefined);
    expect(await count(pool, "select count(*) from pg_stat_activity where datname = current_database() and state = 'idle in transaction'")).toBe(0);
  });
});

describe("physical stock counts", () => {
  const start = async (skus: string[]) => (await startStockCountOnce(db, owner, key(), { scope: "selected", skus })).value;
  const record = async (countId: string, entries: { variantId: string; counted: number | null; recounted?: boolean }[]) =>
    (await recordCountsOnce(db, owner, key(), { countId, expectedVersion: (await getStockCount(db, countId)).version, entries })).value;
  const apply = async (countId: string, reason: string | null = "Shelf count", k = key()) =>
    (await applyStockCountOnce(db, owner, k, { countId, expectedVersion: (await getStockCount(db, countId)).version, reason })).value;
  const movements = (variantId: string) => count(pool, "select count(*) from stock_movements where variant_id = $1", [variantId]);

  it("applies an exact count with no movement, and positive and negative differences as one adjustment each", async () => {
    const exact = await newSku(5);
    const more = await newSku(5);
    const fewer = await newSku(5);
    const c = await start([exact.sku, more.sku, fewer.sku]);
    expect(c.lines.map((l) => l.snapshotOnHand)).toEqual([5, 5, 5]);
    const before = { exact: await movements(exact.variantId), more: await movements(more.variantId), fewer: await movements(fewer.variantId) };
    await record(c.id, [
      { variantId: exact.variantId, counted: 5 },
      { variantId: more.variantId, counted: 8 },
      { variantId: fewer.variantId, counted: 2 },
    ]);
    const done = await apply(c.id);
    expect(done.status).toBe("applied");
    expect(await movements(exact.variantId)).toBe(before.exact);
    expect(await movements(more.variantId)).toBe(before.more + 1);
    expect(await movements(fewer.variantId)).toBe(before.fewer + 1);
    expect((await getStockLevel(db, more.sku)).onHand).toBe(8);
    expect((await getStockLevel(db, fewer.sku)).onHand).toBe(2);
    const { rows } = await pool.query("select movement_type, quantity_delta, reason, actor_type, actor_user_id from stock_movements where variant_id = $1 order by id desc limit 1", [fewer.variantId]);
    expect(rows[0]).toMatchObject({ movement_type: "adjustment", quantity_delta: -3, actor_type: "user", actor_user_id: owner.userId });
    expect(rows[0].reason).toMatch(/^Stock count COUNT-\d{6}: Shelf count$/);
    expect(done.lines.find((l) => l.variantId === exact.variantId)).toMatchObject({ appliedDelta: 0, movementId: null });
  });

  it("refuses a count below the reserved units, and a multi-SKU count applies all or nothing", async () => {
    const ok = await newSku(5);
    const held = await newSku(5);
    await submit([{ sku: held.sku, quantity: 3 }]); // 3 reserved
    const c = await start([ok.sku, held.sku]);
    await record(c.id, [
      { variantId: ok.variantId, counted: 7 },
      { variantId: held.variantId, counted: 2 },
    ]);
    const before = await movements(ok.variantId);
    await expect(apply(c.id)).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(await movements(ok.variantId)).toBe(before);
    expect((await getStockLevel(db, ok.sku)).onHand).toBe(5);
    expect((await getStockCount(db, c.id)).status).toBe("draft");
    // Counting at least the reserved units is allowed: reserved is untouched, available follows.
    await record(c.id, [{ variantId: held.variantId, counted: 3 }]);
    await apply(c.id);
    expect(await getStockLevel(db, held.sku)).toMatchObject({ onHand: 3, reserved: 3, available: 0 });
    expect((await getStockLevel(db, ok.sku)).onHand).toBe(7);
  });

  it("applies once: a repeated request replays and a second confirmation is refused", async () => {
    const s = await newSku(4);
    const c = await start([s.sku]);
    await record(c.id, [{ variantId: s.variantId, counted: 6 }]);
    const version = (await getStockCount(db, c.id)).version;
    const k = key();
    const first = await applyStockCountOnce(db, owner, k, { countId: c.id, expectedVersion: version, reason: "Recount" });
    const replay = await applyStockCountOnce(db, owner, k, { countId: c.id, expectedVersion: version, reason: "Recount" });
    expect(replay.replayed).toBe(true);
    expect(replay.value.status).toBe(first.value.status);
    await expect(applyStockCountOnce(db, owner, key(), { countId: c.id, expectedVersion: version + 1, reason: "Again" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect((await getStockLevel(db, s.sku)).onHand).toBe(6);
  });

  it("applies once under concurrent confirmations with different keys", async () => {
    const s = await newSku(4);
    const c = await start([s.sku]);
    await record(c.id, [{ variantId: s.variantId, counted: 9 }]);
    const version = (await getStockCount(db, c.id)).version;
    const before = await movements(s.variantId);
    const results = await Promise.allSettled([1, 2, 3].map(() => applyStockCountOnce(db, owner, key(), { countId: c.id, expectedVersion: version, reason: "Race" })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await movements(s.variantId)).toBe(before + 1);
    expect((await getStockLevel(db, s.sku)).onHand).toBe(9);
  });

  it("refuses a stale count after a dispatch, and applies correctly once recounted", async () => {
    const s = await newSku(6);
    const order = await submit([{ sku: s.sku, quantity: 2 }]);
    await step(confirmOrderOnce, order.id);
    await step(packOrderOnce, order.id);
    const c = await start([s.sku]);
    await record(c.id, [{ variantId: s.variantId, counted: 5 }]); // counted against 6 on hand: -1
    await step(dispatchOrderOnce, order.id); // on hand 6 → 4 after the count was entered
    expect((await getStockCount(db, c.id)).lines[0].stale).toBe(true);
    const before = await movements(s.variantId);
    await expect(apply(c.id)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(await movements(s.variantId)).toBe(before);
    // Saving the same number again does not hide the problem; marking it recounted does.
    await record(c.id, [{ variantId: s.variantId, counted: 5 }]);
    expect((await getStockCount(db, c.id)).lines[0].stale).toBe(true);
    await record(c.id, [{ variantId: s.variantId, counted: 3, recounted: true }]); // the shelf now: 3
    await apply(c.id);
    expect((await getStockLevel(db, s.sku)).onHand).toBe(3); // 4 − 1, never 6 → 5 or 5 − 2
  });

  it("is not stale when only reservations change during the count", async () => {
    const s = await newSku(6);
    const c = await start([s.sku]);
    await record(c.id, [{ variantId: s.variantId, counted: 7 }]);
    await submit([{ sku: s.sku, quantity: 2 }]); // a new order reserves 2 while counting
    expect((await getStockCount(db, c.id)).lines[0].stale).toBe(false);
    await apply(c.id);
    expect(await getStockLevel(db, s.sku)).toMatchObject({ onHand: 7, reserved: 2, available: 5 });
  });

  it("keeps an interrupted draft for later, and a discarded count changes nothing", async () => {
    const a = await newSku(2);
    const b = await newSku(2);
    const c = await start([a.sku, b.sku]);
    await record(c.id, [{ variantId: a.variantId, counted: 1 }]);
    const resumed = await getStockCount(db, c.id);
    expect(resumed.status).toBe("draft");
    expect(resumed.lines.find((l) => l.variantId === a.variantId)?.counted).toBe(1);
    expect(resumed.lines.find((l) => l.variantId === b.variantId)?.counted).toBeNull();
    await record(c.id, [{ variantId: b.variantId, counted: 2 }]);
    const before = (await movements(a.variantId)) + (await movements(b.variantId));
    const discarded = await discardStockCountOnce(db, owner, key(), { countId: c.id, expectedVersion: (await getStockCount(db, c.id)).version });
    expect(discarded.value.status).toBe("discarded");
    expect((await movements(a.variantId)) + (await movements(b.variantId))).toBe(before);
    await expect(record(c.id, [{ variantId: a.variantId, counted: 0 }])).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("never makes quarantined goods sellable", async () => {
    const s = await newSku(3);
    const id = await dispatched([{ sku: s.sku, quantity: 1 }]);
    await step(markRtoOnce, id);
    await step(receiveRtoOnce, id); // 1 unit awaiting inspection, not on hand
    const c = await start([s.sku]);
    expect((await getStockCount(db, c.id)).lines[0]).toMatchObject({ onHandNow: 2, awaitingInspection: 1 });
    await record(c.id, [{ variantId: s.variantId, counted: 2 }]);
    await apply(c.id);
    expect(await getStockLevel(db, s.sku)).toMatchObject({ onHand: 2, available: 2 });
    expect(await count(pool, "select count(*) from quarantine_items where variant_id = $1 and status = 'awaiting_inspection'", [s.variantId])).toBe(1);
  });

  it("validates its input and refuses a stale page", async () => {
    expect(() => parseSkuList(" , ")).toThrow();
    await expect(start(["NO-SUCH-SKU-OPS"])).rejects.toMatchObject({ code: "VARIANT_NOT_FOUND" });
    const s = await newSku(1);
    const c = await start([s.sku]);
    await expect(recordCountsOnce(db, owner, key(), { countId: c.id, expectedVersion: c.version, entries: [{ variantId: s.variantId, counted: -1 }] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await record(c.id, [{ variantId: s.variantId, counted: 1 }]);
    await expect(recordCountsOnce(db, owner, key(), { countId: c.id, expectedVersion: c.version, entries: [] })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await record(c.id, [{ variantId: s.variantId, counted: 4 }]);
    await expect(apply(c.id, null)).rejects.toMatchObject({ code: "INVALID_INPUT" }); // a difference needs a reason
  });
});

