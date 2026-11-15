import path from "node:path";
import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

// The backup and restore drill (`npm run backup:drill`): babysunray_test only, under the same test-run lock,
// identity checks and guarded reset as `npm run test:db` (tests/support/global-setup.ts). Never part of the
// regular test runs, because it empties and restores the test database.
const fileEnv = loadEnv("test", process.cwd(), "");
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? fileEnv.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not set. See README.md (Local PostgreSQL) and .env.example.");

export default defineConfig({
  resolve: {
    alias: { "server-only": path.resolve("node_modules/server-only/empty.js"), "@": path.resolve("src") },
  },
  test: {
    include: ["tests/drill/**/*.drill.ts"],
    env: { TEST_DATABASE_URL: testDatabaseUrl },
    globalSetup: ["tests/support/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
  },
});
