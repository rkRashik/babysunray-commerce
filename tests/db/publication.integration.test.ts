import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/database";
import { actorFor, type Principal } from "../../src/modules/auth/principal";
import { reviewProductOnce } from "../../src/modules/catalogue/operations";
import { publicationHistory, publicationState, publishProduct, publishProductOnce, withdrawProduct, withdrawProductOnce } from "../../src/modules/catalogue/publication";
import { archiveProduct, createProduct, createVariant, deactivateVariant, replaceMeasurements, updateProduct, updateVariant } from "../../src/modules/catalogue/service";
import { receiveStock } from "../../src/modules/inventory/service";
import { launchReadiness } from "../../src/modules/launch/readiness";
import { setDeliveryZoneOnce, submitOrderOnce } from "../../src/modules/orders/operations";
import { getOrderDetail } from "../../src/modules/orders/queries";
import { clearAuthState, count, createTestAuth, createVerifiedOwner } from "../support/auth";
import { errorCodeOf, TEST_ACTOR } from "../support/fixtures";
import { contentDigestOf, publishNow, reviewNow, TEST_PUBLICATION_RULE, withdrawNow } from "../support/publication";
import { createTestDb } from "../support/test-database";

// The publication foundation (Gate H.32) against PostgreSQL: the real operation refuses (no approved rule), and the
// mechanics are proven with a test-only rule on fictional products. Races hold the product row from another
// session until PostgreSQL reports every attempt blocked, so the overlap is proven, not hoped for.

let db: Db;
let pool: Pool;
let owner: Principal;
let n = 0;

beforeAll(async () => {
  ({ db, pool } = await createTestDb(8));
  await clearAuthState(pool);
  ({ principal: owner } = await createVerifiedOwner(createTestAuth(db), db, pool, "publication-owner@example.test"));
  for (const code of ["dhaka_city", "outside_dhaka"] as const) {
    const { rows } = await pool.query<{ version: number }>("select version from delivery_zones where code = $1", [code]);
    await setDeliveryZoneOnce(db, owner, randomUUID(), { code, chargePaisa: 6_000, active: true, expectedVersion: rows[0]?.version ?? null });
  }
});

afterAll(async () => {
  await pool?.end();
});

/** A draft with both names and descriptions and one priced SKU in stock: the founder-stated readiness items. */
async function draft(stock = 3) {
  n += 1;
  const product = await createProduct(db, { slug: `pub-${n}`, nameEn: "Publication Test Romper", nameBn: "প্রকাশ পরীক্ষা রম্পার", descriptionEn: "Fictional.", descriptionBn: "কাল্পনিক।" });
  const variant = await createVariant(db, { productId: product.id, sku: `PUB-${n}`, size: "0-3M", colour: "Ivory", pricePaisa: 55_000 });
  if (stock) await receiveStock(db, { sku: variant.sku, quantity: stock, actor: TEST_ACTOR });
  return { productId: product.id, variantId: variant.id, sku: variant.sku };
}
const statusOf = async (productId: string) => (await pool.query<{ status: string }>("select status from products where id = $1", [productId])).rows[0].status;
const versionOf = async (productId: string) => (await pool.query<{ version: number }>("select version from products where id = $1", [productId])).rows[0].version;
const events = (productId: string) => count(pool, "select count(*) from product_publication_events where product_id = $1", [productId]);

/** Holds the product row from another session, starts `attempts` each on its own connection, then releases it. */
async function race(productId: string, attempts: (racingDb: Db) => Promise<unknown>[]) {
  const { db: racingDb, pool: racingPool } = await createTestDb(4);
  const gate = await pool.connect();
  try {
    await gate.query("begin");
    await gate.query("select id from products where id = $1 for update", [productId]);
    const runs = attempts(racingDb).map((p) => p.then(() => "ok", (error: unknown) => (error as { code?: string }).code ?? String(error)));
    const deadline = Date.now() + 10_000;
    while ((await count(pool, "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'")) < runs.length) {
      if (Date.now() > deadline) throw new Error("The attempts were not all blocked.");
      await new Promise((r) => setTimeout(r, 20));
    }
    await gate.query("commit");
    return await Promise.all(runs);
  } finally {
    gate.release();
    await racingPool.end();
  }
}

describe("no approved publication rule", () => {
  it("the real operation refuses every product and changes nothing; it checks the caller first", async () => {
    const p = await draft();
    await reviewNow(db, owner, p.productId);
    const digest = await contentDigestOf(db, p.productId);
    expect(await errorCodeOf(publishProductOnce(db, owner, randomUUID(), { productId: p.productId, contentSha256: digest }))).toBe("PUBLICATION_NOT_APPROVED");
    expect(await errorCodeOf(publishProductOnce(db, null as unknown as Principal, randomUUID(), { productId: p.productId, contentSha256: digest }))).toBe("UNAUTHENTICATED");
    expect(await errorCodeOf(publishProductOnce(db, { userId: randomUUID(), role: "owner" }, randomUUID(), { productId: p.productId, contentSha256: digest }))).toBe("UNAUTHENTICATED");
    expect(await statusOf(p.productId)).toBe("draft");
    expect(await events(p.productId)).toBe(0);
    expect((await publicationState(db, p.productId)).blockers).toEqual(["no_approved_rule"]);
  });
});

describe("publishing under a rule (test-only rule)", () => {
  it("needs a current review of exactly the content shown, and the founder-stated items whatever the rule says", async () => {
    const p = await draft();
    const actor = actorFor(owner);
    const publish = (digest: string) => db.transaction((tx) => publishProduct(tx, p.productId, digest, TEST_PUBLICATION_RULE, actor));
    expect(await errorCodeOf(publish(await contentDigestOf(db, p.productId)))).toBe("PRODUCT_NOT_PUBLISHABLE");
    expect((await publicationState(db, p.productId, TEST_PUBLICATION_RULE)).blockers).toEqual(["review_not_current"]);
    await reviewNow(db, owner, p.productId);
    const reviewed = await contentDigestOf(db, p.productId);
    // The content changed after the screen was loaded: refused, even though it was reviewed.
    await updateProduct(db, p.productId, 1, { careEn: "Fictional care." });
    expect(await errorCodeOf(publish(reviewed))).toBe("VERSION_CONFLICT");
    expect((await publicationState(db, p.productId, TEST_PUBLICATION_RULE)).blockers).toEqual(["review_not_current"]);
    // A rule can add items but never drop the founder-stated ones.
    await updateProduct(db, p.productId, 2, { nameBn: null });
    await reviewNow(db, owner, p.productId).catch(() => undefined);
    expect((await publicationState(db, p.productId, { id: "lenient-test", items: [] })).blockers).toEqual(["review_not_current", "item:name"]);
    expect((await publicationState(db, p.productId, { id: "strict-test", items: ["care", "fabric"] })).blockers).toEqual(["review_not_current", "item:name", "item:care", "item:fabric"]);
    expect(await statusOf(p.productId)).toBe("draft");
    expect(await events(p.productId)).toBe(0);
  });

  it("publishes once: status, version, and one history row with the reviewed digest, the rule and the actor", async () => {
    const p = await draft();
    const before = await versionOf(p.productId);
    const published = await publishNow(db, owner, p.productId);
    expect(published).toMatchObject({ status: "published", version: before + 1 });
    const [event] = await publicationHistory(db, p.productId);
    expect(event).toMatchObject({ event: "published", contentSha256: await contentDigestOf(db, p.productId), ruleId: "test-rule", actorUserId: owner.userId });
    expect(await errorCodeOf(publishNow(db, owner, p.productId))).toBe("PRODUCT_NOT_REVIEWABLE");
    const digest = await contentDigestOf(db, p.productId);
    expect(await errorCodeOf(db.transaction((tx) => publishProduct(tx, p.productId, digest, TEST_PUBLICATION_RULE, actorFor(owner))))).toBe("PRODUCT_NOT_PUBLISHABLE");
    expect(await events(p.productId)).toBe(1);
  });

  it("freezes a published product's content; stock and deactivating a SKU still work", async () => {
    const p = await draft();
    const extra = await createVariant(db, { productId: p.productId, sku: `PUB-${n}-B`, size: "3-6M", pricePaisa: 55_000 });
    await publishNow(db, owner, p.productId);
    const v = await versionOf(p.productId);
    const refusals = await Promise.all([
      errorCodeOf(updateProduct(db, p.productId, v, { careEn: "Changed." })),
      errorCodeOf(updateVariant(db, p.variantId, 1, { pricePaisa: 1 })),
      errorCodeOf(createVariant(db, { productId: p.productId, sku: `PUB-${n}-C`, pricePaisa: 100 })),
      errorCodeOf(replaceMeasurements(db, p.productId, v, [{ size: "0-3M", point: "chest", valueMm: 250 }])),
      errorCodeOf(archiveProduct(db, p.productId)),
      errorCodeOf(reviewProductOnce(db, owner, randomUUID(), { productId: p.productId, contentSha256: await contentDigestOf(db, p.productId) })),
    ]);
    expect(refusals).toEqual(["PRODUCT_NOT_EDITABLE", "VARIANT_NOT_EDITABLE", "PRODUCT_NOT_EDITABLE", "PRODUCT_NOT_EDITABLE", "PRODUCT_NOT_EDITABLE", "PRODUCT_NOT_REVIEWABLE"]);
    expect((await receiveStock(db, { sku: p.sku, quantity: 2, actor: TEST_ACTOR })).onHand).toBe(5);
    expect((await deactivateVariant(db, extra.id)).status).toBe("inactive");
    expect(await statusOf(p.productId)).toBe("published");
  });

  it("a content edit racing a publication never leaves a published product with unreviewed content", async () => {
    const p = await draft();
    await reviewNow(db, owner, p.productId);
    const digest = await contentDigestOf(db, p.productId);
    const outcomes = await race(p.productId, (racingDb) => [
      racingDb.transaction((tx) => publishProduct(tx, p.productId, digest, TEST_PUBLICATION_RULE, actorFor(owner))),
      updateProduct(racingDb, p.productId, 1, { careEn: "Racing edit." }),
    ]);
    // Whichever took the row first, the other was refused.
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
    expect(outcomes.filter((o) => o !== "ok")[0]).toMatch(/^(VERSION_CONFLICT|PRODUCT_NOT_EDITABLE)$/);
    if ((await statusOf(p.productId)) === "published") {
      expect((await publicationHistory(db, p.productId))[0].contentSha256).toBe(await contentDigestOf(db, p.productId));
    } else {
      expect(await events(p.productId)).toBe(0);
    }
  });

  it("a price change committed while a publication waits for the product is seen, and the publication is refused", async () => {
    const p = await draft();
    await reviewNow(db, owner, p.productId);
    const digest = await contentDigestOf(db, p.productId);
    const { db: racingDb, pool: racingPool } = await createTestDb(2);
    const writer = await pool.connect();
    try {
      // What updateVariant does: lock the product (not update it), then change a variant.
      await writer.query("begin");
      await writer.query("select id from products where id = $1 for share", [p.productId]);
      await writer.query("update variants set price_paisa = price_paisa + 100, version = version + 1 where id = $1", [p.variantId]);
      const attempt = racingDb.transaction((tx) => publishProduct(tx, p.productId, digest, TEST_PUBLICATION_RULE, actorFor(owner))).then(
        () => "ok",
        (error: unknown) => (error as { code?: string }).code,
      );
      const deadline = Date.now() + 10_000;
      while ((await count(pool, "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'")) < 1) {
        if (Date.now() > deadline) throw new Error("The publication was not blocked.");
        await new Promise((r) => setTimeout(r, 20));
      }
      await writer.query("commit");
      expect(await attempt).toBe("VERSION_CONFLICT");
      expect(await statusOf(p.productId)).toBe("draft");
      expect(await events(p.productId)).toBe(0);
    } finally {
      writer.release();
      await racingPool.end();
    }
  });

  it("two simultaneous publications publish once and record one event", async () => {
    const p = await draft();
    await reviewNow(db, owner, p.productId);
    const digest = await contentDigestOf(db, p.productId);
    const outcomes = await race(p.productId, (racingDb) =>
      [1, 2].map(() => racingDb.transaction((tx) => publishProduct(tx, p.productId, digest, TEST_PUBLICATION_RULE, actorFor(owner)))),
    );
    expect(outcomes.sort()).toEqual(["PRODUCT_NOT_PUBLISHABLE", "ok"]);
    expect(await events(p.productId)).toBe(1);
  });
});

describe("withdrawing", () => {
  it("returns the product to draft, keeps its orders and stock, and records who and when", async () => {
    const p = await draft(4);
    await publishNow(db, owner, p.productId);
    const order = (await submitOrderOnce(db, owner, randomUUID(), { source: "whatsapp", customerName: "Fictional Buyer", customerPhone: "01711000901", deliveryAddress: "House 1, Fictional Road", deliveryZone: "dhaka_city", items: [{ sku: p.sku, quantity: 2 }] })).value;
    const v = await versionOf(p.productId);
    expect(await errorCodeOf(db.transaction((tx) => withdrawProduct(tx, p.productId, v - 1, actorFor(owner))))).toBe("VERSION_CONFLICT");
    const key = randomUUID();
    const first = await withdrawProductOnce(db, owner, key, { productId: p.productId, expectedVersion: v });
    expect(first.value).toMatchObject({ status: "draft", version: v + 1 });
    expect((await withdrawProductOnce(db, owner, key, { productId: p.productId, expectedVersion: v })).replayed).toBe(true);
    expect(await errorCodeOf(withdrawNow(db, owner, p.productId))).toBe("PRODUCT_NOT_PUBLISHABLE");
    expect((await publicationHistory(db, p.productId)).map((e) => e.event)).toEqual(["withdrawn", "published"]);
    // The order, its snapshot and its hold are untouched; the product is editable again.
    const after = await getOrderDetail(db, order.id);
    expect(after.items).toEqual(order.items);
    expect(after.reservations.filter((r) => r.status === "active")).toHaveLength(1);
    expect((await updateProduct(db, p.productId, v + 1, { careEn: "Editable again." })).version).toBe(v + 2);
    expect((await archiveProduct(db, p.productId)).status).toBe("archived");
  });
});

describe("history and oversight", () => {
  it("the publication history is append-only", async () => {
    const p = await draft();
    await publishNow(db, owner, p.productId);
    for (const statement of ["update product_publication_events set rule_id = 'x'", "delete from product_publication_events", "truncate product_publication_events"]) {
      await expect(pool.query(statement)).rejects.toThrow(/append-only/);
    }
  });

  it("launch readiness reports a published product as unexpected while no rule is approved", async () => {
    const check = async () => (await launchReadiness(db, owner)).sections.find((s) => s.id === "catalogue")!.checks.find((c) => c.id === "publication")!;
    await pool.query("update products set status = 'draft' where status = 'published'");
    expect((await check()).status).toBe("founder_approval");
    const p = await draft();
    await publishNow(db, owner, p.productId);
    expect(await check()).toMatchObject({ status: "incomplete", evidence: expect.stringContaining("not done through the application") });
  });
});
