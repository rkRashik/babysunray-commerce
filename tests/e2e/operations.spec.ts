import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import readXlsxFile from "read-excel-file/node";
import { clearSignInLimits, ensureZones, expectLabelledFields, seedSku, signIn, testDatabase } from "./support";

// Dashboard, reports, exports, printing and physical stock counts in a real browser, against the real server,
// Better Auth and PostgreSQL (babysunray_test). Fictional data only.

test.beforeAll(ensureZones);

test.beforeEach(async ({ page }) => {
  await clearSignInLimits();
  page.on("dialog", (dialog) => void dialog.accept());
  await signIn(page);
});

const nav = (page: Page) => page.getByRole("navigation", { name: "Admin" });

async function createOrder(page: Page, sku: string, quantity = 1) {
  await page.goto("/admin/orders/new");
  await page.getByLabel("WhatsApp").check();
  await page.getByLabel("Customer name").fill("Test Customer");
  await page.getByLabel("Phone").fill("01711000008");
  await page.getByLabel("Delivery address").fill("House 8, Test Road, Dhaka");
  await page.getByLabel(/^Dhaka City/).check();
  await page.getByLabel("SKU, line 1").fill(sku);
  await page.getByLabel("Quantity, line 1").fill(String(quantity));
  await page.getByRole("button", { name: "Create order" }).click();
  await expect(page.getByRole("status").first()).toContainText("Order created");
  return page.url().split("?")[0];
}

async function step(page: Page, button: string) {
  const before = (await page.getByTestId("order-version").textContent()) ?? "";
  await page.getByRole("region", { name: "Actions" }).getByRole("button", { name: button }).click();
  await expect(page.getByTestId("order-version")).not.toHaveText(before);
}

async function expectNoAxeViolations(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test("the dashboard shows real queues and links to the matching order list; reports reconcile", async ({ page }) => {
  const sku = await seedSku(2);
  const empty = await seedSku(0);
  const orderUrl = await createOrder(page, sku);
  await step(page, "Confirm order (verified with the customer)");

  const response = await page.goto("/admin/dashboard");
  const headers = response?.headers() ?? {};
  expect(headers["cache-control"]).toContain("no-store");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-robots-tag"]).toContain("noindex");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expect(page.getByTestId("generated-at")).toContainText("(Dhaka)");
  expect(Number(await page.getByTestId("count-to_pack").textContent())).toBeGreaterThanOrEqual(1);
  expect(Number(await page.getByTestId("zero-available").textContent())).toBeGreaterThanOrEqual(1);
  await expect(page.getByRole("region", { name: "Stock availability" })).toContainText(empty);
  await expectLabelledFields(page);
  await expectNoAxeViolations(page);

  await page.locator('[data-queue="to_pack"]').getByRole("link", { name: /^Show all/ }).click();
  await expect(page.getByRole("status").first()).toContainText("Confirmed, to pack");
  await expect(page.getByRole("table", { name: "Orders" }).getByRole("link").first()).toBeVisible();
  const ids = await page.getByRole("table", { name: "Orders" }).getByRole("link").evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).href));
  expect(ids).toContain(orderUrl);

  // An Owner-chosen low-stock view, and a rejected value.
  await page.goto("/admin/dashboard?low=abc");
  await expect(page.locator("main").getByRole("alert")).toContainText("whole number");

  await nav(page).getByRole("link", { name: "Reports" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
  await expect(page.getByTestId("report-scope")).toContainText("up to, not including");
  // The orders section draws its status bar from the real counts and lists every part in words.
  await expect(page.getByRole("img", { name: /^Orders by status now:/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Inventory & costs" })).toBeVisible();
  await page.getByRole("navigation", { name: "Report sections" }).getByRole("link", { name: "COD & reconciliation" }).click();
  await expect(page.getByTestId("reconciled").first()).toContainText("Check passed");
  await expectNoAxeViolations(page);
  await page.goto("/admin/reports?from=2026-11-20&to=2026-11-01");
  await expect(page.locator("main").getByRole("alert")).toContainText("start not after the end");
});

test("printable documents: routine ones omit contact details; the order's shipping document has them", async ({ page }) => {
  const sku = await seedSku(3);
  const orderUrl = await createOrder(page, sku, 2);
  await step(page, "Confirm order (verified with the customer)");

  await page.goto("/admin/print/picking");
  await expect(page.getByRole("heading", { level: 1, name: "Picking list and packing summary" })).toBeVisible();
  await expect(page.getByTestId("pick-table")).toContainText(sku);
  await expect(page.locator("main")).not.toContainText("01711000008");
  await expect(page.locator("main")).not.toContainText("Test Road");
  await page.emulateMedia({ media: "print" });
  await expect(page.getByRole("button", { name: "Print" })).toBeHidden();
  // A4 at print size: nothing wider than the page.
  expect(await page.evaluate(() => document.querySelector("main")!.scrollWidth <= document.querySelector("main")!.clientWidth + 1)).toBe(true);
  await page.emulateMedia({ media: "screen" });

  const orderId = orderUrl.split("/").at(-1);
  await page.goto(`/admin/print/orders/${orderId}`);
  await expect(page.getByTestId("ship-phone")).toHaveText("01711000008");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

  await page.goto("/admin/print/cod");
  await expect(page.getByRole("heading", { level: 1, name: "COD reconciliation summary" })).toBeVisible();
  await expect(page.locator("main")).not.toContainText("01711000008");
});

test("exports: XLSX and CSV downloads with text phone numbers, Bangla and an audit entry", async ({ page }) => {
  const sku = await seedSku(2);
  await createOrder(page, sku);
  await nav(page).getByRole("link", { name: "Exports" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Exports" })).toBeVisible();
  await expectLabelledFields(page);
  await expectNoAxeViolations(page);

  await page.getByRole("combobox", { name: /^Dataset/ }).selectOption("orders");
  await page.getByLabel("Excel (.xlsx)").check();
  const [xlsx] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download" }).click()]);
  expect(xlsx.suggestedFilename()).toMatch(/^orders-complete-\d{8}-\d{6}Z\.xlsx$/);
  const sheets = await readXlsxFile(readFileSync((await xlsx.path()) as string));
  const [header, ...rows] = sheets[0].data;
  const phones = rows.map((r) => r[header.indexOf("customer_phone")]);
  expect(phones).toContain("01711000008");

  await page.getByRole("combobox", { name: /^Dataset/ }).selectOption("order_items");
  await page.getByLabel("CSV (UTF-8)").check();
  await page.getByLabel("Order source").selectOption("whatsapp");
  const [csv] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download" }).click()]);
  expect(csv.suggestedFilename()).toMatch(/^order_items-filtered-/);
  const bytes = readFileSync((await csv.path()) as string);
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(bytes.toString("utf8")).toContain(sku);

  // A filter that does not apply to the dataset is refused with a message, not ignored.
  await page.getByRole("combobox", { name: /^Dataset/ }).selectOption("stock");
  await page.getByLabel("Order source").selectOption("whatsapp");
  await page.getByRole("button", { name: "Download" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("could not be made");

  await page.reload();
  await expect(page.getByTestId("export-audit")).toContainText("order_items");
  await expect(page.getByTestId("export-audit")).toContainText("filtered");
});

test("exports refuse other origins and anyone signed out", async ({ page, playwright, baseURL }) => {
  const crossSite = await page.request.post("/admin/exports/download", { form: { dataset: "orders", format: "csv" }, headers: { origin: "https://evil.example" }, maxRedirects: 0 });
  expect(crossSite.status()).toBe(403);
  const anonymous = await playwright.request.newContext({ baseURL });
  try {
    const response = await anonymous.post("/admin/exports/download", { form: { dataset: "orders", format: "csv" }, headers: { origin: baseURL as string }, maxRedirects: 0 });
    expect(response.status()).toBe(303);
    expect(response.headers().location).toBe("/admin/login");
    for (const path of ["/admin/dashboard", "/admin/reports", "/admin/exports", "/admin/stock-counts", "/admin/print/picking", "/admin/print/cod"]) {
      const page2 = await anonymous.get(path, { maxRedirects: 0 });
      expect([303, 307]).toContain(page2.status());
    }
  } finally {
    await anonymous.dispose();
  }
  // After signing out, the same browser can no longer export.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  const after = await page.request.post("/admin/exports/download", { form: { dataset: "orders", format: "csv" }, headers: { origin: baseURL as string }, maxRedirects: 0 });
  expect(after.status()).toBe(303);
});

async function startCount(page: Page, sku: string) {
  await nav(page).getByRole("link", { name: "Stock counts" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Stock counts" })).toBeVisible();
  await page.getByLabel("Only the SKUs listed below").check();
  await page.getByLabel("SKUs to count").fill(sku.toLowerCase());
  await page.getByRole("button", { name: "Start count" }).click();
  await expect(page.getByRole("status").first()).toContainText("Stock count started");
  return page.url().split("?")[0];
}

async function stockOf(page: Page, sku: string) {
  await page.goto(`/admin/skus/${sku}`);
  return { onHand: await page.getByTestId("on-hand").textContent(), reservation: await page.getByTestId("reservation").textContent() };
}

test("a stock count: enter, resume, review, refuse without a reason, apply once", async ({ page }) => {
  const sku = await seedSku(5);
  const countUrl = await startCount(page, sku);
  await expectLabelledFields(page);
  await expectNoAxeViolations(page);
  await page.getByLabel(`Counted units of ${sku}`).fill("7");
  await page.getByRole("button", { name: "Save counts" }).click();
  await expect(page.getByRole("status").first()).toContainText("Counted quantities saved");

  // Interrupted: leave and come back later.
  await page.goto("/admin/stock-counts");
  await page.getByRole("status").getByRole("link", { name: /^resume/ }).first().click();
  await expect(page.getByLabel(`Counted units of ${sku}`)).toHaveValue("7");
  await expect(page.getByTestId("review-summary")).toContainText("1 with a difference");
  await expect(page.getByRole("list", { name: "Proposed corrections" })).toContainText("+2");

  await page.getByRole("button", { name: "Apply corrections" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Reason is required");
  await page.getByLabel("Reason").fill("E2E shelf count");
  await page.getByRole("button", { name: "Apply corrections" }).click();
  await expect(page.getByRole("status").first()).toContainText("Stock count applied");
  await expect(page.getByTestId("count-status")).toContainText("applied");
  expect((await stockOf(page, sku)).onHand).toBe("7");

  const db = await testDatabase();
  try {
    const { rows } = await db.query("select count(*)::int as n from stock_movements m join variants v on v.id = m.variant_id where v.sku = $1 and m.movement_type = 'adjustment'", [sku]);
    expect(rows[0].n).toBe(1);
  } finally {
    await db.end();
  }
  await page.goto(`${countUrl.replace("/admin/stock-counts/", "/admin/print/stock-counts/")}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Stock reconciliation summary");
  await expect(page.getByTestId("count-sheet")).toContainText("+2");
});

test("a stale count after a dispatch is refused until recounted", async ({ page }) => {
  const sku = await seedSku(4);
  const orderUrl = await createOrder(page, sku, 1);
  await step(page, "Confirm order (verified with the customer)");
  await step(page, "Mark packed");
  const countUrl = await startCount(page, sku);
  await page.getByLabel(`Counted units of ${sku}`).fill("4");
  await page.getByRole("button", { name: "Save counts" }).click();
  await expect(page.getByRole("status").first()).toContainText("Counted quantities saved");

  await page.goto(orderUrl);
  await step(page, "Dispatch");

  await page.goto(countUrl);
  await expect(page.getByTestId(`line-state-${sku}`)).toContainText("Stock moved after you counted");
  await page.getByLabel("Reason").fill("E2E recount");
  await page.getByRole("button", { name: "Apply corrections" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("changed after it was counted");
  expect((await stockOf(page, sku)).onHand).toBe("3");

  await page.goto(countUrl);
  await page.getByLabel(`Counted units of ${sku}`).fill("2");
  await page.getByLabel("I recounted it now").check();
  await page.getByRole("button", { name: "Save counts" }).click();
  await expect(page.getByTestId(`line-state-${sku}`)).toContainText("difference -1");
  await page.getByLabel("Reason").fill("E2E recount");
  await page.getByRole("button", { name: "Apply corrections" }).click();
  await expect(page.getByRole("status").first()).toContainText("Stock count applied");
  expect(await stockOf(page, sku)).toEqual({ onHand: "2", reservation: "Reserved for orders: 0 · Available for new orders: 2" });
});

test("a stale browser tab cannot overwrite a newer count", async ({ page, context }) => {
  const sku = await seedSku(3);
  const countUrl = await startCount(page, sku);
  const other = await context.newPage();
  await other.goto(countUrl);
  await page.getByLabel(`Counted units of ${sku}`).fill("1");
  await page.getByRole("button", { name: "Save counts" }).click();
  await expect(page.getByRole("status").first()).toContainText("Counted quantities saved");
  await other.getByLabel(`Counted units of ${sku}`).fill("9");
  await other.getByRole("button", { name: "Save counts" }).click();
  await expect(other.locator("main").getByRole("alert")).toContainText("changed after you loaded it");
  await other.close();
});
