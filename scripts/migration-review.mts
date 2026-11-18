// `npm run migrations:review [-- --after <number>]`: reads the committed migration files (drizzle/*.sql) and lists the
// statements that are not purely additive (src/db/migration-review.mts). Text only: it connects to no database and
// changes nothing. `--after 18` reviews only migrations numbered above 0018, for example the ones a hosted database does
// not have yet. Exit status 1 when a destructive statement is found, so it can stop a checklist; a finding is a prompt for
// a backup, a stated reason and the Owner's approval (docs/operations/production-migration.md), not a verdict.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { reviewMigration } from "../src/db/migration-review.mts";

const folder = path.resolve(import.meta.dirname, "..", "drizzle");
const afterIndex = process.argv.indexOf("--after");
const after = afterIndex > 0 ? Number(process.argv[afterIndex + 1]) : -1;
if (!Number.isInteger(after)) {
  console.error("Use: --after <whole number>, for example --after 18.");
  process.exit(2);
}

let destructive = 0;
let reviewed = 0;
for (const file of readdirSync(folder).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()) {
  if (Number(file.slice(0, 4)) <= after) continue;
  reviewed += 1;
  const findings = reviewMigration(readFileSync(path.join(folder, file), "utf8"));
  console.log(`${file}: ${findings.length === 0 ? "additive" : `${findings.length} statement(s) to look at`}`);
  for (const f of findings) {
    console.log(`  [${f.level}] ${f.rule}: ${f.statement}`);
    if (f.level === "destructive") destructive += 1;
  }
}
console.log(`${reviewed} migration file(s) reviewed, ${destructive} destructive statement(s). Nothing was connected to or changed.`);
process.exitCode = destructive > 0 ? 1 : 0;
