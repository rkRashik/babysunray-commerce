import path from "node:path";
import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

// Database integration tests. Run with `npm run test:db`.
// TEST_DATABASE_URL comes from the process environment or from .env / .env.local.
const fileEnv = loadEnv("test", process.cwd(), "");
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? fileEnv.TEST_DATABASE_URL;

// Fail loudly instead of skipping, so a missing configuration is never reported as a pass.
if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is not set. See docs/getting-started.md (sections 2 and 3) and .env.example.",
  );
}

export default defineConfig({
  resolve: {
    // Next.js resolves `server-only` at build time; outside Next.js the package throws on import.
    alias: { "server-only": path.resolve("node_modules/server-only/empty.js"), "@": path.resolve("src") },
  },
  test: {
    include: ["tests/**/*.integration.test.ts"],
    env: { TEST_DATABASE_URL: testDatabaseUrl },
    // Replays all migrations into an empty schema before the tests (tests/support/global-setup.ts).
    globalSetup: ["tests/support/global-setup.ts"],
    // Integration tests share one database; run files one at a time.
    fileParallelism: false,
  },
});
