import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";

// Backup freshness and correlation from the files' READABLE headers alone (Gate H.48C): no passphrase, nothing decrypted,
// nothing written. It says how old the newest database and photo backups are, whether they are of the same database and
// close together, and which files are unreadable or unfinished. It does NOT verify a backup's content: that is
// `npm run backup:verify` / `media:backup:verify` (and a restore drill). The age limit is the operator's to give; no retention
// or schedule is chosen here, and nothing is ever deleted.

const MAGIC = "BSRBAK01";
const MAX_HEADER = 16 * 1024; // the same limit the sealed format itself enforces

export type BackupKind = "database" | "photos";
export type BackupHeaderInfo = { kind: BackupKind; database: string; createdAt: string; host: string | null; files: number | null };

/** Reads a backup file's readable header (never the whole file) without its passphrase; throws a fixed message. */
export function readBackupHeader(file: string): BackupHeaderInfo {
  let fd: number | undefined;
  let head: Buffer;
  try {
    fd = openSync(file, "r");
    const first = Buffer.alloc(12);
    if (readSync(fd, first, 0, 12, 0) !== 12) throw new Error("short");
    if (first.subarray(0, 8).toString("ascii") !== MAGIC) throw new Error("magic");
    const length = first.readUInt32BE(8);
    if (length === 0 || length > MAX_HEADER) throw new Error("length");
    head = Buffer.alloc(length);
    if (readSync(fd, head, 0, length, 12) !== length) throw new Error("short");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code) throw new Error("The backup file could not be read.");
    throw new Error("The backup file is not a BabySunray backup.");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  try {
    const header = JSON.parse(head.toString("utf8")) as { format?: unknown; database?: unknown; createdAt?: unknown; host?: unknown; files?: unknown };
    const kind = header.format === "babysunray-backup" ? "database" : header.format === "babysunray-media-backup" ? "photos" : null;
    if (!kind || typeof header.database !== "string" || typeof header.createdAt !== "string" || !Number.isFinite(Date.parse(header.createdAt))) throw new Error("shape");
    return { kind, database: header.database, createdAt: header.createdAt, host: typeof header.host === "string" ? header.host : null, files: typeof header.files === "number" ? header.files : null };
  } catch {
    throw new Error("The backup file's header is not readable.");
  }
}

export type BackupProblem = { severity: "high" | "medium"; code: string; message: string; file?: string };
export type BackupStatus = {
  newest: Record<BackupKind, { file: string; createdAt: string; ageHours: number; database: string; host: string | null; files: number | null } | null>;
  /** Minutes between the newest database backup and the newest photo backup, when both exist. */
  pairGapMinutes: number | null;
  problems: BackupProblem[];
  ok: boolean;
};

const MAX_PAIR_GAP_MINUTES = 15; // the same figure recovery:check uses (src/modules/media/pair.ts)

/**
 * Looks at every *.bsbackup (database) and *.bsmedia (photos) in one folder. `maxAgeHours` is required from the caller.
 * Problems: no backup of a kind, a stale newest backup, an unreadable file, an unfinished ".partial" file, a database
 * and photo backup of different databases or hosts, or taken far apart.
 */
export function backupStatus(dir: string, options: { maxAgeHours: number; now?: number; wantPhotos?: boolean }): BackupStatus {
  if (!(options.maxAgeHours > 0)) throw new Error("Give the age limit in hours (a number above 0).");
  const now = options.now ?? Date.now();
  const problems: BackupProblem[] = [];
  const found: (BackupHeaderInfo & { file: string })[] = [];
  for (const name of readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (name.endsWith(".partial")) {
      problems.push({ severity: "medium", code: "unfinished_backup", file: name, message: "An unfinished backup file is left behind (an interrupted run). It is not a backup; delete it after checking." });
      continue;
    }
    if (!/\.(bsbackup|bsmedia)$/.test(name) || !statSync(file).isFile()) continue;
    try {
      const header = readBackupHeader(file);
      const expected = name.endsWith(".bsbackup") ? "database" : "photos";
      if (header.kind !== expected) throw new Error("The backup file's type does not match its name.");
      found.push({ ...header, file: name });
    } catch (error) {
      problems.push({ severity: "high", code: "unreadable_backup", file: name, message: error instanceof Error ? error.message : "The backup file is not readable." });
    }
  }
  const newestOf = (kind: BackupKind) => {
    const last = found.filter((f) => f.kind === kind).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    return last ? { file: last.file, createdAt: last.createdAt, ageHours: Math.round(((now - Date.parse(last.createdAt)) / 3_600_000) * 10) / 10, database: last.database, host: last.host, files: last.files } : null;
  };
  const newest = { database: newestOf("database"), photos: newestOf("photos") };
  const required: BackupKind[] = options.wantPhotos === false ? ["database"] : ["database", "photos"];
  for (const kind of required) {
    const n = newest[kind];
    if (!n) problems.push({ severity: "high", code: `no_${kind}_backup`, message: `No ${kind} backup was found in this folder.` });
    else if (n.ageHours < 0) problems.push({ severity: "high", code: `${kind}_backup_dated_in_future`, file: n.file, message: `The newest ${kind} backup is dated in the future.` });
    else if (n.ageHours > options.maxAgeHours) problems.push({ severity: "high", code: `${kind}_backup_stale`, file: n.file, message: `The newest ${kind} backup is ${n.ageHours} hours old (limit ${options.maxAgeHours}).` });
  }
  let pairGapMinutes: number | null = null;
  if (newest.database && newest.photos) {
    pairGapMinutes = Math.round((Date.parse(newest.photos.createdAt) - Date.parse(newest.database.createdAt)) / 60_000);
    if (newest.database.database !== newest.photos.database || (newest.database.host && newest.photos.host && newest.database.host !== newest.photos.host)) {
      problems.push({ severity: "high", code: "backups_of_different_databases", message: "The newest database and photo backups are of different databases." });
    }
    if (Math.abs(pairGapMinutes) > MAX_PAIR_GAP_MINUTES) problems.push({ severity: "medium", code: "backups_far_apart", message: `The newest database and photo backups were taken ${Math.abs(pairGapMinutes)} minutes apart; photo changes in between are likely.` });
  }
  return { newest, pairGapMinutes, problems, ok: problems.length === 0 };
}
