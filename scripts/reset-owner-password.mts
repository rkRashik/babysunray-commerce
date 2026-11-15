// `npm run auth:reset-owner-password`: sets a new password for the Owner of the local development
// installation and signs out every session of that Owner (browser cookies and Bearer tokens). For an operator
// who has lost the password and has local database access; it is not a production account-recovery
// mechanism. Run it yourself in an interactive terminal: it asks for the Owner's email and the new password
// twice without echo, so nothing lands in command-line arguments, shell history or logs. It refuses any
// database other than babysunray_dev (same checks as `npm run db:migrate`), and any installation that does
// not have exactly one active Owner. It never creates an account or changes a role. Node 22.18 or newer.
import pg from "pg";
import {
  assertConnectedIdentity,
  DEV_TARGET,
  parseSafeDatabaseUrl,
  resolveDatabaseUrl,
  sessionConfig,
} from "../src/db/connection-guard.mts";
import { assertSingleActiveOwner, resetOwnerPassword } from "../src/modules/auth/owner-password-reset.mts";
import { askNewPassword, askVisible, assertInteractiveTerminal } from "./prompt.mts";

async function main(): Promise<void> {
  // 1. URL-level checks, before any connection.
  const params = parseSafeDatabaseUrl(resolveDatabaseUrl(), DEV_TARGET);
  // 2. Only an interactive terminal: no piped or redirected password.
  assertInteractiveTerminal();

  const client = new pg.Client(sessionConfig(params));
  await client.connect();
  try {
    // 3. PostgreSQL confirms the target and there is exactly one active Owner, before asking for anything.
    await assertConnectedIdentity(client, DEV_TARGET);
    await assertSingleActiveOwner(client);
    const email = await askVisible("Owner email: ");
    const password = await askNewPassword();

    // 4. Checks again inside one locked transaction, then replaces the hash and deletes the sessions.
    const { revokedSessions } = await resetOwnerPassword(client, DEV_TARGET, { email, password });
    console.log(`Owner password changed in ${DEV_TARGET.database}. ${revokedSessions} session(s) signed out.`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  // Message only: never print a stack, a URL, an email or a password.
  console.error(error instanceof Error ? error.message : "Password reset failed.");
  process.exitCode = 1;
});
