import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// npm run netlify:env (Gate H.58) with a fictional staging settings file: the administrator connection must never reach
// the output, the application's must, and the file is created exclusively. Fictional values only.

const dir = mkdtempSync(path.join(tmpdir(), "bs-netlify-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const REF = "abcdefghijklmnop";
const settings = path.join(dir, "staging.env");
writeFileSync(
  settings,
  [
    `STAGING_MIGRATION_DATABASE_URL=postgresql://postgres.${REF}:ADMIN-SECRET-FICTIONAL@aws-0-xx.pooler.supabase.com:5432/postgres`,
    `STAGING_DATABASE_URL=postgresql://babysunray_app.${REF}:APP-SECRET-FICTIONAL@aws-0-xx.pooler.supabase.com:6543/postgres`,
    "STAGING_DATABASE_SSL=require",
    `STAGING_SUPABASE_URL=https://${REF}.supabase.co`,
    `STAGING_SUPABASE_SECRET_KEY=sb_secret_${"a".repeat(30)}`,
    "STAGING_STORAGE_BUCKET=fictional-bucket",
  ].join("\n"),
);
const run = (args: string[]) =>
  spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings=ExperimentalWarning", "--import", "./scripts/register-src.mts", "scripts/netlify-env.mts", ...args], {
    encoding: "utf8",
    env: { ...process.env, STAGING_ENV_FILE: settings, DATABASE_URL: "", STAGING_DATABASE_URL: "" } as NodeJS.ProcessEnv,
  });

describe("npm run netlify:env", () => {
  it("writes the application's connection and photo settings, never the administrator connection, and prints no value", () => {
    const out = path.join(dir, "netlify.env");
    const result = run(["--out", out, "--url", "https://shop-example.netlify.app"]);
    expect(result.status).toBe(0);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("APP-SECRET-FICTIONAL");
    expect(text).not.toContain("ADMIN-SECRET-FICTIONAL");
    expect(text).not.toMatch(/STAGING_|CLOUDINARY/);
    expect(text.split("\n").filter(Boolean).map((l) => l.split("=")[0])).toEqual([
      "DATABASE_URL", "DATABASE_RUNTIME", "DATABASE_POOLER", "DATABASE_SSL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "MEDIA_STORAGE_PROVIDER", "SUPABASE_URL", "SUPABASE_STORAGE_BUCKET", "SUPABASE_SERVICE_ROLE_KEY",
    ]);
    expect(result.stdout + result.stderr).not.toMatch(/APP-SECRET|ADMIN-SECRET|sb_secret_/);
  });
  it("never replaces an existing file, and refuses a path inside the project or a missing or non-https site URL", () => {
    const out = path.join(dir, "netlify.env");
    expect(existsSync(out)).toBe(true);
    expect(run(["--out", out, "--url", "https://shop-example.netlify.app"]).status).toBe(1);
    expect(run(["--out", path.join(process.cwd(), "x.env"), "--url", "https://shop-example.netlify.app"]).status).toBe(1);
    expect(run(["--out", path.join(dir, "b.env")]).status).toBe(1);
    expect(run(["--out", path.join(dir, "c.env"), "--url", "http://shop-example.netlify.app"]).status).toBe(1);
    expect(existsSync(path.join(process.cwd(), "x.env"))).toBe(false);
    // Four child processes in a row: slower than the 5 s default when the whole suite runs in parallel.
  }, 30_000);
});
