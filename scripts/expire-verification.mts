// `npm run orders:expire-verification`: releases the stock of every order still Pending Verification 24 hours
// after submission and marks it Verification Expired (founder rule D). Local development database only (same
// checks as `npm run db:migrate`). Safe to run any number of times, also while the application is running:
// each order is handled in its own short transaction and skipped if another operation holds it.
//
// Logical correctness does not depend on this command: submissions, stock adjustments and confirmations
// release overdue holds themselves. This is the physical clean-up, so Admin shows the expired state
// promptly. No scheduler runs it; with production hosting, the host's scheduler should run the same
// operation every few minutes (docs/product/order-policy-decisions.md, section 3).
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { assertConnectedIdentity, DEV_TARGET, parseSafeDatabaseUrl, pinSearchPath, resolveDatabaseUrl, sessionConfig } from "../src/db/connection-guard.mts";
import { expireOverdueVerifications } from "../src/modules/orders/service.ts";

async function main(): Promise<void> {
  const params = parseSafeDatabaseUrl(resolveDatabaseUrl(), DEV_TARGET);
  const pool = new pg.Pool({ ...sessionConfig(params), max: 2 });
  try {
    const client = await pool.connect();
    try {
      await assertConnectedIdentity(client, DEV_TARGET);
      await pinSearchPath(client);
    } finally {
      client.release();
    }
    const expired = await expireOverdueVerifications(drizzle({ client: pool }));
    console.log(`${expired} order(s) expired in ${DEV_TARGET.database}.`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // Message only: never print a stack, a URL or query parameters.
  console.error(error instanceof Error && !/Failed query/.test(error.message) ? error.message : "Verification expiry failed.");
  process.exitCode = 1;
});
