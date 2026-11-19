import { type ChildProcess, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import type https from "node:https";
import os from "node:os";
import path from "node:path";
import { loadEnv } from "vite";
import { freePort, proveServerUsesTestDatabase, seedOwner, stop, waitForServer } from "../e2e/global-setup";
import { run, selfSignedCertificate, tlsProxy } from "../e2e/prod-setup";
import { resetAndMigrate } from "../support/global-setup";
import { assertSafeTestDatabaseUrl, lockTestDatabase } from "../support/test-database";
import { REHEARSAL_IDENTITY } from "./identity";

// Second-installation rehearsal (`npm run test:install`, requirement G-14, partial). It sets up a separate copy
// of the shop the way a new installation would be set up, then runs every browser test against it:
//  1. `git clone` of the committed HEAD into a new temporary folder outside the project: no working-tree
//     changes, no .env files, no node_modules, no media, no build output.
//  2. `npm ci --offline --ignore-scripts`: the locked dependencies from the local npm cache (no network, no
//     install scripts, nothing added to or removed from this project).
//  3. The clone's own `npm run backup:drill` and `npm run media:drill` (database and photo backup, verify and
//     restore on fictional data), with only TEST_DATABASE_URL passed in.
//  4. babysunray_test reset and migrated from the clone's migrations; one fictional Owner, a new random
//     password and auth secret; a new empty photo folder; fictional branding (tests/install/identity.ts).
//  5. The clone's `next build` and `next start` (NODE_ENV=production behind the local TLS proxy), with proof that
//     it authenticates against babysunray_test.
// What it cannot show: an independent PostgreSQL server (the guards accept only the local babysunray_test
// database and role on this machine), a different operating-system user or machine, or an online install.
// Teardown stops only what it started and deletes the clone, the photo folder and the certificate.

const ROOT = process.cwd();
const SCRUB = /^(DATABASE_URL|TEST_DATABASE_URL|BETTER_AUTH_|API_RATE_LIMIT_|MEDIA_|STORE_|NODE_ENV$|E2E_)/;

function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };
  for (const name of Object.keys(env)) if (SCRUB.test(name)) delete env[name];
  return env;
}

/** Runs a command to completion in `cwd`; throws with the tail of its output when it fails. */
function step(what: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${what} failed in the rehearsal copy.\n${(result.stdout ?? "").slice(-3000)}\n${(result.stderr ?? "").slice(-3000)}`);
  console.log(`[rehearsal] ${what}: passed in ${Math.round((Date.now() - started) / 1000)} s`);
}

export default async function installSetup(): Promise<() => Promise<void>> {
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error("Run the rehearsal with `npm run test:install`.");
  const fileEnv = loadEnv("test", ROOT, "");
  const url = process.env.TEST_DATABASE_URL ?? fileEnv.TEST_DATABASE_URL;
  assertSafeTestDatabaseUrl(url, process.env.DATABASE_URL ?? fileEnv.DATABASE_URL);

  const work = mkdtempSync(path.join(os.tmpdir(), "rehearsal-shop-"));
  const clone = path.join(work, "shop");
  const mediaDir = mkdtempSync(path.join(os.tmpdir(), "rehearsal-media-"));
  const certDir = mkdtempSync(path.join(os.tmpdir(), "rehearsal-tls-"));
  let lock: Awaited<ReturnType<typeof lockTestDatabase>> | undefined;
  let child: ChildProcess | undefined;
  let proxy: https.Server | undefined;
  const teardown = async () => {
    if (child) stop(child);
    if (proxy) await new Promise((r) => proxy?.close(r));
    for (const dir of [work, mediaDir, certDir]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    await lock?.end();
  };

  try {
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
    step("clean checkout of the committed HEAD", "git", ["clone", "--quiet", "--no-hardlinks", ROOT, clone], work, scrubbedEnv());
    const cloned = spawnSync("git", ["rev-parse", "HEAD"], { cwd: clone, encoding: "utf8" }).stdout.trim();
    const leftovers = readdirSync(clone).filter((name) => /^\.env(?!\.example$)|^node_modules$|^\.next$/.test(name));
    if (!head || cloned !== head || leftovers.length) throw new Error(`The rehearsal copy is not a clean checkout of ${head} (${leftovers.join(", ")}).`);
    console.log(`[rehearsal] commit ${head.slice(0, 7)} in ${clone}`);
    // Handover step for another business: BabySunray's logo files are deleted from the copy (docs/operations/installation.md).
    rmSync(path.join(clone, "public", "brand"), { recursive: true, force: true });

    step("npm ci (offline, locked versions)", process.execPath, [npm, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], clone, scrubbedEnv());
    const drillEnv = { ...scrubbedEnv(), TEST_DATABASE_URL: url };
    step("npm run backup:drill", process.execPath, [npm, "run", "backup:drill"], clone, drillEnv);
    step("npm run media:drill", process.execPath, [npm, "run", "media:drill"], clone, drillEnv);

    lock = await lockTestDatabase(url);
    await resetAndMigrate(url, path.join(clone, "drizzle"));
    const password = randomBytes(24).toString("base64url");
    await seedOwner(lock, password);

    const [proxyPort, appPort] = [await freePort(), await freePort()];
    const baseURL = `https://127.0.0.1:${proxyPort}`;
    const env: NodeJS.ProcessEnv = {
      ...scrubbedEnv(),
      ...REHEARSAL_IDENTITY,
      NODE_ENV: "production",
      DATABASE_URL: url,
      BETTER_AUTH_SECRET: randomBytes(32).toString("base64"),
      BETTER_AUTH_URL: baseURL,
      MEDIA_STORAGE_DIR: mediaDir,
      MEDIA_LOCAL_STORAGE_IN_PRODUCTION: "allow",
    };
    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4000);
    };
    const started = Date.now();
    const build = run(["build"], env, keep, clone);
    const code = await new Promise<number | null>((resolve) => build.on("close", resolve));
    if (code !== 0) throw new Error(`next build failed in the rehearsal copy.\n${output}`);
    console.log(`[rehearsal] next build: passed in ${Math.round((Date.now() - started) / 1000)} s`);

    child = run(["start", "--port", String(appPort), "--hostname", "127.0.0.1"], env, keep, clone);
    proxy = tlsProxy(selfSignedCertificate(certDir), appPort);
    await new Promise<void>((resolve) => proxy?.listen(proxyPort, "127.0.0.1", resolve));
    await waitForServer(`http://127.0.0.1:${appPort}`, child, () => output);
    await proveServerUsesTestDatabase(lock, `http://127.0.0.1:${appPort}`, password, baseURL);

    Object.assign(process.env, { E2E_BASE_URL: baseURL, E2E_OWNER_PASSWORD: password, E2E_TEST_DATABASE_URL: url, E2E_MEDIA_DIR: mediaDir });
    return teardown;
  } catch (error) {
    await teardown();
    throw error;
  }
}
