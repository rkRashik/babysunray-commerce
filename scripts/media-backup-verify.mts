// `npm run media:backup:verify -- <file>`: decrypts a photo backup completely and checks every record, the manifest
// and every photo's size and SHA-256. Nothing is written and no database is touched. Passphrase without echo.
import path from "node:path";
import { verifyMediaBackupFile } from "../src/modules/media/backup.ts";
import { askHidden, assertInteractiveTerminal } from "./prompt.mts";

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file || !path.isAbsolute(file)) throw new Error("Give the photo backup file as an absolute path.");
  assertInteractiveTerminal();
  const { header, manifest } = await verifyMediaBackupFile(file, await askHidden("Photo backup passphrase (not shown): "));
  const products = new Set(manifest.files.map((f) => f.productId)).size;
  console.log(`Verified: photo backup of ${header.database} created ${header.createdAt}: ${header.files} photo(s) of ${products} product(s), ${header.bytes} bytes.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Verification failed.");
  process.exitCode = 1;
});
