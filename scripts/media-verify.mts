// `npm run media:verify`: checks the product photo manifest of the local development database against the media
// folder (MEDIA_STORAGE_DIR): every record has its file with the recorded size and SHA-256, and every file has a
// record. Read-only: nothing is deleted, moved or written. Run it after copying or restoring the database or
// the photo folder (docs/operations/runbook.md, Product photos). Prints storage keys (random names), never paths.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { assertConnectedIdentity, DEV_TARGET, parseSafeDatabaseUrl, pinSearchPath, resolveDatabaseUrl, sessionConfig } from "../src/db/connection-guard.mts";
import { mediaHealthy, verifyMediaStore } from "../src/modules/media/manifest.ts";
import { mediaStoreConfig } from "../src/modules/media/storage.ts";

function mediaEnv(): Record<string, string | undefined> {
  let file: Record<string, string | undefined> = {};
  try {
    file = parseEnv(readFileSync(".env.local", "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { MEDIA_STORAGE_DIR: process.env.MEDIA_STORAGE_DIR || file.MEDIA_STORAGE_DIR };
}

async function main(): Promise<void> {
  const config = mediaStoreConfig(mediaEnv(), path.resolve(import.meta.dirname, ".."));
  if (!config.ok) throw new Error(config.problem);
  const params = parseSafeDatabaseUrl(resolveDatabaseUrl(), DEV_TARGET);
  const pool = new pg.Pool({ ...sessionConfig(params), max: 1 });
  try {
    const client = await pool.connect();
    try {
      await assertConnectedIdentity(client, DEV_TARGET);
      await pinSearchPath(client);
    } finally {
      client.release();
    }
    const check = await verifyMediaStore(drizzle({ client: pool }), config.store);
    console.log(`${check.records} photo record(s); ${check.ok} match their file.`);
    for (const [label, keys] of [
      ["Missing file", check.missing],
      ["File differs from its record", check.changed],
      ["File without a record (left by an interrupted upload; safe to delete after checking)", check.unreferenced],
      ["Unexpected entry in the folder", check.unexpected],
    ] as const) {
      for (const key of keys) console.log(`✗ ${label}: ${key}`);
    }
    if (mediaHealthy(check)) console.log("✓ The photo folder and the database agree.");
    else process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error && !/Failed query/.test(error.message) ? error.message : "Media verification failed.");
  process.exitCode = 1;
});
