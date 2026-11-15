import { expect, type Locator, type Page } from "@playwright/test";
import type { Client } from "pg";
import { connectTestClient } from "../support/test-database";

// Shared helpers for the browser tests. Fictional identity only (example.test is reserved and non-routable).
export const E2E_OWNER = { email: "e2e-owner@example.test", name: "E2E Owner" };

/** The random password global-setup gave the fictional Owner for this run. */
export function ownerPassword(): string {
  const password = process.env.E2E_OWNER_PASSWORD;
  if (!password) throw new Error("Run the browser tests with `npm run test:e2e`.");
  return password;
}

/** Signs in through the real sign-in form and waits for the product list. */
export async function signIn(page: Page): Promise<void> {
  await page.goto("/office/login");
  await page.getByLabel("Email").fill(E2E_OWNER.email);
  await page.getByLabel("Password").fill(ownerPassword());
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/office$/);
  await expect(page.getByRole("heading", { level: 1, name: "Products" })).toBeVisible();
}

/** A verified connection to babysunray_test for assertions (identity checked again here). */
export function testDatabase(): Promise<Client> {
  return connectTestClient(process.env.E2E_TEST_DATABASE_URL);
}

/**
 * Better Auth allows 3 sign-in attempts per 10 seconds per client address, and every test signs in from
 * 127.0.0.1; each test starts with fresh counters (test database only).
 */
export async function clearSignInLimits(): Promise<void> {
  const db = await testDatabase();
  try {
    await db.query("delete from auth_rate_limits");
  } finally {
    await db.end();
  }
}

let counter = 0;
/** A slug and SKU unique within this run. */
export function uniqueName(prefix: string): { slug: string; sku: string } {
  counter += 1;
  const tag = `${Date.now().toString(36)}${counter}`;
  return { slug: `${prefix}-${tag}`, sku: `${prefix}-${tag}`.toUpperCase() };
}

/** Clicks a submit button and waits for the Server Action's answer, so the next step sees its result. */
export async function submitAndWait(page: Page, button: Locator): Promise<void> {
  const answer = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
  await button.click();
  await answer;
}
