import { expect, test } from "@playwright/test";
import { E2E_OWNER, signIn, testDatabase } from "../e2e/support";
import { ORIGINAL_BRAND, REHEARSAL_IDENTITY as ID } from "./identity";

// Runs only in the installation rehearsal (`npm run test:install`, tests/install/setup.ts), after or beside every
// browser test of tests/e2e and tests/e2e-prod, against the separately installed, rebranded copy.

test("the rehearsal copy shows its own identity in both languages and nothing of the original business", async ({ page }) => {
  await signIn(page);
  for (const lang of ["en", "bn"] as const) {
    await page.goto(`/office/storefront-preview/${lang}`);
    await expect(page.getByRole("banner").getByRole("link", { name: ID.STORE_NAME })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: ID.STORE_NAME })).toBeVisible();
    await expect(page.getByText(lang === "en" ? ID.STORE_LINE_EN : ID.STORE_LINE_BN).first()).toBeVisible();
    await expect(page.getByTestId("store-contact")).toContainText(ID.STORE_CONTACT_EMAIL);
    // The configured, contrast-checked colours replace the prototype tokens.
    await expect(page.locator(".sf")).toHaveCSS("background-color", "rgb(251, 250, 247)");
    await expect(page.locator(".sf")).toHaveCSS("color", "rgb(31, 42, 68)");
    expect(await page.content()).not.toMatch(ORIGINAL_BRAND);
    // The copy's logo files were deleted at handover: the name is shown as text, no logo image is requested.
    await expect(page.locator('img[src^="/brand/"]')).toHaveCount(0);
  }
  for (const pathname of ["/", "/office", "/office/import", "/office/catalogue-preparation", "/office/media-health", "/office/dashboard", "/office/storefront-preview/en/cart", "/office/storefront-preview/bn/checkout", "/track"]) {
    await page.goto(pathname);
    expect(await page.title(), pathname).not.toMatch(ORIGINAL_BRAND);
    expect(await page.content(), pathname).not.toMatch(ORIGINAL_BRAND);
  }
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`${ID.STORE_NAME}: development build`);
  const template = await page.request.get("/office/import/template?format=csv");
  expect(template.status()).toBe(200);
  expect(await template.text()).not.toMatch(ORIGINAL_BRAND);
});

test("the rehearsal database holds only this installation's fictional data", async () => {
  const db = await testDatabase();
  try {
    const { rows: users } = await db.query<{ email: string }>("select email from auth_users");
    expect(users.map((u) => u.email)).toEqual([E2E_OWNER.email]);
    const { rows: tables } = await db.query<{ name: string }>("select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1");
    expect(tables.length).toBeGreaterThan(20);
    for (const { name } of tables) {
      // Every row of every table, as text: no trace of the original business's name.
      const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from public."${name.replace(/"/g, '""')}" t where t::text ~* 'baby\\s*sunray'`);
      expect(rows[0].n, name).toBe(0);
    }
  } finally {
    await db.end();
  }
});
