// `npm run backup:create -- --out <directory>`: an encrypted backup of the local development database
// (babysunray_dev only; same checks as `npm run db:migrate`). For the founder to run in an interactive terminal:
// it asks for a passphrase twice without echo, so it never appears in arguments, history or logs. The backup
// includes the Owner account (its password hash, never the password) and all business data; session tokens
// are left out. The directory must exist and be outside the project. The new file is verified right away.
// No schedule, retention or off-device copy is set up: those wait for the founder's recovery decisions (K-4,
// K-5, K-8, K-9). Node 22.18 or newer.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import pg from "pg";
import { assertToolsMatch, backupDirectory, createBackupFile, MIN_PASSPHRASE, verifyBackupFile } from "../src/db/backup.mts";
import { assertConnectedIdentity, DEV_TARGET, parseSafeDatabaseUrl, pinSearchPath, resolveDatabaseUrl, sessionConfig } from "../src/db/connection-guard.mts";
import { askHidden, assertInteractiveTerminal } from "./prompt.mts";

const ROOT = path.resolve(import.meta.dirname, "..");

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf("--out");
  const dir = await backupDirectory(outIndex > 0 ? process.argv[outIndex + 1] : undefined, ROOT);
  const params = parseSafeDatabaseUrl(resolveDatabaseUrl(), DEV_TARGET);
  const client = new pg.Client(sessionConfig(params));
  await client.connect();
  let serverMajor: number;
  try {
    await assertConnectedIdentity(client, DEV_TARGET);
    await pinSearchPath(client);
    serverMajor = Math.floor(Number((await client.query<{ v: string }>("show server_version_num")).rows[0].v) / 10000);
  } finally {
    await client.end();
  }
  const pgDumpVersion = await assertToolsMatch(serverMajor);

  assertInteractiveTerminal();
  console.log(`Backing up ${DEV_TARGET.database} to ${dir}.`);
  console.log(`Choose a passphrase of at least ${MIN_PASSPHRASE} characters and keep it safe, apart from the backup: without it the backup cannot be read.`);
  const passphrase = await askHidden("Backup passphrase (not shown): ");
  if ((await askHidden("Repeat the passphrase: ")) !== passphrase) throw new Error("The passphrases do not match. Nothing was written.");

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const file = path.join(dir, `${DEV_TARGET.database}-${stamp}.bsbackup`);
  const { bytes } = await createBackupFile(params, passphrase, file, { pgDumpVersion });
  const verified = await verifyBackupFile(file, passphrase);
  console.log(`Backup written and verified: ${file}`);
  console.log(`${bytes} bytes, ${verified.entries.length} archive entries, SHA-256 ${await sha256(file)}.`);
  console.log("This is a local copy only. Restoring it is described in docs/operations/runbook.md (Backup and restore).");
}

main().catch((error: unknown) => {
  // Message only: never a stack, a URL or query parameters.
  console.error(error instanceof Error && !/Failed query/.test(error.message) ? error.message : "Backup failed. Nothing was written.");
  process.exitCode = 1;
});
