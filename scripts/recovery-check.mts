// `npm run recovery:check -- <database.bsbackup> <photos.bsmedia> [--folder <restored photo folder>]`: after a
// database backup was restored into babysunray_restore (npm run backup:restore), checks that it and a photo backup
// belong together, before anyone switches to the restored copy (docs/operations/runbook.md, "Recovering the database
// and the photos together"). Read-only: it verifies both files completely, reads the restored database's photo
// records and migration count, and with --folder compares a restored photo folder with those records. It writes
// nothing, deletes nothing and never connects to babysunray_dev. Asks for the passphrases without echo; the founder
// runs it. Prints storage keys (random names), never paths, URLs or customer data.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { verifyBackupFile } from "../src/db/backup.mts";
import { assertConnectedIdentity, parseSafeDatabaseUrl, pinSearchPath, resolveEnvValue, RESTORE_TARGET, sessionConfig } from "../src/db/connection-guard.mts";
import { mediaRecords, verifyMediaBackupFile } from "../src/modules/media/backup.ts";
import { mediaHealthy, verifyMediaStore } from "../src/modules/media/manifest.ts";
import { compareBackupPair } from "../src/modules/media/pair.ts";
import { localMediaStore } from "../src/modules/media/storage.ts";
import { askHidden, assertInteractiveTerminal } from "./prompt.mts";

function restoreUrl(): string | undefined {
  let file: Record<string, string | undefined> = {};
  try {
    file = parseEnv(readFileSync(".env.local", "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return resolveEnvValue(RESTORE_TARGET.envName, process.env[RESTORE_TARGET.envName], file[RESTORE_TARGET.envName]);
}

async function main(): Promise<void> {
  const [databaseFile, photoFile, flag, folder] = process.argv.slice(2);
  if (!databaseFile || !photoFile || !path.isAbsolute(databaseFile) || !path.isAbsolute(photoFile)) throw new Error("Give the database backup and the photo backup as absolute paths.");
  if (flag !== undefined && (flag !== "--folder" || !folder || !path.isAbsolute(folder))) throw new Error("Use --folder <absolute path of the restored photo folder>.");
  const params = parseSafeDatabaseUrl(restoreUrl(), RESTORE_TARGET);
  assertInteractiveTerminal();
  const database = await verifyBackupFile(databaseFile, await askHidden("Database backup passphrase (not shown): "));
  const photos = await verifyMediaBackupFile(photoFile, await askHidden("Photo backup passphrase (not shown): "));
  console.log(`Database backup: ${database.header.database}, ${database.header.createdAt}. Photo backup: ${photos.header.database}, ${photos.header.createdAt}, ${photos.header.files} photo(s).`);

  const pool = new pg.Pool({ ...sessionConfig(params), max: 1 });
  try {
    const client = await pool.connect();
    let migrations: number;
    try {
      await assertConnectedIdentity(client, RESTORE_TARGET);
      await pinSearchPath(client);
      const { rows } = await client.query<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations").catch(() => {
        throw new Error(`${RESTORE_TARGET.database} holds no restored database. Restore the database backup first (npm run backup:restore).`);
      });
      migrations = rows[0].n;
    } finally {
      client.release();
    }
    const expected = (JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../drizzle/meta/_journal.json"), "utf8")) as { entries: unknown[] }).entries.length;
    console.log(`Restored database: ${migrations} migration(s) applied; this version of the code has ${expected}.${migrations < expected ? " Apply the newer migrations before using it." : ""}`);
    const db = drizzle({ client: pool });
    const report = compareBackupPair({ databaseBackup: database.header, photoBackup: { ...photos.header, files: photos.manifest.files }, restoredRecords: await mediaRecords(db) });
    console.log(`Photo backup taken ${Math.abs(report.gapSeconds)} s ${report.gapSeconds >= 0 ? "after" : "before"} the database backup.`);
    for (const note of report.notes) console.log(`! ${note}`);
    for (const key of report.missingFromPhotoBackup) console.log(`✗ Recorded, not in the photo backup: ${key}`);
    for (const key of report.notInDatabase) console.log(`✗ In the photo backup, no record: ${key}`);
    for (const key of report.differing) console.log(`✗ Differs between backup and record: ${key}`);
    let folderOk = true;
    if (folder) {
      const check = await verifyMediaStore(db, localMediaStore(folder));
      folderOk = mediaHealthy(check);
      console.log(`Restored photo folder: ${check.ok} of ${check.records} record(s) match their file; ${check.missing.length} missing, ${check.changed.length} changed, ${check.unreferenced.length} without a record, ${check.unexpected.length} unexpected.`);
    }
    if (report.consistent && folderOk) console.log("✓ The two backups belong together: every recorded photo can be restored and nothing is left over.");
    else {
      console.log("✗ The backups do not fully match. Do not switch to the restored copy before deciding what to do about the photos listed above.");
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error && !/Failed query/.test(error.message) ? error.message : "The recovery check failed. Nothing was changed.");
  process.exitCode = 1;
});
