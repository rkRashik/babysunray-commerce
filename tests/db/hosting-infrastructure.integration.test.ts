import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { maintenanceResponse } from "../../src/api/maintenance";
import { publicMediaResponse } from "../../src/api/public-media";
import { createPool, poolSettingsFor } from "../../src/db/client";
import type { Db } from "../../src/db/database";
import type { Principal } from "../../src/modules/auth/principal";
import { createProduct, createVariant } from "../../src/modules/catalogue/service";
import { receiveStock } from "../../src/modules/inventory/service";
import { MAX_RUN_MS, runMaintenance } from "../../src/modules/maintenance/jobs";
import { mediaHealthy, verifyMediaStore } from "../../src/modules/media/manifest";
import { removePhotoOnce, uploadPhotoOnce } from "../../src/modules/media/operations";
import { findPublicPhoto } from "../../src/modules/media/public";
import { localMediaStore, type MediaStore } from "../../src/modules/media/storage";
import { supabaseMediaStore } from "../../src/modules/media/supabase-store";
import { getOrderDetail } from "../../src/modules/orders/queries";
import { setDeliveryZoneOnce, submitOrderOnce } from "../../src/modules/orders/operations";
import { clearAuthState, count, createTestAuth, createVerifiedOwner } from "../support/auth";
import { errorCodeOf, TEST_ACTOR } from "../support/fixtures";
import { FAKE_LEGACY_SERVICE_KEY, fakeSupabase } from "../support/fake-supabase";
import { tempMediaDir, testImage } from "../support/images";
import { publishNow, withdrawNow } from "../support/publication";
import { assertSafeTestDatabaseUrl, createTestDb } from "../support/test-database";

// Hosting-compatibility behaviour (Gate H.44) against babysunray_test: the maintenance run (one at a time, idempotent,
// bounded, independent of scheduling), published-only photo serving, and the order and reservation rules under the
// serverless and transaction-pooler pool settings. Fictional data only; a throwaway media folder; no network.

let db: Db;
let pool: Pool;
let owner: Principal;
let media: { dir: string; cleanup: () => void };
let store: MediaStore;
const key = () => randomUUID();
const tag = `h44${Date.now().toString(36)}`;

beforeAll(async () => {
  ({ db, pool } = await createTestDb(8));
  const auth = createTestAuth(db);
  await clearAuthState(pool);
  ({ principal: owner } = await createVerifiedOwner(auth, db, pool, "hosting-owner@example.test"));
  const zones = await pool.query<{ code: string; version: number }>("select code, version from delivery_zones");
  for (const [code, charge] of [["dhaka_city", 6_000], ["outside_dhaka", 12_000]] as const) {
    await setDeliveryZoneOnce(db, owner, key(), { code, chargePaisa: charge, active: true, expectedVersion: zones.rows.find((z) => z.code === code)?.version ?? null });
  }
  media = tempMediaDir("h44");
  store = localMediaStore(media.dir);
});

afterAll(async () => {
  // Photo records point at a throwaway folder; other test files check the whole manifest.
  await pool?.query("delete from product_media where product_id in (select id from products where slug like $1)", [`${tag}-%`]);
  media?.cleanup();
  await pool?.end();
});

const CUSTOMER = { customerName: "Test Customer", customerPhone: "+880 1711-000044", deliveryAddress: "House 1, Road 2, Test Area", deliveryZone: "dhaka_city" as const };
async function newSku(stock: number) {
  const slug = `${tag}-${Math.random().toString(36).slice(2, 8)}`;
  const product = await createProduct(db, { slug, nameEn: "Hosting Romper", nameBn: "রম্পার", descriptionEn: "Fictional.", descriptionBn: "কাল্পনিক।" });
  const variant = await createVariant(db, { productId: product.id, sku: slug.toUpperCase(), size: "0-3M", colour: "Ivory", pricePaisa: 85_000 });
  if (stock) await receiveStock(db, { sku: variant.sku, quantity: stock, actor: TEST_ACTOR });
  return { productId: product.id, sku: variant.sku };
}
const overdue = (orderId: string) => pool.query("update orders set verification_expires_at = now() - interval '1 minute' where id = $1", [orderId]);
const submit = (sku: string, quantity = 1, d: Db = db) => submitOrderOnce(d, owner, key(), { source: "whatsapp", ...CUSTOMER, items: [{ sku, quantity }] });

describe("the maintenance run", () => {
  it("does the work once, then finds nothing more (replay-safe), and reports counts and no values", async () => {
    const a = await newSku(2);
    const { value } = await submit(a.sku, 2);
    await overdue(value.id);
    const first = await runMaintenance(db);
    expect(first).toMatchObject({ status: "ok", integrityProblems: 0, skipped: [] });
    // The run says how late it was: this order was overdue when it started, and nothing is overdue afterwards.
    expect(first.backlog?.overdueVerifications).toBeGreaterThanOrEqual(1);
    expect(first.backlog?.oldestOverdueMinutes).toBeGreaterThanOrEqual(0);
    expect((await runMaintenance(db)).backlog?.overdueVerifications).toBe(0);
    expect(first.status === "ok" && first.jobs.find((j) => j.job === "verification_expiry")?.count).toBeGreaterThanOrEqual(1);
    expect((await getOrderDetail(db, value.id)).orderStatus).toBe("verification_expired");
    const second = await runMaintenance(db);
    expect(second.status === "ok" && second.jobs.find((j) => j.job === "verification_expiry")?.count).toBe(0);
    expect((await getOrderDetail(db, value.id)).events.filter((e) => e.event === "verification_expired")).toHaveLength(1);
    expect(JSON.stringify(first)).not.toMatch(/Test Customer|1711|House 1/);
  });

  it("needs only one connection at a time: it completes on a pool of one connection (no run-level lock held open)", async () => {
    const single = createPool(assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL), { ...poolSettingsFor(assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL), { DATABASE_POOL_MAX: "1" }), connectionTimeoutMillis: 2_000 });
    try {
      const a = await newSku(1);
      const { value } = await submit(a.sku);
      await overdue(value.id);
      const report = await runMaintenance(drizzle({ client: single }));
      expect(report.status).toBe("ok");
      expect((await getOrderDetail(db, value.id)).orderStatus).toBe("verification_expired");
    } finally {
      await single.end();
    }
  });

  it("many callers at once: every run succeeds and no order is expired twice", async () => {
    const a = await newSku(1);
    const { value } = await submit(a.sku);
    await overdue(value.id);
    const reports = await Promise.all(Array.from({ length: 6 }, () => runMaintenance(db)));
    expect(reports.map((r) => r.status)).toEqual(Array(6).fill("ok"));
    expect(reports.reduce((n, r) => n + (r.jobs.find((j) => j.job === "verification_expiry")?.count ?? 0), 0)).toBeGreaterThanOrEqual(1);
    expect((await getOrderDetail(db, value.id)).events.filter((e) => e.event === "verification_expired")).toHaveLength(1);
    expect(await count(pool, "select count(*) from stock_reservations where order_id = $1 and status = 'active'", [value.id])).toBe(0);
  });

  it("is bounded: after the time budget no further job starts, and the run says so", async () => {
    let calls = 0;
    // The first reading is the start; every later one is past the budget.
    const report = await runMaintenance(db, () => (calls++ === 0 ? 0 : MAX_RUN_MS + 1));
    expect(report).toMatchObject({ status: "failed", skipped: ["verification_expiry", "expired_sessions", "stale_rate_limit_windows", "cdn_reconcile"] });
  });

  it("a failing job is reported by class and SQLSTATE only; the other jobs still run", async () => {
    // Every raw statement the jobs run fails; the lock transaction (a real one) is opened through the same handle.
    const failing = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "execute") return () => Promise.reject(Object.assign(new Error("Failed query: delete from auth_sessions where token = 'topsecret'"), { code: "57014" }));
        return Reflect.get(target, property, receiver);
      },
    }) as Db;
    const report = await runMaintenance(failing);
    expect(report.status).toBe("failed");
    {
      const failed = report.jobs.filter((j) => !j.ok);
      expect(failed.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(report)).not.toMatch(/topsecret|Failed query/);
      expect(failed.every((j) => /57014/.test(j.error ?? ""))).toBe(true);
      expect(report.jobs.some((j) => j.job === "verification_expiry")).toBe(true);
    }
  });

  it("expiry never depends on it running: an overdue hold is released by a new reservation, and confirmation re-checks stock", async () => {
    const a = await newSku(1);
    const { value: first } = await submit(a.sku);
    await overdue(first.id);
    // No maintenance run happened. The last unit is still bookable.
    const { value: second } = await submit(a.sku);
    expect(second.orderStatus).toBe("pending_verification");
    expect((await getOrderDetail(db, first.id)).orderStatus).toBe("verification_expired");
  });

  it("the HTTP wrapper: unauthorised calls change nothing, an authorised one runs, a replay finds no more work", async () => {
    const secret = "Zq8LmW3xT9vB2nR7kD5pC1hY4gF6sJ0aEoUi";
    const env = { MAINTENANCE_SECRET: secret, BETTER_AUTH_SECRET: "k7Qm2Zp9Xv4Rt8Ws3Yb6Nc1Ld5Hf0Gj_aB" };
    const a = await newSku(1);
    const { value } = await submit(a.sku);
    await overdue(value.id);
    const call = (headers: Record<string, string>) => maintenanceResponse(new Request("http://localhost:3000/api/internal/maintenance", { method: "POST", headers }), { db: () => db, env });
    for (const headers of [{} as Record<string, string>, { authorization: "Bearer wrong" }, { authorization: `Bearer ${secret}`, origin: "https://elsewhere.example" }]) expect((await call(headers)).status).toBeGreaterThanOrEqual(401);
    expect((await getOrderDetail(db, value.id)).orderStatus).toBe("pending_verification");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ok = await call({ authorization: `Bearer ${secret}` });
    expect(ok.status).toBe(200);
    expect((await getOrderDetail(db, value.id)).orderStatus).toBe("verification_expired");
    const replay = await (await call({ authorization: `Bearer ${secret}` })).json();
    expect(replay.jobs.find((j: { job: string }) => j.job === "verification_expiry").count).toBe(0);
    vi.restoreAllMocks();
  });
});

describe("published-only photo serving", () => {
  const closed = () => ({ open: false });
  const open = () => ({ open: true });
  const request = (query = "") => new Request(`http://localhost:3000/media/x${query}`);
  const spy = () => {
    const reads: string[] = [];
    return { reads, store: () => ({ ...store, read: async (k: string) => (reads.push(k), store.read(k)) }) as MediaStore };
  };

  async function productWithPhoto() {
    const a = await newSku(1);
    const bytes = await testImage("jpeg", 800, 600);
    const { value } = await uploadPhotoOnce(db, owner, key(), { productId: a.productId, expectedVersion: 1, bytes, altEn: "Fictional photo" }, store);
    return { productId: a.productId, mediaId: value.media[0].id };
  }

  it("a draft product's photo is never found, served or read from storage, though the file exists", async () => {
    const { mediaId } = await productWithPhoto();
    const s = spy();
    expect(await findPublicPhoto(db, mediaId)).toBeNull();
    const response = await publicMediaResponse(request(), mediaId, { db: () => db, store: s.store, gate: open });
    expect(response.status).toBe(404);
    expect(s.reads).toEqual([]);
  });

  it("a published product's photo is served with image headers; withdrawing it hides it again at once", async () => {
    const { productId, mediaId } = await productWithPhoto();
    await publishNow(db, owner, productId);
    const s = spy();
    const response = await publicMediaResponse(request(), mediaId, { db: () => db, store: s.store, gate: open });
    expect([response.status, response.headers.get("content-type"), response.headers.get("x-content-type-options"), response.headers.get("cache-control")]).toEqual([200, "image/jpeg", "nosniff", "no-store"]);
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(100);
    const small = await publicMediaResponse(request("?w=320"), mediaId, { db: () => db, store: s.store, gate: open });
    expect(small.status).toBe(200);
    await withdrawNow(db, owner, productId);
    const after = spy();
    expect((await publicMediaResponse(request(), mediaId, { db: () => db, store: after.store, gate: open })).status).toBe(404);
    expect(after.reads).toEqual([]);
  });

  it("the real launch gate is closed: 503 before any database or storage work", async () => {
    const { productId, mediaId } = await productWithPhoto();
    await publishNow(db, owner, productId);
    const s = spy();
    const query = vi.spyOn(pool, "query");
    const response = await publicMediaResponse(request(), mediaId, { db: () => db, store: s.store, gate: closed });
    expect(response.status).toBe(503);
    expect(s.reads).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    query.mockRestore();
  });

  it("unknown, malformed and injected ids, other methods and odd queries all get a plain refusal", async () => {
    const { productId, mediaId } = await productWithPhoto();
    await publishNow(db, owner, productId);
    const s = spy();
    const deps = { db: () => db, store: s.store, gate: open };
    for (const id of [randomUUID(), "not-a-uuid", "../../etc/passwd", `${mediaId}' or '1'='1`, ""]) expect((await publicMediaResponse(request(), id, deps)).status).toBe(404);
    expect((await publicMediaResponse(new Request("http://localhost:3000/media/x", { method: "POST" }), mediaId, deps)).status).toBe(405);
    for (const query of ["?w=999", "?w=abc", "?w=320&w=640", "?x=1"]) expect((await publicMediaResponse(request(query), mediaId, deps)).status).toBe(400);
    expect(s.reads).toEqual([]);
  });

  it("a missing file or an unreachable store never exposes details", async () => {
    const { productId, mediaId } = await productWithPhoto();
    await publishNow(db, owner, productId);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = { ...store, read: async () => Promise.reject(new Error("connect ECONNREFUSED https://project.example.test key=secret")) } as MediaStore;
    const response = await publicMediaResponse(request(), mediaId, { db: () => db, store: () => broken, gate: open });
    expect([response.status, await response.text()]).toEqual([500, ""]);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/ECONNREFUSED|project\.example|secret/);
    const missing = { ...store, read: async () => null } as MediaStore;
    expect((await publicMediaResponse(request(), mediaId, { db: () => db, store: () => missing, gate: open })).status).toBe(404);
    vi.restoreAllMocks();
  });
});

describe("photo operations on a cloud store (Supabase Storage, mocked)", () => {
  const cloud = () => {
    const server = fakeSupabase();
    return { server, cloudStore: supabaseMediaStore({ origin: "https://project.example.test", bucket: "photos", serviceKey: FAKE_LEGACY_SERVICE_KEY }, server.fetch, 0) };
  };

  it("upload, replacement and removal keep records and objects in step, and the manifest check passes", async () => {
    const { server, cloudStore } = cloud();
    const a = await newSku(0);
    const first = (await uploadPhotoOnce(db, owner, key(), { productId: a.productId, expectedVersion: 1, bytes: await testImage("png", 500, 400) }, cloudStore)).value;
    expect(server.objects.size).toBe(1);
    const old = first.media[0];
    const replaced = (await uploadPhotoOnce(db, owner, key(), { productId: a.productId, expectedVersion: first.version, bytes: await testImage("jpeg", 500, 400), replaceMediaId: old.id }, cloudStore)).value;
    // The replaced object is deleted only after its record is gone; the new one has a new random key.
    expect([...server.objects.keys()]).toEqual([replaced.media[0].storageKey]);
    expect(replaced.media[0].storageKey).not.toBe(old.storageKey);
    const check = await verifyMediaStore(db, cloudStore);
    // The test database holds other tests' photo records (not in this fresh bucket); only this product's matter here.
    const mine = replaced.media[0].storageKey;
    expect([check.ok, check.missing.includes(mine), check.changed.includes(mine), check.unreferenced, check.unexpected]).toEqual([1, false, false, [], []]);
    await removePhotoOnce(db, owner, key(), { productId: a.productId, mediaId: replaced.media[0].id, expectedVersion: replaced.version }, cloudStore);
    expect(server.objects.size).toBe(0);
  });

  it("the manifest check finds an object that was lost or changed in the bucket", async () => {
    const { server, cloudStore } = cloud();
    const a = await newSku(0);
    const { value } = await uploadPhotoOnce(db, owner, key(), { productId: a.productId, expectedVersion: 1, bytes: await testImage("webp", 500, 400) }, cloudStore);
    const storageKey = value.media[0].storageKey;
    const stored = server.objects.get(storageKey)!;
    server.objects.set(storageKey, { ...stored, data: Buffer.from("tampered") });
    expect((await verifyMediaStore(db, cloudStore)).changed).toContain(storageKey);
    server.objects.delete(storageKey);
    const lost = await verifyMediaStore(db, cloudStore);
    expect(lost.missing).toContain(storageKey);
    expect(mediaHealthy(lost)).toBe(false);
  });

  it("a storage failure on upload leaves no record and no half-written state", async () => {
    const { server, cloudStore } = cloud();
    server.intercept = () => new Response("{}", { status: 403 });
    const a = await newSku(0);
    await expect(uploadPhotoOnce(db, owner, key(), { productId: a.productId, expectedVersion: 1, bytes: await testImage("jpeg", 500, 400) }, cloudStore)).rejects.toThrow(/status 403/);
    expect(await count(pool, "select count(*) from product_media where product_id = $1", [a.productId])).toBe(0);
    expect(server.objects.size).toBe(0);
  });
});

describe("order and reservation rules under the hosted pool settings", () => {
  const url = () => assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  for (const [name, env] of [
    ["serverless", { DATABASE_RUNTIME: "serverless" }],
    ["transaction pooler", { DATABASE_RUNTIME: "serverless", DATABASE_POOLER: "transaction", DATABASE_POOL_MAX: "5" }],
  ] as const) {
    it(`${name}: the last unit goes to exactly one of several simultaneous orders, and the ledger agrees`, async () => {
      const settings = poolSettingsFor(url(), env);
      const hosted = createPool(url(), settings);
      try {
        const hdb = drizzle({ client: hosted });
        const a = await newSku(1);
        const results = await Promise.allSettled(Array.from({ length: 8 }, () => submit(a.sku, 1, hdb)));
        const wins = results.filter((r) => r.status === "fulfilled");
        expect(wins).toHaveLength(1);
        const codes = await Promise.all(results.filter((r) => r.status === "rejected").map((r) => errorCodeOf(Promise.reject((r as PromiseRejectedResult).reason))));
        expect(new Set(codes)).toEqual(new Set(["INSUFFICIENT_STOCK"]));
        const { rows } = await pool.query("select b.on_hand, b.reserved from inventory_balances b join variants v on v.id = b.variant_id where v.sku = $1", [a.sku]);
        expect(rows[0]).toEqual({ on_hand: 1, reserved: 1 });
        // The statement limit follows the setting: sent at startup directly, left to the role behind a transaction pooler.
        const shown = (await hosted.query<{ statement_timeout: string }>("show statement_timeout")).rows[0].statement_timeout;
        expect(shown).toBe(settings.statementTimeoutMillis === null ? "0" : "1min");
      } finally {
        await hosted.end();
      }
    });
  }

  it("a pool of the smallest allowed size still completes transactions that need two connections at once", async () => {
    const hosted = createPool(url(), poolSettingsFor(url(), { DATABASE_RUNTIME: "serverless", DATABASE_POOL_MAX: "5" }));
    try {
      const hdb = drizzle({ client: hosted });
      const a = await newSku(3);
      const [x, y, z] = await Promise.all([submit(a.sku, 1, hdb), submit(a.sku, 1, hdb), submit(a.sku, 1, hdb)]);
      expect([x, y, z].every((o) => o.value.orderStatus === "pending_verification")).toBe(true);
    } finally {
      await hosted.end();
    }
  });
});
