import "server-only";
import { createHash } from "node:crypto";
import { asc } from "drizzle-orm";
import type { Db } from "@/db/database";
import { productMedia } from "@/db/schema";
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
    if (STORAGE_KEY.test(name)) {
      if (!known.has(name)) result.unreferenced.push(name);
    } else result.unexpected.push(name);
  }
  return result;
}

export const mediaHealthy = (c: MediaCheck) => c.missing.length + c.changed.length + c.unreferenced.length + c.unexpected.length === 0;
