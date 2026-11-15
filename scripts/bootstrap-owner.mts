// `npm run auth:bootstrap-owner`: creates the first Owner in the local development database, once.
// Run it yourself in an interactive terminal; it asks for the email, name and password (the password
// without echo), so nothing lands in command-line arguments, shell history or logs. It refuses any
// database other than babysunray_dev (same checks as `npm run db:migrate`) and any installation that
// already has an account. Run with Node 22.18 or newer (native TypeScript type stripping).
import pg from "pg";
import {
  assertConnectedIdentity,
  DEV_TARGET,
  parseSafeDatabaseUrl,
  resolveDatabaseUrl,
  sessionConfig,
} from "../src/db/connection-guard.mts";
import { bootstrapFirstOwner, countAuthUsers } from "../src/modules/auth/owner-bootstrap.mts";
import { askNewPassword, askVisible, assertInteractiveTerminal } from "./prompt.mts";

async function main(): Promise<void> {
  // 1. URL-level checks, before any connection.
  const params = parseSafeDatabaseUrl(resolveDatabaseUrl(), DEV_TARGET);
  // 2. Only an interactive terminal: no piped or redirected password.
  assertInteractiveTerminal();

  const client = new pg.Client(sessionConfig(params));
  await client.connect();
  try {
    // 3. PostgreSQL confirms the target, and the installation must be empty, before asking for anything.
    await assertConnectedIdentity(client, DEV_TARGET);
    if ((await countAuthUsers(client)) > 0) {
      throw new Error("An account already exists. The first-Owner bootstrap only runs on an empty installation.");
    }
    const email = await askVisible("Owner email: ");
    const name = await askVisible("Owner display name: ");
    const password = await askNewPassword();

    // 4. Checks again inside one locked transaction, then creates the user, credential and owner access.
    await bootstrapFirstOwner(client, DEV_TARGET, { email, name, password });
    console.log(`Owner account created in ${DEV_TARGET.database}. Sign in at /api/auth/sign-in/email.`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  // Message only: never print a stack, a URL, an email or a password.
  console.error(error instanceof Error ? error.message : "Owner bootstrap failed.");
  process.exitCode = 1;
});
