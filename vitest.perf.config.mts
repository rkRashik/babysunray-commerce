import path from "node:path";
import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

// The performance benchmark (`npm run perf:bench`): babysunray_test only, under the same test-run lock,
// identity checks and guarded reset as `npm run test:db` (tests/support/global-setup.ts). Never part of the
// regular test runs: it fills the test database with thousands of fictional rows.
const fileEnv = loadEnv("test", process.cwd(), "");
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? fileEnv.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not set. See docs/getting-started.md (sections 2 and 3) and .env.example.");

export default defineConfig({
  resolve: {
    alias: { "server-only": path.resolve("node_modules/server-only/empty.js"), "@": path.resolve("src") },
  },
  test: {
    include: ["tests/perf/**/*.perf.ts"],
    env: { TEST_DATABASE_URL: testDatabaseUrl },
    globalSetup: ["tests/support/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 900_000,
  },
});
