import { defineConfig } from "vitest/config";

// Unit tests only. Database tests use vitest.integration.config.ts (`npm run test:db`).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts", "node_modules/**"],
  },
});
