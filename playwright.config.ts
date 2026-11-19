import { defineConfig, devices } from "@playwright/test";

// Real-browser tests of Admin (`npm run test:e2e`). tests/e2e/global-setup.ts verifies and locks
// babysunray_test, starts a dedicated Next.js server and sets E2E_BASE_URL; the tests then drive Chromium
// against it. One worker: the tests share one database and one server. No traces, screenshots or videos are
// kept, so no session cookie or page content is written to disk.
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./tests/e2e/global-setup.ts",
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  // The first request to each page compiles it in `next dev`.
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
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: "**/mobile.spec.ts" },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: "**/mobile.spec.ts" },
  ],
});
