import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Deployment readiness of the brand: the logo and the fonts the First Light design needs must be in the Git checkout
// (a Git-based host such as Netlify builds from it), not only on a developer's machine.

const ROOT = path.resolve(__dirname, "../..");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("brand and font assets", () => {
  it.each(["public/brand/logo.png", "public/brand/mark.png"])("%s exists, is a PNG and is not ignored by Git", (file) => {
    const full = path.join(ROOT, file);
    expect(existsSync(full), `${file} is missing`).toBe(true);
    expect(readFileSync(full).subarray(0, 8).equals(PNG)).toBe(true);
    // `git check-ignore -q` exits 1 when the path is NOT ignored (0 when it is).
    expect(spawnSync("git", ["check-ignore", "-q", file], { cwd: ROOT }).status, `${file} is ignored by Git`).toBe(1);
  });

  it("every font file src/app/_design/fonts.ts loads exists in an installed, locked dependency", () => {
    const source = readFileSync(path.join(ROOT, "src/app/_design/fonts.ts"), "utf8");
    const files = [...source.matchAll(/["'](\.\.\/\.\.\/\.\.\/(node_modules\/[^"']+\.woff2))["']/g)].map((m) => m[2]);
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) expect(existsSync(path.join(ROOT, file)), file).toBe(true);
    // The packages are real dependencies (installed by `npm ci` on the host), not dev-only tools.
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    for (const name of new Set(files.map((f) => f.split("/").slice(1, f.includes("@fontsource-variable") ? 3 : 3).join("/")))) {
      expect(Object.keys(pkg.dependencies), name).toContain(name);
    }
  });
});
