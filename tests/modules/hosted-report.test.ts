import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { outsideRepository, reportWriter } from "../../src/db/hosted-report.mts";

// Where hosted-command reports may go, and a report writer that never replaces a file it did not create (Gate H.48A).

const dir = mkdtempSync(path.join(tmpdir(), "bs-h48a-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ROOT = path.resolve(".");

describe("outsideRepository", () => {
  it("accepts an absolute path in an existing folder outside the project", () => {
    expect(outsideRepository(path.join(dir, "r.json"), "report file", ROOT)).toBe(path.join(realpathSync(dir), "r.json"));
  });
  it("refuses relative paths, the project folder (and below it), and a missing folder", () => {
    expect(() => outsideRepository("r.json", "report file", ROOT)).toThrow(/absolute/);
    expect(() => outsideRepository(undefined, "report file", ROOT)).toThrow(/absolute/);
    expect(() => outsideRepository(path.join(ROOT, "r.json"), "report file", ROOT)).toThrow(/outside the project/);
    expect(() => outsideRepository(path.join(ROOT, "docs", "r.json"), "report file", ROOT)).toThrow(/outside the project/);
    expect(() => outsideRepository(path.join(dir, "nope", "r.json"), "report file", ROOT)).toThrow(/does not exist/);
  });
});

describe("reportWriter", () => {
  it("creates the file exclusively: an existing file is never replaced, even one that appeared after the check", () => {
    const file = path.join(dir, "existing.json");
    writeFileSync(file, "keep me");
    expect(() => reportWriter(file)({ a: 1 })).toThrow(/EEXIST/);
    expect(readFileSync(file, "utf8")).toBe("keep me");
  });
  it("rewrites its own file on later writes, owner-only", () => {
    const file = path.join(dir, "own.json");
    const write = reportWriter(file);
    write({ result: "migrating" });
    write({ result: "migrated" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ result: "migrated" });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
