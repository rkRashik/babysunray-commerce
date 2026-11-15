import { defineConfig, devices } from "@playwright/test";

// Production-build browser tests (`npm run test:e2e:prod`): every browser test of tests/e2e plus the
// production smoke tests in tests/e2e-prod, against `next build` + `next start` (NODE_ENV=production) behind a
// local TLS proxy, so Better Auth runs with its production rules (https, Secure cookies). See
// tests/e2e/prod-setup.ts. The self-signed certificate is accepted by this test browser only.
const https = { ignoreHTTPSErrors: true };

export default defineConfig({
  testDir: "tests",
  testMatch: ["e2e/**/*.spec.ts", "e2e-prod/**/*.spec.ts"],
  globalSetup: "./tests/e2e/prod-setup.ts",
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: "off",
    screenshot: "off",
    video: "off",
    locale: "en-GB",
    timezoneId: "Asia/Dhaka",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], ...https }, testIgnore: "**/mobile.spec.ts" },
    { name: "mobile", use: { ...devices["Pixel 7"], ...https }, testMatch: "**/mobile.spec.ts" },
  ],
});
