import { defineConfig } from "drizzle-kit";

// drizzle-kit does not read .env files; Node's built-in loader does, without printing anything.
// Variables already set in the environment take precedence.
try {
  process.loadEnvFile(".env.local");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const url = process.env.DATABASE_URL ?? "";

// `npm run db:migrate` is for the local development database only. A production migration
// procedure waits for the hosting decision (ADR-0001).
if (url && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
  throw new Error("DATABASE_URL must point at a local host for drizzle-kit commands.");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
