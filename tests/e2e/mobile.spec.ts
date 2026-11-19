import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { clearSignInLimits, ensureZones, seedSku, seedStorefrontProduct, signIn, testDatabase, uniqueName } from "./support";

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
  await page.getByRole("navigation", { name: "Quick links" }).getByRole("link", { name: "Orders" }).tap();
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
  // The bottom bar has the daily pages; the Menu has every page, in large rows.
  const bar = page.getByRole("navigation", { name: "Quick links" });
  await expect(bar.getByRole("link")).toHaveCount(3);
  expect(await smallTargets(page)).toEqual([]);
  await bar.getByRole("button", { name: "Menu" }).tap();
  const menu = page.getByRole("dialog", { name: "All pages" });
  await expect(menu).toBeVisible();
  for (const name of ["Dashboard", "Orders", "Stock counts", "Products", "New product", "Import", "Categories", "Reports", "Exports", "Delivery charges", "Storefront preview", "Launch readiness"]) {
    await expect(menu.getByRole("link", { name, exact: true })).toBeVisible();
  }
  await noSideScroll(page);
  // Escape closes it and returns focus to the Menu button.
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Menu" })).toBeFocused();
  await bar.getByRole("button", { name: "Menu" }).tap();
  await page.getByRole("dialog", { name: "All pages" }).getByRole("link", { name: "New product", exact: true }).tap();
  await expect(page.getByRole("dialog")).toHaveCount(0);
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

  await bar.getByRole("link", { name: "Products" }).tap();
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

test("storefront preview on a phone: the tab bar, search sheet, size and colour by touch, the bag and checkout, without sideways scrolling", async ({ page }) => {
  await ensureZones();
  const product = await seedStorefrontProduct();
  await page.goto("/office/storefront-preview/en");
  await noSideScroll(page);
  await expect(page.getByTestId("tab-bar")).toBeVisible();
  // Search opens from the tab bar with the field focused, so the keyboard comes up at once.
  await page.getByTestId("tab-search").tap();
  const sheet = page.getByRole("dialog", { name: "Search products" });
  await expect(sheet.getByRole("searchbox")).toBeFocused();
  await sheet.getByRole("searchbox").fill(product.nameEn);
  await sheet.getByRole("button", { name: "Search" }).tap();
  await expect(page.getByTestId("result-count")).toHaveText("1 product");
  await noSideScroll(page);
  await page.getByRole("link", { name: new RegExp(`^${product.nameEn}`) }).tap();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(product.nameEn);
  // A product has its buying bar instead of the tab bar: never two bars.
  await expect(page.getByTestId("tab-bar")).toHaveCount(0);
  await noSideScroll(page);
  const chip = (text: string) => page.locator("label").filter({ has: page.getByRole("radio", { name: new RegExp(`^${text}`) }) });
  await chip("0-3M").tap();
  await chip("Ivory").tap();
  await page.getByRole("button", { name: "One more" }).tap();
  await page.getByRole("button", { name: /^Add to Bag/ }).tap();
  await expect(page.getByTestId("cart-count")).toHaveText("2");
  // Touch targets of the buying controls are at least 44 × 44 CSS pixels.
  for (const control of [page.getByRole("button", { name: "One more" }), page.getByRole("button", { name: /^Add to Bag/ }), chip("0-3M")]) {
    const box = (await control.boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  }
  await page.getByRole("link", { name: /^Bag/ }).tap();
  await expect(page.getByTestId("subtotal")).toHaveText("৳ 1,700");
  await page.getByTestId(`cart-line-${product.skus[0]}`).getByRole("button", { name: /^One fewer/ }).tap();
  await expect(page.getByTestId("subtotal")).toHaveText("৳ 850");
  await chip("Dhaka City").tap();
  await expect(page.getByTestId("total")).toHaveText("৳ 910");
  await noSideScroll(page);
  await page.getByRole("link", { name: "Checkout", exact: true }).tap();
  await expect(page.getByTestId("checkout-steps")).toBeVisible();
  await noSideScroll(page);
});

test("checkout simulation on a 360-pixel-wide phone: every step fits, nothing is recorded", async ({ page }) => {
  await ensureZones();
  await page.setViewportSize({ width: 360, height: 740 });
  const product = await seedStorefrontProduct();
  await page.goto(`/office/storefront-preview/bn/products/${product.slug}`);
  await noSideScroll(page);
  const chip = (text: string) => page.locator("label").filter({ has: page.getByRole("radio", { name: new RegExp(`^${text}`) }) });
  await chip("0-3M").tap();
  await chip("Ivory").tap();
  await page.getByRole("button", { name: /^কার্টে যোগ করুন/ }).tap();
  await expect(page.getByTestId("cart-count")).toHaveText("১");
  await page.goto("/office/storefront-preview/bn/checkout");
  await noSideScroll(page);
  await page.getByLabel("পুরো নাম").fill("পরীক্ষামূলক গ্রাহক");
  await page.getByLabel("মোবাইল নম্বর").fill("01711000053");
  await page.getByRole("button", { name: "এগিয়ে যান" }).tap();
  await page.getByLabel("ডেলিভারি ঠিকানা").fill("বাড়ি ৫৩, পরীক্ষা রোড");
  await chip("ঢাকা সিটি").tap();
  await noSideScroll(page);
  await page.getByRole("button", { name: "এগিয়ে যান" }).tap();
  await expect(page.getByTestId("checkout-review")).toBeVisible();
  await noSideScroll(page);
  await page.getByRole("button", { name: "অর্ডার করুন (সিমুলেশন)" }).tap();
  await expect(page.getByTestId("simulation-result")).toContainText("এটি ছিল একটি সিমুলেশন");
  await noSideScroll(page);
  const db = await testDatabase();
  try {
    expect(Number((await db.query("select count(*) as n from orders where customer_phone = '01711000053'")).rows[0].n)).toBe(0);
  } finally {
    await db.end();
  }
});

test("on a phone: search in the tab bar, Add to Bag and its answer always on screen, no sideways scrolling", async ({ page }) => {
  const product = await seedStorefrontProduct();
  await page.goto("/office/storefront-preview/en");
  await expect(page.getByTestId("tab-search")).toBeInViewport();
  await noSideScroll(page);
  await page.goto(`/office/storefront-preview/en/products/${product.slug}`);
  const add = page.getByRole("button", { name: /^Add to Bag/ });
  await expect(add).toBeInViewport();
  await add.tap();
  await expect(page.getByTestId("add-message")).toBeInViewport();
  await expect(page.getByTestId("add-message")).toHaveText("Select a size and colour first.");
  await page.mouse.wheel(0, 3000);
  await expect(add).toBeInViewport();
  await noSideScroll(page);
});

/** Controls in the header and main content smaller than 44 × 24 CSS pixels (inline links inside running text are exempt). */
async function smallTargets(page: import("@playwright/test").Page): Promise<string[]> {
  return page.evaluate(() => {
    const small: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("header a, header button, header input, header summary, main a, main button, main input:not([type=hidden]), main select, main textarea, main summary, nav a, nav button")) {
      const choice = el.matches("input[type=radio], input[type=checkbox]");
      const target = choice ? (el.closest("label") ?? el.parentElement ?? el) : el;
      const r = target.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.tagName === "A" && getComputedStyle(el).display === "inline" && el.closest("p")) continue;
      if (r.height < 43.5 || r.width < 24) small.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return small;
  });
}

test("the storefront on a 360-pixel phone: every page fits, every control is at least 44 pixels, axe passes, and the checkout records nothing", async ({ page }) => {
  await ensureZones();
  const product = await seedStorefrontProduct({ featured: true });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/office/storefront-preview/en");
  const axe = async () => {
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  };
  const check = async (path: string) => {
    await page.goto(`/office/storefront-preview/${path}`);
    await expect(page.locator("main h1")).toBeVisible();
    await noSideScroll(page);
    expect(await smallTargets(page), path).toEqual([]);
    await axe();
  };
  for (const lang of ["en", "bn"]) {
    await check(lang);
    await check(`${lang}/products`);
    await check(`${lang}/products/${product.slug}`);
  }

  // The buying panel: Add to Bag in the fixed bar at once, its answer just above it.
  await page.goto(`/office/storefront-preview/en/products/${product.slug}`);
  await expect(page.getByRole("button", { name: /^Add to Bag/ })).toBeInViewport();
  await page.locator("label").filter({ has: page.getByRole("radio", { name: /^0-3M/ }) }).tap();
  await page.locator("label").filter({ has: page.getByRole("radio", { name: /^Ivory/ }) }).tap();
  await page.getByRole("button", { name: /^Add to Bag/ }).tap();
  await expect(page.getByTestId("add-message")).toBeInViewport();
  await expect(page.getByTestId("cart-count")).toHaveText("1");
  await check("bn/cart");
  await expect(page.getByTestId("total")).toHaveText("—");

  const db = await testDatabase();
  const orders = async () => Number((await db.query("select count(*) as n from orders")).rows[0].n);
  try {
    const before = await orders();
    await check("bn/checkout");
    await page.getByLabel("পুরো নাম").fill("পরীক্ষামূলক গ্রাহক");
    await page.getByLabel("মোবাইল নম্বর").fill("০১৭১১-০০০০৮১");
    await page.getByRole("button", { name: "এগিয়ে যান" }).tap();
    await page.getByLabel("ডেলিভারি ঠিকানা").fill("বাড়ি ৮১, পরীক্ষা রোড");
    await page.locator("label").filter({ has: page.getByRole("radio", { name: /^ঢাকা সিটি/ }) }).tap();
    expect(await smallTargets(page)).toEqual([]);
    await axe();
    await page.getByRole("button", { name: "এগিয়ে যান" }).tap();
    await expect(page.getByTestId("checkout-review")).toBeVisible();
    await noSideScroll(page);
    expect(await smallTargets(page)).toEqual([]);
    await axe();
    await page.getByRole("button", { name: "অর্ডার করুন (সিমুলেশন)" }).tap();
    const result = page.getByTestId("simulation-result");
    await expect(result).toBeVisible();
    await expect(page.getByTestId("next-steps")).toContainText("এরপর যা হবে");
    await expect(page.getByTestId("reference-preview")).toBeVisible();
    await noSideScroll(page);
    expect(await smallTargets(page)).toEqual([]);
    await axe();
    expect(await orders()).toBe(before);
  } finally {
    await db.end();
  }
});
