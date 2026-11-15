import "server-only";
import { createHash } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import { productMedia } from "@/db/schema";
import { assertPermission, type Principal } from "../auth/principal";
import { type MediaStore, STORAGE_KEY } from "./storage";

// The media manifest check (requirement K-2): every photo record must have its file, byte for byte (size and
// SHA-256), and every file must have a record. The database backup holds the records; the files are NOT in it
// and must be copied separately (docs/operations/runbook.md). Run after copying or restoring either side.

export type MediaCheck = {
  records: number;
  ok: number;
  /** Records whose file is missing. */
  missing: string[];
  /** Records whose file differs in size or SHA-256. */
  changed: string[];
  /** Files with no record (for example left by an interrupted upload). */
  unreferenced: string[];
  /** Other entries in the folder: unfinished writes (.partial) or files this application did not create. */
  unexpected: string[];
};

export async function verifyMediaStore(db: Db, store: MediaStore): Promise<MediaCheck> {
  const rows = await db
    .select({ key: productMedia.storageKey, byteSize: productMedia.byteSize, sha256: productMedia.sha256 })
    .from(productMedia)
    .orderBy(asc(productMedia.storageKey));
  const result: MediaCheck = { records: rows.length, ok: 0, missing: [], changed: [], unreferenced: [], unexpected: [] };
  for (const row of rows) {
    const data = await store.read(row.key);
    if (!data) result.missing.push(row.key);
    else if (data.length !== row.byteSize || createHash("sha256").update(data).digest("hex") !== row.sha256) result.changed.push(row.key);
    else result.ok += 1;
  }
  const known = new Set(rows.map((r) => r.key));
  for (const name of (await store.entries()).sort()) {
    const regular = (await store.info(name))?.regularFile === true;
    // A link or folder under a photo's name is never treated as a photo.
    if (STORAGE_KEY.test(name) && regular) {
      if (!known.has(name)) result.unreferenced.push(name);
    } else result.unexpected.push(name);
  }
  return result;
}

/** Files without a record are kept this long before they may be removed, so an upload in progress is never touched. */
export const UNREFERENCED_GRACE_MS = 60 * 60 * 1000;

/**
 * Removes photo files that no record uses and that have not changed for an hour (left by an interrupted upload or
 * removal). Each file is checked again against the records just before it is deleted. Only regular files named like
 * a photo are ever deleted; unexpected entries are left alone. Owner only (catalog:write), never automatic.
 */
export async function removeUnreferencedFiles(db: Db, principal: Principal, store: MediaStore, now = Date.now()): Promise<{ removed: string[]; kept: string[] }> {
  assertPermission(principal, "catalog:write");
  const { unreferenced } = await verifyMediaStore(db, store);
  const removed: string[] = [];
  const kept: string[] = [];
  for (const key of unreferenced) {
    const info = await store.info(key);
    const [stillUnreferenced] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(productMedia).where(eq(productMedia.storageKey, key));
    if (!info?.regularFile || info.modifiedMs > now - UNREFERENCED_GRACE_MS || stillUnreferenced.n !== 0) {
      kept.push(key);
      continue;
    }
    await store.remove(key);
    removed.push(key);
  }
  if (removed.length) console.log(JSON.stringify({ level: "info", event: "media_unreferenced_removed", count: removed.length }));
  return { removed, kept };
}

export const mediaHealthy = (c: MediaCheck) => c.missing.length + c.changed.length + c.unreferenced.length + c.unexpected.length === 0;
