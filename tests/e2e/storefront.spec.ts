import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { clearSignInLimits, ensureZones, seedStorefrontProduct, signIn, testDatabase } from "./support";

// The private storefront preview in a real browser against the real server and babysunray_test: Owner-only
// access, English and Bangla, size and colour choice with measurements, the cart re-checked against the
// database, and the checkout simulation, which must never create an order. Fictional products only.

const PREVIEW = "/office/storefront-preview";

test.beforeAll(ensureZones);
test.beforeEach(clearSignInLimits);

/** A size or colour choice: the visible label of its radio button. */
const chip = (page: Page, text: string) => page.locator("label").filter({ has: page.getByRole("radio", { name: new RegExp(`^${text}`) }) });

async function expectNoAxeViolations(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function counts() {
  const db = await testDatabase();
  try {
    const one = async (sql: string) => Number((await db.query(sql)).rows[0].n);
    return {
      orders: await one("select count(*) as n from orders"),
      reservations: await one("select count(*) as n from stock_reservations"),
      reserved: await one("select coalesce(sum(reserved), 0) as n from inventory_balances"),
      idempotency: await one("select count(*) as n from idempotency_records"),
    };
  } finally {
    await db.end();
  }
}

async function setStock(sku: string, onHand: number) {
  const db = await testDatabase();
  try {
    const { rows } = await db.query<{ id: string; on_hand: number }>("select v.id, b.on_hand from variants v join inventory_balances b on b.variant_id = v.id where v.sku = $1", [sku]);
    const delta = onHand - rows[0].on_hand;
    if (delta !== 0) {
      await db.query("insert into stock_movements (variant_id, movement_type, quantity_delta, reason, actor_type, actor_ref) values ($1, 'adjustment', $2, 'Fictional recount', 'system', 'e2e-seed')", [rows[0].id, delta]);
      await db.query("update inventory_balances set on_hand = $2 where variant_id = $1", [rows[0].id, onHand]);
    }
  } finally {
    await db.end();
  }
}

test("signed out, no preview page, product or photo is shown: every route goes to sign-in", async ({ browser, baseURL }) => {
  const product = await seedStorefrontProduct();
  const anonymous = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await anonymous.newPage();
  for (const path of [PREVIEW, `${PREVIEW}/en`, `${PREVIEW}/bn/products`, `${PREVIEW}/en/products/${product.slug}`, `${PREVIEW}/en/cart`, `${PREVIEW}/en/checkout`]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/office\/login$/);
    await expect(page.locator("body")).not.toContainText(product.nameEn);
  }
  const html = await anonymous.request.get(`${baseURL}${PREVIEW}/en/products/${product.slug}`, { maxRedirects: 0 });
  expect([303, 307, 308]).toContain(html.status());
  expect(await html.text()).not.toContain(product.nameEn);
  await anonymous.close();
});

test("the Owner browses in English and Bangla: banner, private headers, search, filters, sizes in cm", async ({ page }) => {
  const product = await seedStorefrontProduct({ featured: true });
  await signIn(page);
  const response = await page.goto(`${PREVIEW}/en`);
  const headers = response?.headers() ?? {};
  expect(headers["x-robots-tag"]).toContain("noindex");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["cache-control"]).toContain("no-store");
  await expect(page.getByTestId("preview-banner")).toHaveText("Storefront Preview — Not Live");
  await expect(page.getByRole("list", { name: "Featured" })).toContainText(product.nameEn);
  await expectNoAxeViolations(page);

  await page.getByTestId("language-switch").click();
  await expect(page).toHaveURL(new RegExp(`${PREVIEW}/bn$`));
  await expect(page.locator(".sf")).toHaveAttribute("lang", "bn");
  await expect(page.getByTestId("preview-banner")).toHaveText("স্টোরফ্রন্ট প্রিভিউ — লাইভ নয়");
  await expect(page.locator("main")).toContainText(product.nameBn);
  await expect(page.locator("main")).toContainText("৳ ৮৫০ থেকে");
  await expectNoAxeViolations(page);

  await page.goto(`${PREVIEW}/en/products?q=${encodeURIComponent(product.nameEn)}&size=3-6M`);
  await expect(page.getByTestId("result-count")).toHaveText("1 product");
  await page.goto(`${PREVIEW}/en/products?q=${encodeURIComponent(product.nameEn)}&size=12-18M`);
  await expect(page.getByTestId("result-count")).toContainText("No products match");
  // The language switch keeps the search and filters.
  await page.getByTestId("language-switch").click();
  await expect(page).toHaveURL(/\/bn\/products\?q=.*size=12-18M/);

  await page.goto(`${PREVIEW}/en/products/${product.slug}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(product.nameEn);
  await expect(page.getByText("Chest 24.5 cm, Length 38 cm")).toBeVisible();
  await expect(page.getByRole("img", { name: "Fictional romper, front" })).toBeVisible();
  await expect.poll(() => page.getByRole("img", { name: "Fictional romper, front" }).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByRole("region", { name: "Size guide (cm)" }).getByRole("row", { name: /3-6M/ })).toContainText("26");
  await expect(page.getByRole("region", { name: "Delivery" })).toContainText("Dhaka City: ৳ 60");
  await expectNoAxeViolations(page);
  await page.goto(`${PREVIEW}/bn/products/${product.slug}`);
  await expect(page.getByText("বুক ২৪.৫ সেমি, দৈর্ঘ্য ৩৮ সেমি")).toBeVisible();
  await expect(page.getByRole("img", { name: "কাল্পনিক রম্পার, সামনে" })).toBeVisible();
  await expectNoAxeViolations(page);
});

test("cart: choose size and colour, add, change quantities, totals in paisa, invalid input, stale stock, no reservation", async ({ page }) => {
  const product = await seedStorefrontProduct();
  const [skuA, skuB] = product.skus;
  await signIn(page);
  const before = await counts();
  await page.goto(`${PREVIEW}/en/products/${product.slug}`);

  // Keyboard: the size and colour choices are radio buttons.
  await page.getByRole("radio", { name: /^0-3M/ }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("radio", { name: /^0-3M/ })).toBeChecked();
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.getByTestId("add-message")).toHaveText("Choose a size and colour first.");
  await chip(page, "Ivory").click();
  await expect(page.getByTestId("availability")).toHaveText("In stock: 5 available");
  await page.getByLabel("Quantity").fill("2.5");
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.getByTestId("add-message")).toHaveText("Enter a whole number from 1 to 5.");
  await page.getByLabel("Quantity").fill("6");
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.getByTestId("add-message")).toContainText("Only 5 available");
  await page.getByLabel("Quantity").fill("2");
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.getByTestId("add-message")).toHaveText(`2 × ${product.nameEn} added to your cart.`);
  await expect(page.getByTestId("cart-count")).toHaveText("2");

  // The sold-out colour is marked and cannot be added.
  await chip(page, "3-6M").click();
  await chip(page, "Sand").click();
  await expect(page.getByTestId("availability")).toHaveText("Sold out");
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.getByTestId("add-message")).toHaveText("This option is sold out.");
  await chip(page, "Ivory").click();
  await page.getByLabel("Quantity").fill("1");
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.getByTestId("cart-count")).toHaveText("3");
  // Adding to the cart holds nothing.
  expect(await counts()).toEqual(before);

  await page.getByRole("link", { name: /^Cart/ }).click();
  await expect(page.getByTestId("subtotal")).toHaveText("৳ 2,620.50");
  await page.getByLabel(/^Dhaka City/).check();
  await expect(page.getByTestId("total")).toHaveText("৳ 2,680.50");
  const lineA = page.getByTestId(`cart-line-${skuA}`);
  await lineA.getByRole("button", { name: /^One more/ }).click();
  await expect(page.getByTestId("subtotal")).toHaveText("৳ 3,470.50");
  await lineA.getByRole("textbox").fill("abc");
  await lineA.getByRole("textbox").press("Enter");
  await expect(lineA).toContainText("Enter a whole number from 1 to");
  await expect(page.getByTestId("subtotal")).toHaveText("৳ 3,470.50");
  await lineA.getByRole("textbox").fill("2");
  await lineA.getByRole("textbox").press("Enter");
  await expect(page.getByTestId("subtotal")).toHaveText("৳ 2,620.50");
  await expectNoAxeViolations(page);

  // Stock fell after the cart was filled: the cart says so and checkout is blocked until it is fixed.
  await setStock(skuA, 1);
  await page.reload();
  await expect(page.getByTestId(`cart-line-${skuA}`).getByTestId("line-problem")).toHaveText("Only 1 available now. Lower the quantity to continue.");
  await expect(page.getByTestId("checkout-blocked")).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to checkout" })).toHaveCount(0);
  await page.getByTestId(`cart-line-${skuA}`).getByRole("button", { name: /^One fewer/ }).click();
  await expect(page.getByTestId("checkout-blocked")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Go to checkout" })).toBeVisible();
  await page.getByTestId(`cart-line-${skuB}`).getByRole("button", { name: /^Remove/ }).click();
  await expect(page.getByTestId(`cart-line-${skuB}`)).toHaveCount(0);
  await expect(page.getByTestId("cart-count")).toHaveText("1");
  expect(await counts()).toEqual(before);
});

test("checkout simulation: validation in both languages, the COD total, and no order, hold or record created", async ({ page }) => {
  const product = await seedStorefrontProduct();
  await signIn(page);
  await page.goto(`${PREVIEW}/en/products/${product.slug}`);
  await chip(page, "0-3M").click();
  await chip(page, "Ivory").click();
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.getByTestId("cart-count")).toHaveText("1");
  const before = await counts();

  await page.goto(`${PREVIEW}/bn/checkout`);
  await expect(page.getByTestId("simulation-note")).toContainText("শুধু সিমুলেশন");
  await page.getByRole("button", { name: "অর্ডার যাচাই করুন (সিমুলেশন)" }).click();
  const errors = page.getByTestId("checkout-errors");
  await expect(errors).toContainText("আপনার পুরো নাম লিখুন।");
  await expect(errors).toContainText("বাংলাদেশি মোবাইল নম্বর লিখুন");
  await expect(page.getByLabel("পুরো নাম")).toHaveAttribute("aria-invalid", "true");
  await expectNoAxeViolations(page);

  await page.goto(`${PREVIEW}/en/checkout`);
  await page.getByLabel("Full name").fill("Test Customer");
  await page.getByLabel("Mobile number").fill("12345");
  await page.getByLabel("Delivery address").fill("House 51, Test Road, Test Area");
  await page.getByRole("button", { name: "Check order (simulation)" }).click();
  await expect(page.getByTestId("checkout-errors")).toContainText("Enter a Bangladesh mobile number");
  await expect(page.getByTestId("checkout-errors")).toContainText("Choose a delivery area.");
  // What was typed is kept after a refusal.
  await expect(page.getByLabel("Full name")).toHaveValue("Test Customer");
  await page.getByLabel("Mobile number").fill("+880 1711-000051");
  await page.getByLabel(/^Outside Dhaka/).check();
  await expect(page.getByTestId("total")).toHaveText("৳ 970");
  await page.getByRole("button", { name: "Check order (simulation)" }).click();
  const result = page.getByTestId("simulation-result");
  await expect(result).toContainText("This was a simulation. No order was recorded and no stock was held.");
  await expect(result).toContainText("01711000051");
  await expect(page.getByTestId("simulated-total")).toHaveText("৳ 970");
  await expectNoAxeViolations(page);
  expect(await counts()).toEqual(before);
});

test("keyboard and motion: a skip link first, a visible focus ring on every control, no transitions when reduced motion is asked", async ({ page }) => {
  await seedStorefrontProduct();
  await signIn(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${PREVIEW}/en`);
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press("Tab");
    const style = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const s = getComputedStyle(el);
      return { outline: s.outlineStyle, width: s.outlineWidth, transition: s.transitionDuration, tag: el.tagName };
    });
    expect(style.outline, style.tag).not.toBe("none");
    expect(style.width).toBe("2px");
    expect(style.transition.split(",").every((d) => d.trim() === "0s")).toBe(true);
  }
});
