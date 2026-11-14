import path from "node:path";
import { defineConfig } from "vitest/config";

// Unit tests only. Database tests use vitest.integration.config.mts (`npm run test:db`).
export default defineConfig({
  resolve: {
    // Next.js resolves `server-only` at build time; outside Next.js the package throws on import.
    alias: { "server-only": path.resolve("node_modules/server-only/empty.js"), "@": path.resolve("src") },
  },
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts", "node_modules/**"],
  },
});
