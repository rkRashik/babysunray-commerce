import { defineConfig } from "drizzle-kit";
import { DEV_TARGET, parseSafeDatabaseUrl, resolveDatabaseUrl } from "./src/db/connection-guard.mts";

// `generate` and `check` only read and write local files, so they need no database. Any other
// drizzle-kit command is refused except `migrate`, which gets credentials only if DATABASE_URL names
// the local development database and role. Use `npm run db:migrate`, which also asks PostgreSQL to
// confirm the connection. This config cannot stop a direct `drizzle-kit ... --config <other file>`
// or a command-line URL; those bypass it (README.md, Database migrations).
const command = process.argv[2];
const READ_ONLY = ["generate", "check"];

if (command !== undefined && !READ_ONLY.includes(command) && command !== "migrate") {
  throw new Error(`drizzle-kit ${command} is not supported in this project. See README.md (Database migrations).`);
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  ...(command === "migrate"
    ? { dbCredentials: { ...parseSafeDatabaseUrl(resolveDatabaseUrl(), DEV_TARGET), ssl: false as const } }
    : {}),
  strict: true,
  verbose: true,
});
