import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/database";
import type { Principal } from "../../src/modules/auth/principal";
import { withdrawProductOnce } from "../../src/modules/catalogue/publication";
import { createProduct, createVariant, getProductWithVariants } from "../../src/modules/catalogue/service";
import { receiveStock } from "../../src/modules/inventory/service";
import { cdnPublicId, type CdnClient, CdnError } from "../../src/modules/media/cdn";
import { type CdnDeps, publishPhotosToCdn, reconcileCdn, withdrawPhotosFromCdn } from "../../src/modules/media/cdn-sync";
import { removePhotoOnce, uploadPhotoOnce } from "../../src/modules/media/operations";
import { localMediaStore, type MediaStore } from "../../src/modules/media/storage";
import { runMaintenance } from "../../src/modules/maintenance/jobs";
import { getPublicProduct, listPublicProducts } from "../../src/modules/storefront/public-catalogue";
import { clearAuthState, createTestAuth, createVerifiedOwner } from "../support/auth";
import { errorCodeOf, TEST_ACTOR } from "../support/fixtures";
import { tempMediaDir, testImage } from "../support/images";
import { publishNow, withdrawNow } from "../support/publication";
import { createTestDb } from "../support/test-database";

// Cloudinary copies of PUBLISHED product photos (Gate H.57): uploaded only after publication, destroyed after withdrawal,
// never orphaned, and public URLs produced only while the database says the product is published. Cloudinary is a
// recording fake (no network); the database and the photo files are real. Fictional data only.

const ENV = { CLOUDINARY_CLOUD_NAME: "demo-cloud", CLOUDINARY_API_KEY: "123456789012345", CLOUDINARY_API_SECRET: "fictional-secret-value" };

let db: Db;
let pool: Pool;
let owner: Principal;
let media: { dir: string; cleanup: () => void };
let store: MediaStore;
let n = 0;

beforeAll(async () => {
  ({ db, pool } = await createTestDb(6));
  await clearAuthState(pool);
  ({ principal: owner } = await createVerifiedOwner(createTestAuth(db), db, pool, "cdn-owner@example.test"));
  media = tempMediaDir("cdn");
  store = localMediaStore(media.dir);
  vi.stubEnv("MEDIA_STORAGE_DIR", media.dir);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  // The database is shared by the next test files, and the media tests compare every photo record with their own folder.
  await pool?.query("delete from product_media where product_id in (select id from products where slug like 'cdn-%')");
  media?.cleanup();
  await pool?.end();
});

/** A recording fake Cloudinary; `failing` makes the next calls fail like a network or HTTP error. */
function fake() {
  const calls: { op: "upload" | "destroy"; publicId: string }[] = [];
  const state = { failing: false, beforeUpload: null as null | (() => Promise<void>) };
  const client: CdnClient = {
    async upload(publicId) {
      await state.beforeUpload?.();
      if (state.failing) throw new CdnError(503);
      calls.push({ op: "upload", publicId });
    },
    async destroy(publicId) {
      if (state.failing) throw new CdnError(503);
      calls.push({ op: "destroy", publicId });
    },
  };
  const deps: CdnDeps = { config: { cloudName: "demo-cloud", apiKey: "k", apiSecret: "s", folder: "test/products" }, client, store: () => store };
  return { calls, state, deps };
}

/** A draft with one SKU and `photos` stored photos. */
async function product(photos = 1) {
  n += 1;
  const p = await createProduct(db, { slug: `cdn-${n}`, nameEn: "CDN Test Romper", nameBn: "সিডিএন পরীক্ষা", descriptionEn: "Fictional.", descriptionBn: "কাল্পনিক।" });
  const v = await createVariant(db, { productId: p.id, sku: `CDN-${n}`, size: "0-3M", colour: "Ivory", pricePaisa: 55_000 });
  await receiveStock(db, { sku: v.sku, quantity: 2, actor: TEST_ACTOR });
  for (let i = 0; i < photos; i += 1) {
    const version = (await getProductWithVariants(db, p.id)).version;
    await uploadPhotoOnce(db, owner, randomUUID(), { productId: p.id, expectedVersion: version, bytes: await testImage("jpeg", 500 + i, 400, { colour: 20 + i * 40 }), altEn: "Alt", altBn: "বিকল্প" }, store);
  }
  return { id: p.id, slug: p.slug };
}
const rows = async (productId: string) => (await pool.query<{ id: string; sha256: string; cdn: string | null }>("select id, sha256, cdn_public_id as cdn from product_media where product_id = $1 order by position", [productId])).rows;
const withEnv = <T>(work: () => Promise<T>) => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  return work().finally(() => { for (const k of Object.keys(ENV)) vi.stubEnv(k, ""); });
};

describe("publication to the CDN", () => {
  it("never uploads a draft's photos, and uploads a published product's once each with a content-addressed id", async () => {
    const p = await product(2);
    const cdn = fake();
    expect(await publishPhotosToCdn(db, p.id, cdn.deps)).toEqual({ uploaded: 0, destroyed: 0, failed: 0 });
    expect(cdn.calls).toEqual([]);
    expect((await rows(p.id)).every((r) => r.cdn === null)).toBe(true);

    await publishNow(db, owner, p.id);
    expect(await publishPhotosToCdn(db, p.id, cdn.deps)).toEqual({ uploaded: 2, destroyed: 0, failed: 0 });
    const after = await rows(p.id);
    expect(after.map((r) => r.cdn)).toEqual(after.map((r) => cdnPublicId(cdn.deps.config, r)));
    expect(cdn.calls.map((c) => c.op)).toEqual(["upload", "upload"]);
    // Repeating finds nothing to do.
    expect(await publishPhotosToCdn(db, p.id, cdn.deps)).toEqual({ uploaded: 0, destroyed: 0, failed: 0 });
    expect(cdn.calls).toHaveLength(2);
  });
  it("does nothing, and sends nothing, without a CDN configuration", async () => {
    const p = await product(1);
    await publishNow(db, owner, p.id);
    expect(await publishPhotosToCdn(db, p.id, null)).toEqual({ uploaded: 0, destroyed: 0, failed: 0 });
    expect(await reconcileCdn(db, null)).toEqual({ uploaded: 0, destroyed: 0, failed: 0 });
    expect((await rows(p.id))[0].cdn).toBeNull();
  });
  it("a failed upload records nothing and is retried by the reconcile job", async () => {
    const p = await product(1);
    await publishNow(db, owner, p.id);
    const cdn = fake();
    cdn.state.failing = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await publishPhotosToCdn(db, p.id, cdn.deps)).toEqual({ uploaded: 0, destroyed: 0, failed: 1 });
    expect((await rows(p.id))[0].cdn).toBeNull();
    cdn.state.failing = false;
    expect((await reconcileCdn(db, cdn.deps)).uploaded).toBeGreaterThanOrEqual(1);
    expect((await rows(p.id))[0].cdn).not.toBeNull();
    vi.restoreAllMocks();
  });
  it("a product withdrawn while its photo is uploading ends with no copy and no record", async () => {
    const p = await product(1);
    await publishNow(db, owner, p.id);
    const cdn = fake();
    cdn.state.beforeUpload = async () => {
      cdn.state.beforeUpload = null;
      await withdrawNow(db, owner, p.id);
    };
    const result = await publishPhotosToCdn(db, p.id, cdn.deps);
    expect(result.failed).toBe(0);
    expect(cdn.calls.map((c) => c.op)).toEqual(["upload", "destroy"]);
    expect((await rows(p.id))[0].cdn).toBeNull();
  });
});

describe("public URLs follow the database, not Cloudinary", () => {
  it("a published product's photo has Cloudinary URLs only once its copy is recorded; a withdrawn product shows nothing at all", async () => {
    const p = await product(1);
    await publishNow(db, owner, p.id);
    await withEnv(async () => {
      expect((await getPublicProduct(db, p.slug))!.photos[0].images).toBeNull();
      const cdn = fake();
      await publishPhotosToCdn(db, p.id, cdn.deps);
      const [photo] = (await getPublicProduct(db, p.slug))!.photos;
      const id = (await rows(p.id))[0].cdn!;
      expect(photo.images!.src).toBe(`https://res.cloudinary.com/demo-cloud/image/upload/f_auto,q_auto,c_limit,w_640/${id}`);
      expect(photo.images!.srcSet).toContain(`w_1280/${id} 1280w`);
      const card = (await listPublicProducts(db, {})).items.find((c) => c.slug === p.slug)!;
      expect(card.photo!.images!.src).toContain(id);
      // Withdrawn: the database stops the URLs at once, whatever state Cloudinary is in.
      cdn.state.failing = true;
      await withdrawNow(db, owner, p.id);
      expect(await getPublicProduct(db, p.slug)).toBeNull();
      expect((await listPublicProducts(db, {})).items.find((c) => c.slug === p.slug)).toBeUndefined();
    });
  });
  it("without CLOUDINARY_* settings the DTO carries images: null even when a copy is recorded", async () => {
    const p = await product(1);
    await publishNow(db, owner, p.id);
    await publishPhotosToCdn(db, p.id, fake().deps);
    expect((await getPublicProduct(db, p.slug))!.photos[0].images).toBeNull();
  });
});

describe("withdrawal and edits", () => {
  it("destroys the copy after withdrawal, never while the product is published", async () => {
    const p = await product(1);
    await publishNow(db, owner, p.id);
    const cdn = fake();
    await publishPhotosToCdn(db, p.id, cdn.deps);
    expect(await withdrawPhotosFromCdn(db, p.id, cdn.deps)).toEqual({ uploaded: 0, destroyed: 0, failed: 0 });
    await reconcileCdn(db, cdn.deps); // may finish other tests' leftovers, but never this published product's copy
    const recorded = (await rows(p.id))[0].cdn;
    expect(recorded).not.toBeNull();
    expect(cdn.calls.filter((c) => c.op === "destroy" && c.publicId === recorded)).toEqual([]);

    await withdrawNow(db, owner, p.id);
    expect(await withdrawPhotosFromCdn(db, p.id, cdn.deps)).toEqual({ uploaded: 0, destroyed: 1, failed: 0 });
    expect(cdn.calls.at(-1)!.op).toBe("destroy");
    expect((await rows(p.id))[0].cdn).toBeNull();
  });
  it("a failed destroy keeps the record, blocks replacing or removing that photo (no orphaned public copy), and the reconcile job finishes it", async () => {
    const p = await product(1);
    await publishNow(db, owner, p.id);
    const cdn = fake();
    await publishPhotosToCdn(db, p.id, cdn.deps);
    await withdrawNow(db, owner, p.id);
    cdn.state.failing = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await withdrawPhotosFromCdn(db, p.id, cdn.deps)).toEqual({ uploaded: 0, destroyed: 0, failed: 1 });
    const [photo] = await rows(p.id);
    expect(photo.cdn).not.toBeNull();

    const version = (await getProductWithVariants(db, p.id)).version;
    expect(await errorCodeOf(removePhotoOnce(db, owner, randomUUID(), { productId: p.id, mediaId: photo.id, expectedVersion: version }, store))).toBe("PRODUCT_NOT_EDITABLE");
    expect(await errorCodeOf(uploadPhotoOnce(db, owner, randomUUID(), { productId: p.id, expectedVersion: version, bytes: await testImage("png"), replaceMediaId: photo.id }, store))).toBe("PRODUCT_NOT_EDITABLE");
    expect((await rows(p.id))).toHaveLength(1);

    cdn.state.failing = false;
    expect((await reconcileCdn(db, cdn.deps)).destroyed).toBeGreaterThanOrEqual(1);
    expect((await rows(p.id))[0].cdn).toBeNull();
    await removePhotoOnce(db, owner, randomUUID(), { productId: p.id, mediaId: photo.id, expectedVersion: version }, store);
    expect(await rows(p.id)).toHaveLength(0);
    vi.restoreAllMocks();
  });
  it("a replaced photo in a draft gets a new content-addressed URL (the old one is never reused)", async () => {
    const p = await product(1);
    const [before] = await rows(p.id);
    const version = (await getProductWithVariants(db, p.id)).version;
    await uploadPhotoOnce(db, owner, randomUUID(), { productId: p.id, expectedVersion: version, bytes: await testImage("jpeg", 640, 480, { colour: 200 }), replaceMediaId: before.id }, store);
    const [after] = await rows(p.id);
    expect(after.id).not.toBe(before.id);
    expect(cdnPublicId({ folder: "x" }, after)).not.toBe(cdnPublicId({ folder: "x" }, before));
  });
  it("withdrawProductOnce destroys the copy through the configured client after the commit (signed request, no secret in it)", async () => {
    const p = await product(1);
    await publishNow(db, owner, p.id);
    await publishPhotosToCdn(db, p.id, fake().deps);
    const recorded = (await rows(p.id))[0].cdn;
    const sent: FormData[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: FormData }) => {
      expect(url).toBe("https://api.cloudinary.com/v1_1/demo-cloud/image/destroy");
      sent.push(init.body);
      return new Response(JSON.stringify({ result: "ok" }), { status: 200 });
    });
    await withEnv(async () => {
      const version = (await getProductWithVariants(db, p.id)).version;
      await withdrawProductOnce(db, owner, randomUUID(), { productId: p.id, expectedVersion: version });
    });
    vi.unstubAllGlobals();
    expect(sent).toHaveLength(1);
    expect(sent[0].get("public_id")).toBe(recorded);
    expect(sent[0].get("invalidate")).toBe("true");
    expect([...sent[0].values()].join("|")).not.toContain(ENV.CLOUDINARY_API_SECRET);
    expect((await rows(p.id))[0].cdn).toBeNull();
  });
});

describe("maintenance", () => {
  it("includes the CDN reconcile job, which is a no-op (count 0) without CLOUDINARY_* settings", async () => {
    const report = await runMaintenance(db);
    expect(report.jobs.find((j) => j.job === "cdn_reconcile")).toEqual({ job: "cdn_reconcile", ok: true, count: 0 });
  });
});
