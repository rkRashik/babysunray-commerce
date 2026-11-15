import { defineConfig, devices } from "@playwright/test";

// Second-installation rehearsal (`npm run test:install`): tests/install/setup.ts installs a clean clone of the
// committed HEAD with fictional branding and its own fresh schema, secrets and photo folder, then every browser
// test of tests/e2e and tests/e2e-prod plus tests/install runs against that copy's production build.
const https = { ignoreHTTPSErrors: true };

export default defineConfig({
  testDir: "tests",
  testMatch: ["e2e/**/*.spec.ts", "e2e-prod/**/*.spec.ts", "install/**/*.spec.ts"],
  globalSetup: "./tests/install/setup.ts",
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
