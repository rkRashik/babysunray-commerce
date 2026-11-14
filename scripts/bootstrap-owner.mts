// `npm run auth:bootstrap-owner`: creates the first Owner in the local development database, once.
// Run it yourself in an interactive terminal; it asks for the email, name and password (the password
// without echo), so nothing lands in command-line arguments, shell history or logs. It refuses any
// database other than babysunray_dev (same checks as `npm run db:migrate`) and any installation that
// already has an account. Run with Node 22.18 or newer (native TypeScript type stripping).
import { createInterface } from "node:readline/promises";
import pg from "pg";
import {
  assertConnectedIdentity,
  DEV_TARGET,
  parseSafeDatabaseUrl,
  resolveDatabaseUrl,
  sessionConfig,
} from "../src/db/connection-guard.mts";
import { bootstrapFirstOwner, countAuthUsers } from "../src/modules/auth/owner-bootstrap.mts";

async function askVisible(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

// Reads one line in raw mode without echoing it.
function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (ch === "\u0003" || ch === "\u0004") {
          finish();
          reject(new Error("Cancelled."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    // Input closed before Enter (for example Ctrl+Z on Windows): stop with a message, never silently.
    const onEnd = () => {
      finish();
      reject(new Error("Input closed. Nothing was created."));
    };
    process.stdout.write(question);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    stdin.once("end", onEnd);
  });
}

async function main(): Promise<void> {
  // 1. URL-level checks, before any connection.
  const params = parseSafeDatabaseUrl(resolveDatabaseUrl(), DEV_TARGET);
  // 2. Only an interactive terminal: no piped or redirected password.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Run this command in an interactive terminal; it does not read input from a pipe or file.");
  }

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
    const password = await askHidden("Password (not shown): ");
    if ((await askHidden("Repeat password: ")) !== password) throw new Error("The passwords do not match.");

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
