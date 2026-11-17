// `npm run media:verify:staging` and `npm run media:backup:staging -- --out <directory>`: the photo checks and the
// encrypted photo backup (the same .bsmedia format as `npm run media:backup`) for the hosted STAGING project: the photo
// records come from the staging database (as the application role, through the transaction pooler, read-only) and the
// photo files from the staging Storage bucket. Both only READ: nothing is uploaded, changed or deleted in the database
// or the bucket. The backup is refused, with nothing kept, if a recorded photo is missing or different, or the records
// change while it runs. The founder runs them (the backup asks for a passphrase twice, without echo). Without the
// staging settings they report NOT RUN and exit 2. Restoring a photo backup into a bucket has no command (disabled until
// approved; docs/operations/runbook.md). Gate H.47. Tested against a fake Storage only; a real bucket has not been used.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { backupDirectory, MIN_PASSPHRASE } from "../src/db/backup.mts";
import { APP_ROLE, assertNotLocalDatabase, assertStagingTarget, parseStagingUrl } from "../src/db/hosted-target.mts";
import { stagingPreflight } from "../src/db/staging-preflight.mts";
import { createMediaBackupFile, verifyMediaBackupFile } from "../src/modules/media/backup.ts";
import { mediaHealthy, verifyMediaStore } from "../src/modules/media/manifest.ts";
import { supabaseMediaStore, supabaseStorageConfig } from "../src/modules/media/supabase-store.ts";
import { askHidden, assertInteractiveTerminal } from "./prompt.mts";
import { readStagingEnv, ROOT } from "./staging-env.mts";

const NEEDED = ["STAGING_DATABASE_URL", "STAGING_DATABASE_SSL", "STAGING_SUPABASE_URL", "STAGING_SUPABASE_SECRET_KEY", "STAGING_STORAGE_BUCKET"];

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function main(): Promise<number> {
  const mode = process.argv[2];
  if (mode !== "verify" && mode !== "backup") throw new Error("Use: verify, or backup --out <directory>.");
  const env = readStagingEnv();
  const problems = stagingPreflight(env).settings.filter((s) => (NEEDED.includes(s.name) || s.name.startsWith("(")) && s.state !== "ok");
  if (problems.length) {
    console.log("NOT RUN — awaiting founder setup.");
    for (const p of problems) console.log(`${p.state === "missing" ? "MISSING" : "INVALID"}  ${p.name}${p.note ? ` — ${p.note}` : ""}`);
    console.log("Nothing was connected to. See docs/operations/staging-setup.md; npm run staging:preflight lists every setting.");
    return 2;
  }
  const outIndex = process.argv.indexOf("--out");
  const dir = mode === "backup" ? await backupDirectory(outIndex > 0 ? process.argv[outIndex + 1] : undefined, ROOT) : "";
  const conn = parseStagingUrl(env, "STAGING_DATABASE_URL", { pooled: true });
  assertNotLocalDatabase(conn, env);
  const storage = supabaseStorageConfig({ SUPABASE_URL: env.STAGING_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: env.STAGING_SUPABASE_SECRET_KEY, SUPABASE_STORAGE_BUCKET: env.STAGING_STORAGE_BUCKET });
  if (!storage.ok) throw new Error(storage.problems.map((p) => p.problem).join(" "));
  const store = supabaseMediaStore(storage.config);

  const pool = new pg.Pool({ host: conn.host, port: conn.port, database: conn.database, user: conn.user, password: conn.password, ssl: conn.ssl, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    const client = await pool.connect();
    try {
      const identity = await assertStagingTarget(client);
      if (identity.user !== APP_ROLE) throw new Error(`Connected as ${identity.user}; this command uses the application role ${APP_ROLE} (read-only).`);
    } finally {
      client.release();
    }
    const bucket = await store.bucketState();
    if (!bucket.reachable) throw new Error("The staging bucket could not be reached (check the project URL, bucket name and secret key).");
    if (!bucket.private) throw new Error("The staging bucket is not private. Refusing: make it private in Supabase Storage first.");
    const db = drizzle({ client: pool });

    if (mode === "verify") {
      const check = await verifyMediaStore(db, store);
      console.log(`Records: ${check.records}, matching: ${check.ok}, missing: ${check.missing.length}, changed: ${check.changed.length}, without a record: ${check.unreferenced.length}, unexpected: ${check.unexpected.length}.`);
      for (const [label, keys] of [["missing", check.missing], ["changed", check.changed], ["without a record", check.unreferenced], ["unexpected", check.unexpected]] as const) {
        if (keys.length) console.log(`  ${label}: ${keys.slice(0, 20).join(", ")}${keys.length > 20 ? ` (+${keys.length - 20} more)` : ""}`);
      }
      return mediaHealthy(check) ? 0 : 1;
    }

    assertInteractiveTerminal();
    console.log(`Backing up the staging photos (${conn.database} on ${conn.host}, bucket ${storage.config.bucket}) to ${dir}. Nothing in the database or the bucket is changed.`);
    console.log(`Choose a passphrase of at least ${MIN_PASSPHRASE} characters and keep it apart from the backup.`);
    const passphrase = await askHidden("Photo backup passphrase (not shown): ");
    if ((await askHidden("Repeat the passphrase: ")) !== passphrase) throw new Error("The passphrases do not match. Nothing was written.");
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const file = path.join(dir, `staging-${conn.database}-photos-${stamp}.bsmedia`);
    const result = await createMediaBackupFile(db, store, passphrase, file, { database: conn.database });
    const { header } = await verifyMediaBackupFile(file, passphrase);
    console.log(`Photo backup written and verified: ${file}`);
    console.log(`${header.files} photo(s), ${header.bytes} bytes of photos, manifest SHA-256 ${result.manifestSha256}, file SHA-256 ${await sha256(file)}.`);
    if (result.unreferenced.length) console.log(`Not included: ${result.unreferenced.length} object(s) without a record (see npm run media:verify:staging).`);
    if (result.unexpected.length) console.log(`Not included: ${result.unexpected.length} unexpected object(s) in the bucket.`);
    console.log("Take the database backup (npm run backup:create:staging) at the same time, with no uploads in between.");
    return 0;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error && !/Failed query/.test(error.message) ? error.message : "The staging photo command failed. Nothing was written.");
    process.exitCode = 1;
  },
);
