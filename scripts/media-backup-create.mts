// `npm run media:backup -- --out <directory>`: an encrypted backup of every product photo the local development
// database records (babysunray_dev only, same checks as `npm run db:migrate`), read from MEDIA_STORAGE_DIR. For the
// founder to run in an interactive terminal: the passphrase is asked twice without echo. The directory must exist and
// be outside the project. The backup is refused, with nothing kept, if a recorded photo is missing or different or
// the photos change while it runs. It is verified right away. No schedule, retention or off-device copy is set up.
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { backupDirectory, MIN_PASSPHRASE } from "../src/db/backup.mts";
import { assertConnectedIdentity, DEV_TARGET, parseSafeDatabaseUrl, pinSearchPath, resolveDatabaseUrl, sessionConfig } from "../src/db/connection-guard.mts";
import { createMediaBackupFile, verifyMediaBackupFile } from "../src/modules/media/backup.ts";
import { mediaStoreConfig } from "../src/modules/media/storage.ts";
import { askHidden, assertInteractiveTerminal } from "./prompt.mts";

const ROOT = path.resolve(import.meta.dirname, "..");

function mediaDir(): string | undefined {
  let file: Record<string, string | undefined> = {};
  try {
    file = parseEnv(readFileSync(".env.local", "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return process.env.MEDIA_STORAGE_DIR || file.MEDIA_STORAGE_DIR;
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf("--out");
  const dir = await backupDirectory(outIndex > 0 ? process.argv[outIndex + 1] : undefined, ROOT);
  const config = mediaStoreConfig({ MEDIA_STORAGE_DIR: mediaDir() }, ROOT);
  if (!config.ok) throw new Error(config.problem);
  const pool = new pg.Pool({ ...sessionConfig(parseSafeDatabaseUrl(resolveDatabaseUrl(), DEV_TARGET)), max: 1 });
  try {
    const client = await pool.connect();
    try {
      await assertConnectedIdentity(client, DEV_TARGET);
      await pinSearchPath(client);
    } finally {
      client.release();
    }
    assertInteractiveTerminal();
    console.log(`Backing up the product photos of ${DEV_TARGET.database} to ${dir}.`);
    console.log(`Choose a passphrase of at least ${MIN_PASSPHRASE} characters and keep it safe, apart from the backup: without it the backup cannot be read.`);
    const passphrase = await askHidden("Photo backup passphrase (not shown): ");
    if ((await askHidden("Repeat the passphrase: ")) !== passphrase) throw new Error("The passphrases do not match. Nothing was written.");
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const file = path.join(dir, `${DEV_TARGET.database}-photos-${stamp}.bsmedia`);
    const result = await createMediaBackupFile(drizzle({ client: pool }), config.store, passphrase, file, { database: DEV_TARGET.database });
    const { header } = await verifyMediaBackupFile(file, passphrase);
    console.log(`Photo backup written and verified: ${file}`);
    console.log(`${header.files} photo(s), ${header.bytes} bytes of photos, manifest SHA-256 ${result.manifestSha256}, file SHA-256 ${await sha256(file)}.`);
    if (result.unreferenced.length) console.log(`Not included: ${result.unreferenced.length} file(s) without a record (see npm run media:verify).`);
    if (result.unexpected.length) console.log(`Not included: ${result.unexpected.length} unexpected entr(y/ies) in the photo folder.`);
    console.log("Take the database backup (npm run backup:create) at the same time, with no uploads in between. Restoring: docs/operations/runbook.md.");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error && !/Failed query/.test(error.message) ? error.message : "Photo backup failed. Nothing was written.");
  process.exitCode = 1;
});
