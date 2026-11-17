// `npm run config:check`: says which configuration variables are set and valid, and whether the local
// database is reachable and migrated, without printing any value. Reads the shell and .env.local, like the
// other local commands. Changes nothing: no account, session, file or table is created or modified.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import pg from "pg";
import { type ConfigCheck, configChecks, configReady } from "../src/config/readiness.ts";
import { assertConnectedIdentity, DEV_TARGET, parseSafeDatabaseUrl, sessionConfig } from "../src/db/connection-guard.mts";

function readEnv(): { env: Record<string, string | undefined>; conflicts: string[] } {
  let file: Record<string, string | undefined> = {};
  try {
    file = parseEnv(readFileSync(".env.local", "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    console.log("No .env.local file: copy .env.example to .env.local and fill it in.");
  }
  const env: Record<string, string | undefined> = { ...file };
  const conflicts: string[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (file[name] && file[name] !== value && Object.hasOwn(file, name)) conflicts.push(name);
    env[name] = value;
  }
  return { env, conflicts };
}

async function databaseState(env: Record<string, string | undefined>): Promise<string[]> {
  const client = new pg.Client(sessionConfig(parseSafeDatabaseUrl(env.DATABASE_URL, DEV_TARGET)));
  try {
    await client.connect();
    await assertConnectedIdentity(client, DEV_TARGET);
    const journal = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../drizzle/meta/_journal.json"), "utf8")) as { entries: unknown[] };
    const applied = await client
      .query<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations")
      .then((r) => r.rows[0].n)
      .catch(() => 0);
    const owners = await client
      .query<{ n: number }>("select count(*)::int as n from user_access where role = 'owner' and disabled_at is null")
      .then((r) => r.rows[0].n)
      .catch(() => null);
    return [
      `✓ Database reachable: ${DEV_TARGET.database} as ${DEV_TARGET.role}.`,
      applied === journal.entries.length
        ? `✓ Migrations: all ${applied} applied.`
        : `✗ Migrations: ${applied} of ${journal.entries.length} applied. Run npm run db:migrate (take a backup first once real data exists).`,
      owners === null
        ? "✗ Owner account: the user_access table is missing (migrations not applied)."
        : owners > 0
          ? `✓ Owner account: ${owners} active.`
          : "✗ Owner account: none. The founder creates it with npm run auth:bootstrap-owner.",
    ];
  } catch (error) {
    const message = error instanceof Error && !/password|Failed query/i.test(error.message) ? error.message : "connection failed";
    return [`✗ Database not reachable (${message}). Is PostgreSQL running, and is the password in DATABASE_URL right?`];
  } finally {
    await client.end().catch(() => undefined);
  }
}

const line = (c: ConfigCheck) =>
  `${c.status === "ok" ? "✓" : c.status === "missing" && c.need === "optional" ? "-" : "✗"} ${c.name}: ${c.status === "ok" ? "set" : c.status}${c.need === "optional" ? " (optional)" : ""}. ${c.detail}`;

async function main(): Promise<void> {
  const { env, conflicts } = readEnv();
  const checks = configChecks(env);
  for (const c of checks) console.log(line(c));
  for (const name of conflicts) console.log(`✗ ${name}: set in the shell and differs from .env.local; the shell value wins in the app but local commands refuse it. Unset one.`);
  const databaseOk = checks.find((c) => c.name === "DATABASE_URL")?.status === "ok";
  // Hosted (NODE_ENV=production): the settings are validated, but this command never connects to a hosted database.
  const database =
    env.NODE_ENV === "production"
      ? ["- Database: not connected to (hosted settings are validated only; check readiness at /api/health/ready on the host)."]
      : databaseOk
        ? await databaseState(env)
        : ["- Database: not checked until DATABASE_URL is valid."];
  for (const l of database) console.log(l);
  const ready = configReady(checks) && conflicts.length === 0 && database.every((l) => !l.startsWith("✗"));
  console.log(ready ? "Ready: the Owner Office can start and sign-in can work." : "Not ready: fix the lines marked ✗, then run npm run config:check again.");
  if (!ready) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "The configuration check failed.");
  process.exitCode = 1;
});
