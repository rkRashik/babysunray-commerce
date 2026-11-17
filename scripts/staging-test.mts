// `npm run test:staging`: the staging verification suite (tests/staging) against a dedicated, HOSTED Supabase STAGING
// project, after the founder has set it up (docs/operations/staging-setup.md). Settings come from the shell or from
// `.env.staging.local` (git-ignored; never committed, never printed). Without them it reports NOT RUN and exits 2:
// a missing setup is never a pass. With them it first refuses anything that is not a hosted, staging-marked database
// distinct from the local ones; the suite then checks again inside (tests/staging/global-setup.ts). Gate H.45.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { readStagingEnv } from "./staging-env.mts";
import { assertNotLocalDatabase, parseStagingUrl } from "../src/db/hosted-target.mts";

const ROOT = path.resolve(import.meta.dirname, "..");
export const REQUIRED = [
  "STAGING_DATABASE_URL",
  "STAGING_DATABASE_SSL",
  "STAGING_SUPABASE_URL",
  "STAGING_SUPABASE_PUBLISHABLE_KEY",
  "STAGING_SUPABASE_SECRET_KEY",
  "STAGING_STORAGE_BUCKET",
];

function main(): number {
  const env = readStagingEnv();
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length) {
    console.log("NOT RUN — awaiting founder setup.");
    console.log(`Missing staging settings (names only): ${missing.join(", ")}.`);
    console.log("Nothing was tested and nothing was connected to. See docs/operations/staging-setup.md.");
    return 2;
  }
  try {
    assertNotLocalDatabase(parseStagingUrl(env, "STAGING_DATABASE_URL", { pooled: true }), env);
  } catch (error) {
    console.log(`NOT RUN — ${error instanceof Error ? error.message : "the staging settings are not valid"}`);
    return 2;
  }
  const user = parseStagingUrl(env, "STAGING_DATABASE_URL", { pooled: true }).user;
  const ref = user.includes(".") ? user.slice(user.indexOf(".") + 1) : null;
  let supabaseHost = "";
  try {
    supabaseHost = new URL(env.STAGING_SUPABASE_URL ?? "").hostname;
  } catch {
    // reported below
  }
  if (!ref || supabaseHost.split(".")[0] !== ref) {
    console.log("NOT RUN — STAGING_DATABASE_URL (user babysunray_app.<project-ref>) and STAGING_SUPABASE_URL (https://<project-ref>.supabase.co) must name the same project.");
    return 2;
  }
  if (process.argv.includes("--check-only")) {
    console.log("Staging settings are present and well-formed (values not shown). Run npm run test:staging to test.");
    return 0;
  }
  // The suite gets the operating system's own variables and the staging settings it needs; nothing that names a local
  // database, no other secret, and never the migration (administrator) connection.
  const child: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name.startsWith("STAGING_") || /DATABASE_URL|SECRET|PASSWORD|TOKEN|_KEY$|^PG/i.test(name)) continue;
    child[name] = value;
  }
  for (const name of [...REQUIRED, "STAGING_DATABASE_SSL_ROOT_CERT"]) if (env[name]) child[name] = env[name]!;
  const result = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--config", "vitest.staging.config.mts"], { cwd: ROOT, env: child as NodeJS.ProcessEnv, stdio: "inherit" });
  return result.status ?? 1;
}

process.exitCode = main();
