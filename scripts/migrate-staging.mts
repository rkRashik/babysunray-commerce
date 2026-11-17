// `npm run db:migrate:staging -- --backup <file> --report <file>` (or `--first-time` instead of `--backup` on an empty
// database): applies the committed migrations to a HOSTED STAGING database, then its privilege script, then audits the
// privilege boundary. For the founder to run in an interactive terminal; it is never run by the application, a test or
// a scheduler, and Next.js never migrates on start. Gate H.45; docs/operations/staging-setup.md.
//
// Before any change: the URL is a direct (or session) connection with TLS, not this machine and not a local database;
// PostgreSQL confirms the database carries the staging marker; the founder types the host name back; the database's
// migration history is a prefix of this checkout's (same hashes, same order; a newer or diverged database is refused);
// and a backup of this database from the last 24 hours exists (unless the database has no application tables yet).
// The migrations run under the project's migration lock in ONE transaction (Drizzle's migrator): a failure applies
// none of them. A JSON report (no secrets, no data) is written whatever the outcome. Node 22.18 or newer.
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { auditPrivileges } from "../src/db/hosted-security.mts";
import { APP_ROLE, applicationTableCount, assertNotLocalDatabase, assertRecentBackup, assertStagingTarget, migrationState, parseStagingUrl } from "../src/db/hosted-target.mts";
import { MIGRATION_LOCK } from "../src/db/migrate-verified.mts";
import { outsideRepository, reportWriter } from "../src/db/hosted-report.mts";
import { readStagingEnv } from "./staging-env.mts";
import { askVisible, assertInteractiveTerminal } from "./prompt.mts";

const ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATIONS = path.join(ROOT, "drizzle");
const PRIVILEGES = path.join(ROOT, "db", "hosted", "privileges.sql");

/** Runs db/hosted/privileges.sql in its own transaction (it is idempotent). */
async function applyPrivileges(client: pg.Client): Promise<void> {
  await client.query("begin");
  try {
    await client.query(readFileSync(PRIVILEGES, "utf8"));
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<void> {
  const env = readStagingEnv();
  const reportFile = outsideRepository(arg("--report"), "report file", ROOT);
  if (existsSync(reportFile)) throw new Error("The report file already exists. Choose a new name; nothing was changed.");
  const firstTime = process.argv.includes("--first-time");
  const backupFile = firstTime ? undefined : outsideRepository(arg("--backup"), "backup file (from npm run backup:create:staging)", ROOT);
  const conn = parseStagingUrl(env, "STAGING_MIGRATION_DATABASE_URL", { pooled: false });
  assertNotLocalDatabase(conn, env);

  const report: Record<string, unknown> = { command: "db:migrate:staging", startedAt: new Date().toISOString(), target: { host: conn.host, port: conn.port, database: conn.database, user: conn.user }, result: "not started" };
  const write = reportWriter(reportFile);
  const save = () => write(report);
  const client = new pg.Client({ host: conn.host, port: conn.port, database: conn.database, user: conn.user, password: conn.password, ssl: conn.ssl, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    const identity = await assertStagingTarget(client);
    if (identity.user === APP_ROLE) throw new Error(`Connected as ${APP_ROLE}: migrations need the migration role (STAGING_MIGRATION_DATABASE_URL), never the application's.`);
    const before = await migrationState(client, MIGRATIONS);
    report.before = before;
    if (before.ahead || before.mismatches.length) throw new Error("The database's migration history does not match this checkout (it is newer, or diverged). Nothing was changed.");
    const tables = await applicationTableCount(client);
    if (firstTime && (tables > 0 || before.applied > 0)) throw new Error("--first-time is only for an empty database; this one has tables. Take a backup and use --backup.");
    if (!firstTime) report.backup = { ...assertRecentBackup(backupFile!, { host: conn.host, database: identity.database }), sha256: createHash("sha256").update(readFileSync(backupFile!)).digest("hex") };

    assertInteractiveTerminal();
    console.log(`Staging database: ${identity.database} on ${conn.host} as ${identity.user} (marked staging).`);
    console.log(`Applied: ${before.applied} of ${before.expected} migrations; ${before.expected - before.applied} will be applied in one transaction.`);
    const typed = (await askVisible(`Type the host name to continue (${conn.host}): `)).trim();
    if (typed !== conn.host) throw new Error("The host name did not match. Nothing was changed.");

    report.result = "migrating";
    save();
    await client.query("select pg_advisory_lock($1, $2)", [...MIGRATION_LOCK]);
    try {
      await client.query("set search_path to public");
      // Before: removes the API roles' default privileges, so the tables the migrations create are never granted to
      // them, even for a moment and even if the run fails later. After: grants the new tables to the application role
      // and applies the append-only revokes.
      await applyPrivileges(client);
      await migrate(drizzle({ client }), { migrationsFolder: MIGRATIONS });
      await applyPrivileges(client);
    } finally {
      await client.query("select pg_advisory_unlock($1, $2)", [...MIGRATION_LOCK]).catch(() => undefined);
    }
    const after = await migrationState(client, MIGRATIONS);
    report.after = after;
    if (after.applied !== after.expected || after.mismatches.length) throw new Error("After migrating, the history does not match this checkout. Investigate before using the database.");
    const findings = await auditPrivileges(client, APP_ROLE);
    report.privilegeFindings = findings;
    report.result = findings.length ? "migrated, privilege findings" : "migrated";
    console.log(`Migrations: all ${after.applied} applied. Privilege audit: ${findings.length ? `${findings.length} finding(s), see the report` : "no findings"}.`);
    if (findings.length) process.exitCode = 1;
  } catch (error) {
    report.result = "failed";
    // Message only: never a stack, a URL, a password or query parameters.
    report.error = error instanceof Error && !/Failed query|password/i.test(error.message) ? error.message : "failed";
    try {
      report.afterFailure = await migrationState(client, MIGRATIONS);
    } catch {
      // the connection itself failed
    }
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    save();
    await client.end().catch(() => undefined);
  }
  console.log(`Report: ${reportFile}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error && !/Failed query|password/i.test(error.message) ? error.message : "Staging migration failed.");
  process.exitCode = 1;
});
