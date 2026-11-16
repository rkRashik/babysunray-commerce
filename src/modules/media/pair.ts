// Recovery coordination (Gate H.28). A database backup holds the photo records; a photo backup holds the photo
// files and its own copy of the records. They are two files taken at two moments, never one snapshot. This compares
// what a restored database records with what a photo backup contains, and the two backups' times, so the founder
// sees before switching to a restored copy whether every recorded photo can be restored and which ones cannot.
// Pure data in, report out; reads nothing and changes nothing.

export type PhotoRef = { mediaId: string; storageKey: string; sha256: string; byteSize: number };
export type PairInput = {
  databaseBackup: { createdAt: string; database: string };
  photoBackup: { createdAt: string; database: string; files: PhotoRef[] };
  /** The photo records of the restored database (product_media). */
  restoredRecords: PhotoRef[];
};
export type PairReport = {
  consistent: boolean;
  /** Photo backup time minus database backup time, in whole seconds (negative: photos were backed up first). */
  gapSeconds: number;
  sameDatabase: boolean;
  /** Recorded in the restored database, but not in the photo backup: these photos cannot be restored from it. */
  missingFromPhotoBackup: string[];
  /** In the photo backup, but not recorded in the restored database: restoring them adds files without a record. */
  notInDatabase: string[];
  /** Same record, different file (size or SHA-256): the photo was replaced between the two backups. */
  differing: string[];
  notes: string[];
};

export function compareBackupPair(input: PairInput): PairReport {
  const files = new Map(input.photoBackup.files.map((f) => [f.mediaId, f]));
  const recorded = new Set(input.restoredRecords.map((r) => r.mediaId));
  const missingFromPhotoBackup: string[] = [];
  const differing: string[] = [];
  for (const r of input.restoredRecords) {
    const f = files.get(r.mediaId);
    if (!f) missingFromPhotoBackup.push(r.storageKey);
    else if (f.storageKey !== r.storageKey || f.sha256 !== r.sha256 || f.byteSize !== r.byteSize) differing.push(r.storageKey);
  }
  const notInDatabase = input.photoBackup.files.filter((f) => !recorded.has(f.mediaId)).map((f) => f.storageKey);
  const gapSeconds = Math.round((Date.parse(input.photoBackup.createdAt) - Date.parse(input.databaseBackup.createdAt)) / 1000);
  const sameDatabase = input.photoBackup.database === input.databaseBackup.database;
  const notes: string[] = [];
  if (!Number.isFinite(gapSeconds)) throw new Error("A backup time is not a valid date.");
  if (!sameDatabase) notes.push("The two backups were taken from different databases.");
  if (Math.abs(gapSeconds) > 15 * 60) notes.push("The backups were taken more than 15 minutes apart; photo changes in between are likely. Take them back to back.");
  if (missingFromPhotoBackup.length) notes.push(`${missingFromPhotoBackup.length} recorded photo(s) are not in the photo backup (probably uploaded after it). Their records would point at missing files.`);
  if (notInDatabase.length) notes.push(`${notInDatabase.length} photo(s) in the backup have no record in the restored database (probably removed or added between the backups).`);
  if (differing.length) notes.push(`${differing.length} photo(s) differ between the backup and the record (replaced between the backups).`);
  const consistent = sameDatabase && missingFromPhotoBackup.length === 0 && notInDatabase.length === 0 && differing.length === 0;
  return { consistent, gapSeconds, sameDatabase, missingFromPhotoBackup, notInDatabase, differing, notes };
}
