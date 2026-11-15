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

/** A fictional draft product with one active SKU and `stock` units, written straight into babysunray_test. */
export async function seedSku(stock: number, pricePaisa = 50_000): Promise<string> {
  const { slug, sku } = uniqueName("e2e-ord");
  const db = await testDatabase();
  try {
    const product = await db.query<{ id: string }>("insert into products (slug, name_en) values ($1, 'E2E Order Romper') returning id", [slug]);
    const variant = await db.query<{ id: string }>(
      "insert into variants (product_id, sku, size, price_paisa) values ($1, $2, '0-3M', $3) returning id",
      [product.rows[0].id, sku, pricePaisa],
    );
    await db.query("insert into inventory_balances (variant_id, on_hand) values ($1, $2)", [variant.rows[0].id, stock]);
    // The ledger has no zero-unit receipts: a SKU seeded with no stock has no movement.
    if (stock > 0) {
      await db.query(
        "insert into stock_movements (variant_id, movement_type, quantity_delta, actor_type, actor_ref) values ($1, 'receipt', $2, 'system', 'e2e-seed')",
        [variant.rows[0].id, stock],
      );
    }
  } finally {
    await db.end();
  }
  return sku;
}

/** Both delivery zones configured (fictional test amounts), so order tests also run on their own. */
export async function ensureZones(): Promise<void> {
  const db = await testDatabase();
  try {
    await db.query(
      `insert into delivery_zones (code, charge_paisa, active, updated_by_user_id)
       select z.code, z.charge, true, u.id from (values ('dhaka_city', 6000), ('outside_dhaka', 12000)) as z(code, charge)
       cross join (select id from auth_users where email = $1) u
       on conflict (code) do update set active = true`,
      [E2E_OWNER.email],
    );
  } finally {
    await db.end();
  }
}

/** Every visible field has a label and no id repeats (a repeated id breaks label and hint associations). */
export async function expectLabelledFields(page: Page): Promise<void> {
  const unnamed = await page.locator("main input:not([type=hidden]), main select, main textarea").evaluateAll(
    (elements) => elements.filter((el) => !(el as HTMLInputElement).labels?.length && !el.getAttribute("aria-label")).length,
  );
  expect(unnamed).toBe(0);
  const duplicates = await page.evaluate(() => {
    const ids = [...document.querySelectorAll("[id]")].map((el) => el.id);
    return ids.filter((id, i) => ids.indexOf(id) !== i);
  });
  expect(duplicates).toEqual([]);
}
