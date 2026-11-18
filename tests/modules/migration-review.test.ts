import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reviewMigration, statementsOf } from "../../src/db/migration-review.mts";

// The additive-migration review (Gate H.53): pure text analysis, no database.

const rules = (sql: string) => reviewMigration(sql).map((f) => `${f.level}:${f.rule.split(" (")[0]}`);

describe("reviewMigration", () => {
  it("passes purely additive SQL", () => {
    const sql = [
      'CREATE TABLE "things" ("id" uuid PRIMARY KEY NOT NULL);--> statement-breakpoint',
      'ALTER TABLE "things" ADD COLUMN "note" text;--> statement-breakpoint',
      'ALTER TABLE "things" ADD COLUMN "n" integer DEFAULT 0 NOT NULL;--> statement-breakpoint',
      'CREATE INDEX "things_note" ON "things" ("note");--> statement-breakpoint',
      'ALTER TABLE "things" ADD CONSTRAINT "n_ok" CHECK ("n" >= 0);',
    ].join("\n");
    expect(reviewMigration(sql)).toEqual([]);
  });
  it("flags every kind of destructive statement", () => {
    const sql = [
      'ALTER TABLE "t" DROP COLUMN "c";--> statement-breakpoint',
      'DROP TABLE "t";--> statement-breakpoint',
      'ALTER TABLE "t" RENAME COLUMN "a" TO "b";--> statement-breakpoint',
      'ALTER TABLE "t" ALTER COLUMN "a" SET DATA TYPE bigint;--> statement-breakpoint',
      'TRUNCATE "t";--> statement-breakpoint',
      'DELETE FROM "t" WHERE "x" = 1;',
    ].join("\n");
    expect(reviewMigration(sql).map((f) => f.level)).toEqual(Array(6).fill("destructive"));
  });
  it("marks statements that can fail on existing rows as checks, not as destructive", () => {
    const sql = [
      'ALTER TABLE "t" ALTER COLUMN "a" SET NOT NULL;--> statement-breakpoint',
      'ALTER TABLE "t" ADD COLUMN "b" text NOT NULL;--> statement-breakpoint',
      'UPDATE "t" SET "a" = 1;--> statement-breakpoint',
      'ALTER TABLE "t" DROP CONSTRAINT "t_ok";',
    ].join("\n");
    expect(rules(sql)).toEqual([
      "check:makes a column NOT NULL",
      "check:adds a NOT NULL column without a default",
      "check:rewrites rows",
      "check:drops a constraint",
    ]);
  });
  it("does not mistake a trigger that mentions DELETE or TRUNCATE for a deletion, and ignores comments", () => {
    const sql = '-- DROP TABLE "t";\nCREATE TRIGGER "x" BEFORE UPDATE OR DELETE OR TRUNCATE ON "t" FOR EACH STATEMENT EXECUTE FUNCTION f();';
    expect(reviewMigration(sql)).toEqual([]);
    expect(statementsOf("-- c\nSELECT 1;--> statement-breakpoint\n\nSELECT 2;")).toEqual(["SELECT 1;", "SELECT 2;"]);
  });
});

describe("the committed migrations", () => {
  it("none drops a table, column or index, renames or truncates anything, or changes a column type (history is additive apart from re-created constraints and one reviewed deletion)", () => {
    const dir = path.resolve(import.meta.dirname, "../../drizzle");
    const found = readdirSync(dir)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .flatMap((f) => reviewMigration(readFileSync(path.join(dir, f), "utf8")).filter((x) => x.level === "destructive").map((x) => `${f}: ${x.statement.slice(0, 60)}`));
    // 0005 deletes sessions inside a trigger function body (not a statement of its own); 0010 removes obsolete rate-limit windows.
    expect(found).toEqual(['0010_order_return_window_tracking_limits.sql: DELETE FROM "tracking_rate_limits" WHERE "bucket" = \'lookup\'']);
  });
});

describe("npm run migrations:review", () => {
  const script = path.resolve(import.meta.dirname, "../../scripts/migration-review.mts");
  it("reads text only; a range after the newest migration reviews nothing and succeeds", () => {
    const out = execFileSync(process.execPath, [script, "--after", "999"], { encoding: "utf8" });
    expect(out).toContain("0 migration file(s) reviewed, 0 destructive");
    expect(out).toContain("Nothing was connected to or changed.");
  });
  it("exits 1 when a destructive statement is in range and 2 on a bad argument", () => {
    expect(spawnSync(process.execPath, [script, "--after", "9"], { encoding: "utf8" }).status).toBe(1);
    expect(spawnSync(process.execPath, [script, "--after", "x"], { encoding: "utf8" }).status).toBe(2);
  });
});
