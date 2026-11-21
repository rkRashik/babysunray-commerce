import { expect, type Page, test } from "@playwright/test";
import { clearSignInLimits, ensureZones, expectNoAxeViolations, openPanel, productOf, seedSku, signIn, smallTargets } from "./support";

// The product, order, stock and report workspaces in a real browser: the product overview and its next step, the
// numbered publishing steps, action panels opened from the keyboard, the order's next step apart from cancelling,
// customer details beside the work on a desktop and right after the next step on a phone, the copy button, the money
// and stock figures with their meanings, the report's two groups of figures, axe, and 44-pixel controls on a phone.
// Fictional data only, in babysunray_test.

test.beforeAll(ensureZones);
test.beforeEach(async ({ page }) => {
  await clearSignInLimits();
  await signIn(page);
});

/** A new assisted order for one unit of the SKU, through the form; returns the order page path. */
async function newOrder(page: Page, sku: string): Promise<string> {
  await page.goto("/admin/orders/new");
  await page.getByLabel("Messenger").check();
  await page.getByLabel("Customer name").fill("Fictional Workspace Customer");
  await page.getByLabel("Phone").fill("01711000077");
  await page.getByLabel("Delivery address").fill("House 77, Fictional Lane");
  await page.getByLabel(/^Dhaka City/).check();
  await page.getByLabel("SKU, line 1").fill(sku);
  await page.getByLabel("Quantity, line 1").fill("1");
  await page.getByRole("button", { name: "Create order" }).click();
  await expect(page.getByRole("status").first()).toContainText("Order created");
  return new URL(page.url()).pathname;
}

test("a product opens on an overview with its stock and next step; publishing is three numbered steps", async ({ page }) => {
  const sku = await seedSku(4);
  const { id } = await productOf(sku);
  await page.goto(`/admin/products/${id}`);

  await expect(page.getByTestId("product-status")).toContainText("Draft");
  await expect(page.getByTestId("product-status")).toContainText("Not shown to customers");
  await expect(page.getByTestId("product-glance")).toContainText("1 active");
  await expect(page.getByTestId("product-glance")).toContainText("On hand: 4");
  await expect(page.getByTestId("product-glance")).toContainText("Available for orders: 4");
  // The next step comes from the publication blockers: something to finish, or publishing switched off.
  await expect(page.getByTestId("next-step")).toContainText(/to finish before you can publish|Publishing is off/);

  // The jump links reach each part of the page.
  await page.getByRole("navigation", { name: "On this page" }).getByRole("link", { name: "Publishing" }).click();
  await expect(page).toHaveURL(/#section-publishing$/);
  await expect(page.getByRole("heading", { name: "Publishing", level: 2 })).toBeInViewport();

  // Publishing: three steps in order; nothing is reviewed yet, so step 2 is not done and step 3 lists what is missing.
  const publishing = page.getByRole("region", { name: "Publishing" });
  await expect(publishing.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 3 }) })).toHaveCount(3);
  await expect(publishing.locator('[data-step="2"]')).toHaveAttribute("data-done", "false");
  await expect(publishing.getByRole("heading", { name: /Mark the content as reviewed \(not done\)/ })).toBeVisible();
  await expect(page.getByTestId("publication-blockers")).toBeVisible();

  // The variant form waits behind its panel (the product has a variant); the keyboard opens it.
  const variants = page.getByRole("region", { name: "Variants and stock" });
  await expect(variants.getByRole("row", { name: new RegExp(sku) })).toContainText("4");
  await expect(page.getByLabel("SKU")).toBeHidden();
  await page.locator("summary").filter({ hasText: "Add a variant" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Add a variant" }).getByLabel("SKU")).toBeVisible();
  await expect(page.getByRole("button", { name: "Archive product" })).toBeHidden();
  await expectNoAxeViolations(page);
});

test("an order shows its next step apart from cancelling, the customer beside it, money with meanings and a timeline", async ({ page, context }) => {
  const sku = await seedSku(3);
  const orderPath = await newOrder(page, sku);

  const next = page.getByRole("region", { name: "Next step" });
  await expect(next.getByRole("button", { name: "Confirm order (verified with the customer)" })).toBeVisible();
  // Cancelling is a separate, quieter choice under its own heading.
  await expect(next.getByText("If the order cannot go ahead")).toBeVisible();
  const confirmBox = await next.getByRole("button", { name: "Confirm order (verified with the customer)" }).boundingBox();
  const cancelBox = await next.getByRole("button", { name: "Cancel order" }).boundingBox();
  expect(cancelBox!.y).toBeGreaterThan(confirmBox!.y);

  // On a desktop the customer card sits beside the work, not under it.
  await page.setViewportSize({ width: 1440, height: 900 });
  const status = await page.getByRole("region", { name: "Status" }).boundingBox();
  const customer = page.getByRole("region", { name: "Customer and delivery" });
  const side = await customer.boundingBox();
  expect(side!.x).toBeGreaterThan(status!.x + status!.width);

  // The copy button puts exactly the phone number on the clipboard and says so.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await customer.getByRole("button", { name: "Copy phone number" }).click();
  await expect(customer.getByRole("status").first()).toHaveText("phone number copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("01711000077");

  // Money: expected is labelled as not money received; nothing is collected yet.
  const cod = page.getByTestId("cod");
  await expect(cod).toContainText("Not money received");
  await expect(cod.locator(".of-stat").filter({ hasText: "Collected by courier" })).toContainText("৳ 0");

  // History: a timeline, oldest first, the latest step last.
  const history = page.getByRole("list", { name: "Order history" });
  await expect(history.getByRole("listitem").last()).toContainText("Owner");
  await expectNoAxeViolations(page);

  // On a phone the next step comes before the customer card.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(orderPath);
  const nextTop = (await page.getByRole("region", { name: "Next step" }).boundingBox())!.y;
  const customerTop = (await page.getByRole("region", { name: "Customer and delivery" }).boundingBox())!.y;
  expect(customerTop).toBeGreaterThan(nextTop);
});

test("stock and report figures say what they mean; the money words are explained", async ({ page }) => {
  const sku = await seedSku(5);
  await page.goto(`/admin/skus/${sku}`);
  await expect(page.getByTestId("on-hand")).toHaveText("5");
  await expect(page.getByTestId("reserved")).toHaveText("0");
  await expect(page.getByTestId("available")).toHaveText("5");
  await expect(page.getByRole("region", { name: "Current stock" })).toContainText("On hand minus reserved.");
  await expectNoAxeViolations(page);

  await page.goto("/admin/reports");
  const kpis = page.getByTestId("report-kpis");
  await expect(kpis).toContainText("Orders placed (activity, not money)");
  await expect(kpis).toContainText("Money recorded (by the date you entered)");
  await expect(kpis).toContainText("Not sales or money received.");
  await expect(page.getByTestId("report-glossary")).toBeHidden();
  await page.getByText("What these words mean").click();
  await expect(page.getByTestId("report-glossary")).toContainText("Expected is not money.");
  await expectNoAxeViolations(page);
});

test("the product, order, stock, report and edit pages fit a phone with 44-pixel controls", async ({ page }) => {
  const sku = await seedSku(2);
  const { id } = await productOf(sku);
  const orderPath = await newOrder(page, sku);
  await page.setViewportSize({ width: 390, height: 844 });
  const check = async (state: string) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${state}: sideways scroll`).toBeLessThanOrEqual(0);
    expect(await smallTargets(page), state).toEqual([]);
  };
  for (const path of [`/admin/products/${id}`, orderPath, `/admin/skus/${sku}`, "/admin/reports", `/admin/products/${id}/edit`]) {
    await page.goto(path);
    await check(path);
  }
  await page.goto(`/admin/products/${id}`);
  await openPanel(page, "Add a variant");
  await openPanel(page, "Archive this product");
  await check("product, panels open");

  // A dispatched order has the longest step names (Mark returned to sender …).
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto(orderPath);
  for (const button of ["Confirm order (verified with the customer)", "Mark packed", "Dispatch"]) {
    const before = await page.getByTestId("order-version").textContent();
    await page.getByRole("region", { name: "Next step" }).getByRole("button", { name: button }).click();
    await expect(page.getByTestId("order-version")).not.toHaveText(before!);
  }
  await expect(page.getByRole("button", { name: "Mark returned to sender (refused or undelivered)" })).toBeVisible();
  await check("order, dispatched");
});

test("payment and return forms open from their panels, and a saved payment closes its panel again", async ({ page }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  const sku = await seedSku(2);
  await newOrder(page, sku);
  const step = async (button: string) => {
    const before = await page.getByTestId("order-version").textContent();
    await page.getByRole("region", { name: "Next step" }).getByRole("button", { name: button }).click();
    await expect(page.getByTestId("order-version")).not.toHaveText(before!);
  };
  for (const button of ["Confirm order (verified with the customer)", "Mark packed", "Dispatch", "Record delivery"]) await step(button);

  // Delivered with nothing collected: recording the collection is the next thing, so its panel is already open.
  const payment = page.locator("details.of-panel").filter({ hasText: "Record a payment" });
  await expect(payment).toHaveAttribute("open", "");
  const cod = page.getByRole("region", { name: "Cash on delivery" });
  await cod.getByLabel("Courier collected").check();
  await cod.getByLabel("Amount (BDT)").fill("100");
  const before = await page.getByTestId("order-version").textContent();
  await cod.getByRole("button", { name: "Record amount" }).click();
  await expect(page.getByTestId("order-version")).not.toHaveText(before!);
  await expect(payment).not.toHaveAttribute("open");

  // A return request is recorded through its own panel.
  await openPanel(page, "Record a return or exchange");
  const panel = page.getByRole("region", { name: "Record a return or exchange" });
  await panel.getByLabel("Return (refund)").check();
  await panel.getByLabel(/^Size or preference/).check();
  await panel.getByLabel(`Units of ${sku} coming back (of 1)`).fill("1");
  await panel.getByRole("button", { name: "Record request" }).click();
  await expect(page.getByTestId("return-status")).toHaveText("Requested");
});
