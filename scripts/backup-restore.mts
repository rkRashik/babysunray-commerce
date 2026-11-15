// `npm run backup:restore -- <file>`: restores a backup into the local babysunray_restore database, which must
// exist and be empty (the founder creates it: docs/operations/runbook.md). It never restores into
// babysunray_dev or babysunray_test, never drops or overwrites anything, and stops if the target holds any
// table. The whole backup is authenticated first; the restore then runs in one transaction. Target:
// RESTORE_DATABASE_URL (shell or .env.local), checked like DATABASE_URL. Asks for the passphrase without echo.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import pg from "pg";
import { assertToolsMatch, restoreBackupFile, verifyBackupFile } from "../src/db/backup.mts";
import { assertConnectedIdentity, parseSafeDatabaseUrl, pinSearchPath, resolveEnvValue, RESTORE_TARGET, sessionConfig } from "../src/db/connection-guard.mts";
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
  const file = process.argv[2];
  if (!file || !path.isAbsolute(file)) throw new Error("Give the backup file as an absolute path.");
  const params = parseSafeDatabaseUrl(restoreUrl(), RESTORE_TARGET);
  const client = new pg.Client(sessionConfig(params));
  await client.connect();
  try {
    await assertConnectedIdentity(client, RESTORE_TARGET);
    await pinSearchPath(client);
    const { rows } = await client.query<{ n: string }>(
      "select (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'drizzle')) + (select count(*) from pg_namespace where nspname = 'drizzle') as n",
    );
    if (Number(rows[0].n) !== 0) throw new Error(`${RESTORE_TARGET.database} is not empty. Nothing was changed.`);
    await assertToolsMatch(Math.floor(Number((await client.query<{ v: string }>("show server_version_num")).rows[0].v) / 10000));
  } finally {
    await client.end();
  }
  assertInteractiveTerminal();
  const passphrase = await askHidden("Backup passphrase (not shown): ");
  const { header } = await verifyBackupFile(file, passphrase);
  const started = Date.now();
  await restoreBackupFile(file, passphrase, params);
  console.log(`Restored the backup of ${header.database} (${header.createdAt}) into ${RESTORE_TARGET.database} in ${Math.round((Date.now() - started) / 1000)} s.`);
  console.log("Sessions were not restored: sign in again. Check the data before relying on it.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error && !/Failed query/.test(error.message) ? error.message : "Restore failed. Nothing was restored.");
  process.exitCode = 1;
});
