import path from "node:path";
import { defineConfig } from "vitest/config";

// The staging verification suite (Gate H.45). Run only through `npm run test:staging` (scripts/staging-test.mts), which
// reports NOT RUN without staging settings. Deliberately reads no .env file: the local database URLs never reach it.
export default defineConfig({
  resolve: {
    alias: { "server-only": path.resolve("node_modules/server-only/empty.js"), "@": path.resolve("src") },
  },
  test: {
    include: ["tests/staging/**/*.staging.ts"],
    globalSetup: ["tests/staging/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
