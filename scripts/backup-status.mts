// `npm run backup:status -- --dir <backup folder> --max-age-hours <n> [--no-photos] [--json]`: how fresh the newest
// database and photo backups in a folder are, whether they belong together, and which files are unreadable or unfinished.
// Reads only the files' readable headers: no passphrase, nothing decrypted, nothing written or deleted, no database or
// network. It is NOT a verification of the backups' content (npm run backup:verify and media:backup:verify do that) and
// no restore is proven by it. The age limit is yours to choose. Exit 0: nothing to report; 1: problems; 2: bad arguments.
// Gate H.48C.
import path from "node:path";
import { backupDirectory } from "../src/db/backup.mts";
import { backupStatus } from "../src/db/backup-status.mts";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<number> {
  const maxAgeHours = Number(arg("--max-age-hours"));
  if (!arg("--dir") || !(maxAgeHours > 0)) {
    console.error("Use: npm run backup:status -- --dir <backup folder> --max-age-hours <hours> [--no-photos] [--json]");
    return 2;
  }
  const dir = await backupDirectory(arg("--dir"), path.resolve(import.meta.dirname, ".."));
  const status = backupStatus(dir, { maxAgeHours, wantPhotos: !process.argv.includes("--no-photos") });
  if (process.argv.includes("--json")) console.log(JSON.stringify(status, null, 2));
  else {
    for (const kind of ["database", "photos"] as const) {
      const n = status.newest[kind];
      console.log(n ? `${kind}: newest ${n.file}, ${n.ageHours} hours old${n.files !== null ? `, ${n.files} photo(s)` : ""}.` : `${kind}: none found.`);
    }
    if (status.pairGapMinutes !== null) console.log(`The two were taken ${Math.abs(status.pairGapMinutes)} minute(s) apart.`);
    for (const p of status.problems) console.log(`${p.severity.toUpperCase()}  ${p.code}${p.file ? ` (${p.file})` : ""}: ${p.message}`);
    console.log(status.ok ? "No problems found in the headers. This does not verify the content: run backup:verify and media:backup:verify." : "PROBLEMS FOUND.");
  }
  return status.ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : "The backup status could not be read.");
    process.exitCode = 2;
  },
);
