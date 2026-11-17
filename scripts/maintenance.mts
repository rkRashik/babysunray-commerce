// `npm run maintenance:run`: the routine maintenance jobs (src/modules/maintenance/jobs.ts) against the local
// development database only (same target checks as `npm run db:migrate`), then read-only health checks. Safe to run
// any number of times, also concurrently and while the application runs. Prints counts only, never values. Exits
// with status 1 if an integrity check fails, so a scheduler can alert on it. No scheduler runs it yet (hosting).
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { assertConnectedIdentity, DEV_TARGET, parseSafeDatabaseUrl, pinSearchPath, resolveDatabaseUrl, sessionConfig } from "../src/db/connection-guard.mts";
import { expireVerifications, maintenanceBacklog, healthReport, integrityProblems, removeExpiredSessions, removeStaleRateLimitWindows } from "../src/modules/maintenance/jobs.ts";

async function main(): Promise<void> {
  const pool = new pg.Pool({ ...sessionConfig(parseSafeDatabaseUrl(resolveDatabaseUrl(), DEV_TARGET)), max: 2 });
  pool.on("error", (error) => console.error(`A database connection was lost (${error.name}).`));
  try {
    const client = await pool.connect();
    try {
      await assertConnectedIdentity(client, DEV_TARGET);
      await pinSearchPath(client);
    } finally {
      client.release();
    }
    const db = drizzle({ client: pool });
    const backlog = await maintenanceBacklog(db).catch(() => ({ overdueVerifications: 0, oldestOverdueMinutes: null, expiredSessions: 0 }));
    console.log(`Already overdue at the start: ${backlog.overdueVerifications} verification(s)${backlog.oldestOverdueMinutes === null ? "" : `, the oldest by ${backlog.oldestOverdueMinutes} minute(s)`}; ${backlog.expiredSessions} expired session(s). A large figure means this has not run on time.`);
    console.log(`Verification expiry: ${await expireVerifications(db)} order(s) expired.`);
    console.log(`Expired sessions removed (each recorded in the audit): ${await removeExpiredSessions(db)}.`);
    console.log(`Stale rate-limit windows removed: ${await removeStaleRateLimitWindows(db)}.`);
    const health = await healthReport(db);
    console.log(
      `Integrity: ${health.ledgerMismatch} ledger, ${health.reservedMismatch} reservation, ${health.strayHolds} stray hold, ${health.unheldOrders} unheld order and ${health.codMismatch} COD total mismatch(es).`,
    );
    console.log(`Kept (no retention period is approved): ${health.idempotencyRecords} idempotency record(s), ${health.guestSubmissions} guest submission(s), ${health.authEvents} audit row(s).`);
    if (integrityProblems(health) > 0) {
      console.error("Integrity check failed: stop taking orders, take a backup and investigate (docs/operations/runbook.md, section 4).");
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // Message only: never print a stack, a URL or query parameters.
  console.error(error instanceof Error && !/Failed query/.test(error.message) ? error.message : "Maintenance failed.");
  process.exitCode = 1;
});
