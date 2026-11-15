import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/database";
import type { Principal } from "../../src/modules/auth/principal";
import { archiveProduct, createProduct, createVariant, deactivateVariant, updateProduct } from "../../src/modules/catalogue/service";
import { adjustStock, receiveStock } from "../../src/modules/inventory/service";
import { setDeliveryZoneOnce } from "../../src/modules/orders/operations";
import { getPreviewProduct, listPreviewProducts, quoteCart, simulateCheckout } from "../../src/modules/storefront/service";
import { clearAuthState, count, createTestAuth, createVerifiedOwner } from "../support/auth";
import { errorCodeOf, TEST_ACTOR } from "../support/fixtures";
import { createTestDb } from "../support/test-database";

// The private storefront preview against PostgreSQL: Owner-only reads of draft products, the authoritative cart
// quote in integer paisa, and the checkout simulation, which must never write anything. Fictional data only.

const state = vi.hoisted(() => ({ db: undefined as unknown, auth: undefined as unknown, headers: new Headers() }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/modules/auth/server", () => ({ getAuth: () => state.auth }));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  },
}));
const actions = await import("../../src/app/office/storefront-preview/actions");

let db: Db;
let pool: Pool;
let owner: Principal;
let cookie: string;
let tag = 0;

beforeAll(async () => {
  ({ db, pool } = await createTestDb(6));
  const auth = createTestAuth(db);
  Object.assign(state, { db, auth });
  await clearAuthState(pool);
  ({ principal: owner, cookie } = await createVerifiedOwner(auth, db, pool, "preview-owner@example.test"));
  const zones = await pool.query<{ code: string; version: number }>("select code, version from delivery_zones");
  const version = (code: string) => zones.rows.find((z) => z.code === code)?.version ?? null;
  await setDeliveryZoneOnce(db, owner, randomUUID(), { code: "dhaka_city", chargePaisa: 6_000, active: true, expectedVersion: version("dhaka_city") });
  await setDeliveryZoneOnce(db, owner, randomUUID(), { code: "outside_dhaka", chargePaisa: 12_000, active: true, expectedVersion: version("outside_dhaka") });
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(() => {
  state.headers = new Headers({ cookie });
});

/** A fictional draft product with SKUs given as [size, colour, pricePaisa, stock]. */
async function product(name: string, skus: [string, string, number, number][], extra: { nameBn?: string; featured?: boolean } = {}) {
  tag += 1;
  const p = await createProduct(db, { slug: `preview-${Date.now().toString(36)}-${tag}`, nameEn: name, nameBn: extra.nameBn ?? null });
  if (extra.featured) await updateProduct(db, p.id, 1, { featured: true });
  const list = [];
  for (const [i, [size, colour, price, stock]] of skus.entries()) {
    const v = await createVariant(db, { productId: p.id, sku: `PRV-${tag}-${i}`, size, colour, pricePaisa: price });
    if (stock > 0) await receiveStock(db, { sku: v.sku, quantity: stock, actor: TEST_ACTOR });
    list.push(v);
  }
  return { product: p, variants: list };
}

const writes = async () => ({
  orders: await count(pool, "select count(*) from orders"),
  items: await count(pool, "select count(*) from order_items"),
  reservations: await count(pool, "select count(*) from stock_reservations"),
  events: await count(pool, "select count(*) from order_events"),
  idempotency: await count(pool, "select count(*) from idempotency_records"),
  movements: await count(pool, "select count(*) from stock_movements"),
  reserved: await count(pool, "select coalesce(sum(reserved), 0) from inventory_balances"),
});

describe("preview reads", () => {
  it("lists only draft products with an active SKU, featured first, with prices, stock state and filters", async () => {
    const word = `Zebrafictional${Date.now().toString(36)}`;
    const plain = await product(`${word} plain`, [["0-3M", "Ivory", 50_000, 2], ["3-6M", "Ivory", 55_000, 0]], { nameBn: "কাল্পনিক জেব্রা" });
    const star = await product(`${word} star`, [["6-12M", "Sand", 70_000, 4]], { featured: true });
    const archived = await product(`${word} archived`, [["0-3M", "Ivory", 50_000, 1]]);
    await archiveProduct(db, archived.product.id);
    const inactive = await product(`${word} inactive`, [["0-3M", "Ivory", 50_000, 1]]);
    await deactivateVariant(db, inactive.variants[0].id);
    await product(`${word} empty`, []);

    const { items } = await listPreviewProducts(db, owner, { q: word });
    expect(items.map((i) => i.nameEn)).toEqual([`${word} star`, `${word} plain`]);
    expect(items[1]).toMatchObject({ minPricePaisa: 50_000, maxPricePaisa: 55_000, stock: "partial", photo: null });
    expect(items[0]).toMatchObject({ stock: "in", featured: true });
    expect((await listPreviewProducts(db, owner, { q: "কাল্পনিক জেব্রা" })).items.map((i) => i.id)).toEqual([plain.product.id]);
    expect((await listPreviewProducts(db, owner, { q: word, size: "6-12M" })).items.map((i) => i.id)).toEqual([star.product.id]);
    expect((await listPreviewProducts(db, owner, { q: word, colour: "Ivory" })).items.map((i) => i.id)).toEqual([plain.product.id]);
    expect((await listPreviewProducts(db, owner, { q: `${word}%` })).items).toEqual([]);
    expect(await getPreviewProduct(db, owner, archived.product.slug)).toBeNull();
    const detail = await getPreviewProduct(db, owner, plain.product.slug);
    expect(detail?.variants.map((v) => [v.size, v.available])).toEqual([["0-3M", 2], ["3-6M", 0]]);
    expect(detail?.zones).toEqual([{ code: "dhaka_city", chargePaisa: 6_000 }, { code: "outside_dhaka", chargePaisa: 12_000 }]);
  });

  it("pages 24 products at a time", async () => {
    const word = `Pagefictional${Date.now().toString(36)}`;
    for (let i = 0; i < 25; i += 1) await product(`${word} ${i}`, [["0-3M", "Ivory", 10_000, 1]]);
    const first = await listPreviewProducts(db, owner, { q: word });
    const second = await listPreviewProducts(db, owner, { q: word, page: 2 });
    expect([first.items.length, first.hasMore, second.items.length, second.hasMore]).toEqual([24, true, 1, false]);
    expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(25);
  });

  it("refuses anyone but a verified Owner session", async () => {
    const forged = Object.freeze({ userId: randomUUID(), role: "owner" as const });
    expect(await errorCodeOf(listPreviewProducts(db, forged, {}))).toBe("UNAUTHENTICATED");
    expect(await errorCodeOf(quoteCart(db, forged, { lines: [] }))).toBe("UNAUTHENTICATED");
    expect(await errorCodeOf(simulateCheckout(db, forged, { name: "x", phone: "x", address: "x", zone: "dhaka_city", lines: [] }))).toBe("UNAUTHENTICATED");
    state.headers = new Headers();
    for (const call of [() => actions.quoteCartAction({ lines: [], zone: null }), () => actions.simulateCheckoutAction(null, new FormData())]) {
      await expect(call()).rejects.toMatchObject({ url: "/office/login" });
    }
  });
});

describe("cart quote", () => {
  it("prices from the database in integer paisa, adds the configured delivery charge, and merges repeated SKUs", async () => {
    const { variants } = await product("Quote fictional", [["0-3M", "Ivory", 85_000, 5], ["3-6M", "Ivory", 92_050, 3]]);
    const [a, b] = variants;
    const quote = await quoteCart(db, owner, { lines: [{ sku: a.sku.toLowerCase(), quantity: 1 }, { sku: b.sku, quantity: 1 }, { sku: a.sku, quantity: 1 }], zone: "dhaka_city" });
    expect(quote.lines.map((l) => [l.sku, l.quantity, l.status, l.lineTotalPaisa])).toEqual([[a.sku, 2, "ok", 170_000], [b.sku, 1, "ok", 92_050]]);
    expect([quote.subtotalPaisa, quote.deliveryChargePaisa, quote.totalPaisa, quote.ready]).toEqual([262_050, 6_000, 268_050, true]);
    const outside = await quoteCart(db, owner, { lines: [{ sku: b.sku, quantity: 3 }], zone: "outside_dhaka" });
    expect([outside.subtotalPaisa, outside.totalPaisa]).toEqual([276_150, 288_150]);
    const noZone = await quoteCart(db, owner, { lines: [{ sku: b.sku, quantity: 1 }] });
    expect([noZone.deliveryChargePaisa, noZone.totalPaisa, noZone.ready]).toEqual([null, null, false]);
  });

  it("follows the database, not the cart: changed stock, a deactivated SKU, an archived product, an unknown SKU, a new price", async () => {
    const { product: p, variants } = await product("Stale fictional", [["0-3M", "Ivory", 50_000, 3], ["3-6M", "Ivory", 60_000, 2]]);
    const [a, b] = variants;
    const lines = [{ sku: a.sku, quantity: 2 }, { sku: b.sku, quantity: 1 }, { sku: "NO-SUCH-PREVIEW-SKU", quantity: 1 }];
    await adjustStock(db, { sku: a.sku, quantityDelta: -2, reason: "Fictional recount", actor: TEST_ACTOR });
    await deactivateVariant(db, b.id);
    const quote = await quoteCart(db, owner, { lines, zone: "dhaka_city" });
    expect(quote.lines.map((l) => [l.status, l.available, l.unitPricePaisa])).toEqual([["insufficient", 1, 50_000], ["unavailable", 0, null], ["unknown", 0, null]]);
    expect([quote.subtotalPaisa, quote.ready]).toEqual([100_000, false]);
    await archiveProduct(db, p.id);
    expect((await quoteCart(db, owner, { lines: [{ sku: a.sku, quantity: 1 }] })).lines[0].status).toBe("unavailable");

    const fresh = await product("Price fictional", [["0-3M", "Ivory", 50_000, 3]]);
    await pool.query("update variants set price_paisa = 55500 where id = $1", [fresh.variants[0].id]);
    expect((await quoteCart(db, owner, { lines: [{ sku: fresh.variants[0].sku, quantity: 2 }] })).subtotalPaisa).toBe(111_000);
  });

  it("counts units reserved for orders as unavailable, and refuses malformed carts", async () => {
    const { variants } = await product("Reserved fictional", [["0-3M", "Ivory", 50_000, 2]]);
    await pool.query("update inventory_balances set reserved = 2 where variant_id = $1", [variants[0].id]);
    expect((await quoteCart(db, owner, { lines: [{ sku: variants[0].sku, quantity: 1 }] })).lines[0]).toMatchObject({ status: "insufficient", available: 0 });
    await pool.query("update inventory_balances set reserved = 0 where variant_id = $1", [variants[0].id]);
    for (const lines of [null, [{ sku: "A", quantity: 0 }], [{ sku: "A", quantity: 1.5 }], Array.from({ length: 21 }, (_, i) => ({ sku: `S${i}`, quantity: 1 }))]) {
      expect(await errorCodeOf(quoteCart(db, owner, { lines }))).toBe("INVALID_INPUT");
    }
    expect(await actions.quoteCartAction({ lines: "not a cart", zone: null })).toBeNull();
  });

  it("has no delivery charge for a zone that is not active", async () => {
    const { variants } = await product("Zone fictional", [["0-3M", "Ivory", 50_000, 2]]);
    const { rows } = await pool.query<{ version: number }>("select version from delivery_zones where code = 'outside_dhaka'");
    await setDeliveryZoneOnce(db, owner, randomUUID(), { code: "outside_dhaka", chargePaisa: 12_000, active: false, expectedVersion: rows[0].version });
    try {
      const quote = await quoteCart(db, owner, { lines: [{ sku: variants[0].sku, quantity: 1 }], zone: "outside_dhaka" });
      expect([quote.deliveryChargePaisa, quote.totalPaisa, quote.ready]).toEqual([null, null, false]);
      const result = await simulateCheckout(db, owner, { name: "Test Customer", phone: "01711000041", address: "House 41, Test Road", zone: "outside_dhaka", lines: [{ sku: variants[0].sku, quantity: 1 }] });
      expect(result.errors).toEqual({ zone: "zone_unavailable" });
    } finally {
      await setDeliveryZoneOnce(db, owner, randomUUID(), { code: "outside_dhaka", chargePaisa: 12_000, active: true, expectedVersion: rows[0].version + 1 });
    }
  });
});

describe("checkout simulation", () => {
  it("validates like an order (Bangladesh mobile, name, address, zone, stock) and reports codes, not text", async () => {
    const { variants } = await product("Checkout fictional", [["0-3M", "Ivory", 50_000, 1]]);
    const empty = await simulateCheckout(db, owner, { name: " ", phone: "12345", address: "", zone: "mars", lines: [] });
    expect(empty).toMatchObject({ ok: false, customer: null, errors: { name: "name_required", phone: "phone_invalid", address: "address_required", zone: "zone_required", cart: "cart_empty" } });
    const long = await simulateCheckout(db, owner, { name: "x".repeat(101), phone: "+880 1711-000042", address: "y".repeat(501), zone: "dhaka_city", lines: [{ sku: variants[0].sku, quantity: 2 }] });
    expect(long.errors).toEqual({ name: "name_too_long", address: "address_too_long", cart: "cart_stock" });
    const control = await simulateCheckout(db, owner, { name: "Test\u0007Customer", phone: "01711000042", address: "House 42", zone: "dhaka_city", lines: [{ sku: variants[0].sku, quantity: 1 }] });
    expect(control.errors).toEqual({ name: "name_invalid" });
    const bad = await simulateCheckout(db, owner, { name: "Test Customer", phone: "01711000042", address: "House 42", zone: "dhaka_city", lines: "nonsense" });
    expect(bad.errors).toEqual({ cart: "cart_invalid" });
  });

  it("returns the authoritative total for a valid order and writes nothing at all", async () => {
    const { variants } = await product("Nothing written fictional", [["0-3M", "Ivory", 85_000, 2], ["3-6M", "Ivory", 92_050, 1]]);
    const before = await writes();
    const form = new FormData();
    for (const [k, v] of Object.entries({ name: "Test Customer", phone: "+880 1711-000043", address: "House 43, Test Road\nTest Area", zone: "dhaka_city" })) form.append(k, v);
    form.append("lines", JSON.stringify([{ sku: variants[0].sku, quantity: 2 }, { sku: variants[1].sku, quantity: 1 }]));
    const result = await actions.simulateCheckoutAction(null, form);
    expect(result).toMatchObject({ ok: true, errors: {}, customer: { name: "Test Customer", phone: "01711000043", address: "House 43, Test Road\nTest Area" } });
    expect([result.quote?.subtotalPaisa, result.quote?.deliveryChargePaisa, result.quote?.totalPaisa]).toEqual([262_050, 6_000, 268_050]);
    expect(await writes()).toEqual(before);
    // Run twice: still nothing (no idempotency record, no order, no hold).
    await actions.simulateCheckoutAction(null, form);
    expect(await writes()).toEqual(before);
  });
});
