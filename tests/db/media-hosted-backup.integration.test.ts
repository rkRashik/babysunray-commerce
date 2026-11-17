import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/database";
import type { Principal } from "../../src/modules/auth/principal";
import { createProduct } from "../../src/modules/catalogue/service";
import { createMediaBackupFile, MediaBackupError, restoreMediaBackupToStore, verifyMediaBackupFile } from "../../src/modules/media/backup";
import { mediaHealthy, verifyMediaStore } from "../../src/modules/media/manifest";
import { uploadPhotoOnce } from "../../src/modules/media/operations";
import { supabaseMediaStore } from "../../src/modules/media/supabase-store";
import { clearAuthState, createTestAuth, createVerifiedOwner } from "../support/auth";
import { FAKE_LEGACY_SERVICE_KEY, fakeSupabase, type FakeSupabase } from "../support/fake-supabase";
import { testImage } from "../support/images";
import { createTestDb } from "../support/test-database";

// Photo backup, verification and restore for a Supabase Storage bucket (Gate H.47), against a mocked Storage and
// fictional records in babysunray_test. A real bucket has not been used: tests/staging is where that happens.
// Backups only read; a restore only fills an empty, confirmed store.

const PASS = "fictional hosted passphrase";
let db: Db;
let pool: Pool;
let owner: Principal;
let work: string;
const key = () => randomUUID();
const tag = `h47${Date.now().toString(36)}`;

/** A fake bucket and a store over it; `peak` is the most requests ever in flight at once through this store. */
function bucket() {
  const server = fakeSupabase();
  const probe = { active: 0, peak: 0 };
  const tracked = (async (input: RequestInfo | URL, init?: RequestInit) => {
    probe.peak = Math.max(probe.peak, ++probe.active);
    try {
      return await server.fetch(input, init);
    } finally {
      probe.active -= 1;
    }
  }) as typeof fetch;
  return { server, probe, store: supabaseMediaStore({ origin: "https://project.example.test", bucket: "photos", serviceKey: FAKE_LEGACY_SERVICE_KEY }, tracked, 0) };
}
const writes = (server: FakeSupabase) => server.requests.filter((r) => r.method === "POST" && !r.path.includes("/object/list/") || r.method === "DELETE" || r.method === "PUT").length;

let source: ReturnType<typeof bucket>;
const keys: string[] = [];

beforeAll(async () => {
  ({ db, pool } = await createTestDb(4));
  await clearAuthState(pool);
  ({ principal: owner } = await createVerifiedOwner(createTestAuth(db), db, pool, "hosted-media-owner@example.test"));
  work = await mkdtemp(path.join(os.tmpdir(), "bs-h47-"));
  // The backup covers every photo record in the database, so this file starts from none (a guarded test database).
  await pool.query("delete from product_media");
  source = bucket();
  for (const [i, format] of (["png", "jpeg", "webp"] as const).entries()) {
    const product = await createProduct(db, { slug: `${tag}-${i}`, nameEn: "Hosted Romper", nameBn: "রম্পার", descriptionEn: "Fictional.", descriptionBn: "কাল্পনিক।" });
    const { value } = await uploadPhotoOnce(db, owner, key(), { productId: product.id, expectedVersion: 1, bytes: await testImage(format, 500, 400, { colour: 40 + i * 60 }) }, source.store);
    keys.push(value.media[0].storageKey);
  }
});

afterAll(async () => {
  await pool?.query("delete from product_media where product_id in (select id from products where slug like $1)", [`${tag}-%`]);
  await pool?.end();
  if (work) await rm(work, { recursive: true, force: true });
});

const backupFile = (name: string) => path.join(work, `${name}.bsmedia`);

describe("backing up a Supabase Storage bucket", () => {
  it("reads every recorded photo's bytes one at a time, changes nothing in the bucket, and the backup verifies", async () => {
    const before = source.server.requests.length;
    const file = backupFile("ok");
    const result = await createMediaBackupFile(db, source.store, PASS, file, { database: "postgres" });
    expect(result).toMatchObject({ files: 3, unreferenced: [], unexpected: [] });
    expect(source.probe.peak).toBe(1); // sequential: one photo in memory at a time
    expect(writes({ ...source.server, requests: source.server.requests.slice(before) })).toBe(0);
    expect(source.server.objects.size).toBe(3);
    const { header, manifest } = await verifyMediaBackupFile(file, PASS);
    expect(header).toMatchObject({ files: 3, database: "postgres" });
    // The manifest carries the authoritative size and SHA-256 from the database, and the bytes matched them.
    expect(manifest.files.map((f) => f.storageKey).sort()).toEqual([...keys].sort());
    const raw = await readFile(file);
    for (const k of keys) expect(raw.includes(source.server.objects.get(k)!.data)).toBe(false); // encrypted at rest
  });

  it("restores into a separate empty, confirmed bucket; the restored bucket matches the records and the source is untouched", async () => {
    const target = bucket();
    const file = backupFile("ok");
    const restored = await restoreMediaBackupToStore(file, PASS, target.store, { label: "test-bucket-2", confirmedLabel: "test-bucket-2" });
    expect(restored.files).toBe(3);
    expect(mediaHealthy(await verifyMediaStore(db, target.store))).toBe(true);
    for (const k of keys) expect(target.server.objects.get(k)!.data.equals(source.server.objects.get(k)!.data)).toBe(true);
    expect(source.server.objects.size).toBe(3);
  });

  it("refuses an unconfirmed or non-empty target before writing anything", async () => {
    const file = backupFile("ok");
    const empty = bucket();
    await expect(restoreMediaBackupToStore(file, PASS, empty.store, { label: "test-bucket-2", confirmedLabel: "test-bucket-3" })).rejects.toThrow(/not confirmed/);
    await expect(restoreMediaBackupToStore(file, PASS, empty.store, { label: "", confirmedLabel: "" })).rejects.toThrow(/not confirmed/);
    expect(writes(empty.server)).toBe(0);

    const used = bucket();
    const existing = `${"a".repeat(32)}.jpg`;
    used.server.objects.set(existing, { data: Buffer.from("real photo"), type: "image/jpeg", updated: new Date().toISOString() });
    await expect(restoreMediaBackupToStore(file, PASS, used.store, { label: "x", confirmedLabel: "x" })).rejects.toThrow(/already holds files/);
    expect(writes(used.server)).toBe(0);
    expect(used.server.objects.get(existing)!.data.toString()).toBe("real photo");
  });

  it("a restore that fails part way removes only what it wrote, and never overwrites a photo that appeared meanwhile", async () => {
    const target = bucket();
    const midway = keys.slice().sort()[1];
    const appeared = Buffer.from("added by someone else");
    // The second photo's key is taken by another upload after the emptiness check: the restore must refuse, not replace it.
    target.server.intercept = (r) => {
      if (r.method === "POST" && r.path.endsWith(midway) && !target.server.objects.has(midway)) {
        target.server.objects.set(midway, { data: appeared, type: "image/jpeg", updated: new Date().toISOString() });
      }
      return undefined;
    };
    await expect(restoreMediaBackupToStore(backupFile("ok"), PASS, target.store, { label: "t", confirmedLabel: "t" })).rejects.toThrow();
    expect([...target.server.objects.keys()]).toEqual([midway]);
    expect(target.server.objects.get(midway)!.data.equals(appeared)).toBe(true);
  });

  it("never writes or removes a key that already exists, even one that appears after the emptiness check", async () => {
    const target = bucket();
    const [existing] = keys;
    const theirs = Buffer.from("someone else's photo");
    target.server.objects.set(existing, { data: theirs, type: "image/png", updated: new Date().toISOString() });
    // The store looks empty when asked for its entries (as if the object arrived a moment later).
    const racing = { ...target.store, entries: async () => [] };
    await expect(restoreMediaBackupToStore(backupFile("ok"), PASS, racing, { label: "t", confirmedLabel: "t" })).rejects.toThrow(/already holds/);
    expect(target.server.objects.get(existing)!.data.equals(theirs)).toBe(true);
    // Whatever this restore had written before it stopped is removed again; the other writer's object stays.
    expect([...target.server.objects.keys()]).toEqual([existing]);
  });

  it("refuses to back up, keeping nothing, when a recorded photo is missing, changed or cannot be downloaded", async () => {
    const [victim] = keys;
    const saved = source.server.objects.get(victim)!;
    const attempt = (name: string) => createMediaBackupFile(db, source.store, PASS, backupFile(name), { database: "postgres" });

    source.server.objects.delete(victim);
    await expect(attempt("missing")).rejects.toThrow(/missing/);
    source.server.objects.set(victim, { ...saved, data: Buffer.from("tampered bytes") });
    await expect(attempt("changed")).rejects.toThrow(/differs from its record/);
    source.server.objects.set(victim, saved);

    source.server.intercept = (r) => (r.method === "GET" && r.path.endsWith(victim) ? new Response("{}", { status: 500 }) : undefined);
    await expect(attempt("interrupted")).rejects.toThrow();
    source.server.intercept = null;

    const files = await readdir(work);
    expect(files.filter((f) => /missing|changed|interrupted/.test(f))).toEqual([]);
    expect(source.server.objects.size).toBe(3);
  });

  it("retries a transient download failure, and the backup is still exact", async () => {
    let failed = 0;
    source.server.intercept = (r) => (r.method === "GET" && r.path.includes("/authenticated/") && failed++ < 2 ? new Response("{}", { status: 503 }) : undefined);
    try {
      await createMediaBackupFile(db, source.store, PASS, backupFile("retry"), { database: "postgres" });
    } finally {
      source.server.intercept = null;
    }
    expect(failed).toBeGreaterThan(2);
    expect((await verifyMediaBackupFile(backupFile("retry"), PASS)).header.files).toBe(3);
  });

  it("reports objects without a record and leaves them in the bucket, out of the backup", async () => {
    const stray = `${"b".repeat(32)}.png`;
    source.server.objects.set(stray, { data: Buffer.from("stray"), type: "image/png", updated: new Date().toISOString() });
    try {
      const result = await createMediaBackupFile(db, source.store, PASS, backupFile("stray"), { database: "postgres" });
      expect(result.unreferenced).toEqual([stray]);
      expect((await verifyMediaBackupFile(backupFile("stray"), PASS)).manifest.files.map((f) => f.storageKey)).not.toContain(stray);
      expect(source.server.objects.has(stray)).toBe(true);
    } finally {
      source.server.objects.delete(stray);
    }
  });

  it("refuses a damaged, truncated or wrongly keyed backup, and a restore from one writes nothing", async () => {
    const raw = await readFile(backupFile("ok"));
    const flipped = Buffer.from(raw);
    flipped[flipped.length - 100] ^= 0x01;
    await writeFile(backupFile("flipped"), flipped);
    await writeFile(backupFile("short"), raw.subarray(0, raw.length - 200));
    await expect(verifyMediaBackupFile(backupFile("flipped"), PASS)).rejects.toThrow();
    await expect(verifyMediaBackupFile(backupFile("short"), PASS)).rejects.toThrow();
    await expect(verifyMediaBackupFile(backupFile("ok"), "another passphrase entirely")).rejects.toThrow();

    const target = bucket();
    for (const name of ["flipped", "short"]) {
      await expect(restoreMediaBackupToStore(backupFile(name), PASS, target.store, { label: "t", confirmedLabel: "t" })).rejects.toThrow();
    }
    expect(target.server.objects.size).toBe(0);
    expect(MediaBackupError.name).toBe("MediaBackupError");
  });
});
