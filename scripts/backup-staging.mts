// `npm run backup:create:staging -- --out <directory>`: an encrypted backup of a HOSTED STAGING database's application
// schemas (public and drizzle; not the provider's own schemas), in the same format as `npm run backup:create`, so
// `backup:verify` reads it and `backup:restore` restores it into the local empty babysunray_restore for a drill.
// For the founder to run in an interactive terminal; it asks for a passphrase twice without echo. Only a database
// marked staging is accepted (src/db/hosted-target.mts), over a direct or session connection with TLS. Session tokens,
// verification tokens and rate-limit windows are left out, as in local backups. Gate H.45; Node 22.18 or newer.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import pg from "pg";
import { assertToolsMatch, backupDirectory, createBackupFile, MIN_PASSPHRASE, verifyBackupFile } from "../src/db/backup.mts";
import { assertNotLocalDatabase, assertStagingTarget, parseStagingUrl } from "../src/db/hosted-target.mts";
import { readStagingEnv } from "./staging-env.mts";
import { askHidden, assertInteractiveTerminal } from "./prompt.mts";

const ROOT = path.resolve(import.meta.dirname, "..");

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function main(): Promise<void> {
  const env = readStagingEnv();
  const outIndex = process.argv.indexOf("--out");
  const dir = await backupDirectory(outIndex > 0 ? process.argv[outIndex + 1] : undefined, ROOT);
  const conn = parseStagingUrl(env, "STAGING_MIGRATION_DATABASE_URL", { pooled: false });
  assertNotLocalDatabase(conn, env);
  const client = new pg.Client({ host: conn.host, port: conn.port, database: conn.database, user: conn.user, password: conn.password, ssl: conn.ssl, connectionTimeoutMillis: 10_000 });
  let serverMajor: number;
  try {
    await client.connect();
    serverMajor = Math.floor((await assertStagingTarget(client)).serverVersion / 10000);
  } finally {
    await client.end().catch(() => undefined);
  }
  const pgDumpVersion = await assertToolsMatch(serverMajor);

  assertInteractiveTerminal();
  console.log(`Backing up the staging database ${conn.database} on ${conn.host} (schemas public and drizzle) to ${dir}.`);
  console.log(`Choose a passphrase of at least ${MIN_PASSPHRASE} characters and keep it apart from the backup.`);
  const passphrase = await askHidden("Backup passphrase (not shown): ");
  if ((await askHidden("Repeat the passphrase: ")) !== passphrase) throw new Error("The passphrases do not match. Nothing was written.");

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const file = path.join(dir, `staging-${conn.database.replace(/[^\w.-]/g, "_")}-${stamp}.bsbackup`);
  const { bytes } = await createBackupFile({ host: conn.host, port: conn.port, database: conn.database, user: conn.user, password: conn.password, sslMode: conn.sslMode, sslRootCert: conn.sslRootCert, schemas: ["public", "drizzle"] }, passphrase, file, { pgDumpVersion });
  const verified = await verifyBackupFile(file, passphrase);
  console.log(`Backup written and verified: ${file}`);
  console.log(`${bytes} bytes, ${verified.entries.length} archive entries, SHA-256 ${await sha256(file)}.`);
  console.log("Photos in the bucket are not in this file: see docs/operations/staging-setup.md (Backups).");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error && !/Failed query|password/i.test(error.message) ? error.message : "Backup failed. Nothing was written.");
  process.exitCode = 1;
});
