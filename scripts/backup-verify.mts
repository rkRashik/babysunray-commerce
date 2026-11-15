// `npm run backup:verify -- <file>`: checks that a backup can be decrypted and read (every record authenticated,
// the archive listed by pg_restore). No database is touched. Asks for the passphrase without echo.
import path from "node:path";
import { verifyBackupFile } from "../src/db/backup.mts";
import { askHidden, assertInteractiveTerminal } from "./prompt.mts";

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file || !path.isAbsolute(file)) throw new Error("Give the backup file as an absolute path.");
  assertInteractiveTerminal();
  const { header, entries, bytes } = await verifyBackupFile(file, await askHidden("Backup passphrase (not shown): "));
  const tables = entries.filter((e) => / TABLE DATA /.test(e)).length;
  console.log(`Verified: backup of ${header.database} created ${header.createdAt} with ${header.pgDumpVersion}.`);
  console.log(`${entries.length} archive entries (${tables} tables with data), ${bytes} bytes of archive. Session data is not included.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Verification failed.");
  process.exitCode = 1;
});
