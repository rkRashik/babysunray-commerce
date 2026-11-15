import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/database";
import type { Principal } from "../../src/modules/auth/principal";
import { reviewProductOnce } from "../../src/modules/catalogue/operations";
import { reviewStates } from "../../src/modules/catalogue/review";
import { archiveProduct, createProduct, createVariant, replaceMeasurements, updateProduct, updateVariant } from "../../src/modules/catalogue/service";
import { createExport } from "../../src/modules/exports/service";
import { receiveStock } from "../../src/modules/inventory/service";
import { launchReadiness } from "../../src/modules/launch/readiness";
import { listPolicyDrafts, markPolicyReviewedOnce, savePolicyDraftOnce } from "../../src/modules/policies/drafts";
import { clearAuthState, count, createTestAuth, createVerifiedOwner } from "../support/auth";
import { errorCodeOf, TEST_ACTOR } from "../support/fixtures";
import { createTestDb } from "../support/test-database";

// Private launch preparation (Gate H.26): policy drafts, internal product reviews and the readiness overview,
// against PostgreSQL. Nothing here may publish anything or open checkout. Fictional data only.

let db: Db;
let pool: Pool;
let owner: Principal;
const key = () => randomUUID();
const forged = Object.freeze({ userId: "00000000-0000-0000-0000-000000000000", role: "owner" as const });
let counter = 0;

beforeAll(async () => {
  ({ db, pool } = await createTestDb(6));
  await clearAuthState(pool);
  ({ principal: owner } = await createVerifiedOwner(createTestAuth(db), db, pool, "launch-owner@example.test"));
  await pool.query("delete from auth_rate_limits");
});

afterAll(async () => {
  await pool?.end();
});

async function collect(chunks: AsyncGenerator<Uint8Array>) {
  const parts: Buffer[] = [];
  for await (const c of chunks) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}

const draft = async (kind: "delivery" | "returns" | "privacy" | "checkout_notices") => (await listPolicyDrafts(db, owner)).find((d) => d.kind === kind);
const save = (kind: "delivery" | "returns" | "privacy" | "checkout_notices", expectedVersion: number, bodyEn: string | null, bodyBn: string | null, k = key()) =>
  savePolicyDraftOnce(db, owner, k, { kind, expectedVersion, bodyEn, bodyBn });

describe("policy drafts", () => {
  it("are refused without a verified Owner", async () => {
    await expect(listPolicyDrafts(db, forged)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(await errorCodeOf(savePolicyDraftOnce(db, forged, key(), { kind: "delivery", expectedVersion: 0, bodyEn: "x", bodyBn: null }))).toBe("UNAUTHENTICATED");
    expect(await errorCodeOf(launchReadiness(db, forged))).toBe("UNAUTHENTICATED");
  });

  it("move from empty to drafted to reviewed, and any edit clears the review; every step is audited", async () => {
    expect(await draft("returns")).toMatchObject({ status: "empty", version: 0 });
    await save("returns", 0, "  Fictional English draft.  ", null);
    expect(await draft("returns")).toMatchObject({ status: "drafted", version: 1, bodyEn: "Fictional English draft.", bodyBn: null });
    expect(await errorCodeOf(markPolicyReviewedOnce(db, owner, key(), { kind: "returns", expectedVersion: 1 }))).toBe("INVALID_INPUT");
    await save("returns", 1, "Fictional English draft.", "কাল্পনিক বাংলা খসড়া।");
    await markPolicyReviewedOnce(db, owner, key(), { kind: "returns", expectedVersion: 2 });
    expect(await draft("returns")).toMatchObject({ status: "reviewed", version: 2 });
    await save("returns", 2, "Fictional English draft, changed.", "কাল্পনিক বাংলা খসড়া।");
    expect(await draft("returns")).toMatchObject({ status: "drafted", version: 3, reviewedAt: null });
    const { rows } = await pool.query("select event, version, actor_user_id, body_en_sha256 is not null as en, body_bn_sha256 is not null as bn from policy_draft_events where kind = 'returns' order by id");
    expect(rows).toEqual([
      { event: "saved", version: 1, actor_user_id: owner.userId, en: true, bn: false },
      { event: "saved", version: 2, actor_user_id: owner.userId, en: true, bn: true },
      { event: "marked_reviewed", version: 2, actor_user_id: owner.userId, en: true, bn: true },
      { event: "saved", version: 3, actor_user_id: owner.userId, en: true, bn: true },
    ]);
    await expect(pool.query("delete from policy_draft_events")).rejects.toThrow(/append-only/);
  });

  it("refuse a stale version and a second first save, and saving the same text changes nothing", async () => {
    const [a, b] = await Promise.allSettled([save("privacy", 0, "First tab.", null), save("privacy", 0, "Second tab.", null)]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect((([a, b].find((r) => r.status === "rejected") as PromiseRejectedResult).reason as { code: string }).code).toBe("VERSION_CONFLICT");
    const current = await draft("privacy");
    expect(current?.version).toBe(1);
    expect(await errorCodeOf(save("privacy", 0, "Stale tab.", null))).toBe("VERSION_CONFLICT");
    const events = await count(pool, "select count(*) from policy_draft_events where kind = 'privacy'");
    await save("privacy", 1, current?.bodyEn ?? null, null);
    expect(await count(pool, "select count(*) from policy_draft_events where kind = 'privacy'")).toBe(events);
    expect((await draft("privacy"))?.version).toBe(1);
  });

  it("keep pasted markup as plain text, refuse control characters and over-long text, and replay a retried save", async () => {
    const markup = '<script>alert("x")</script><img src=x onerror=alert(1)>';
    const k = key();
    const first = await save("checkout_notices", 0, markup, null, k);
    const replay = await save("checkout_notices", 0, markup, null, k);
    expect(replay.replayed).toBe(true);
    expect(replay.value.version).toBe(first.value.version);
    expect((await draft("checkout_notices"))?.bodyEn).toBe(markup);
    expect(await errorCodeOf(save("checkout_notices", 1, "bad\u0007bell", null))).toBe("INVALID_INPUT");
    expect(await errorCodeOf(save("checkout_notices", 1, "x".repeat(20_001), null))).toBe("INVALID_INPUT");
  });

  it("are included in an Owner export (and its audit), unpublished", async () => {
    await save("delivery", 0, "Fictional delivery draft.", "কাল্পনিক ডেলিভারি খসড়া।");
    const file = await createExport(db, owner, { dataset: "policy_drafts", format: "json", filters: {} });
    const text = (await collect(file.chunks)).toString("utf8");
    expect(text).toContain("Fictional delivery draft.");
    expect(text).not.toContain('"published"');
    expect(await count(pool, "select count(*) from export_requests where dataset = 'policy_drafts'")).toBe(1);
  });
});

describe("internal product review", () => {
  async function product(complete = true) {
    counter += 1;
    const p = await createProduct(db, { slug: `review-p-${counter}`, nameEn: "Review Romper", nameBn: complete ? "রিভিউ রম্পার" : null, descriptionEn: "Fictional.", descriptionBn: complete ? "কাল্পনিক।" : null });
    const v = await createVariant(db, { productId: p.id, sku: `REVIEW-${counter}`, size: "0-3M", colour: "Ivory", pricePaisa: 60_000 });
    return { id: p.id, variantId: v.id, sku: v.sku };
  }
  const state = async (id: string) => (await reviewStates(db, [id])).get(id);
  const review = async (id: string) => reviewProductOnce(db, owner, key(), { productId: id, contentSha256: (await state(id))?.contentSha256 ?? "" });

  it("requires the founder-stated content and records what was still open", async () => {
    const incomplete = await product(false);
    expect(await errorCodeOf(review(incomplete.id))).toBe("PRODUCT_NOT_REVIEWABLE");
    const p = await product();
    await review(p.id);
    expect(await state(p.id)).toMatchObject({ current: true });
    const { rows } = await pool.query<{ open_items: string[]; reviewed_by_user_id: string }>("select open_items, reviewed_by_user_id from product_reviews where product_id = $1", [p.id]);
    expect(rows[0].reviewed_by_user_id).toBe(owner.userId);
    expect(rows[0].open_items).toEqual(expect.arrayContaining(["measurements", "fabric", "care", "policies", "photo"]));
    expect(await errorCodeOf(reviewProductOnce(db, forged, key(), { productId: p.id, contentSha256: "0".repeat(64) }))).toBe("UNAUTHENTICATED");
    await expect(pool.query("update product_reviews set open_items = '[]'")).rejects.toThrow(/append-only/);
  });

  it("refuses a review of content the Owner did not see, and archived products", async () => {
    const p = await product();
    const seen = (await state(p.id))?.contentSha256 ?? "";
    await updateVariant(db, p.variantId, 1, { pricePaisa: 61_000 });
    expect(await errorCodeOf(reviewProductOnce(db, owner, key(), { productId: p.id, contentSha256: seen }))).toBe("VERSION_CONFLICT");
    expect(await errorCodeOf(reviewProductOnce(db, owner, key(), { productId: p.id, contentSha256: "not-a-digest" }))).toBe("INVALID_INPUT");
    await archiveProduct(db, p.id);
    expect(await errorCodeOf(review(p.id))).toBe("PRODUCT_NOT_REVIEWABLE");
  });

  it("is outdated by any content, claim, size, SKU or price change, but not by stock", async () => {
    const p = await product();
    await review(p.id);
    await receiveStock(db, { sku: p.sku, quantity: 4, actor: TEST_ACTOR });
    expect((await state(p.id))?.current).toBe(true);
    await updateProduct(db, p.id, 1, { fabricEn: "Fictional fabric." });
    expect((await state(p.id))?.current).toBe(false);
    await review(p.id);
    await replaceMeasurements(db, p.id, 2, [{ size: "0-3M", point: "chest", valueMm: 420 }]);
    expect((await state(p.id))?.current).toBe(false);
    await review(p.id);
    await createVariant(db, { productId: p.id, sku: `${p.sku}-B`, size: "3-6M", colour: "Ivory", pricePaisa: 60_000 });
    expect((await state(p.id))?.current).toBe(false);
    await review(p.id);
    const { rows } = await pool.query<{ version: number }>("select version from products where id = $1", [p.id]);
    await updateProduct(db, p.id, rows[0].version, { featured: true });
    expect((await state(p.id))?.current).toBe(true);
  });
});

describe("launch readiness", () => {
  it("keeps the gate closed and never shows a policy as ready, even when every draft is reviewed", async () => {
    for (const kind of ["delivery", "returns", "privacy", "checkout_notices"] as const) {
      const d = await draft(kind);
      const saved = await save(kind, d?.version ?? 0, `Fictional ${kind} text, final.`, "কাল্পনিক চূড়ান্ত লেখা।");
      await markPolicyReviewedOnce(db, owner, key(), { kind, expectedVersion: saved.value.version });
    }
    const readiness = await launchReadiness(db, owner);
    expect(readiness.gate.open).toBe(false);
    expect(readiness.gate.blockers.map((b) => b.id)).toContain("policies_not_published");
    const policies = readiness.sections.find((s) => s.id === "policies")?.checks ?? [];
    expect(policies.map((c) => c.status)).toEqual(["founder_approval", "founder_approval", "founder_approval", "founder_approval", "founder_approval"]);
    const operations = readiness.sections.find((s) => s.id === "operations")?.checks ?? [];
    expect(operations.some((c) => c.status === "ready")).toBe(false);
    expect(readiness.sections.find((s) => s.id === "commerce")?.checks.find((c) => c.id === "checkout_disabled")?.status).toBe("ready");
  });

  it("checks stock and order integrity against the live data", async () => {
    const ok = await launchReadiness(db, owner);
    expect(ok.sections.find((s) => s.id === "commerce")?.checks.find((c) => c.id === "integrity")?.status).toBe("ready");
    const p = await product();
    await receiveStock(db, { sku: p.sku, quantity: 2, actor: TEST_ACTOR });
    // A balance that disagrees with its ledger is found (inside a transaction that is rolled back).
    const found = await db
      .transaction(async (tx) => {
        await tx.execute(sql`update inventory_balances set on_hand = on_hand + 1 where variant_id = ${p.variantId}`);
        const r = await launchReadiness(tx, owner);
        throw Object.assign(new Error("rollback"), { result: r });
      })
      .catch((e: { result?: Awaited<ReturnType<typeof launchReadiness>> }) => e.result);
    const integrity = found?.sections.find((s) => s.id === "commerce")?.checks.find((c) => c.id === "integrity");
    expect(integrity?.status).toBe("incomplete");
    expect(integrity?.evidence).toContain("1 ledger mismatches");
    expect((await launchReadiness(db, owner)).sections.find((s) => s.id === "commerce")?.checks.find((c) => c.id === "integrity")?.status).toBe("ready");
  });

  async function product() {
    counter += 1;
    const p = await createProduct(db, { slug: `launch-p-${counter}`, nameEn: "Launch Romper", nameBn: "লঞ্চ রম্পার" });
    const v = await createVariant(db, { productId: p.id, sku: `LAUNCH-${counter}`, size: "0-3M", colour: "Ivory", pricePaisa: 60_000 });
    return { id: p.id, variantId: v.id, sku: v.sku };
  }
});
