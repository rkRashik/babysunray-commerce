// `npm run media:restore -- <file> --into <empty folder>`: restores a photo backup into an EMPTY folder outside the
// project, never into a folder that holds anything (so the photo folder in use is never overwritten). The whole
// backup is verified first; only checked storage keys are written; on failure the folder is left empty. Then point
// MEDIA_STORAGE_DIR at the folder (after restoring the database too) and run npm run media:verify.
import path from "node:path";
import { restoreMediaBackupFile } from "../src/modules/media/backup.ts";
import { askHidden, assertInteractiveTerminal } from "./prompt.mts";

async function main(): Promise<void> {
  const file = process.argv[2];
  const intoIndex = process.argv.indexOf("--into");
  const target = intoIndex > 0 ? process.argv[intoIndex + 1] : undefined;
  if (!file || !path.isAbsolute(file)) throw new Error("Give the photo backup file as an absolute path, then --into <empty folder>.");
  assertInteractiveTerminal();
  const started = Date.now();
  const { files, bytes } = await restoreMediaBackupFile(file, await askHidden("Photo backup passphrase (not shown): "), target ?? "", path.resolve(import.meta.dirname, ".."));
  console.log(`Restored ${files} photo(s), ${bytes} bytes, in ${Math.round((Date.now() - started) / 1000)} s.`);
  console.log("Next: restore the matching database backup, set MEDIA_STORAGE_DIR to this folder, and run npm run media:verify.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Restore failed. Nothing was restored.");
  process.exitCode = 1;
});
