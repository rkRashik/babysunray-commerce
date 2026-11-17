import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publicMediaResponse } from "../../src/api/public-media";
import type { Principal } from "../../src/modules/auth/principal";
import { createProduct, createVariant } from "../../src/modules/catalogue/service";
import { newStorageKey } from "../../src/modules/media/images";
import { verifyMediaStore } from "../../src/modules/media/manifest";
import { removePhotoOnce, uploadPhotoOnce } from "../../src/modules/media/operations";
import { findPublicPhoto } from "../../src/modules/media/public";
import { createTestAuth, createVerifiedOwner } from "../support/auth";
import { testImage } from "../support/images";
import { dbOf, disableAccounts, randomPassword, STAGING_EMAIL_DOMAIN, stagingPool, stagingStore, supabase, tag } from "./support";

// Staging items 3, 7, 8, 9 and the photo half of 12 (docs/operations/staging-setup.md), against the real Supabase API of
// the staging project, with fictional, generated images. Every object this creates is removed again.

const pool = stagingPool(2);
const db = dbOf(pool);
let owner: Principal;
let ownerId: string;
const key = () => randomUUID();
const apiKeyHeaders = (k: string): Record<string, string> => (k.startsWith("sb_") ? { apikey: k } : { apikey: k, authorization: `Bearer ${k}` });

beforeAll(async () => {
  ({ principal: owner, userId: ownerId } = await createVerifiedOwner(createTestAuth(db), db, pool, `media-${tag()}${STAGING_EMAIL_DOMAIN}`, randomPassword()));
});
afterAll(async () => {
  await disableAccounts(pool, [ownerId]);
  await pool.end();
});

describe("3. the Data API exposes nothing of the application", () => {
  const TABLES = ["orders", "auth_users", "auth_sessions", "auth_accounts", "products", "product_media", "payment_entries", "user_access"];
  it("no table answers with either key", async () => {
    const { url, publishable, secret } = supabase();
    for (const k of [publishable, secret]) {
      for (const table of TABLES) {
        const response = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, { headers: apiKeyHeaders(k) });
        expect([table, response.ok]).toEqual([table, false]);
      }
    }
  });
  it("the API description, if served at all, lists no application table", async () => {
    const { url, publishable } = supabase();
    const response = await fetch(`${url}/rest/v1/`, { headers: apiKeyHeaders(publishable) });
    const body = response.ok ? await response.text() : "";
    for (const table of TABLES) expect(body.includes(`"/${table}"`)).toBe(false);
  });
});

describe("7 and 8. Storage: private bucket and round trip", () => {
  it("the bucket is private and unversioned", async () => {
    expect(await stagingStore().bucketState()).toMatchObject({ reachable: true, private: true, versioned: false });
  });
  it("upload, read, list, metadata and delete a fictional photo; anonymous and public access are refused", async () => {
    const store = stagingStore();
    const { url, publishable, bucket } = supabase();
    const k = newStorageKey("jpg");
    const bytes = await testImage("jpeg", 400, 300);
    await store.put(k, bytes);
    try {
      await store.put(k, bytes); // the same bytes again: a recovered retry, not an overwrite
      await expect(store.put(k, await testImage("jpeg", 400, 300, { colour: 10 }))).rejects.toThrow(/already exists/);
      expect((await store.read(k))?.equals(bytes)).toBe(true);
      expect(await store.entries()).toContain(k);
      expect(await store.info(k)).toMatchObject({ regularFile: true });
      expect((await fetch(`${url}/storage/v1/object/public/${bucket}/${k}`)).ok).toBe(false);
      expect((await fetch(`${url}/storage/v1/object/authenticated/${bucket}/${k}`, { headers: apiKeyHeaders(publishable) })).ok).toBe(false);
    } finally {
      await store.remove(k);
    }
    expect(await store.read(k)).toBeNull();
    expect(await store.info(k)).toBeNull();
  });
});

describe("9 and 12 (photos). records and objects in step; drafts never served", () => {
  it("an Owner upload keeps record and object identical; a draft photo is not served; removal deletes both", async () => {
    const store = stagingStore();
    const slug = tag();
    const product = await createProduct(db, { slug, nameEn: "Staging Romper", nameBn: "রম্পার", descriptionEn: "Fictional.", descriptionBn: "কাল্পনিক।" });
    await createVariant(db, { productId: product.id, sku: slug.toUpperCase(), size: "0-3M", colour: "Ivory", pricePaisa: 50_000 });
    const { value } = await uploadPhotoOnce(db, owner, key(), { productId: product.id, expectedVersion: 1, bytes: await testImage("png", 500, 400) }, store);
    const photo = value.media[0];
    const check = await verifyMediaStore(db, store);
    expect([check.missing.includes(photo.storageKey), check.changed.includes(photo.storageKey)]).toEqual([false, false]);
    expect(await findPublicPhoto(db, photo.id)).toBeNull();
    expect((await publicMediaResponse(new Request("https://staging.example.test/media/x"), photo.id, { db, store: () => store, gate: () => ({ open: true }) })).status).toBe(404);
    await removePhotoOnce(db, owner, key(), { productId: product.id, mediaId: photo.id, expectedVersion: value.version }, store);
    expect(await store.read(photo.storageKey)).toBeNull();
  });
});
