import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publicCatalogueResponse } from "../../src/api/public-catalogue";
import { maintenanceResponse } from "../../src/api/maintenance";
import { auditPrivileges } from "../../src/db/hosted-security.mts";
import { APP_ROLE } from "../../src/db/hosted-target.mts";
import { getPrincipal, type Principal } from "../../src/modules/auth/principal";
import { createProduct, createVariant } from "../../src/modules/catalogue/service";
import { receiveStockOnce } from "../../src/modules/inventory/operations";
import { runMaintenance } from "../../src/modules/maintenance/jobs";
import { setDeliveryZoneOnce, submitOrderOnce } from "../../src/modules/orders/operations";
import { call, createTestAuth, createVerifiedOwner, headersWith } from "../support/auth";
import { errorCodeOf } from "../support/fixtures";
import { CUSTOMER, dbOf, disableAccounts, randomPassword, STAGING_EMAIL_DOMAIN, stagingPool, tag } from "./support";

// Staging items 1, 2, 4, 5, 6, 10, 11 and the database half of 12 (docs/operations/staging-setup.md), through the
// transaction pooler as the application role. Fictional data only.

const pool = stagingPool(4);
const db = dbOf(pool);
let owner: Principal;
const accounts: string[] = [];
const key = () => randomUUID();

beforeAll(async () => {
  let userId: string;
  ({ principal: owner, userId } = await createVerifiedOwner(createTestAuth(db), db, pool, `owner-${tag()}${STAGING_EMAIL_DOMAIN}`, randomPassword()));
  accounts.push(userId);
  const zones = await pool.query<{ code: string; version: number }>("select code, version from delivery_zones");
  for (const [code, charge] of [["dhaka_city", 6_000], ["outside_dhaka", 12_000]] as const) {
    const current = zones.rows.find((z) => z.code === code);
    if (!current) await setDeliveryZoneOnce(db, owner, key(), { code, chargePaisa: charge, active: true, expectedVersion: null });
  }
});
afterAll(async () => {
  // Fictional Owners must not stay usable on a shared staging database.
  await disableAccounts(pool, accounts);
  await pool.end();
});

async function sku(stock: number) {
  const slug = tag();
  const product = await createProduct(db, { slug, nameEn: "Staging Romper", nameBn: "রম্পার", descriptionEn: "Fictional.", descriptionBn: "কাল্পনিক।" });
  const variant = await createVariant(db, { productId: product.id, sku: slug.toUpperCase(), size: "0-3M", colour: "Ivory", pricePaisa: 50_000 });
  if (stock) await receiveStockOnce(db, owner, key(), { sku: variant.sku, quantity: stock });
  return { productId: product.id, slug, sku: variant.sku };
}

describe("1. connection through the transaction pooler", () => {
  it("answers, as the application role, with the 60 s statement limit set on the role", async () => {
    const { rows } = await pool.query<{ usr: string; timeout: string }>("select current_user as usr, current_setting('statement_timeout') as timeout");
    expect(rows[0]).toEqual({ usr: APP_ROLE, timeout: "1min" });
  });
});

describe("2. least privilege", () => {
  it("the privilege audit has no findings", async () => {
    const client = await pool.connect();
    try {
      expect(await auditPrivileges(client, APP_ROLE)).toEqual([]);
    } finally {
      client.release();
    }
  });
  it("the application role cannot create objects, truncate, or change an append-only table", async () => {
    // 42501 is "insufficient privilege": refused by the grants, not only by the append-only triggers (which would also
    // refuse these statements, with another code).
    for (const statement of ["create table stg_probe (id int)", "truncate orders", "update stock_movements set quantity_delta = quantity_delta where false", "delete from auth_events where false", "select * from drizzle.__drizzle_migrations"]) {
      const code = await pool.query(statement).then(() => "succeeded", (error: { code?: string }) => error.code);
      expect([statement, code]).toEqual([statement, "42501"]);
    }
  });
});

describe("4 and 5. reservations", () => {
  it("the last unit goes to exactly one of several orders sent at once from separate function instances", async () => {
    const a = await sku(1);
    const instances = Array.from({ length: 4 }, () => stagingPool(1));
    try {
      const results = await Promise.allSettled(instances.map((p) => submitOrderOnce(dbOf(p), owner, key(), { source: "whatsapp", ...CUSTOMER, items: [{ sku: a.sku, quantity: 1 }] })));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const { rows } = await pool.query("select b.on_hand, b.reserved from inventory_balances b join variants v on v.id = b.variant_id where v.sku = $1", [a.sku]);
      expect(rows[0]).toEqual({ on_hand: 1, reserved: 1 });
    } finally {
      await Promise.all(instances.map((p) => p.end()));
    }
  });
  it("an order whose second SKU is short is refused as a whole: the first SKU is not held", async () => {
    const a = await sku(2);
    const b = await sku(1);
    expect(await errorCodeOf(submitOrderOnce(db, owner, key(), { source: "whatsapp", ...CUSTOMER, items: [{ sku: a.sku, quantity: 1 }, { sku: b.sku, quantity: 2 }] }))).toBe("INSUFFICIENT_STOCK");
    const { rows } = await pool.query("select v.sku, b.reserved from inventory_balances b join variants v on v.id = b.variant_id where v.sku = any($1) order by v.sku", [[a.sku, b.sku]]);
    expect(rows.map((r) => r.reserved)).toEqual([0, 0]);
  });
});

describe("6. Better Auth sessions", () => {
  it("sign-in gives a working session; sign-out ends it at once", async () => {
    const auth = createTestAuth(db);
    const email = `session-${tag()}${STAGING_EMAIL_DOMAIN}`;
    const { cookie, userId } = await createVerifiedOwner(auth, db, pool, email, randomPassword());
    accounts.push(userId);
    expect(await getPrincipal(auth, db, headersWith(cookie))).not.toBeNull();
    expect((await call(auth, "POST", "/sign-out", { cookie })).status).toBe(200);
    expect(await getPrincipal(auth, db, headersWith(cookie))).toBeNull();
  });
});

describe("10. maintenance", () => {
  it("runs from several instances at once without conflict, and the HTTP call refuses anyone without the secret", async () => {
    const instances = Array.from({ length: 3 }, () => stagingPool(1));
    try {
      const reports = await Promise.all(instances.map((p) => runMaintenance(dbOf(p))));
      expect(reports.map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
    } finally {
      await Promise.all(instances.map((p) => p.end()));
    }
    const env = { MAINTENANCE_SECRET: "Zq8LmW3xT9vB2nR7kD5pC1hY4gF6sJ0aEoUi" };
    const refused = await maintenanceResponse(new Request("https://staging.example.test/api/internal/maintenance", { method: "POST" }), { db: () => db, env });
    expect(refused.status).toBe(401);
  });
});

describe("11. connection exhaustion and recovery", () => {
  it("a full instance pool fails fast with a timeout, then recovers once a connection is free", async () => {
    const instance = stagingPool(1, 1_000);
    try {
      const held = await instance.connect();
      await expect(instance.query("select 1")).rejects.toThrow(/timeout/i);
      held.release();
      expect((await instance.query("select 1 as ok")).rows[0].ok).toBe(1);
    } finally {
      await instance.end();
    }
  });
  it("a connection killed under the application is replaced; the next query works", async () => {
    const instance = stagingPool(1);
    try {
      await instance.query("select pg_terminate_backend(pg_backend_pid())").catch(() => undefined);
      expect((await instance.query("select 1 as ok")).rows[0].ok).toBe(1);
    } finally {
      await instance.end();
    }
  });
});

describe("12 (database). nothing unpublished is visible to customers", () => {
  it("a draft product is unknown to the public catalogue, even with the gate opened by the test", async () => {
    const a = await sku(1);
    const deps = { db, baseUrl: "https://staging.example.test", gate: () => ({ open: true }) };
    const product = await publicCatalogueResponse(new Request(`https://staging.example.test/x`), { kind: "product", slug: a.slug }, deps);
    expect(product.status).toBe(404);
    const list = await (await publicCatalogueResponse(new Request(`https://staging.example.test/x?q=${a.slug}`), { kind: "products" }, deps)).json();
    expect(JSON.stringify(list)).not.toContain(a.slug);
    expect((await db.execute(sql`select count(*)::int as n from products where status = 'published'`)).rows[0]).toEqual({ n: 0 });
  });
});
