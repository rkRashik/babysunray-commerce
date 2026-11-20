import { expect, type Page, test } from "@playwright/test";
import { clearSignInLimits, ensureZones, seedStorefrontProduct, signIn, testDatabase } from "./support";

// The founder acceptance rehearsal (ADR-0011), end to end in real browsers against the real server and PostgreSQL (the
// test database is marked staging by global-setup): the shop does not exist without a pass; the Owner reviews and publishes;
// a separate shopper starts acceptance, leaves Admin and places a real Cash on Delivery order; the Owner verifies,
// confirms, packs, dispatches, records delivery and the cash; stock, history and tracking agree; a withdrawn product is gone.
// Fictional customer only.

const chip = (page: Page, text: string) => page.locator("label").filter({ has: page.getByText(text, { exact: true }) }).first();
const dimension = (page: Page, name: string) => page.locator(`[data-dimension="${name}"]`);

async function step(page: Page, button: string) {
  const before = await page.getByTestId("order-version").textContent();
  await page.getByRole("region", { name: "Actions" }).getByRole("button", { name: button }).click();
  await expect(page.getByTestId("order-version")).not.toHaveText(before ?? "");
}

test.beforeAll(ensureZones);

test("founder acceptance: publish, shop as a separate customer, place a real COD order, fulfil it in Admin and track it", async ({ page, browser, baseURL }) => {
  test.setTimeout(300_000);
  page.on("dialog", (dialog) => void dialog.accept());
  await clearSignInLimits();
  const product = await seedStorefrontProduct();
  const [sku] = product.skus;

  // Without a pass the shop does not exist, and the checkout refuses before reading anything.
  const outsiderContext = await browser.newContext();
  const outsider = await outsiderContext.newPage();
  for (const path of ["/en", `/en/products/${product.slug}`, "/bn/checkout", "/en/order"]) expect((await outsider.goto(path))?.status(), path).toBe(404);
  const closed = await outsider.request.post("/api/shop/checkout", { headers: { "content-type": "application/json", origin: baseURL!, "idempotency-key": crypto.randomUUID() }, data: "{}" });
  expect(closed.status()).toBe(503);
  // A forged pass changes nothing.
  await outsiderContext.addCookies([{ name: "bsr_acceptance", value: "v1.00000000-0000-4000-8000-000000000000.9999999999.AAAA.BBBB", url: baseURL! }]);
  expect((await outsider.goto("/en"))?.status()).toBe(404);

  // The Owner reviews and publishes: on this staging-marked database the proposed rule applies.
  await signIn(page);
  await page.goto(`/admin/products/${product.productId}`);
  await page.getByRole("button", { name: "Mark the current content as reviewed" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Review recorded" })).toBeVisible();
  await expect(page.getByTestId("publication-rule")).toContainText("trial set of requirements");
  await page.getByRole("button", { name: "Publish to the shop" }).click();
  await expect(page.getByTestId("publication-state")).toContainText("Published");
  // Publishing opens nothing to the public.
  expect((await outsider.goto(`/en/products/${product.slug}`))?.status()).toBe(404);

  // A separate shopper: starts acceptance in that browser, then leaves Admin there.
  const shopperContext = await browser.newContext();
  const shopper = await shopperContext.newPage();
  await clearSignInLimits();
  await signIn(shopper);
  await shopper.goto("/admin/acceptance");
  await expect(shopper.getByTestId("database-state")).toContainText("Marked as the staging database");
  await expect(shopper.getByTestId("gate-state")).toContainText("Closed");
  await shopper.getByRole("button", { name: "Start acceptance in this browser" }).click();
  await expect(shopper.getByTestId("pass-state")).toContainText("Holds an acceptance pass");
  await shopperContext.clearCookies({ name: /session_token/ });
  await shopper.goto("/admin");
  await expect(shopper).toHaveURL(/\/admin\/login$/);

  // Shopping as a guest, with the real prices and stock.
  await shopper.goto(`/en/products/${product.slug}`);
  await expect(shopper.getByTestId("acceptance-banner")).toBeVisible();
  await chip(shopper, "0-3M").click();
  await chip(shopper, "Ivory").click();
  await expect(shopper.getByTestId("availability")).toHaveText("In stock: 5 available");
  await shopper.getByLabel("Quantity").fill("2");
  await shopper.getByRole("button", { name: "Add to Bag", exact: true }).click();
  await expect(shopper.getByTestId("cart-count")).toHaveText("2");
  await shopper.goto("/en/checkout");
  await shopper.getByLabel("Full name").fill("Fictional Acceptance Customer");
  await shopper.getByLabel("Mobile number").fill("01711000123");
  await shopper.getByRole("button", { name: "Continue" }).click();
  await shopper.getByLabel("Delivery address").fill("House 12, Fictional Road, Dhaka");
  await chip(shopper, "Dhaka City").click();
  await shopper.getByRole("button", { name: "Continue" }).click();
  await expect(shopper.getByTestId("checkout-review")).toBeVisible();
  await expect(shopper.getByTestId("total")).toHaveText("৳ 1,760");
  const answered = shopper.waitForResponse((r) => r.url().endsWith("/api/shop/checkout"));
  await shopper.getByRole("button", { name: "Place order" }).click();
  expect((await answered).status()).toBe(201);
  await expect(shopper.getByTestId("order-placed")).toBeVisible();
  const reference = ((await shopper.getByTestId("order-reference").textContent()) ?? "").trim();
  expect(reference).toMatch(/^ORD-\d{6}$/);
  const trackingUrl = ((await shopper.getByTestId("tracking-url").textContent()) ?? "").trim();
  expect(trackingUrl).toMatch(/\/track#t=[A-Za-z0-9_-]+$/);
  await expect(shopper.getByTestId("placed-total")).toHaveText("৳ 1,760");
  // Customer details never travel in a URL.
  expect(shopper.url()).not.toMatch(/01711000123|Fictional/);

  // In the database: one website order, held stock, a tracking link; nothing linked to an account (a guest order).
  const db = await testDatabase();
  try {
    const { rows } = await db.query<{ id: string; source: string; status: string; total: number }>(
      "select id, source, order_status as status, total_paisa::int as total from orders where number = $1",
      [Number(reference.slice(4))],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "website", status: "pending_verification", total: 176_000 });
    expect((await db.query("select 1 from customer_orders where order_id = $1", [rows[0].id])).rowCount).toBe(0);
  } finally {
    await db.end();
  }

  // The Owner sees that exact order and runs the whole workflow.
  await page.goto(`/admin/skus/${sku}`);
  await expect(page.getByTestId("reservation")).toHaveText("Reserved for orders: 2 · Available for new orders: 3");
  await page.goto("/admin/orders");
  await page.getByRole("link", { name: reference, exact: true }).click();
  await expect(dimension(page, "order")).toHaveText("Pending verification");
  await step(page, "Confirm order (verified with the customer)");
  await expect(dimension(page, "order")).toHaveText("Confirmed");
  await step(page, "Mark packed");
  await step(page, "Dispatch");
  await page.reload();
  await expect(dimension(page, "fulfilment")).toHaveText("Dispatched");
  await expect(page.getByTestId("deliver-note")).toContainText("No courier system is connected");
  await step(page, "Record delivery");
  const cod = page.getByRole("region", { name: "Cash on delivery" });
  await cod.getByLabel("Courier collected").check();
  await cod.getByLabel("Amount (BDT)").fill("1760");
  await cod.getByRole("button", { name: "Record amount" }).click();
  await expect(dimension(page, "payment")).toHaveText("Collected, not fully settled");
  await cod.getByLabel("Settled to me").check();
  await cod.getByLabel("Amount (BDT)").fill("1760");
  await cod.getByRole("button", { name: "Record amount" }).click();
  await expect(dimension(page, "payment")).toHaveText("Settled");
  await expect(page.getByRole("list", { name: "Order history" })).toContainText("cod settled");

  // Stock moved out exactly once; the customer's tracking link shows the same order.
  await page.goto(`/admin/skus/${sku}`);
  await expect(page.getByTestId("on-hand")).toHaveText("3");
  await expect(page.getByTestId("reservation")).toHaveText("Reserved for orders: 0 · Available for new orders: 3");
  await shopper.goto(trackingUrl);
  await expect(shopper.getByTestId("guest-order-status")).toHaveText("Confirmed");
  await expect(shopper.getByText(reference)).toBeVisible();
  for (const path of ["/admin/dashboard", "/admin/reports"]) expect((await page.goto(path))?.status(), path).toBe(200);

  // Withdrawn, the product disappears from the shop at once.
  await page.goto(`/admin/products/${product.productId}`);
  await page.getByRole("button", { name: "Withdraw from the shop" }).click();
  await expect(page.getByTestId("publication-state")).toContainText("Draft");
  expect((await shopper.goto(`/en/products/${product.slug}`))?.status()).toBe(404);
  await expect(shopper.getByRole("heading", { level: 1 })).toContainText("Not found");
  await shopper.goto("/en/products");
  await expect(shopper.getByRole("link", { name: product.nameEn })).toHaveCount(0);

  // Ending the pass closes the shop to that browser again.
  await shopperContext.clearCookies({ name: "bsr_acceptance" });
  expect((await shopper.goto("/en"))?.status()).toBe(404);
  await outsiderContext.close();
  await shopperContext.close();
});
