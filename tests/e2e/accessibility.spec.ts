import { expect, test } from "@playwright/test";
import { clearSignInLimits, E2E_OWNER, ownerPassword, uniqueName } from "./support";

// Keyboard-only use and the essentials assistive technology relies on: labels, landmarks, headings, focus.

test.beforeEach(clearSignInLimits);

test("sign in and create a product with the keyboard only", async ({ page }) => {
  await page.goto("/office/login");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Email")).toBeFocused();
  await page.keyboard.type(E2E_OWNER.email);
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Password")).toBeFocused();
  await page.keyboard.type(ownerPassword());
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Products" })).toBeVisible();

  // Skip link first, then the navigation, in reading order.
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  const newProduct = page.getByRole("navigation", { name: "Owner Office" }).getByRole("link", { name: "New product" });
  for (let i = 0; i < 6 && !(await newProduct.evaluate((el) => el === document.activeElement)); i += 1) await page.keyboard.press("Tab");
  await expect(newProduct).toBeFocused();
  // A visible focus indicator (outline or ring), not just the browser default being suppressed.
  expect(await newProduct.evaluate((el) => getComputedStyle(el).outlineStyle !== "none" || getComputedStyle(el).boxShadow !== "none")).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "New draft product" })).toBeVisible();

  const { slug } = uniqueName("e2e-kbd");
  await page.getByLabel("Slug").focus();
  await page.keyboard.type(slug);
  await page.keyboard.press("Tab");
  await page.keyboard.type("Keyboard Romper");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Name (Bangla)")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Draft product created.");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Keyboard Romper");
});

test("pages have one main landmark, a level-1 heading, labelled fields and Bangla marked as Bangla", async ({ page }) => {
  await page.goto("/office/login");
  await page.getByLabel("Email").fill(E2E_OWNER.email);
  await page.getByLabel("Password").fill(ownerPassword());
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Products" })).toBeVisible();

  for (const path of ["/office", "/office/products/new"]) {
    await page.goto(path);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    // Every visible input, select and textarea has an accessible name.
    const unnamed = await page.locator("main input:not([type=hidden]), main select, main textarea").evaluateAll((elements) =>
      elements.filter((el) => !(el as HTMLInputElement).labels?.length && !el.getAttribute("aria-label")).length,
    );
    expect(unnamed).toBe(0);
    // No id is used twice (a duplicate id breaks label and hint associations).
    const duplicates = await page.evaluate(() => {
      const ids = [...document.querySelectorAll("[id]")].map((el) => el.id);
      return ids.filter((id, i) => ids.indexOf(id) !== i);
    });
    expect(duplicates).toEqual([]);
  }
  await expect(page.getByLabel("Name (Bangla)")).toHaveAttribute("lang", "bn");
  await expect(page.getByLabel("Description (Bangla)")).toHaveAttribute("lang", "bn");
});
