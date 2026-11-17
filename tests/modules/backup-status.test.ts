import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { backupStatus, readBackupHeader } from "../../src/db/backup-status.mts";

// Backup freshness from headers alone (Gate H.48C). Files here are fictional: the readable header plus filler; nothing
// is decrypted, so none is a real backup.

const dir = mkdtempSync(path.join(tmpdir(), "bs-h48c-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const NOW = Date.parse("2026-11-20T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

/** A file with the sealed format's readable start (magic, header length, header JSON) and filler after it. */
function fake(name: string, header: Record<string, unknown>, filler = 64) {
  const json = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  const file = path.join(dir, name);
  writeFileSync(file, Buffer.concat([Buffer.from("BSRBAK01"), length, json, Buffer.alloc(filler, 7)]));
  return file;
}
const database = (createdAt: string, extra: Record<string, unknown> = {}) => ({ format: "babysunray-backup", createdAt, database: "postgres", ...extra });
const photos = (createdAt: string, extra: Record<string, unknown> = {}) => ({ format: "babysunray-media-backup", createdAt, database: "postgres", files: 3, ...extra });
const fresh = () => {
  const d = mkdtempSync(path.join(dir, "case-"));
  return d;
};
const put = (folder: string, name: string, header: Record<string, unknown>) => {
  const file = fake(path.join(path.basename(folder), name), header);
  return file;
};

describe("readBackupHeader", () => {
  it("reads only the header, and refuses other files with fixed messages", () => {
    expect(readBackupHeader(fake("a.bsbackup", database(hoursAgo(1), { host: "db.example.test" })))).toMatchObject({ kind: "database", database: "postgres", createdAt: hoursAgo(1), host: "db.example.test", files: null });
    expect(readBackupHeader(fake("b.bsmedia", photos(hoursAgo(1))))).toMatchObject({ kind: "photos", files: 3 });
    writeFileSync(path.join(dir, "text.bsbackup"), "just some text that is long enough");
    expect(() => readBackupHeader(path.join(dir, "text.bsbackup"))).toThrow(/not a BabySunray backup/);
    expect(() => readBackupHeader(path.join(dir, "missing.bsbackup"))).toThrow(/could not be read/);
    expect(() => readBackupHeader(fake("c.bsbackup", { format: "other", createdAt: hoursAgo(1), database: "x" }))).toThrow(/not readable/);
    expect(() => readBackupHeader(fake("d.bsbackup", database("not a date")))).toThrow(/not readable/);
  });
});

describe("backupStatus", () => {
  it("is ok for fresh, matching, close database and photo backups, and reports the newest of several", () => {
    const f = fresh();
    put(f, "old.bsbackup", database(hoursAgo(90)));
    put(f, "new.bsbackup", database(hoursAgo(3)));
    put(f, "new.bsmedia", photos(hoursAgo(3)));
    const status = backupStatus(f, { maxAgeHours: 24, now: NOW });
    expect(status.ok).toBe(true);
    expect(status.newest.database).toMatchObject({ file: "new.bsbackup", ageHours: 3 });
    expect(status.pairGapMinutes).toBe(0);
  });
  it("classifies each failure: none, stale, future, unreadable, unfinished, different databases, far apart", () => {
    const empty = backupStatus(fresh(), { maxAgeHours: 24, now: NOW });
    expect(empty.problems.map((p) => p.code)).toEqual(["no_database_backup", "no_photos_backup"]);
    expect(backupStatus(fresh(), { maxAgeHours: 24, now: NOW, wantPhotos: false }).problems.map((p) => p.code)).toEqual(["no_database_backup"]);

    const f = fresh();
    put(f, "a.bsbackup", database(hoursAgo(30)));
    put(f, "a.bsmedia", photos(hoursAgo(-2)));
    writeFileSync(path.join(f, "broken.bsbackup"), "not a backup at all");
    writeFileSync(path.join(f, "x.bsbackup.partial"), "half");
    put(f, "wrongtype.bsmedia", database(hoursAgo(1)));
    const codes = backupStatus(f, { maxAgeHours: 24, now: NOW }).problems.map((p) => p.code).sort();
    expect(codes).toEqual(["backups_far_apart", "database_backup_stale", "photos_backup_dated_in_future", "unfinished_backup", "unreadable_backup", "unreadable_backup"].sort());

    const g = fresh();
    put(g, "a.bsbackup", database(hoursAgo(1), { host: "db.one.example.test" }));
    put(g, "a.bsmedia", photos(hoursAgo(1), { database: "other" }));
    expect(backupStatus(g, { maxAgeHours: 24, now: NOW }).problems.map((p) => p.code)).toEqual(["backups_of_different_databases"]);
    const h = fresh();
    put(h, "a.bsbackup", database(hoursAgo(1), { host: "db.one.example.test" }));
    put(h, "a.bsmedia", photos(hoursAgo(1), { host: "db.two.example.test" }));
    expect(backupStatus(h, { maxAgeHours: 24, now: NOW }).problems.map((p) => p.code)).toEqual(["backups_of_different_databases"]);
  });
  it("flags a header-only (cut-off) file, and refuses an infinite age limit", () => {
    const f = fresh();
    const file = path.join(f, "cut.bsbackup");
    const json = Buffer.from(JSON.stringify(database(hoursAgo(1))));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(json.length);
    writeFileSync(file, Buffer.concat([Buffer.from("BSRBAK01"), length, json]));
    const codes = backupStatus(f, { maxAgeHours: 24, now: NOW, wantPhotos: false }).problems.map((p) => p.code);
    expect(codes).toEqual(["unreadable_backup", "no_database_backup"]);
    expect(() => backupStatus(f, { maxAgeHours: Infinity })).toThrow(/age limit/);
  });
  it("requires an age limit, deletes and changes nothing", () => {
    const f = fresh();
    put(f, "a.bsbackup", database(hoursAgo(1)));
    expect(() => backupStatus(f, { maxAgeHours: 0 })).toThrow(/age limit/);
    backupStatus(f, { maxAgeHours: 24, now: NOW });
    expect(backupStatus(f, { maxAgeHours: 24, now: NOW }).newest.database?.file).toBe("a.bsbackup");
  });
});

describe("npm run backup:status", () => {
  it("exits 1 with problems, 2 without arguments, and prints no passphrase prompt", () => {
    const f = fresh();
    put(f, "a.bsbackup", database(new Date().toISOString()));
    const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings=ExperimentalWarning", "scripts/backup-status.mts", ...args], { encoding: "utf8", timeout: 30_000 });
    expect(run().status).toBe(2);
    const noPhotos = run("--dir", f, "--max-age-hours", "24", "--no-photos");
    expect(noPhotos.status).toBe(0);
    expect(noPhotos.stdout).toContain("does not verify the content");
    const both = run("--dir", f, "--max-age-hours", "24", "--json");
    expect(both.status).toBe(1);
    expect(JSON.parse(both.stdout).problems[0].code).toBe("no_photos_backup");
  });
});
