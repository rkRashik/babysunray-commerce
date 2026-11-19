// `npm run auth:bootstrap-owner:staging`: creates the founder's Owner account on the hosted STAGING database, so the founder
// can sign in to the Office on the staging site for founder acceptance (ADR-0011). For the founder to run in an interactive
// terminal; never run by the application, a test or a scheduler. It asks for the email, name and password (the password
// without echo), so nothing lands in arguments, history or logs.
//
// Before anything: the URL (STAGING_MIGRATION_DATABASE_URL from .env.staging.local) is a direct connection with TLS, not this
// machine; PostgreSQL confirms the database carries the staging marker; the founder types the host name back. It refuses
// when an Owner with active access already exists or the email is taken, and never changes or removes an existing row (the
// staging tests' disabled accounts stay as they are). Node 22.18 or newer.
import pg from "pg";
import { assertNotLocalDatabase, assertStagingTarget, parseStagingUrl } from "../src/db/hosted-target.mts";
import { bootstrapStagingOwner } from "../src/modules/auth/owner-bootstrap.mts";
import { askNewPassword, askVisible, assertInteractiveTerminal } from "./prompt.mts";
import { readStagingEnv } from "./staging-env.mts";

async function main(): Promise<void> {
  const env = readStagingEnv();
  const conn = parseStagingUrl(env, "STAGING_MIGRATION_DATABASE_URL", { pooled: false });
  assertNotLocalDatabase(conn, env);
  assertInteractiveTerminal();
  const client = new pg.Client({ host: conn.host, port: conn.port, database: conn.database, user: conn.user, password: conn.password, ssl: conn.ssl, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const identity = await assertStagingTarget(client);
    console.log(`Staging database: ${identity.database} on ${conn.host} (marked staging).`);
    const typed = (await askVisible(`Type the host name to continue (${conn.host}): `)).trim();
    if (typed !== conn.host) throw new Error("The host name did not match. Nothing was changed.");
    const email = await askVisible("Owner email: ");
    const name = await askVisible("Owner display name: ");
    const password = await askNewPassword();
    await bootstrapStagingOwner(client, { email, name, password });
    console.log("Owner account created on the staging database. Sign in at <site>/office/login.");
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  // Message only: never print a stack, a URL, an email or a password.
  console.error(error instanceof Error ? error.message : "Staging Owner bootstrap failed.");
  process.exitCode = 1;
});
