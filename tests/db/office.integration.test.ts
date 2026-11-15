import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/database";
import { bearer, clearAuthState, count, createTestAuth, createTestUser, signIn, signInNative } from "../support/auth";
import { createTestVariant, withFailingInserts } from "../support/fixtures";
import { createTestDb } from "../support/test-database";

// Owner Office server code: the access helper and every Server Action, called as Next.js would call them
// (request headers from next/headers, redirect from next/navigation), against PostgreSQL.

const state = vi.hoisted(() => ({ db: undefined as unknown, auth: undefined as unknown, headers: new Headers() }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/modules/auth/server", () => ({ getAuth: () => state.auth }));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  },
}));

const actions = await import("../../src/app/office/actions");
const { requireOffice } = await import("../../src/app/office/_lib/session");

const OWNER = { email: "office-owner@example.test", password: "office owner long password" };
const OTHER = { email: "office-other@example.test", password: "office other long password" };

let db: Db;
let pool: Pool;
let auth: ReturnType<typeof createTestAuth>;
let ownerId: string;
let otherId: string;
let cookie: string;

beforeAll(async () => {
  ({ db, pool } = await createTestDb(6));
  auth = createTestAuth(db);
  Object.assign(state, { db, auth });
  await clearAuthState(pool);
  ownerId = await createTestUser(pool, { ...OWNER, role: "owner" });
  otherId = await createTestUser(pool, { ...OTHER, role: "owner" });
  ({ cookie } = await signIn(auth, OWNER.email, OWNER.password));
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query("delete from auth_rate_limits");
  state.headers = new Headers({ cookie });
});

type Action = (state: { error?: string }, form: FormData) => Promise<{ error?: string; values?: Record<string, string> }>;

/** Runs an action like a form post. Returns where it redirected, or the state it answered with. */
async function submit(action: Action, fields: Record<string, string>) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  try {
    return { state: await action({}, form) };
  } catch (error) {
    const url = (error as { url?: string }).url;
    if (url) return { redirect: url };
    throw error;
  }
}

const movementsOf = (variantId: string) => count(pool, "select count(*) from stock_movements where variant_id = $1", [variantId]);

describe("Office access", () => {
  it("redirects to sign-in without a session, also when only a Bearer token is sent", async () => {
    state.headers = new Headers();
    await expect(requireOffice("catalog:read")).rejects.toMatchObject({ url: "/office/login" });
    const token = (await signInNative(auth, OWNER.email, OWNER.password)).token!;
    state.headers = bearer(token);
    await expect(requireOffice("catalog:read")).rejects.toMatchObject({ url: "/office/login" });
  });

  it("accepts the session cookie, and refuses a missing permission on the server", async () => {
    expect((await requireOffice("catalog:read", "stock:read")).userId).toBe(ownerId);
    await expect(requireOffice("orders:refund" as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a signed-out, expired or disabled session", async () => {
    const { cookie: signedOut } = await signIn(auth, OTHER.email, OTHER.password);
    await auth.handler(new Request("http://localhost:3000/api/auth/sign-out", { method: "POST", headers: { cookie: signedOut, origin: "http://localhost:3000" } }));
    state.headers = new Headers({ cookie: signedOut });
    await expect(requireOffice("catalog:read")).rejects.toMatchObject({ url: "/office/login" });

    const { cookie: expiring } = await signIn(auth, OTHER.email, OTHER.password);
    await pool.query("update auth_sessions set expires_at = now() - interval '1 minute' where user_id = $1", [otherId]);
    state.headers = new Headers({ cookie: expiring });
    await expect(requireOffice("catalog:read")).rejects.toMatchObject({ url: "/office/login" });

    const disabledId = await createTestUser(pool, { email: "office-disabled@example.test", password: "office disabled long password", role: "owner" });
    const { cookie: disabled } = await signIn(auth, "office-disabled@example.test", "office disabled long password");
    await pool.query("update user_access set disabled_at = now() where user_id = $1", [disabledId]);
    state.headers = new Headers({ cookie: disabled });
    await expect(requireOffice("catalog:read")).rejects.toMatchObject({ url: "/office/login" });
  });

  it("every Server Action redirects an anonymous caller to sign-in and changes nothing", async () => {
    const { product, variant } = await createTestVariant(db, "offanon");
    state.headers = new Headers();
    const key = randomUUID();
    const attempts: [Action, Record<string, string>][] = [
      [actions.createProductAction, { idempotencyKey: key, slug: "offanon-x", nameEn: "X" }],
      [actions.createVariantAction, { idempotencyKey: key, productId: product.id, sku: "OFFANON-X", priceTaka: "1" }],
      [actions.archiveProductAction, { idempotencyKey: key, productId: product.id }],
      [actions.deactivateVariantAction, { idempotencyKey: key, variantId: variant.id }],
      [actions.receiveStockAction, { idempotencyKey: key, sku: variant.sku, quantity: "1" }],
      [actions.adjustStockAction, { idempotencyKey: key, sku: variant.sku, direction: "add", units: "1", reason: "x" }],
      [actions.updateProductAction, { idempotencyKey: key, productId: product.id, version: "1", nameEn: "Anonymous edit" }],
      [actions.updateVariantAction, { idempotencyKey: key, variantId: variant.id, version: "1", priceTaka: "1" }],
    ];
    for (const [action, fields] of attempts) expect(await submit(action, fields)).toEqual({ redirect: "/office/login" });
    expect(await movementsOf(variant.id)).toBe(0);
    expect(await count(pool, "select count(*) from products where slug = 'offanon-x'")).toBe(0);
    expect(await count(pool, "select count(*) from idempotency_records where idempotency_key = $1", [key])).toBe(0);
  });
});

describe("stock forms", () => {
  it("records a receipt as the signed-in user, ignoring any identity fields in the form", async () => {
    const { variant } = await createTestVariant(db, "offstk");
    const result = await submit(actions.receiveStockAction, {
      idempotencyKey: randomUUID(),
      sku: variant.sku.toLowerCase(),
      quantity: "6",
      reason: "Delivery",
      actorRef: otherId,
      userId: otherId,
      actorType: "system",
      role: "owner",
    });
    expect(result).toEqual({ redirect: `/office/skus/${variant.sku}?done=received` });
    const { rows } = await pool.query("select actor_type, actor_ref, quantity_delta from stock_movements where variant_id = $1", [variant.id]);
    expect(rows).toEqual([{ actor_type: "user", actor_ref: ownerId, quantity_delta: 6 }]);
  });

  it("a double-click or resubmission with the same form key records one receipt", async () => {
    const { variant } = await createTestVariant(db, "offstk");
    const fields = { idempotencyKey: randomUUID(), sku: variant.sku, quantity: "2" };
    const results = await Promise.all([submit(actions.receiveStockAction, fields), submit(actions.receiveStockAction, fields)]);
    expect(results).toEqual([{ redirect: `/office/skus/${variant.sku}?done=received` }, { redirect: `/office/skus/${variant.sku}?done=received` }]);
    expect(await submit(actions.receiveStockAction, fields)).toEqual({ redirect: `/office/skus/${variant.sku}?done=received` });
    expect(await movementsOf(variant.id)).toBe(1);
    const changed = await submit(actions.receiveStockAction, { ...fields, quantity: "3" });
    expect(changed.state?.error).toMatch(/already submitted/);
    expect(await movementsOf(variant.id)).toBe(1);
  });

  it("shows safe validation messages, keeps the typed values, and records nothing", async () => {
    const { variant } = await createTestVariant(db, "offstk");
    const cases: [Action, Record<string, string>, RegExp][] = [
      [actions.receiveStockAction, { sku: variant.sku, quantity: "abc" }, /Units received must be a whole number/],
      [actions.receiveStockAction, { sku: variant.sku, quantity: "0" }, /Units received must be a positive whole number/],
      [actions.receiveStockAction, { sku: variant.sku, quantity: "1.5" }, /whole number/],
      [actions.receiveStockAction, { sku: "bad sku!", quantity: "1" }, /SKU must be/],
      [actions.receiveStockAction, { sku: "OFFSTK-NOPE", quantity: "1" }, /No variant has this SKU/],
      [actions.adjustStockAction, { sku: variant.sku, direction: "remove", units: "1", reason: "" }, /Reason is required/],
      [actions.adjustStockAction, { sku: variant.sku, direction: "remove", units: "1", reason: "Recount" }, /Not enough stock/],
      [actions.adjustStockAction, { sku: variant.sku, direction: "remove", units: "0", reason: "Recount" }, /Units must be at least 1/],
      [actions.receiveStockAction, { sku: variant.sku, quantity: "1", idempotencyKey: "short" }, /Idempotency-Key/],
    ];
    for (const [action, fields, message] of cases) {
      const { state: answer } = await submit(action, { idempotencyKey: randomUUID(), ...fields });
      expect(answer?.error).toMatch(message);
      expect(answer?.error).not.toMatch(/select|insert|update|constraint|stock_movements|SQL/i);
      expect(answer?.values).not.toHaveProperty("idempotencyKey");
    }
    const { state: kept } = await submit(actions.adjustStockAction, { idempotencyKey: randomUUID(), sku: variant.sku, direction: "remove", units: "9", reason: "Typed reason" });
    expect(kept?.values).toMatchObject({ direction: "remove", units: "9", reason: "Typed reason" });
    expect(await movementsOf(variant.id)).toBe(0);
  });

  it("adjusts with a reason, and hides unexpected errors behind a generic message", async () => {
    const { variant } = await createTestVariant(db, "offstk");
    await submit(actions.receiveStockAction, { idempotencyKey: randomUUID(), sku: variant.sku, quantity: "5" });
    expect(await submit(actions.adjustStockAction, { idempotencyKey: randomUUID(), sku: variant.sku, direction: "remove", units: "2", reason: "Damaged" })).toEqual({
      redirect: `/office/skus/${variant.sku}?done=adjusted`,
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { state: answer } = await withFailingInserts(pool, "stock_movements", () =>
        submit(actions.adjustStockAction, { idempotencyKey: randomUUID(), sku: variant.sku, direction: "remove", units: "1", reason: "Recount" }),
      );
      expect(answer?.error).toBe("Something went wrong and nothing was saved. Please try again.");
    } finally {
      spy.mockRestore();
    }
    expect((await pool.query("select on_hand from inventory_balances where variant_id = $1", [variant.id])).rows[0].on_hand).toBe(3);
  });
});

describe("catalogue forms", () => {
  it("creates a draft product once per form key, then a variant priced in Taka (stored as paisa)", async () => {
    const fields = { idempotencyKey: randomUUID(), slug: "office-romper", nameEn: "Romper", nameBn: "রম্পার", descriptionEn: "", descriptionBn: "নরম" };
    const created = await submit(actions.createProductAction, fields);
    expect(created.redirect).toMatch(/^\/office\/products\/[0-9a-f-]{36}\?done=created$/);
    expect(await submit(actions.createProductAction, fields)).toEqual(created);
    const productId = created.redirect!.split("/")[3].split("?")[0];
    const { rows } = await pool.query("select status, name_bn, description_en, description_bn from products where id = $1", [productId]);
    expect(rows).toEqual([{ status: "draft", name_bn: "রম্পার", description_en: null, description_bn: "নরম" }]);

    const variant = { idempotencyKey: randomUUID(), productId, sku: "office-rmp-01", size: "0-3M", colour: "", priceTaka: "450.50" };
    expect(await submit(actions.createVariantAction, variant)).toEqual({ redirect: `/office/products/${productId}?done=variant` });
    const { rows: saved } = await pool.query("select sku, price_paisa, colour from variants where product_id = $1", [productId]);
    expect(saved).toEqual([{ sku: "OFFICE-RMP-01", price_paisa: "45050", colour: null }]);
    expect((await submit(actions.createVariantAction, { ...variant, idempotencyKey: randomUUID() })).state?.error).toBe("A variant with this SKU already exists.");
    for (const priceTaka of ["", "0", "-1", "1.234", "abc"]) {
      expect((await submit(actions.createVariantAction, { ...variant, idempotencyKey: randomUUID(), sku: "OFFICE-RMP-02", priceTaka })).state?.error).toMatch(/^Price \(BDT\) (must|is) /);
    }
    expect((await submit(actions.createProductAction, { ...fields, idempotencyKey: randomUUID() })).state?.error).toBe("A product with this slug already exists.");
    expect((await submit(actions.createProductAction, { idempotencyKey: randomUUID(), slug: "office-noname" })).state?.error).toMatch(/needs a name/);
  });

  it("archives a product and deactivates a variant, without deleting", async () => {
    const { product, variant } = await createTestVariant(db, "offarc");
    expect(await submit(actions.deactivateVariantAction, { idempotencyKey: randomUUID(), variantId: variant.id })).toEqual({
      redirect: `/office/products/${product.id}?done=deactivated`,
    });
    expect(await submit(actions.archiveProductAction, { idempotencyKey: randomUUID(), productId: product.id })).toEqual({
      redirect: `/office/products/${product.id}?done=archived`,
    });
    const { rows } = await pool.query("select p.status as product, v.status as variant from products p join variants v on v.product_id = p.id where p.id = $1", [product.id]);
    expect(rows).toEqual([{ product: "archived", variant: "inactive" }]);
    expect((await submit(actions.archiveProductAction, { idempotencyKey: randomUUID(), productId: "not-a-uuid" })).state?.error).toMatch(/productId must be a UUID/);
  });
});

describe("edit forms", () => {
  it("saves a draft product's text, keeps Bangla exactly, clears emptied fields, and runs once per form key", async () => {
    const { product } = await createTestVariant(db, "offedit");
    const fields = { idempotencyKey: randomUUID(), productId: product.id, version: "1", nameEn: "  Edited Romper ", nameBn: "নতুন রম্পার", descriptionEn: "", descriptionBn: "নরম সুতি" };
    expect(await submit(actions.updateProductAction, fields)).toEqual({ redirect: `/office/products/${product.id}?done=updated` });
    expect(await submit(actions.updateProductAction, fields)).toEqual({ redirect: `/office/products/${product.id}?done=updated` });
    const { rows } = await pool.query("select slug, name_en, name_bn, description_en, description_bn, version from products where id = $1", [product.id]);
    expect(rows).toEqual([{ slug: product.slug, name_en: "Edited Romper", name_bn: "নতুন রম্পার", description_en: null, description_bn: "নরম সুতি", version: 2 }]);
  });

  it("refuses a stale form with a reload message and keeps what was typed", async () => {
    const { product } = await createTestVariant(db, "offstale");
    await submit(actions.updateProductAction, { idempotencyKey: randomUUID(), productId: product.id, version: "1", nameEn: "First tab" });
    const { state: answer } = await submit(actions.updateProductAction, { idempotencyKey: randomUUID(), productId: product.id, version: "1", nameEn: "Second tab", nameBn: "দ্বিতীয়" });
    expect(answer?.error).toMatch(/changed after you loaded it\. Reload it/);
    expect(answer?.values).toMatchObject({ nameEn: "Second tab", nameBn: "দ্বিতীয়" });
    expect((await pool.query("select name_en from products where id = $1", [product.id])).rows[0].name_en).toBe("First tab");
  });

  it("refuses removing both names and editing an archived product", async () => {
    const { product } = await createTestVariant(db, "offnoname");
    const both = await submit(actions.updateProductAction, { idempotencyKey: randomUUID(), productId: product.id, version: "1", nameEn: " ", nameBn: "" });
    expect(both.state?.error).toBe("A product needs a name in English or Bangla.");
    await submit(actions.archiveProductAction, { idempotencyKey: randomUUID(), productId: product.id });
    const archived = await submit(actions.updateProductAction, { idempotencyKey: randomUUID(), productId: product.id, version: "2", nameEn: "Revived" });
    expect(archived.state?.error).toBe("An archived product cannot be edited.");
  });

  it("saves a variant's size, colour and exact price without touching SKU or stock", async () => {
    const { product, variant } = await createTestVariant(db, "offvedit");
    await submit(actions.receiveStockAction, { idempotencyKey: randomUUID(), sku: variant.sku, quantity: "4" });
    const fields = { idempotencyKey: randomUUID(), variantId: variant.id, version: "1", size: "6-12M", colour: "", priceTaka: "1234.05", sku: "HACKED-SKU" };
    expect(await submit(actions.updateVariantAction, fields)).toEqual({ redirect: `/office/products/${product.id}?done=variant-updated` });
    const { rows } = await pool.query("select v.sku, v.size, v.colour, v.price_paisa, v.version, b.on_hand from variants v join inventory_balances b on b.variant_id = v.id where v.id = $1", [variant.id]);
    expect(rows).toEqual([{ sku: variant.sku, size: "6-12M", colour: null, price_paisa: "123405", version: 2, on_hand: 4 }]);
    for (const priceTaka of ["", "0", "12.345", "1,000"]) {
      const { state: answer } = await submit(actions.updateVariantAction, { ...fields, idempotencyKey: randomUUID(), version: "2", priceTaka });
      expect(answer?.error).toMatch(/^Price \(BDT\) /);
    }
  });

  it("adjusts up or down only with an explicit choice", async () => {
    const { variant } = await createTestVariant(db, "offdir");
    expect((await submit(actions.adjustStockAction, { idempotencyKey: randomUUID(), sku: variant.sku, direction: "add", units: "3", reason: "Found" })).redirect).toMatch(/done=adjusted/);
    const missing = await submit(actions.adjustStockAction, { idempotencyKey: randomUUID(), sku: variant.sku, units: "1", reason: "Recount" });
    expect(missing.state?.error).toBe("Choose whether to add or remove units.");
    const signed = await submit(actions.adjustStockAction, { idempotencyKey: randomUUID(), sku: variant.sku, direction: "remove", units: "-1", reason: "Recount" });
    expect(signed.state?.error).toBe("Units must be a whole number.");
    const { rows } = await pool.query("select quantity_delta from stock_movements where variant_id = $1", [variant.id]);
    expect(rows).toEqual([{ quantity_delta: 3 }]);
  });
});
