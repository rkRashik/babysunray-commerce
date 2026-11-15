import { expect, test } from "@playwright/test";
import { clearSignInLimits, ensureZones, seedSku, seedStorefrontProduct, signIn, uniqueName } from "./support";

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

test("dashboard, reports, exports and a stock count on a phone, without sideways scrolling", async ({ page }) => {
  const sku = await seedSku(2);
  for (const path of ["/office/dashboard", "/office/reports", "/office/exports", "/office/stock-counts", "/office/print/picking"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await noSideScroll(page);
  }
  await page.goto("/office/stock-counts");
  await page.getByLabel("Only the SKUs listed below").tap();
  await page.getByLabel("SKUs to count").fill(sku);
  await page.getByRole("button", { name: "Start count" }).tap();
  await expect(page.getByRole("status").first()).toContainText("Stock count started");
  await noSideScroll(page);
  await page.getByLabel(`Counted units of ${sku}`).fill("2");
  await page.getByRole("button", { name: "Save counts" }).tap();
  await expect(page.getByTestId(`line-state-${sku}`)).toContainText("difference 0");
  await page.getByRole("button", { name: "Apply corrections" }).tap();
  await expect(page.getByTestId("count-status")).toContainText("applied");
  await noSideScroll(page);
});

test("storefront preview on a phone: the menu, size and colour by touch, the cart and checkout, without sideways scrolling", async ({ page }) => {
  await ensureZones();
  const product = await seedStorefrontProduct();
  await page.goto("/office/storefront-preview/en");
  await noSideScroll(page);
  const menu = page.getByTestId("mobile-menu");
  await menu.getByText("Menu").tap();
  await expect(menu.getByRole("link", { name: "All products" })).toBeVisible();
  await menu.getByRole("searchbox").fill(product.nameEn);
  await menu.getByRole("button", { name: "Search" }).tap();
  await expect(page.getByTestId("result-count")).toHaveText("1 product");
  await noSideScroll(page);
  await page.getByRole("link", { name: new RegExp(product.nameEn) }).tap();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(product.nameEn);
  await noSideScroll(page);
  const chip = (text: string) => page.locator("label").filter({ has: page.getByRole("radio", { name: new RegExp(`^${text}`) }) });
  await chip("0-3M").tap();
  await chip("Ivory").tap();
  await page.getByRole("button", { name: "One more" }).tap();
  await page.getByRole("button", { name: "Add to cart" }).tap();
  await expect(page.getByTestId("cart-count")).toHaveText("2");
  // Touch targets of the buying controls are at least 44 × 44 CSS pixels.
  for (const control of [page.getByRole("button", { name: "One more" }), page.getByRole("button", { name: "Add to cart" }), chip("0-3M")]) {
    const box = (await control.boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  }
  await page.getByRole("link", { name: /^Cart/ }).tap();
  await expect(page.getByTestId("subtotal")).toHaveText("৳ 1,700");
  await page.getByTestId(`cart-line-${product.skus[0]}`).getByRole("button", { name: /^One fewer/ }).tap();
  await expect(page.getByTestId("subtotal")).toHaveText("৳ 850");
  await page.getByLabel(/^Dhaka City/).tap();
  await expect(page.getByTestId("total")).toHaveText("৳ 910");
  await noSideScroll(page);
  await page.getByRole("link", { name: "Go to checkout" }).tap();
  await expect(page.getByTestId("simulation-note")).toBeVisible();
  await noSideScroll(page);
});
