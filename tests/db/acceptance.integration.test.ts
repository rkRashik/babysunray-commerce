import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GUEST_CHECKOUTS_PER_CLIENT_PER_HOUR, guestCheckoutResponse } from "../../src/api/guest-checkout";
import type { Db } from "../../src/db/database";
import { bootstrapStagingOwner } from "../../src/modules/auth/owner-bootstrap.mts";
import type { Principal } from "../../src/modules/auth/principal";
import { PROPOSED_PUBLICATION_RULE, publicationRuleFor, publishProductOnce, withdrawProductOnce } from "../../src/modules/catalogue/publication";
import { customerOrderList } from "../../src/modules/customers/orders";
import { forgetStagingMarker, isStagingDatabase } from "../../src/modules/launch/acceptance";
import { placeGuestOrder } from "../../src/modules/orders/guest-checkout";
import { setDeliveryZoneOnce } from "../../src/modules/orders/operations";
import { markPolicyReviewedOnce, savePolicyDraftOnce } from "../../src/modules/policies/drafts";
import { publishedPolicies, publishPolicyOnce, withdrawPolicyOnce } from "../../src/modules/policies/publication";
import { consumePublicLimit } from "../../src/modules/rate-limit/service";
import { clearAuthState, createTestAuth, createVerifiedOwner } from "../support/auth";
import { errorCodeOf } from "../support/fixtures";
import { markTestDatabaseAsStaging } from "../support/global-setup";
import { contentDigestOf, reviewNow } from "../support/publication";
import { connectTestClient, createTestDb } from "../support/test-database";

// Founder acceptance against PostgreSQL (ADR-0011): publication under the proposed rule only on a staging-marked database,
// founder-approved policy publication, the link from a signed-in customer to their order, the customer/Owner boundary and
// the per-client checkout limit. Fictional data only. The staging marker is removed again after this file.

let db: Db;
let pool: Pool;
let owner: Principal;
let ownerId: string;
let n = 0;
const BASE = "http://localhost:3000";

beforeAll(async () => {
  ({ db, pool } = await createTestDb(6));
  await clearAuthState(pool);
  ({ principal: owner, userId: ownerId } = await createVerifiedOwner(createTestAuth(db), db, pool, "acceptance-owner@example.test"));
  for (const code of ["dhaka_city", "outside_dhaka"] as const) {
    const { rows } = await pool.query<{ version: number }>("select version from delivery_zones where code = $1", [code]);
    await setDeliveryZoneOnce(db, owner, randomUUID(), { code, chargePaisa: 7_000, active: true, expectedVersion: rows[0]?.version ?? null });
  }
});

afterAll(async () => {
  await markTestDatabaseAsStaging(pool, false);
  await pool?.end();
});

const mark = async (marked: boolean) => {
  await markTestDatabaseAsStaging(pool, marked);
  forgetStagingMarker();
};

/** A product that meets every readiness item (names, descriptions, fabric confirmed, care, category, sizes with measurements, a described photo) and has stock. */
async function readyProduct(stock = 5) {
  n += 1;
  const slug = `acc-${n}-${randomBytes(3).toString("hex")}`;
  const category = await pool.query<{ id: string }>("insert into product_categories (slug, name_en, name_bn) values ($1, 'Fictional', 'কাল্পনিক') returning id", [`${slug}-c`]);
  const product = await pool.query<{ id: string }>(
    `insert into products (slug, name_en, name_bn, description_en, description_bn, category_id, fabric_en, fabric_bn, fabric_confirmed_at, fabric_confirmed_by_user_id, care_en, care_bn)
     values ($1, 'Acceptance Romper', 'যাচাই রম্পার', 'Fictional.', 'কাল্পনিক।', $2, 'Fictional fabric', 'কাল্পনিক কাপড়', now(), $3, 'Fictional care', 'কাল্পনিক যত্ন') returning id`,
    [slug, category.rows[0].id, ownerId],
  );
  const productId = product.rows[0].id;
  const sku = `ACC-${n}-${randomBytes(2).toString("hex").toUpperCase()}`;
  const variant = await pool.query<{ id: string }>("insert into variants (product_id, sku, size, colour, price_paisa) values ($1, $2, '0-3M', 'Ivory', 50000) returning id", [productId, sku]);
  await pool.query("insert into inventory_balances (variant_id, on_hand) values ($1, $2)", [variant.rows[0].id, stock]);
  await pool.query("insert into stock_movements (variant_id, movement_type, quantity_delta, actor_type, actor_ref) values ($1, 'receipt', $2, 'system', 'acceptance-test')", [variant.rows[0].id, stock]);
  await pool.query("insert into product_measurements (product_id, size, point, value_mm) values ($1, '0-3M', 'chest', 245)", [productId]);
  await pool.query(
    "insert into product_media (product_id, storage_key, content_type, byte_size, width, height, sha256, alt_en, alt_bn, position, created_by_user_id) values ($1, $2, 'image/png', 10, 800, 1000, $3, 'Front', 'সামনে', 0, $4)",
    [productId, `${randomBytes(16).toString("hex")}.png`, createHash("sha256").update(slug).digest("hex"), ownerId],
  );
  return { productId, sku };
}

/** A ready product, reviewed and published under the proposed rule (the database must be marked staging). */
async function publishedProduct() {
  const p = await readyProduct();
  await reviewNow(db, owner, p.productId);
  await publishProductOnce(db, owner, randomUUID(), { productId: p.productId, contentSha256: await contentDigestOf(db, p.productId) });
  return p;
}

const order = (sku: string, quantity = 1) => ({
  customer: { name: "Fictional Acceptance", phone: "01711000777", address: "House 7, Fictional Road" },
  deliveryZone: "dhaka_city",
  items: [{ sku, quantity, unitPricePaisa: 50_000 }],
  deliveryChargePaisa: 7_000,
  totalPaisa: 50_000 * quantity + 7_000,
});

describe("publication under the proposed rule", () => {
  it("refuses on a database that is not marked staging, whatever the product", async () => {
    await mark(false);
    const p = await readyProduct();
    await reviewNow(db, owner, p.productId);
    expect(await isStagingDatabase(db)).toBe(false);
    expect(await publicationRuleFor(db)).toBeNull();
    expect(await errorCodeOf(publishProductOnce(db, owner, randomUUID(), { productId: p.productId, contentSha256: await contentDigestOf(db, p.productId) }))).toBe("PUBLICATION_NOT_APPROVED");
  });

  it("publishes on the staging-marked database only with a current review and every item, records the rule, and withdraws", async () => {
    await mark(true);
    expect(await publicationRuleFor(db)).toBe(PROPOSED_PUBLICATION_RULE);
    const p = await readyProduct();
    const digest = await contentDigestOf(db, p.productId);
    // No review yet.
    expect(await errorCodeOf(publishProductOnce(db, owner, randomUUID(), { productId: p.productId, contentSha256: digest }))).toBe("PRODUCT_NOT_PUBLISHABLE");
    await reviewNow(db, owner, p.productId);
    const once = await publishProductOnce(db, owner, randomUUID(), { productId: p.productId, contentSha256: digest });
    expect(once.value.status).toBe("published");
    const { rows } = await pool.query<{ rule_id: string }>("select rule_id from product_publication_events where product_id = $1", [p.productId]);
    expect(rows.map((r) => r.rule_id)).toEqual(["i6-proposed-acceptance"]);

    // A product missing an item (no photo description in Bangla) is refused with that item named.
    const q = await readyProduct();
    await pool.query("update product_media set alt_bn = null where product_id = $1", [q.productId]);
    await reviewNow(db, owner, q.productId);
    const refused = publishProductOnce(db, owner, randomUUID(), { productId: q.productId, contentSha256: await contentDigestOf(db, q.productId) });
    await expect(refused).rejects.toThrow(/item:alt/);

    await withdrawProductOnce(db, owner, randomUUID(), { productId: p.productId, expectedVersion: once.value.version });
    expect((await pool.query<{ status: string }>("select status from products where id = $1", [p.productId])).rows[0].status).toBe("draft");
  });
});

describe("policy publication", () => {
  it("publishes only a reviewed version with explicit approval, copies its text, and withdraws", async () => {
    const current = (await pool.query<{ version: number }>("select version from policy_drafts where kind = 'delivery'")).rows[0]?.version ?? 0;
    const saved = await savePolicyDraftOnce(db, owner, randomUUID(), { kind: "delivery", expectedVersion: current, bodyEn: "Fictional delivery policy.", bodyBn: "কাল্পনিক ডেলিভারি নীতি।" });
    const version = saved.value.version;
    // Not reviewed yet.
    expect(await errorCodeOf(publishPolicyOnce(db, owner, randomUUID(), { kind: "delivery", expectedVersion: version, approved: true }))).toBe("INVALID_INPUT");
    await markPolicyReviewedOnce(db, owner, randomUUID(), { kind: "delivery", expectedVersion: version });
    // No approval, or a stale version: refused.
    expect(await errorCodeOf(publishPolicyOnce(db, owner, randomUUID(), { kind: "delivery", expectedVersion: version, approved: false }))).toBe("INVALID_INPUT");
    expect(await errorCodeOf(publishPolicyOnce(db, owner, randomUUID(), { kind: "delivery", expectedVersion: version + 1, approved: true }))).toBe("VERSION_CONFLICT");
    expect(await publishedPolicies(db)).toEqual([]);

    await publishPolicyOnce(db, owner, randomUUID(), { kind: "delivery", expectedVersion: version, approved: true });
    const [published] = await publishedPolicies(db);
    expect(published).toMatchObject({ kind: "delivery", bodyEn: "Fictional delivery policy.", bodyBn: "কাল্পনিক ডেলিভারি নীতি।", draftVersion: version });

    // Editing the draft changes nothing customers see until the new version is published.
    await savePolicyDraftOnce(db, owner, randomUUID(), { kind: "delivery", expectedVersion: version, bodyEn: "Changed fictional text.", bodyBn: "বদলানো কাল্পনিক লেখা।" });
    expect((await publishedPolicies(db))[0].bodyEn).toBe("Fictional delivery policy.");

    await withdrawPolicyOnce(db, owner, randomUUID(), { kind: "delivery" });
    expect(await publishedPolicies(db)).toEqual([]);
    expect(await errorCodeOf(withdrawPolicyOnce(db, owner, randomUUID(), { kind: "delivery" }))).toBe("INVALID_INPUT");
    // The record is append-only.
    await expect(pool.query("update policy_publications set body_en = 'x' where kind = 'delivery'")).rejects.toThrow();
    // Leave no draft behind for later files, which start each kind at version 0 (the history is append-only and stays).
    await pool.query("delete from policy_drafts where kind = 'delivery'");
  });
});

describe("customers and the Owner", () => {
  it("links a signed-in customer's order in the order's transaction, once, and a guest's never", async () => {
    await mark(true);
    const p = await publishedProduct();
    const customer = await pool.query<{ id: string }>("insert into customer_users (name, email, email_verified) values ('Fictional Customer', $1, true) returning id", [`c-${randomUUID()}@example.test`]);
    const customerId = customer.rows[0].id;
    const key = randomUUID();
    const first = await placeGuestOrder(db, key, order(p.sku), { customerUserId: customerId });
    const replay = await placeGuestOrder(db, key, order(p.sku), { customerUserId: customerId });
    expect(replay.replayed).toBe(true);
    const guest = await placeGuestOrder(db, randomUUID(), order(p.sku));
    const listed = await customerOrderList(db, customerId);
    expect(listed.map((o) => o.reference)).toEqual([first.order.reference]);
    expect(listed[0]).toMatchObject({ orderStatus: "pending_verification", totalPaisa: 57_000 });
    expect((await pool.query("select 1 from customer_orders o join orders r on r.id = o.order_id where r.number::text = $1", [guest.order.reference.replace(/\D/g, "")])).rowCount).toBe(0);
  });

  it("can never give a customer Office access, even with the Owner's email", async () => {
    const email = "acceptance-owner@example.test";
    const twin = await pool.query<{ id: string }>("insert into customer_users (name, email, email_verified) values ('Same Email', $1, true) returning id", [email]);
    // Separate tables: the same address is a different person here, and user_access can only point at auth_users.
    await expect(pool.query("insert into user_access (user_id, role) values ($1, 'owner')", [twin.rows[0].id])).rejects.toThrow(/foreign key/);
    // No column, token or password from Google can be stored.
    await expect(
      pool.query("insert into customer_accounts (account_id, provider_id, user_id, access_token, updated_at) values ('g-1', 'google', $1, 'token', now())", [twin.rows[0].id]),
    ).rejects.toThrow(/customer_accounts_no_secrets/);
    await expect(pool.query("insert into customer_accounts (account_id, provider_id, user_id, password, updated_at) values ('c-1', 'credential', $1, 'x', now())", [twin.rows[0].id])).rejects.toThrow();
  });
});

describe("per-client checkout limit", () => {
  it("counts per client and hour, separately from the storewide minute", async () => {
    const client = createHash("sha256").update(randomUUID()).digest("hex");
    for (let i = 0; i < GUEST_CHECKOUTS_PER_CLIENT_PER_HOUR; i++) expect(await consumePublicLimit(db, `checkout-client:${client}`, GUEST_CHECKOUTS_PER_CLIENT_PER_HOUR, "hour")).toBe(true);
    expect(await consumePublicLimit(db, `checkout-client:${client}`, GUEST_CHECKOUTS_PER_CLIENT_PER_HOUR, "hour")).toBe(false);
    const other = createHash("sha256").update(randomUUID()).digest("hex");
    expect(await consumePublicLimit(db, `checkout-client:${other}`, GUEST_CHECKOUTS_PER_CLIENT_PER_HOUR, "hour")).toBe(true);
  });

  it("refuses a client over its limit with 429 and creates nothing", async () => {
    await mark(true);
    const p = await publishedProduct();
    const client = createHash("sha256").update(randomUUID()).digest("hex");
    await pool.query("insert into tracking_rate_limits (bucket, window_start, count) values ($1, date_trunc('hour', now()), $2)", [`checkout-client:${client}`, GUEST_CHECKOUTS_PER_CLIENT_PER_HOUR]);
    const before = (await pool.query("select count(*)::int as n from orders")).rows[0].n;
    const response = await guestCheckoutResponse(
      new Request(`${BASE}/api/shop/checkout`, { method: "POST", headers: { origin: BASE, "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify(order(p.sku)) }),
      { db, baseUrl: BASE, gate: () => ({ open: true }), clientKey: client },
    );
    expect(response.status).toBe(429);
    expect((await pool.query("select count(*)::int as n from orders")).rows[0].n).toBe(before);
  });
});

describe("the founder's Owner on the staging database", () => {
  it("is refused while an Owner has active access, and created (with its audit) once none has, without touching other accounts", async () => {
    const client = await connectTestClient();
    try {
      const input = { email: `staging-owner-${randomUUID()}@example.test`, name: "Staging Owner", password: "a fictional long staging password" };
      await expect(bootstrapStagingOwner(client, input)).rejects.toThrow(/already exists/);
      // The staging tests leave disabled accounts behind: they do not count, and they are not changed.
      await pool.query("update user_access set disabled_at = now() where disabled_at is null");
      const disabledBefore = (await pool.query("select count(*)::int as n from user_access where disabled_at is not null")).rows[0].n;
      await expect(bootstrapStagingOwner(client, { ...input, email: "acceptance-owner@example.test" })).rejects.toThrow(/email already exists/);
      const { userId } = await bootstrapStagingOwner(client, input);
      const { rows } = await pool.query<{ role: string; disabled: boolean; audited: number }>(
        "select a.role, a.disabled_at is not null as disabled, (select count(*)::int from auth_events e where e.subject_user_id = a.user_id and e.event = 'owner_created') as audited from user_access a where a.user_id = $1",
        [userId],
      );
      expect(rows[0]).toEqual({ role: "owner", disabled: false, audited: 1 });
      expect((await pool.query("select count(*)::int as n from user_access where disabled_at is not null")).rows[0].n).toBe(disabledBefore);
      await expect(bootstrapStagingOwner(client, { ...input, email: `second-${randomUUID()}@example.test` })).rejects.toThrow(/already exists/);
    } finally {
      await client.end();
    }
  });
});
