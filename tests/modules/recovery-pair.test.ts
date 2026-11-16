import { describe, expect, it } from "vitest";
import { compareBackupPair, type PhotoRef } from "../../src/modules/media/pair";

// The database-and-photo backup pair check (Gate H.28): pure comparison, fictional ids.

const photo = (n: number, sha = "a"): PhotoRef => ({ mediaId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, storageKey: `${String(n).padStart(32, "0")}.png`, sha256: sha.repeat(64), byteSize: 100 + n });
const at = (iso: string) => ({ createdAt: iso, database: "babysunray_dev" });

describe("compareBackupPair", () => {
  it("is consistent when every restored record has its file and nothing is left over", () => {
    const report = compareBackupPair({ databaseBackup: at("2026-11-16T10:00:00.000Z"), photoBackup: { ...at("2026-11-16T10:01:30.000Z"), files: [photo(1), photo(2)] }, restoredRecords: [photo(2), photo(1)] });
    expect(report).toMatchObject({ consistent: true, gapSeconds: 90, sameDatabase: true, missingFromPhotoBackup: [], notInDatabase: [], differing: [], notes: [] });
  });

  it("names photos uploaded after the photo backup, removed before the database backup, and replaced in between", () => {
    const report = compareBackupPair({
      databaseBackup: at("2026-11-16T12:00:00.000Z"),
      photoBackup: { ...at("2026-11-16T10:00:00.000Z"), files: [photo(1), photo(2, "b"), photo(3)] },
      restoredRecords: [photo(1), photo(2, "c"), photo(4)],
    });
    expect(report.consistent).toBe(false);
    expect(report.gapSeconds).toBe(-7200);
    expect(report.missingFromPhotoBackup).toEqual([photo(4).storageKey]);
    expect(report.notInDatabase).toEqual([photo(3).storageKey]);
    expect(report.differing).toEqual([photo(2).storageKey]);
    expect(report.notes.join(" ")).toMatch(/more than 15 minutes apart/);
  });

  it("refuses to call backups of different databases a pair, and rejects unreadable times", () => {
    expect(compareBackupPair({ databaseBackup: at("2026-11-16T10:00:00.000Z"), photoBackup: { createdAt: "2026-11-16T10:00:00.000Z", database: "other_db", files: [] }, restoredRecords: [] }).consistent).toBe(false);
    expect(() => compareBackupPair({ databaseBackup: at("not a date"), photoBackup: { ...at("2026-11-16T10:00:00.000Z"), files: [] }, restoredRecords: [] })).toThrow(/not a valid date/);
  });
});
