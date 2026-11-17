import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, poolSettingsFor } from "../../src/db/client";
import type { Db } from "../../src/db/database";
import { getPrincipal, type Principal } from "../../src/modules/auth/principal";
import { createProduct, createVariant } from "../../src/modules/catalogue/service";
import { createExport } from "../../src/modules/exports/service";
import { applyStockCountOnce, receiveStockOnce, recordCountsOnce, startStockCountOnce } from "../../src/modules/inventory/operations";
import { runMaintenance } from "../../src/modules/maintenance/jobs";
import { uploadPhotoOnce } from "../../src/modules/media/operations";
import { localMediaStore } from "../../src/modules/media/storage";
import { placeGuestOrder } from "../../src/modules/orders/guest-checkout";
import {
  cancelOrderOnce,
  confirmOrderOnce,
  createTrackingLinkOnce,
  deliverOrderOnce,
  dispatchOrderOnce,
  packOrderOnce,
  recordPaymentOnce,
  setDeliveryZoneOnce,
  submitOrderOnce,
} from "../../src/modules/orders/operations";
import { getOrderDetail } from "../../src/modules/orders/queries";
import { dhakaToday } from "../../src/modules/orders/rules";
import { guestCancel, guestView } from "../../src/modules/orders/tracking";
import { clearAuthState, createTestAuth, createVerifiedOwner, headersWith, signIn } from "../support/auth";
import { tempMediaDir, testImage } from "../support/images";
import { publishNow } from "../support/publication";
import { assertSafeTestDatabaseUrl, createTestDb } from "../support/test-database";

// The application's main paths on a pool of ONE connection (Gate H.45), the size Supabase advises for a serverless function.
// Any code that held a connection (an open transaction) while waiting for a second one would wait for itself; here the
// connect timeout is 2 s, so such a path fails instead of hanging. Passing means: no nested connection use on these
// paths, so a pool of 1 only queues, never deadlocks. Fictional data only.

let pool: Pool;
let single: Pool;
let db: Db;
let owner: Principal;
let cookie: string;
let auth: ReturnType<typeof createTestAuth>;
const key = () => randomUUID();
const tag = `p1${Date.now().toString(36)}`;
const media = tempMediaDir("pool-one");
const CUSTOMER = { customerName: "Test Customer", customerPhone: "+880 1711-000111", deliveryAddress: "House 1, Road 2, Test Area", deliveryZone: "dhaka_city" as const };

beforeAll(async () => {
  ({ pool } = await createTestDb(2));
  const url = assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  single = createPool(url, { ...poolSettingsFor(url, { DATABASE_RUNTIME: "serverless", DATABASE_POOL_MAX: "1" }), connectionTimeoutMillis: 2_000 });
  expect(single.options.max).toBe(1);
  db = drizzle({ client: single });
  await clearAuthState(pool);
  // Sign-in, its audit hooks and session verification all through the one connection.
  auth = createTestAuth(db);
  ({ principal: owner, cookie } = await createVerifiedOwner(auth, db, pool, "pool-one-owner@example.test"));
  const zones = await pool.query<{ code: string; version: number }>("select code, version from delivery_zones");
  for (const [code, charge] of [["dhaka_city", 6_000], ["outside_dhaka", 12_000]] as const) {
    await setDeliveryZoneOnce(db, owner, key(), { code, chargePaisa: charge, active: true, expectedVersion: zones.rows.find((z) => z.code === code)?.version ?? null });
  }
});

afterAll(async () => {
  // Photo records point at a throwaway folder; other test files check the whole manifest.
  await pool?.query("delete from product_media where product_id in (select id from products where slug like $1)", [`${tag}-%`]);
  media.cleanup();
  await single?.end();
  await pool?.end();
});

async function sku(stock: number, publish = false) {
  const slug = `${tag}-${Math.random().toString(36).slice(2, 8)}`;
  const product = await createProduct(db, { slug, nameEn: "Pool Romper", nameBn: "রম্পার", descriptionEn: "Fictional.", descriptionBn: "কাল্পনিক।" });
  const variant = await createVariant(db, { productId: product.id, sku: slug.toUpperCase(), size: "0-3M", colour: "Ivory", pricePaisa: 50_000 });
  if (stock) await receiveStockOnce(db, owner, key(), { sku: variant.sku, quantity: stock });
  if (publish) await publishNow(db, owner, product.id);
  return { productId: product.id, variantId: variant.id, sku: variant.sku };
}
const v = async (orderId: string) => (await getOrderDetail(db, orderId)).version;

describe("the detector", () => {
  it("control: code that holds a transaction while asking the pool for a second connection fails here (as H.44's maintenance lock did)", async () => {
    const { sql } = await import("drizzle-orm");
    const failure = await db.transaction(async () => db.execute(sql`select 1`)).then(() => null, (error: Error) => error);
    expect(String((failure?.cause as Error | undefined)?.message ?? failure?.message)).toMatch(/timeout/i);
  });
});

describe("a pool of one connection never waits for itself", () => {
  it("authentication: sign-in (with its audit) and session checks", async () => {
    const { cookie: again } = await signIn(auth, "pool-one-owner@example.test", "fictional owner long password");
    expect(await getPrincipal(auth, db, headersWith(again))).not.toBeNull();
    expect(await getPrincipal(auth, db, headersWith(cookie))).not.toBeNull();
  });

  it("the whole Owner order lifecycle with COD, and a cancellation", async () => {
    const a = await sku(3);
    const { value } = await submitOrderOnce(db, owner, key(), { source: "whatsapp", ...CUSTOMER, items: [{ sku: a.sku, quantity: 1 }] });
    for (const step of [confirmOrderOnce, packOrderOnce, dispatchOrderOnce, deliverOrderOnce]) await step(db, owner, key(), { orderId: value.id, expectedVersion: await v(value.id) });
    const detail = await getOrderDetail(db, value.id);
    await recordPaymentOnce(db, owner, key(), { orderId: value.id, expectedVersion: detail.version, kind: "collected", amountPaisa: detail.totalPaisa, occurredOn: dhakaToday() });
    const { value: other } = await submitOrderOnce(db, owner, key(), { source: "whatsapp", ...CUSTOMER, items: [{ sku: a.sku, quantity: 1 }] });
    await cancelOrderOnce(db, owner, key(), { orderId: other.id, expectedVersion: await v(other.id) });
    expect((await getOrderDetail(db, other.id)).orderStatus).toBe("cancelled");
  });

  it("an idempotent replay returns the first result", async () => {
    const a = await sku(2);
    const k = key();
    const input = { source: "whatsapp" as const, ...CUSTOMER, items: [{ sku: a.sku, quantity: 1 }] };
    const first = await submitOrderOnce(db, owner, k, input);
    const replay = await submitOrderOnce(db, owner, k, input);
    expect([replay.replayed, replay.value.id]).toEqual([true, first.value.id]);
  });

  it("guest checkout, tracking and guest cancellation", async () => {
    const a = await sku(2, true);
    const result = await placeGuestOrder(db, key(), {
      customer: { name: "Guest Tester", phone: "01711 000 333", address: "House 5, Road 6, Test Town" },
      deliveryZone: "dhaka_city",
      items: [{ sku: a.sku, quantity: 1, unitPricePaisa: 50_000 }],
      deliveryChargePaisa: 6_000,
      totalPaisa: 56_000,
    });
    expect(result.replayed).toBe(false);
    const token = result.trackingToken;
    expect(await guestView(db, token)).not.toBeNull();
    expect(await guestCancel(db, token, "cancel")).not.toBeNull();
  });

  it("a tracking link issued by the Owner", async () => {
    const a = await sku(1);
    const { value } = await submitOrderOnce(db, owner, key(), { source: "whatsapp", ...CUSTOMER, items: [{ sku: a.sku, quantity: 1 }] });
    const link = await createTrackingLinkOnce(db, owner, key(), { orderId: value.id });
    expect(link.value).toBeTruthy();
  });

  it("an overdue hold is released inside a new reservation, and the maintenance run", async () => {
    const a = await sku(1);
    const { value } = await submitOrderOnce(db, owner, key(), { source: "whatsapp", ...CUSTOMER, items: [{ sku: a.sku, quantity: 1 }] });
    await pool.query("update orders set verification_expires_at = now() - interval '1 minute' where id = $1", [value.id]);
    await submitOrderOnce(db, owner, key(), { source: "whatsapp", ...CUSTOMER, items: [{ sku: a.sku, quantity: 1 }] });
    expect((await runMaintenance(db)).status).toBe("ok");
  });

  it("a physical stock count, applied", async () => {
    const a = await sku(4);
    const started = (await startStockCountOnce(db, owner, key(), { scope: "selected", skus: [a.sku] })).value;
    const counted = (await recordCountsOnce(db, owner, key(), { countId: started.id, expectedVersion: started.version, entries: [{ variantId: a.variantId, counted: 3 }] })).value;
    expect((await applyStockCountOnce(db, owner, key(), { countId: counted.id, expectedVersion: counted.version, reason: "fictional recount" })).value.status).toBe("applied");
  });

  it("a photo upload and an export (a cursor inside a transaction)", async () => {
    const a = await sku(0);
    await uploadPhotoOnce(db, owner, key(), { productId: a.productId, expectedVersion: 1, bytes: await testImage("jpeg", 400, 300) }, localMediaStore(media.dir));
    let bytes = 0;
    for await (const chunk of (await createExport(db, owner, { dataset: "orders", format: "csv", filters: {} })).chunks) bytes += chunk.length;
    expect(bytes).toBeGreaterThan(0);
  });
});
