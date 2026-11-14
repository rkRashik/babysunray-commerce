import { defineConfig } from "drizzle-kit";

// Only `generate` and `check` are supported: they read and write local files and need no database. Every
// other drizzle-kit command, including `migrate` and `push`, is refused, and this config never carries
// database credentials. Apply migrations with `npm run db:migrate`, which checks the target with
// PostgreSQL and pins the session search_path first. This config cannot stop
// `drizzle-kit ... --config <other file>` or command-line credentials (README.md, Database migrations).
const command = process.argv[2];
const SUPPORTED = ["generate", "check"];

if (command !== undefined && !SUPPORTED.includes(command)) {
  throw new Error(`drizzle-kit ${command} is not supported in this project. See README.md (Database migrations).`);
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
});
