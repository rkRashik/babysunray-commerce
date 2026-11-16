import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The project's drizzle.config.ts refuses every drizzle-kit command that can change a database, so the
// only migration path is `npm run db:migrate`. No database is needed: refused commands stop while the
// config loads, before any connection. (`--config <other file>` bypasses this; see docs/getting-started.md, section 4.)

const ROOT = path.resolve(import.meta.dirname, "../..");
const BIN = path.join(ROOT, "node_modules/drizzle-kit/bin.cjs");

function drizzleKit(...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: "postgresql://babysunray_dev:s3cret@localhost:5432/babysunray_dev" };
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, env, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

describe("direct drizzle-kit commands", () => {
  it.each(["migrate", "push", "pull", "studio", "drop", "up"])("refuses drizzle-kit %s", (command) => {
    const { status, output } = drizzleKit(command);
    expect(status).not.toBe(0);
    expect(output).toContain(`drizzle-kit ${command} is not supported in this project`);
    expect(output).not.toContain("s3cret");
  });

  it("still runs check", () => {
    const { status, output } = drizzleKit("check");
    expect(status).toBe(0);
    expect(output).toContain("Everything's fine");
  });
});
