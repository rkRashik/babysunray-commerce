import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertConnectedIdentity, DEV_TARGET } from "../../src/db/connection-guard.mts";
import { connectTestClient } from "../support/test-database";

// The development migration must stop before changing anything unless it reaches babysunray_dev as
// babysunray_dev. These tests never connect to the development database: every scenario either fails
// before a connection is made, or runs against the test database, where the identity check must refuse.

const SCRIPT = path.resolve(import.meta.dirname, "../../scripts/migrate-dev.mts");

let client: Client;
let emptyDir: string;

beforeAll(async () => {
  client = await connectTestClient();
  // The script reads .env.local from its working directory. An empty one hides the real file, so each
  // scenario controls exactly which value the script sees.
  emptyDir = mkdtempSync(path.join(tmpdir(), "bsr-migrate-"));
});

afterAll(async () => {
  await client?.end();
  rmSync(emptyDir, { recursive: true, force: true });
});

function runMigrate(shellDatabaseUrl: string | undefined, cwd = emptyDir) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DATABASE_URL;
  if (shellDatabaseUrl !== undefined) env.DATABASE_URL = shellDatabaseUrl;
  const result = spawnSync(process.execPath, [SCRIPT], { cwd, env, encoding: "utf8", timeout: 30_000 });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("PostgreSQL-side identity check", () => {
  it("refuses a real connection to the test database as the development target", async () => {
    // Everything the URL checks look at is fine for the test database; only PostgreSQL's own answer is wrong.
    await expect(assertConnectedIdentity(client, DEV_TARGET)).rejects.toThrow("Connected database is not babysunray_dev");
  });
});

describe("npm run db:migrate entrypoint", () => {
  it("refuses the test database URL as DATABASE_URL, before connecting", () => {
    const testUrl = process.env.TEST_DATABASE_URL as string;
    const { status, output } = runMigrate(testUrl);
    expect(status).toBe(1);
    expect(output).toContain("DATABASE_URL must name the babysunray_dev database.");
    expect(output).not.toContain(new URL(testUrl).password);
    expect(output).not.toContain("Migrations are up to date");
  });

  it.each([
    ["a missing DATABASE_URL", undefined, "DATABASE_URL is not set."],
    ["a malformed URL", "not a url", "not a valid URL"],
    ["a superuser role", "postgresql://postgres:s3cret@localhost:5432/babysunray_dev", "babysunray_dev role"],
    ["the test role", "postgresql://babysunray_test:s3cret@localhost:5432/babysunray_dev", "babysunray_dev role"],
    ["a remote host", "postgresql://babysunray_dev:s3cret@db.example.com:5432/babysunray_dev", "local host"],
    ["an unexpected port", "postgresql://babysunray_dev:s3cret@localhost:5433/babysunray_dev", "port 5432"],
    ["a redirecting query parameter", "postgresql://babysunray_dev:s3cret@localhost/babysunray_dev?host=db.example.com", "query parameters"],
    ["another database name", "postgresql://babysunray_dev:s3cret@localhost:5432/postgres", "babysunray_dev database"],
  ] as const)("fails closed for %s and leaks no secret", (_name, url, expected) => {
    const { status, output } = runMigrate(url);
    expect(status).toBe(1);
    expect(output).toContain(expected);
    expect(output).not.toContain("s3cret");
    expect(output).not.toContain("Migrations are up to date");
  });

  it("stops when a stale shell DATABASE_URL differs from .env.local, without printing either", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bsr-migrate-env-"));
    try {
      writeFileSync(path.join(dir, ".env.local"), "DATABASE_URL=postgresql://babysunray_dev:file-s3cret@localhost:5432/babysunray_dev\n");
      const { status, output } = runMigrate("postgresql://babysunray_dev:shell-s3cret@localhost:5432/babysunray_dev", dir);
      expect(status).toBe(1);
      expect(output).toContain("differs from DATABASE_URL in .env.local");
      expect(output).not.toContain("s3cret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
