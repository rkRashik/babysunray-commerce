import "server-only";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import * as z from "zod";
import { checkPassphrase, openSealed, sealStream } from "@/db/backup.mts";
import type { Db } from "@/db/database";
import { productMedia, products } from "@/db/schema";
import { localMediaStore, type MediaStore, STORAGE_KEY } from "./storage";

// Encrypted photo backups (requirement K-2; runbook "Product photos"). The database backup holds the photo
// records, not the photo files; this backs up the files with their manifest, sealed exactly like the database
// backups (src/db/backup.mts: AES-256-GCM in authenticated records, scrypt key from a passphrase), so no second
// cryptographic design exists. Plaintext inside the sealed stream:
//
//   "BSMEDIA1" | uint32 manifest length | manifest (JSON, UTF-8) | each file's bytes, in manifest order
//
// The file system and PostgreSQL are not one transaction, so a backup is accepted only if it is consistent:
// every record's file exists with the recorded size and SHA-256, and the records are identical before and after
// the files were read. Otherwise nothing is kept and the operator retries (when no one is uploading). Files without
// a record are reported, not included: they are not part of the catalogue. This is not an atomic snapshot of the
// database and the folder together; a database backup taken at another moment may differ (runbook).

const MAGIC = Buffer.from("BSMEDIA1", "ascii");
export const MEDIA_BACKUP_FORMAT = "babysunray-media-backup";
export const MEDIA_BACKUP_VERSION = 1;
const MAX_MANIFEST = 64 * 1024 * 1024;
const MAX_FILE = 20 * 1024 * 1024;

const record = z.strictObject({
  mediaId: z.uuid(),
  productId: z.uuid(),
  productSlug: z.string().max(100),
  position: z.int().min(0),
  storageKey: z.string().regex(STORAGE_KEY),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  byteSize: z.int().min(1).max(MAX_FILE),
  width: z.int().min(1).max(10000),
  height: z.int().min(1).max(10000),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  altEn: z.string().max(300).nullable(),
  altBn: z.string().max(300).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const manifestSchema = z.strictObject({
  format: z.literal("babysunray-media-manifest"),
  version: z.literal(MEDIA_BACKUP_VERSION),
  createdAt: z.iso.datetime(),
  database: z.string().max(63),
  files: z.array(record).max(100_000),
});
export type MediaRecord = z.infer<typeof record>;
export type MediaManifest = z.infer<typeof manifestSchema>;
export type MediaBackupHeader = { format: typeof MEDIA_BACKUP_FORMAT; version: number; createdAt: string; database: string; files: number; bytes: number; manifestSha256: string };

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const READ_ONLY = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

/** The photo records now, in a fixed order (one read-only snapshot). */
export async function mediaRecords(db: Db): Promise<MediaRecord[]> {
  const rows = await db.transaction(
    (tx) =>
      tx
        .select({ media: productMedia, slug: products.slug })
        .from(productMedia)
        .innerJoin(products, eq(products.id, productMedia.productId))
        .orderBy(asc(productMedia.storageKey)),
    READ_ONLY,
  );
  return rows.map(({ media: m, slug }) => ({
    mediaId: m.id,
    productId: m.productId,
    productSlug: slug,
    position: m.position,
    storageKey: m.storageKey,
    contentType: m.contentType,
    byteSize: m.byteSize,
    width: m.width,
    height: m.height,
    sha256: m.sha256,
    altEn: m.altEn,
    altBn: m.altBn,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  }));
}

/** A problem that makes a photo backup, verification or restore unusable. The message is safe to show. */
export class MediaBackupError extends Error {
  override name = "MediaBackupError";
}

function validateManifest(bytes: Buffer, header: MediaBackupHeader): MediaManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new MediaBackupError("The photo backup's manifest is malformed.");
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) throw new MediaBackupError("The photo backup's manifest is malformed or from an unsupported version.");
  const manifest = result.data;
  const keys = new Set(manifest.files.map((f) => f.storageKey));
  const ids = new Set(manifest.files.map((f) => f.mediaId));
  if (keys.size !== manifest.files.length || ids.size !== manifest.files.length) throw new MediaBackupError("The photo backup lists the same file twice.");
  const total = manifest.files.reduce((n, f) => n + f.byteSize, 0);
  if (header.files !== manifest.files.length || header.bytes !== total || header.manifestSha256 !== sha256(bytes)) throw new MediaBackupError("The photo backup's header does not match its manifest.");
  return manifest;
}

/** Reads exactly n bytes from an async byte source, or fewer at its end. */
function exactReader(source: AsyncIterator<Uint8Array>) {
  let buffer = Buffer.alloc(0);
  let done = false;
  return async (n: number): Promise<Buffer> => {
    while (buffer.length < n && !done) {
      const next = await source.next();
      if (next.done) done = true;
      else buffer = buffer.length ? Buffer.concat([buffer, Buffer.from(next.value)]) : Buffer.from(next.value);
    }
    const out = buffer.subarray(0, n);
    buffer = buffer.subarray(out.length);
    return out;
  };
}

/**
 * Opens and reads a photo backup, authenticating every record (wrong passphrase, tampering and truncation are
 * refused) and checking every file's size and SHA-256 against the manifest. `onFile` receives each verified file.
 */
export async function readMediaBackup(
  input: AsyncIterable<Uint8Array>,
  passphrase: string,
  onFile: (file: MediaRecord, data: Buffer) => Promise<void> = async () => {},
): Promise<{ header: MediaBackupHeader; manifest: MediaManifest }> {
  const { header, plaintext } = await openSealed<MediaBackupHeader>(
    input,
    passphrase,
    (h) => h.format === MEDIA_BACKUP_FORMAT && h.version === MEDIA_BACKUP_VERSION && Number.isSafeInteger(h.files) && Number.isSafeInteger(h.bytes) && typeof h.manifestSha256 === "string",
    "photo backup",
  );
  const read = exactReader(plaintext[Symbol.asyncIterator]());
  if (!(await read(MAGIC.length)).equals(MAGIC)) throw new MediaBackupError("The photo backup's content is not in the expected format.");
  const lengthBytes = await read(4);
  if (lengthBytes.length !== 4) throw new MediaBackupError("The photo backup is cut short.");
  const length = lengthBytes.readUInt32BE(0);
  if (length === 0 || length > MAX_MANIFEST) throw new MediaBackupError("The photo backup's manifest is malformed.");
  const manifestBytes = await read(length);
  if (manifestBytes.length !== length) throw new MediaBackupError("The photo backup is cut short.");
  const manifest = validateManifest(manifestBytes, header);
  for (const file of manifest.files) {
    const data = await read(file.byteSize);
    if (data.length !== file.byteSize) throw new MediaBackupError("The photo backup is cut short.");
    if (sha256(data) !== file.sha256) throw new MediaBackupError(`A photo in the backup does not match its recorded SHA-256 (${file.storageKey}).`);
    await onFile(file, data);
  }
  if ((await read(1)).length !== 0) throw new MediaBackupError("The photo backup has data after its last photo.");
  return { header, manifest };
}

export type MediaBackupResult = { files: number; bytes: number; manifestSha256: string; unreferenced: string[]; unexpected: string[] };

/**
 * Writes an encrypted backup of every photo the database records, to `file` (which must not exist), via
 * "<file>.partial" (exclusive, owner-only, flushed, then renamed). Refused, with nothing kept, if a recorded file is
 * missing or different, or the records changed while the files were read.
 */
export async function createMediaBackupFile(db: Db, store: MediaStore, passphrase: string, file: string, meta: { database: string }): Promise<MediaBackupResult> {
  checkPassphrase(passphrase);
  if (await stat(file).then(() => true, () => false)) throw new MediaBackupError("The backup file already exists. Nothing was overwritten.");
  const before = await mediaRecords(db);
  const manifest: MediaManifest = { format: "babysunray-media-manifest", version: MEDIA_BACKUP_VERSION, createdAt: new Date().toISOString(), database: meta.database, files: before };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const bytes = before.reduce((n, f) => n + f.byteSize, 0);
  const header = { format: MEDIA_BACKUP_FORMAT, version: MEDIA_BACKUP_VERSION, createdAt: manifest.createdAt, database: meta.database, files: before.length, bytes, manifestSha256: sha256(manifestBytes) };
  async function* plaintext(): AsyncGenerator<Buffer> {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(manifestBytes.length);
    yield Buffer.concat([MAGIC, length, manifestBytes]);
    for (const f of before) {
      const data = await store.read(f.storageKey);
      if (!data) throw new MediaBackupError(`The photo file ${f.storageKey} is missing. Nothing was saved. Run npm run media:verify.`);
      if (data.length !== f.byteSize || sha256(data) !== f.sha256) {
        throw new MediaBackupError(`The photo file ${f.storageKey} differs from its record. Nothing was saved. Run npm run media:verify.`);
      }
      yield data;
    }
  }
  const partial = `${file}.partial`;
  const handle = await open(partial, "wx", 0o600);
  try {
    try {
      for await (const chunk of sealStream(plaintext(), passphrase, header)) await handle.write(chunk);
      const after = await mediaRecords(db);
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        throw new MediaBackupError("Photos were added, changed or removed while the backup ran. Nothing was saved. Try again when no one is uploading.");
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(partial, file);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  const known = new Set(before.map((f) => f.storageKey));
  const entries = (await store.entries()).sort();
  return {
    files: before.length,
    bytes,
    manifestSha256: header.manifestSha256,
    unreferenced: entries.filter((e) => STORAGE_KEY.test(e) && !known.has(e)),
    unexpected: entries.filter((e) => !STORAGE_KEY.test(e)),
  };
}

/** Verifies a photo backup completely without writing anything. */
export function verifyMediaBackupFile(file: string, passphrase: string) {
  return readMediaBackup(createReadStream(file), passphrase);
}

/**
 * The folder a restore writes into: absolute, existing, a real directory (not a link), empty, and outside the
 * project. Compared on real paths, case-insensitively on Windows.
 */
export async function restoreTarget(dir: string | undefined, projectRoot: string): Promise<string> {
  if (!dir || !path.isAbsolute(dir)) throw new MediaBackupError("Give the restore folder as an absolute path outside the project.");
  let info;
  try {
    info = await lstat(dir);
  } catch {
    throw new MediaBackupError("The restore folder does not exist. Create an empty folder first.");
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new MediaBackupError("The restore folder must be a real folder, not a link or a file.");
  const real = await realpath(dir);
  const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const relative = path.relative(fold(await realpath(projectRoot)), fold(real));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) throw new MediaBackupError("The restore folder is inside the project. Choose a folder outside it.");
  if ((await readdir(real)).length) throw new MediaBackupError("The restore folder is not empty. Restore only into an empty folder; nothing was changed.");
  return real;
}

/**
 * Restores a photo backup into an empty folder. The whole backup is verified first (a separate pass); then each
 * file is written under its checked storage key only (never a path from the archive), exclusively, and checked
 * again. On any failure the files written by this restore are removed, so the folder is left empty.
 */
export async function restoreMediaBackupFile(file: string, passphrase: string, targetDir: string, projectRoot: string): Promise<{ files: number; bytes: number }> {
  const target = await restoreTarget(targetDir, projectRoot);
  return restoreInto(file, passphrase, localMediaStore(target));
}

/**
 * Restores a photo backup into any MediaStore, for a drill against a separate test store or, once approved, a hosted
 * one. It never overwrites: the store must be EMPTY, and the caller must repeat the target's label (`confirmedLabel`
 * must equal `label`), so a restore cannot be pointed at a store holding photos, or at the wrong place, by accident.
 * No command calls it for a hosted store yet: a production recovery action stays disabled until the founder approves
 * one (docs/operations/backup-recovery.md).
 */
export async function restoreMediaBackupToStore(
  file: string,
  passphrase: string,
  store: MediaStore,
  target: { label: string; confirmedLabel: string },
): Promise<{ files: number; bytes: number }> {
  if (!target.label || target.confirmedLabel !== target.label) throw new MediaBackupError("The restore target was not confirmed. Nothing was changed.");
  if ((await store.entries()).length) throw new MediaBackupError("The restore target already holds files. Restore only into an empty store; nothing was changed.");
  return restoreInto(file, passphrase, store);
}

async function restoreInto(file: string, passphrase: string, store: MediaStore): Promise<{ files: number; bytes: number }> {
  await verifyMediaBackupFile(file, passphrase);
  const written: string[] = [];
  try {
    const { header } = await readMediaBackup(createReadStream(file), passphrase, async (f, data) => {
      await store.put(f.storageKey, data);
      written.push(f.storageKey);
      const back = await store.read(f.storageKey);
      if (!back || sha256(back) !== f.sha256) throw new MediaBackupError(`The restored file ${f.storageKey} could not be read back correctly.`);
    });
    return { files: header.files, bytes: header.bytes };
  } catch (error) {
    for (const key of written) await store.remove(key).catch(() => undefined);
    throw error;
  }
}
