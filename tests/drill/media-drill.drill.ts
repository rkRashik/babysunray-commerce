import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Db } from "../../src/db/database";
import type { Principal } from "../../src/modules/auth/principal";
import { createMediaBackupFile, MediaBackupError, mediaRecords, restoreMediaBackupFile, verifyMediaBackupFile } from "../../src/modules/media/backup";
import { mediaHealthy, verifyMediaStore } from "../../src/modules/media/manifest";
import { uploadPhotoOnce } from "../../src/modules/media/operations";
import { localMediaStore, type MediaStore } from "../../src/modules/media/storage";
import { clearAuthState, createTestAuth, createVerifiedOwner } from "../support/auth";
import { createTestVariant } from "../support/fixtures";
import { testImage } from "../support/images";
import { createTestDb } from "../support/test-database";

// Photo backup and restore drill (requirement K-2) on fictional images and records in babysunray_test: upload
// through the normal validation, back up (encrypted), verify, restore into a fresh folder outside the repository,
// compare every file and record, run the manifest check on the restored folder, prove nothing escaped it, and
// prove damaged backups and inconsistent sources fail closed. Uses only temporary folders it creates; never
// MEDIA_STORAGE_DIR. Times are observations, not an approved RTO.

const ROOT = path.resolve(import.meta.dirname, "../..");
const PASS = "fictional drill passphrase";
let db: Db;
let pool: Pool;
let owner: Principal;
let work: string;
let source: string;
let store: MediaStore;

beforeAll(async () => {
  ({ db, pool } = await createTestDb(4));
  const auth = createTestAuth(db);
  await clearAuthState(pool);
  ({ principal: owner } = await createVerifiedOwner(auth, db, pool, "media-drill@example.test"));
  work = await mkdtemp(path.join(os.tmpdir(), "babysunray-media-drill-"));
  source = path.join(work, "source");
  await mkdir(source);
  store = localMediaStore(source);
});

afterAll(async () => {
  await pool?.end();
  if (work) await rm(work, { recursive: true, force: true });
});

const version = async (productId: string) => Number((await pool.query("select version from products where id = $1", [productId])).rows[0].version);

it("backs up every photo encrypted, verifies, restores into an empty folder and finds every file and record intact", async () => {
  const started = Date.now();
  // 1-2. Fictional photos in three formats on two products, uploaded through the normal validation.
  const a = (await createTestVariant(db, "mdrill")).product.id;
  const b = (await createTestVariant(db, "mdrill")).product.id;
  for (const [productId, format, colour] of [[a, "png", 10], [a, "jpeg", 40], [a, "webp", 80], [b, "png", 120], [b, "jpeg", 160]] as const) {
    await uploadPhotoOnce(db, owner, randomUUID(), { productId, expectedVersion: await version(productId), bytes: await testImage(format, 640, 480, { colour }), altEn: `Fictional ${format}`, altBn: "কাল্পনিক" }, store);
  }
  const records = await mediaRecords(db);
  const ours = records.filter((r) => r.productId === a || r.productId === b);
  expect(ours).toHaveLength(5);
  // An interrupted upload's leftover is reported, not included.
  await writeFile(path.join(source, `${"c".repeat(32)}.png`), Buffer.from("orphan"));

  // 3. Encrypted backup.
  const file = path.join(work, "drill.bsmedia");
  let t = Date.now();
  const result = await createMediaBackupFile(db, store, PASS, file, { database: "babysunray_test" });
  const backupMs = Date.now() - t;
  expect(result.files).toBe(records.length);
  expect(result.unreferenced).toEqual([`${"c".repeat(32)}.png`]);
  const sealed = await readFile(file);
  for (const r of ours) expect(sealed.includes(await readFile(path.join(source, r.storageKey))), r.storageKey).toBe(false);

  // 4. Verify.
  t = Date.now();
  const { header, manifest } = await verifyMediaBackupFile(file, PASS);
  const verifyMs = Date.now() - t;
  expect([header.files, manifest.files.map((f) => f.storageKey)]).toEqual([records.length, records.map((r) => r.storageKey)]);
  expect(manifest.files).toEqual(records);

  // 5-6. Restore into a fresh empty folder outside the repository; compare every file and record.
  const restored = path.join(work, "restored");
  await mkdir(restored);
  t = Date.now();
  await restoreMediaBackupFile(file, PASS, restored, ROOT);
  const restoreMs = Date.now() - t;
  for (const r of records) expect((await readFile(path.join(restored, r.storageKey))).equals(await readFile(path.join(source, r.storageKey))), r.storageKey).toBe(true);
  // 7. The manifest check passes against the records and the restored folder.
  expect(mediaHealthy(await verifyMediaStore(db, localMediaStore(restored)))).toBe(true);
  // 8. Nothing escaped: the folder holds exactly the photo files, and the work folder nothing unexpected.
  expect((await readdir(restored)).sort()).toEqual(records.map((r) => r.storageKey).sort());
  expect((await readdir(work)).sort()).toEqual(["drill.bsmedia", "restored", "source"]);

  // 9. Damaged backups and wrong passphrases fail closed, and a failed restore leaves its folder empty.
  const flipped = Buffer.from(sealed);
  flipped[flipped.length - 100] ^= 1;
  for (const [name, bytes, pass] of [["tampered", flipped, PASS], ["truncated", sealed.subarray(0, sealed.length - 10), PASS], ["wrong passphrase", sealed, "another fictional phrase"]] as const) {
    const bad = path.join(work, `${name.replace(" ", "-")}.bsmedia`);
    await writeFile(bad, bytes);
    await expect(verifyMediaBackupFile(bad, pass), name).rejects.toThrow();
    const into = path.join(work, `into-${name.replace(" ", "-")}`);
    await mkdir(into);
    await expect(restoreMediaBackupFile(bad, pass, into, ROOT), name).rejects.toThrow();
    expect(await readdir(into), name).toEqual([]);
  }
  await expect(restoreMediaBackupFile(file, PASS, restored, ROOT)).rejects.toThrow(/not empty/);
  await expect(restoreMediaBackupFile(file, PASS, path.join(ROOT, "public"), ROOT)).rejects.toThrow(MediaBackupError);

  console.log(
    JSON.stringify(
      {
        drill: "photo-backup-restore",
        result: "passed",
        database: "babysunray_test (fictional photos)",
        photos: header.files,
        photoBytes: header.bytes,
        backupBytes: sealed.length,
        timingsMs: { backup: backupMs, verify: verifyMs, restore: restoreMs, total: Date.now() - started },
        note: "Times are observations on this machine, not an approved RTO.",
      },
      null,
      2,
    ),
  );
});

it("refuses an inconsistent source: a missing file, a changed file, or records changing during the backup", async () => {
  const records = await mediaRecords(db);
  const victim = records[0];
  const original = await readFile(path.join(source, victim.storageKey));
  const attempt = async (name: string, s: MediaStore = store) => {
    const file = path.join(work, `${name}.bsmedia`);
    await expect(createMediaBackupFile(db, s, PASS, file, { database: "babysunray_test" }), name).rejects.toThrow(MediaBackupError);
    expect((await readdir(work)).filter((f) => f.startsWith(name)), name).toEqual([]);
  };
  await rm(path.join(source, victim.storageKey));
  await attempt("missing");
  await writeFile(path.join(source, victim.storageKey), Buffer.concat([original, Buffer.from([0])]));
  await attempt("changed");
  await writeFile(path.join(source, victim.storageKey), original);
  // A photo record changes while the files are being read.
  let touched = false;
  const racing: MediaStore = {
    ...store,
    read: async (key) => {
      if (!touched) {
        touched = true;
        await pool.query("update product_media set alt_en = 'Changed during the backup' where id = $1", [victim.mediaId]);
      }
      return store.read(key);
    },
  };
  await attempt("racing", racing);
  expect(mediaHealthy(await verifyMediaStore(db, store))).toBe(false); // the orphan from the first test is still reported
});
