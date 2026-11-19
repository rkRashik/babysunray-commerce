import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { hashPassword } from "better-auth/crypto";
import type { Client } from "pg";
import { loadEnv } from "vite";
import { markTestDatabaseAsStaging, resetAndMigrate } from "../support/global-setup";
import { assertSafeTestDatabaseUrl, lockTestDatabase } from "../support/test-database";
import { E2E_OWNER } from "./support";

// Fail-closed set-up for the browser tests (`npm run test:e2e`):
//  1. TEST_DATABASE_URL must name the local babysunray_test database and role and differ from DATABASE_URL;
//     PostgreSQL then confirms the identity on the connection that takes the test-run lock (shared with
//     `npm run test:db`, so neither run can reset the database while the other is active).
//  2. The test database is reset and migrated, and one fictional Owner is created with a random password.
//  3. A dedicated `next dev` starts on a free 127.0.0.1 port with its own output directory, the test database
//     as DATABASE_URL and a random auth secret. Explicit variables win over .env.local, which is not changed.
//  4. Before any test, a sign-in through that server must create a session row in babysunray_test: proof that
//     the server uses the test database (the development database has no such account).
// Teardown stops only the process this set-up started, restores next-env.d.ts and releases the lock.

// Playwright loads this file as CommonJS (no import.meta); `npm run test:e2e` runs from the project root.
const ROOT = process.cwd();
const DIST_DIR = ".next/e2e";
const NEXT_ENV = path.join(ROOT, "next-env.d.ts");

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("No free port."))));
    });
  });
}

export function stop(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  // Only this process tree: the server started below and its workers.
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else process.kill(-child.pid, "SIGTERM");
}

export async function waitForServer(baseURL: string, child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The E2E server exited early.\n${output()}`);
    try {
      const response = await fetch(`${baseURL}/admin/login`, { redirect: "manual" });
      if (response.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`The E2E server did not start within 3 minutes.\n${output()}`);
}

export async function seedOwner(client: Client, password: string): Promise<void> {
  const hash = await hashPassword(password);
  const { rows } = await client.query<{ id: string }>(
    "insert into auth_users (name, email, created_at, updated_at) values ($1, $2, now(), now()) returning id",
    [E2E_OWNER.name, E2E_OWNER.email],
  );
  const id = rows[0].id;
  await client.query(
    `insert into auth_accounts (account_id, provider_id, user_id, password, created_at, updated_at)
     values ($1, 'credential', $2, $3, now(), now())`,
    [id, id, hash],
  );
  await client.query("insert into user_access (user_id, role) values ($1, 'owner')", [id]);
}

/** Signs in once over HTTP and checks that the session landed in babysunray_test, then removes it. */
export async function proveServerUsesTestDatabase(client: Client, baseURL: string, password: string, origin = baseURL): Promise<void> {
  const response = await fetch(`${baseURL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email: E2E_OWNER.email, password }),
  });
  const { rows } = await client.query<{ n: number }>(
    "select count(*)::int as n from auth_sessions s join auth_users u on u.id = s.user_id where u.email = $1",
    [E2E_OWNER.email],
  );
  if (response.status !== 200 || rows[0].n !== 1) {
    throw new Error("The E2E server did not authenticate against babysunray_test. Stopping before any browser test.");
  }
  await client.query("delete from auth_sessions");
  await client.query("delete from auth_rate_limits");
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const fileEnv = loadEnv("test", ROOT, "");
  const url = process.env.TEST_DATABASE_URL ?? fileEnv.TEST_DATABASE_URL;
  assertSafeTestDatabaseUrl(url, process.env.DATABASE_URL ?? fileEnv.DATABASE_URL);
  const lock = await lockTestDatabase(url);

  let child: ChildProcess | undefined;
  let nextEnvBefore: string | null = null;
  // Fictional test photos only, in a throwaway folder outside the project (never the founder's media folder).
  const mediaDir = mkdtempSync(path.join(os.tmpdir(), "babysunray-e2e-media-"));
  const teardown = async () => {
    if (child) stop(child);
    rmSync(mediaDir, { recursive: true, force: true });
    // `next dev` rewrites next-env.d.ts for its output directory; put back what the developer had.
    if (nextEnvBefore !== null) writeFileSync(NEXT_ENV, nextEnvBefore);
    await lock.end();
  };

  try {
    await resetAndMigrate(url);
    // The browser tests rehearse founder acceptance (the real shop and checkout), which runs only on a staging-marked database.
    await markTestDatabaseAsStaging(lock);
    const password = randomBytes(24).toString("base64url");
    await seedOwner(lock, password);

    try {
      nextEnvBefore = readFileSync(NEXT_ENV, "utf8");
    } catch {
      nextEnvBefore = null;
    }
    writeFileSync(path.join(ROOT, "tsconfig.e2e.json"), `${JSON.stringify({ extends: "./tsconfig.json" }, null, 2)}\n`);

    const port = await freePort();
    const baseURL = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of Object.keys(env)) {
      if (/^(DATABASE_URL|TEST_DATABASE_URL|BETTER_AUTH_|API_RATE_LIMIT_|MEDIA_|NODE_ENV$)/.test(name)) delete env[name];
    }
    // No real Google client, proxy trust or CDN in tests, whatever .env.local holds (set but empty wins over .env files).
    for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "RESEND_API_KEY", "EMAIL_FROM", "ADMIN_SETUP_TOKEN", "TRUSTED_PROXY", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "CLOUDINARY_FOLDER"]) env[name] = "";
    Object.assign(env, {
      DATABASE_URL: url,
      BETTER_AUTH_SECRET: randomBytes(32).toString("base64"),
      BETTER_AUTH_URL: baseURL,
      E2E_NEXT_DIST_DIR: DIST_DIR,
      NEXT_TELEMETRY_DISABLED: "1",
      MEDIA_STORAGE_DIR: mediaDir,
    });
    let output = "";
    child = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "dev", "--port", String(port), "--hostname", "127.0.0.1"], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4000);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);

    await waitForServer(baseURL, child, () => output);
    await proveServerUsesTestDatabase(lock, baseURL, password);

    process.env.E2E_BASE_URL = baseURL;
    process.env.E2E_OWNER_PASSWORD = password;
    process.env.E2E_TEST_DATABASE_URL = url;
    process.env.E2E_MEDIA_DIR = mediaDir;
    return teardown;
  } catch (error) {
    await teardown();
    throw error;
  }
}
