import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// `npm run orders:expire-verification` refuses every target except the local development database, before
// connecting, and prints no secret. The expiry itself (expireOverdueVerifications) is tested in
// orders.integration.test.ts against babysunray_test.

const SCRIPT = path.resolve("scripts/expire-verification.mts");
const LOADER = pathToFileURL(path.resolve("scripts/register-src.mts")).href;

describe("npm run orders:expire-verification", () => {
  let emptyDir: string;
  beforeAll(() => {
    // An empty working directory hides the real .env.local, so each case controls DATABASE_URL exactly.
    emptyDir = mkdtempSync(path.join(tmpdir(), "bsr-expiry-"));
  });
  afterAll(() => rmSync(emptyDir, { recursive: true, force: true }));

  it.each([
    ["the test database", () => process.env.TEST_DATABASE_URL as string, "DATABASE_URL must name the babysunray_dev database."],
    ["a missing DATABASE_URL", () => undefined, "DATABASE_URL is not set."],
    ["a remote host", () => "postgresql://babysunray_dev:s3cret@db.example.com:5432/babysunray_dev", "local host"],
    ["another role", () => "postgresql://babysunray_test:s3cret@localhost:5432/babysunray_dev", "babysunray_dev role"],
  ])("refuses %s before connecting, and prints no secret", (_name, url, expected) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DATABASE_URL;
    const value = url();
    if (value !== undefined) env.DATABASE_URL = value;
    const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings=ExperimentalWarning", "--import", LOADER, SCRIPT], {
      cwd: emptyDir,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    const output = `${r.stdout}${r.stderr}`;
    expect(r.status).toBe(1);
    expect(output).toContain(expected);
    expect(output).not.toMatch(/s3cret|postgresql:\/\//);
  });
});
