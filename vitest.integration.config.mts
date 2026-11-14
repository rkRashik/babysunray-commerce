import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

// Database integration tests. Run with `npm run test:db`.
// TEST_DATABASE_URL comes from the process environment or from .env / .env.local.
const fileEnv = loadEnv("test", process.cwd(), "");
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? fileEnv.TEST_DATABASE_URL;

// Fail loudly instead of skipping, so a missing configuration is never reported as a pass.
if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is not set. See README.md (Local PostgreSQL) and .env.example.",
  );
}

export default defineConfig({
  test: {
    include: ["tests/**/*.integration.test.ts"],
    env: { TEST_DATABASE_URL: testDatabaseUrl },
    // Integration tests share one database; run files one at a time.
    fileParallelism: false,
  },
});
