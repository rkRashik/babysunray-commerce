import { expect, test } from "@playwright/test";
import { clearSignInLimits, ensureZones, seedSku, signIn, uniqueName } from "./support";

// The Office on a phone-sized screen (Pixel 7 profile: touch, 412 px wide).

test.beforeEach(async ({ page }) => {
  await clearSignInLimits();
  await signIn(page);
});

async function noSideScroll(page: import("@playwright/test").Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test("an assisted order on a phone: create, confirm and read it without sideways scrolling", async ({ page }) => {
  await ensureZones();
  page.on("dialog", (dialog) => void dialog.accept());
  const sku = await seedSku(3);
  await page.getByRole("navigation", { name: "Owner Office" }).getByRole("link", { name: "Orders" }).tap();
  await expect(page.getByRole("heading", { level: 1, name: "Orders" })).toBeVisible();
  await noSideScroll(page);
  await page.getByRole("link", { name: "New assisted order" }).tap();
  await page.getByLabel("Messenger").tap();
  await page.getByLabel("Customer name").fill("Test Customer");
  await page.getByLabel("Phone").fill("01711000007");
  await page.getByLabel("Delivery address").fill("House 7, Test Road");
  await page.getByLabel(/^Outside Dhaka/).tap();
  await page.getByLabel("SKU, line 1").fill(sku);
  await page.getByLabel("Quantity, line 1").fill("1");
  await noSideScroll(page);
  await page.getByRole("button", { name: "Create order" }).tap();
  await expect(page.locator('[data-dimension="order"]')).toHaveText("Pending verification");
  await noSideScroll(page);
  const before = await page.getByTestId("order-version").textContent();
  await page.getByRole("button", { name: "Confirm order (verified with the customer)" }).tap();
  await expect(page.getByTestId("order-version")).not.toHaveText(before ?? "");
  await expect(page.locator('[data-dimension="order"]')).toHaveText("Confirmed");
  await noSideScroll(page);
});

test("navigation and the main screens work without sideways scrolling", async ({ page }) => {
  await noSideScroll(page);
  const nav = page.getByRole("navigation", { name: "Owner Office" });
  await nav.getByRole("link", { name: "New product" }).tap();
  await expect(page.getByRole("heading", { level: 1, name: "New draft product" })).toBeVisible();
  await noSideScroll(page);

  const { slug, sku } = uniqueName("e2e-mob");
  await page.getByLabel("Slug").fill(slug);
  await page.getByLabel("Name (English)").fill("Mobile Romper");
  await page.getByRole("button", { name: "Create draft" }).tap();
  await expect(page.getByRole("status")).toHaveText("Draft product created.");
  await noSideScroll(page);

  const form = page.getByRole("region", { name: "Add a variant" });
  await form.getByLabel("SKU").fill(sku);
  await form.getByLabel("Price (BDT)").fill("450");
  await form.getByRole("button", { name: "Add variant" }).tap();
  await expect(page.getByRole("status")).toHaveText("Variant added.");
  await noSideScroll(page);

  await page.getByRole("link", { name: sku, exact: true }).tap();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(sku);
  await noSideScroll(page);
  const receive = page.getByRole("region", { name: "Receive stock" });
  await receive.getByLabel("Units received").fill("3");
  await receive.getByRole("button", { name: "Record receipt" }).tap();
  await expect(page.getByRole("status")).toHaveText("Stock receipt recorded.");

  const adjust = page.getByRole("region", { name: "Adjust stock" });
  await adjust.getByLabel("Remove units").tap();
  await adjust.getByRole("textbox", { name: /^Units/ }).fill("1");
  await adjust.getByLabel("Reason").fill("Mobile recount");
  await adjust.getByRole("button", { name: "Record adjustment" }).tap();
  await expect(page.getByRole("status")).toHaveText("Stock adjustment recorded.");
  await expect(page.getByTestId("on-hand")).toHaveText("2");
  await noSideScroll(page);

  await nav.getByRole("link", { name: "Products" }).tap();
  const search = page.getByRole("search", { name: "Search products" });
  await search.getByLabel("Search").fill(sku);
  await search.getByRole("button", { name: "Search" }).tap();
  await expect(page.getByRole("list", { name: "Products" }).getByRole("listitem")).toHaveCount(1);
  await noSideScroll(page);
  await page.getByRole("link", { name: /Mobile Romper/ }).tap();
  await page.getByRole("link", { name: "Edit details" }).tap();
  await expect(page.getByLabel("Name (English)")).toHaveValue("Mobile Romper");
  await noSideScroll(page);
  await page.getByRole("button", { name: "Sign out" }).tap();
  await expect(page).toHaveURL(/\/office\/login$/);
});
