import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { loadEnv } from "vite";
import { resetAndMigrate } from "../support/global-setup";
import { assertSafeTestDatabaseUrl, lockTestDatabase } from "../support/test-database";
import { freePort, proveServerUsesTestDatabase, seedOwner, stop, waitForServer } from "./global-setup";

// Production-build smoke harness (`npm run test:e2e:prod`). Same database safeguards as the development browser
// tests (identity checks, shared test-run lock, guarded reset, fictional Owner, proof the server uses
// babysunray_test), but the application is `next build` + `next start` with NODE_ENV=production, so Better
// Auth's production rules apply unchanged: an https base URL and Secure cookies. HTTPS comes from a local TLS
// proxy with a throwaway self-signed certificate (created with openssl in a temporary directory outside the
// repository and deleted at the end); the browser is told to accept it. Nothing in the application is relaxed.

const ROOT = process.cwd();
const DIST_DIR = ".next/e2e-prod";
const NEXT_ENV = path.join(ROOT, "next-env.d.ts");

export function selfSignedCertificate(dir: string): { key: Buffer; cert: Buffer } {
  const result = spawnSync(
    "openssl",
    ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem")],
    { stdio: "pipe", windowsHide: true },
  );
  if (result.status !== 0) throw new Error("openssl could not create the test certificate; the production smoke test needs openssl on the PATH.");
  return { key: readFileSync(path.join(dir, "key.pem")), cert: readFileSync(path.join(dir, "cert.pem")) };
}

/** A TLS front for the local server: forwards each request unchanged (Host included), marking it as https. */
export function tlsProxy(tls: { key: Buffer; cert: Buffer }, appPort: number): https.Server {
  return https.createServer(tls, (req, res) => {
    const upstream = http.request(
      { host: "127.0.0.1", port: appPort, method: req.method, path: req.url, headers: { ...req.headers, "x-forwarded-proto": "https" } },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
}

/** Runs this checkout's (or `root`'s) Next.js CLI. */
export function run(args: string[], env: NodeJS.ProcessEnv, keep: (chunk: Buffer) => void, root = ROOT): ChildProcess {
  const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  return child;
}

export default async function prodSetup(): Promise<() => Promise<void>> {
  const fileEnv = loadEnv("test", ROOT, "");
  const url = process.env.TEST_DATABASE_URL ?? fileEnv.TEST_DATABASE_URL;
  assertSafeTestDatabaseUrl(url, process.env.DATABASE_URL ?? fileEnv.DATABASE_URL);
  const lock = await lockTestDatabase(url);
  const certDir = mkdtempSync(path.join(os.tmpdir(), "babysunray-e2e-tls-"));
  // Fictional test photos only, in a throwaway folder outside the project. Allowing local storage under
  // NODE_ENV=production is this harness's explicit choice for a local disk, as the runbook describes.
  const mediaDir = mkdtempSync(path.join(os.tmpdir(), "babysunray-e2e-media-"));
  let child: ChildProcess | undefined;
  let proxy: https.Server | undefined;
  let nextEnvBefore: string | null = null;
  const teardown = async () => {
    if (child) stop(child);
    if (proxy) await new Promise((r) => proxy?.close(r));
    rmSync(certDir, { recursive: true, force: true });
    rmSync(mediaDir, { recursive: true, force: true });
    if (nextEnvBefore !== null) writeFileSync(NEXT_ENV, nextEnvBefore);
    await lock.end();
  };
  try {
    await resetAndMigrate(url);
    const password = randomBytes(24).toString("base64url");
    await seedOwner(lock, password);
    try {
      nextEnvBefore = readFileSync(NEXT_ENV, "utf8");
    } catch {
      nextEnvBefore = null;
    }
    writeFileSync(path.join(ROOT, "tsconfig.e2e.json"), `${JSON.stringify({ extends: "./tsconfig.json" }, null, 2)}\n`);

    const [proxyPort, appPort] = [await freePort(), await freePort()];
    const baseURL = `https://127.0.0.1:${proxyPort}`;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of Object.keys(env)) if (/^(DATABASE_URL|TEST_DATABASE_URL|BETTER_AUTH_|API_RATE_LIMIT_|MEDIA_|NODE_ENV$)/.test(name)) delete env[name];
    Object.assign(env, { DATABASE_URL: url, BETTER_AUTH_SECRET: randomBytes(32).toString("base64"), BETTER_AUTH_URL: baseURL, E2E_NEXT_DIST_DIR: DIST_DIR, NEXT_TELEMETRY_DISABLED: "1", MEDIA_STORAGE_DIR: mediaDir, MEDIA_LOCAL_STORAGE_IN_PRODUCTION: "allow" });

    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4000);
    };
    const build = run(["build"], { ...env, NODE_ENV: "production" }, keep);
    const code = await new Promise<number | null>((resolve) => build.on("close", resolve));
    if (code !== 0) throw new Error(`next build failed.\n${output}`);

    child = run(["start", "--port", String(appPort), "--hostname", "127.0.0.1"], { ...env, NODE_ENV: "production" }, keep);
    proxy = tlsProxy(selfSignedCertificate(certDir), appPort);
    await new Promise<void>((resolve) => proxy?.listen(proxyPort, "127.0.0.1", resolve));
    await waitForServer(`http://127.0.0.1:${appPort}`, child, () => output);
    await proveServerUsesTestDatabase(lock, `http://127.0.0.1:${appPort}`, password, baseURL);

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
