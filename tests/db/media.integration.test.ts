import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/database";
import type { Principal } from "../../src/modules/auth/principal";
import { archiveProduct, getProductWithVariants } from "../../src/modules/catalogue/service";
import { mediaHealthy, verifyMediaStore } from "../../src/modules/media/manifest";
import { describePhotoOnce, movePhotoOnce, removePhotoOnce, uploadPhotoOnce } from "../../src/modules/media/operations";
import { MAX_PRODUCT_PHOTOS } from "../../src/modules/media/service";
import { localMediaStore, mediaStoreConfig, type MediaStore } from "../../src/modules/media/storage";
import { BASE_URL, clearAuthState, count, createTestAuth, createVerifiedOwner } from "../support/auth";
import { createTestVariant, errorCodeOf } from "../support/fixtures";
import { tempMediaDir, testImage } from "../support/images";
import { createTestDb } from "../support/test-database";

// Product photos against PostgreSQL and a throwaway media folder: validation, normalisation, records and files
// kept in step (also on failure, replay and conflict), ordering, replacement, removal and the manifest check.
// Fictional, generated images only.

const state = vi.hoisted(() => ({ db: undefined as unknown, auth: undefined as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/modules/auth/server", () => ({ getAuth: () => state.auth }));
const mediaRoute = await import("../../src/app/admin/media/[mediaId]/route");
const uploadRoute = await import("../../src/app/admin/products/[productId]/photos/upload/route");

let db: Db;
let pool: Pool;
let owner: Principal;
let cookie: string;
let media: { dir: string; cleanup: () => void };
let store: MediaStore;

beforeAll(async () => {
  ({ db, pool } = await createTestDb(6));
  const auth = createTestAuth(db);
  Object.assign(state, { db, auth });
  await clearAuthState(pool);
  ({ principal: owner, cookie } = await createVerifiedOwner(auth, db, pool, "media-owner@example.test"));
  media = tempMediaDir("ops");
  store = localMediaStore(media.dir);
  vi.stubEnv("MEDIA_STORAGE_DIR", media.dir);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  media?.cleanup();
  await pool?.end();
});

const key = () => randomUUID();
const files = () => readdirSync(media.dir).sort();
const version = async (productId: string) => (await getProductWithVariants(db, productId)).version;
const upload = async (productId: string, bytes: Buffer, extra: { altEn?: string; altBn?: string; replaceMediaId?: string; expectedVersion?: number } = {}, k = key()) =>
  uploadPhotoOnce(db, owner, k, { productId, expectedVersion: extra.expectedVersion ?? (await version(productId)), bytes, ...extra }, store);
const draft = async () => (await createTestVariant(db, "media")).product.id;

describe("upload", () => {
  it("stores a re-encoded copy without metadata, and a record that matches the file byte for byte", async () => {
    const productId = await draft();
    const before = await version(productId);
    const original = await testImage("jpeg", 600, 400, { exif: true });
    expect((await sharp(original).metadata()).exif).toBeDefined();
    const { value } = await upload(productId, original, { altEn: "Front of the romper", altBn: "রম্পারের সামনের দিক" });
    expect(value.version).toBe(before + 1);
    const [photo] = value.media;
    expect(photo).toMatchObject({ contentType: "image/jpeg", width: 600, height: 400, position: 0, altEn: "Front of the romper", altBn: "রম্পারের সামনের দিক" });
    expect(photo.storageKey).toMatch(/^[0-9a-f]{32}\.jpg$/);
    const stored = readFileSync(path.join(media.dir, photo.storageKey));
    expect(stored.length).toBe(photo.byteSize);
    const meta = await sharp(stored).metadata();
    expect([meta.format, meta.exif, meta.icc, meta.xmp]).toEqual(["jpeg", undefined, undefined, undefined]);
    expect(stored.includes(Buffer.from("fictional-secret-place"))).toBe(false);
    expect(mediaHealthy(await verifyMediaStore(db, store))).toBe(true);
  });

  it("shrinks very large photos to at most 2400 pixels and keeps PNG and WebP in their format", async () => {
    const productId = await draft();
    const { value } = await upload(productId, await testImage("png", 3000, 1500));
    expect(value.media[0]).toMatchObject({ contentType: "image/png", width: 2400, height: 1200 });
    const { value: second } = await upload(productId, await testImage("webp", 500, 500));
    expect(second.media.map((m) => [m.contentType, m.position])).toEqual([["image/png", 0], ["image/webp", 1]]);
  });

  it("refuses anything that is not a whole JPEG, PNG or WebP photo of sensible size, and leaves no file or record", async () => {
    const productId = await draft();
    const png = await testImage("png", 400, 300);
    const jpeg = await testImage("jpeg", 400, 300);
    const before = files();
    const cases: [string, Buffer][] = [
      ["empty", Buffer.alloc(0)],
      ["svg", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")],
      ["html", Buffer.from("<!doctype html><html><script>alert(1)</script></html>")],
      ["gif", Buffer.from("GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;")],
      ["exe", Buffer.from("MZ\u0090\u0000\u0003\u0000\u0000\u0000")],
      ["truncated png", png.subarray(0, Math.floor(png.length / 2))],
      ["truncated jpeg", jpeg.subarray(0, Math.floor(jpeg.length / 2))],
      ["png signature, then junk", Buffer.concat([png.subarray(0, 8), Buffer.alloc(200, 7)])],
      ["too small", await testImage("png", 120, 120)],
      ["too large file", Buffer.concat([png.subarray(0, 8), Buffer.alloc(10 * 1024 * 1024)])],
    ];
    for (const [name, bytes] of cases) expect(await errorCodeOf(upload(productId, bytes)), name).toBe("INVALID_INPUT");
    expect(files()).toEqual(before);
    expect(await count(pool, "select count(*) from product_media where product_id = $1", [productId])).toBe(0);
    expect(await version(productId)).toBe(1);
  });

  it("a retry with the same key records one photo and leaves one file; a different file under that key is refused", async () => {
    const productId = await draft();
    const bytes = await testImage("png", 400, 300);
    const k = key();
    const expectedVersion = await version(productId);
    const first = await upload(productId, bytes, { expectedVersion }, k);
    const again = await upload(productId, bytes, { expectedVersion }, k);
    expect([first.replayed, again.replayed]).toEqual([false, true]);
    expect(again.value.media).toHaveLength(1);
    expect(await errorCodeOf(upload(productId, await testImage("png", 400, 300, { colour: 10 }), { expectedVersion }, k))).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(mediaHealthy(await verifyMediaStore(db, store))).toBe(true);
  });

  it("refuses a stale version, an archived product and a 13th photo, deleting the new file each time", async () => {
    const productId = await draft();
    const bytes = await testImage("webp", 300, 300);
    await upload(productId, bytes);
    expect(await errorCodeOf(upload(productId, bytes, { expectedVersion: 1 }))).toBe("VERSION_CONFLICT");
    for (let i = 1; i < MAX_PRODUCT_PHOTOS; i += 1) await upload(productId, bytes);
    expect(await errorCodeOf(upload(productId, bytes))).toBe("INVALID_INPUT");
    const archived = await draft();
    await archiveProduct(db, archived);
    expect(await errorCodeOf(upload(archived, bytes))).toBe("PRODUCT_NOT_EDITABLE");
    expect(mediaHealthy(await verifyMediaStore(db, store))).toBe(true);
  });

  it("two uploads based on the same version: one is recorded, the other refused, and no file is left over", async () => {
    const productId = await draft();
    const expectedVersion = await version(productId);
    const [a, b] = await Promise.allSettled([
      upload(productId, await testImage("png", 400, 300, { colour: 1 }), { expectedVersion }),
      upload(productId, await testImage("png", 400, 300, { colour: 2 }), { expectedVersion }),
    ]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    const failure = [a, b].find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason.code).toBe("VERSION_CONFLICT");
    expect(await count(pool, "select count(*) from product_media where product_id = $1", [productId])).toBe(1);
    expect(mediaHealthy(await verifyMediaStore(db, store))).toBe(true);
  });
});

describe("managing photos", () => {
  it("reorders, describes, replaces in place and removes, keeping positions 0..n-1 and files in step", async () => {
    const productId = await draft();
    for (const colour of [1, 2, 3]) await upload(productId, await testImage("png", 400, 300, { colour }), { altEn: `Photo ${colour}` });
    let detail = await getProductWithVariants(db, productId);
    const [p1, p2, p3] = detail.media;
    const move = async (mediaId: string, direction: "up" | "down" | "first") => movePhotoOnce(db, owner, key(), { productId, mediaId, expectedVersion: await version(productId), direction });
    await move(p3.id, "first");
    await move(p1.id, "down");
    detail = await getProductWithVariants(db, productId);
    expect(detail.media.map((m) => [m.altEn, m.position])).toEqual([["Photo 3", 0], ["Photo 2", 1], ["Photo 1", 2]]);

    await describePhotoOnce(db, owner, key(), { productId, mediaId: p2.id, expectedVersion: await version(productId), altEn: "Back view", altBn: "পেছনের দিক" });
    const replaced = await upload(productId, await testImage("webp", 500, 400), { replaceMediaId: p2.id });
    const replacement = replaced.value.media.find((m) => m.position === 1)!;
    expect(replacement).toMatchObject({ contentType: "image/webp", altEn: "Back view", altBn: "পেছনের দিক" });
    expect(files()).not.toContain(p2.storageKey);

    await removePhotoOnce(db, owner, key(), { productId, mediaId: p3.id, expectedVersion: await version(productId) }, store);
    detail = await getProductWithVariants(db, productId);
    expect(detail.media.map((m) => m.position)).toEqual([0, 1]);
    expect(files()).not.toContain(p3.storageKey);
    expect(await errorCodeOf(removePhotoOnce(db, owner, key(), { productId, mediaId: p3.id, expectedVersion: detail.version }, store))).toBe("MEDIA_NOT_FOUND");
    expect(await errorCodeOf(move(randomUUID(), "up"))).toBe("MEDIA_NOT_FOUND");
    expect(mediaHealthy(await verifyMediaStore(db, store))).toBe(true);
  });

  it("never touches another product's photo through this product", async () => {
    const mine = await draft();
    const theirs = await draft();
    const { value } = await upload(theirs, await testImage("png", 400, 300));
    expect(await errorCodeOf(removePhotoOnce(db, owner, key(), { productId: mine, mediaId: value.media[0].id, expectedVersion: await version(mine) }, store))).toBe("MEDIA_NOT_FOUND");
    expect(files()).toContain(value.media[0].storageKey);
  });
});

describe("media manifest", () => {
  it("finds a missing file, a changed file, a file without a record and an unfinished write", async () => {
    const productId = await draft();
    const { value } = await upload(productId, await testImage("png", 400, 300));
    const { value: two } = await upload(productId, await testImage("png", 400, 300, { colour: 9 }));
    const [a, b] = two.media;
    expect(value.media).toHaveLength(1);
    const check = await verifyMediaStore(db, store);
    expect(mediaHealthy(check)).toBe(true);
    expect(check.records).toBe(check.ok);

    const fileA = path.join(media.dir, a.storageKey);
    const bytesA = readFileSync(fileA);
    writeFileSync(fileA, Buffer.concat([bytesA, Buffer.from([0])]));
    const bytesB = readFileSync(path.join(media.dir, b.storageKey));
    await store.remove(b.storageKey);
    const stray = `${"a".repeat(32)}.png`;
    writeFileSync(path.join(media.dir, stray), Buffer.from("x"));
    writeFileSync(path.join(media.dir, `${"b".repeat(32)}.png.partial`), Buffer.from("x"));
    const broken = await verifyMediaStore(db, store);
    expect(broken).toMatchObject({ missing: [b.storageKey], changed: [a.storageKey], unreferenced: [stray], unexpected: [`${"b".repeat(32)}.png.partial`] });
    expect(mediaHealthy(broken)).toBe(false);

    // Put everything back for the other tests.
    writeFileSync(fileA, bytesA);
    writeFileSync(path.join(media.dir, b.storageKey), bytesB);
    await store.remove(stray);
    await import("node:fs/promises").then((fs) => fs.rm(path.join(media.dir, `${"b".repeat(32)}.png.partial`)));
    expect(mediaHealthy(await verifyMediaStore(db, store))).toBe(true);
  });
});

describe("storage configuration", () => {
  it("accepts only an existing absolute folder outside the project, and refuses local storage in production unless allowed", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    expect(mediaStoreConfig({}, root)).toMatchObject({ ok: false, problem: expect.stringContaining("not set") });
    expect(mediaStoreConfig({ MEDIA_STORAGE_DIR: "relative/media" }, root)).toMatchObject({ ok: false, problem: expect.stringContaining("absolute") });
    expect(mediaStoreConfig({ MEDIA_STORAGE_DIR: path.join(root, "src") }, root)).toMatchObject({ ok: false, problem: expect.stringContaining("outside the project") });
    expect(mediaStoreConfig({ MEDIA_STORAGE_DIR: root }, root)).toMatchObject({ ok: false, problem: expect.stringContaining("outside the project") });
    expect(mediaStoreConfig({ MEDIA_STORAGE_DIR: path.join(media.dir, "missing") }, root)).toMatchObject({ ok: false, problem: expect.stringContaining("does not exist") });
    expect(mediaStoreConfig({ MEDIA_STORAGE_DIR: media.dir }, root)).toMatchObject({ ok: true });
    expect(mediaStoreConfig({ MEDIA_STORAGE_DIR: media.dir, NODE_ENV: "production" }, root)).toMatchObject({ ok: false, problem: expect.stringContaining("refused in production") });
    expect(mediaStoreConfig({ MEDIA_STORAGE_DIR: media.dir, NODE_ENV: "production", MEDIA_LOCAL_STORAGE_IN_PRODUCTION: "allow" }, root)).toMatchObject({ ok: true });
    for (const r of [mediaStoreConfig({ MEDIA_STORAGE_DIR: path.join(media.dir, "missing") }, root)]) expect(JSON.stringify(r)).not.toContain(media.dir);
  });

  it("refuses storage keys that could name another path", async () => {
    for (const bad of ["../x.png", "..\\x.png", `${"a".repeat(32)}.svg`, `${"A".repeat(32)}.png`, "a.png"]) {
      await expect(store.read(bad)).rejects.toThrow("Invalid media storage key.");
    }
  });
});

describe("Admin photo routes", () => {
  const get = (mediaId: string, query = "", headers: Record<string, string> = {}) =>
    mediaRoute.GET(new Request(`${BASE_URL}/admin/media/${mediaId}${query}`, { headers }), { params: Promise.resolve({ mediaId }) });
  const post = async (productId: string, fields: Record<string, string | Blob>, headers: Record<string, string> = { origin: BASE_URL, cookie }) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    return uploadRoute.POST(new Request(`${BASE_URL}/admin/products/${productId}/photos/upload`, { method: "POST", headers, body: form }), { params: Promise.resolve({ productId }) });
  };

  it("serves a photo only to a signed-in Owner, privately, as an image, with smaller copies and revalidation", async () => {
    const productId = await draft();
    const { value } = await upload(productId, await testImage("png", 800, 400));
    const photo = value.media[0];
    const anonymous = await get(photo.id);
    expect([anonymous.status, await anonymous.text()]).toEqual([401, ""]);
    const res = await get(photo.id, "", { cookie });
    expect(res.status).toBe(200);
    for (const [name, expected] of [["content-type", "image/png"], ["cache-control", "private, no-cache"], ["x-content-type-options", "nosniff"], ["content-security-policy", "default-src 'none'; sandbox"]]) {
      expect(res.headers.get(name), name).toBe(expected);
    }
    expect(Buffer.from(await res.arrayBuffer()).equals(readFileSync(path.join(media.dir, photo.storageKey)))).toBe(true);
    const small = await get(photo.id, "?w=320", { cookie });
    expect((await sharp(Buffer.from(await small.arrayBuffer())).metadata()).width).toBe(320);
    expect((await get(photo.id, "?w=999", { cookie })).headers.get("etag")).toBe(res.headers.get("etag"));
    expect((await get(photo.id, "", { cookie, "if-none-match": res.headers.get("etag")! })).status).toBe(304);
    expect((await get(randomUUID(), "", { cookie })).status).toBe(404);
    expect((await get("../../etc/passwd", "", { cookie })).status).toBe(404);
  });

  it("uploads through the form route only from this origin with a session, and answers errors with fixed codes", async () => {
    const productId = await draft();
    const png = new Blob([new Uint8Array(await testImage("png", 400, 300))], { type: "image/png" });
    const fields = async () => ({ idempotencyKey: key(), version: String(await version(productId)), image: png, altEn: "Fictional front view" });
    expect((await post(productId, await fields(), { origin: "https://elsewhere.example", cookie })).status).toBe(403);
    const anonymous = await post(productId, await fields(), { origin: BASE_URL });
    expect([anonymous.status, anonymous.headers.get("location")]).toEqual([303, "/admin/login"]);
    const ok = await post(productId, await fields());
    expect([ok.status, ok.headers.get("location")]).toEqual([303, `/admin/products/${productId}/photos?done=photo-uploaded`]);
    expect((await getProductWithVariants(db, productId)).media.map((m) => m.altEn)).toEqual(["Fictional front view"]);
    const svg = await post(productId, { ...(await fields()), image: new Blob(["<svg xmlns='http://www.w3.org/2000/svg'/>"], { type: "image/png" }) });
    expect(svg.headers.get("location")).toBe(`/admin/products/${productId}/photos?error=type`);
    const stale = await post(productId, { ...(await fields()), version: "1" });
    expect(stale.headers.get("location")).toBe(`/admin/products/${productId}/photos?error=conflict`);
    const huge = await post(productId, await fields(), { origin: BASE_URL, cookie, "content-length": String(11 * 1024 * 1024) });
    expect(huge.headers.get("location")).toBe(`/admin/products/${productId}/photos?error=too_large`);
    expect((await post("not-a-uuid", await fields())).status).toBe(404);
    expect(await count(pool, "select count(*) from product_media where product_id = $1", [productId])).toBe(1);
    expect(mediaHealthy(await verifyMediaStore(db, store))).toBe(true);
  });
});

describe("photo folder health", () => {
  it("deletes only unreferenced regular photo files untouched for an hour, and never touches records' files or other entries", async () => {
    const { removeUnreferencedFiles } = await import("../../src/modules/media/manifest");
    const { utimesSync, mkdirSync, rmSync } = await import("node:fs");
    const productId = await draft();
    const { value } = await upload(productId, await testImage("png", 400, 300, { colour: 77 }));
    const kept = value.media[0].storageKey;
    const old = `${"d".repeat(32)}.png`;
    const fresh = `${"e".repeat(32)}.png`;
    const folder = `${"f".repeat(32)}.png`;
    writeFileSync(path.join(media.dir, old), Buffer.from("old orphan"));
    writeFileSync(path.join(media.dir, fresh), Buffer.from("fresh orphan"));
    mkdirSync(path.join(media.dir, folder));
    const hourAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(path.join(media.dir, old), hourAgo, hourAgo);
    try {
      const check = await verifyMediaStore(db, store);
      expect(check.unreferenced).toEqual(expect.arrayContaining([old, fresh]));
      expect(check.unexpected).toContain(folder);
      expect(await store.read(folder)).toBeNull();
      const { removed, kept: notRemoved } = await removeUnreferencedFiles(db, owner, store);
      expect(removed).toEqual([old]);
      expect(notRemoved).toContain(fresh);
      expect(files()).toEqual(expect.arrayContaining([kept, fresh, folder]));
      expect(files()).not.toContain(old);
      const forged = Object.freeze({ userId: owner.userId, role: "owner" as const });
      expect(await errorCodeOf(removeUnreferencedFiles(db, forged, store))).toBe("UNAUTHENTICATED");
    } finally {
      rmSync(path.join(media.dir, fresh), { force: true });
      rmSync(path.join(media.dir, folder), { recursive: true, force: true });
    }
  });

  it("keeps resized copies in memory by content: a second request does not read or resize again", async () => {
    const { cachedRendition } = await import("../../src/modules/media/images");
    const data = await testImage("jpeg", 1600, 1200, { colour: 33 });
    let loads = 0;
    const load = async () => {
      loads += 1;
      return data;
    };
    const sha = `${randomUUID().replace(/-/g, "")}${"0".repeat(32)}`;
    const first = await cachedRendition(sha, 640, "jpeg", load);
    const second = await cachedRendition(sha, 640, "jpeg", load);
    expect(second).toBe(first);
    expect(loads).toBe(1);
    expect((await sharp(first!).metadata()).width).toBe(640);
    expect(await cachedRendition(`${sha.slice(0, 63)}1`, 640, "jpeg", async () => null)).toBeNull();
  });
});
