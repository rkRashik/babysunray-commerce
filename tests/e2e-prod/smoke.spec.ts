import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import readXlsxFile from "read-excel-file/node";
import { clearSignInLimits, ensureZones, seedSku, signIn } from "../e2e/support";

// The production build over HTTPS: Secure session cookies, Server Actions and route handlers passing their
// same-origin checks, private response headers, and sign-out. Fictional data in babysunray_test only.

test.beforeAll(ensureZones);
test.beforeEach(clearSignInLimits);

test("sign-in sets a Secure, HttpOnly session cookie; Admin pages are private", async ({ page, context }) => {
  await signIn(page);
  const cookies = await context.cookies();
  const session = cookies.filter((c) => /session_token/.test(c.name));
  expect(session.length).toBeGreaterThan(0);
  for (const c of session) {
    expect(c.secure).toBe(true);
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe("Lax");
  }
  const response = await page.goto("/admin/dashboard");
  const headers = response?.headers() ?? {};
  expect(headers["cache-control"]).toContain("no-store");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-robots-tag"]).toContain("noindex");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
});

test("an order, a stock count and an export work end to end in the production build", async ({ page }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await signIn(page);
  const sku = await seedSku(3);
  await page.goto("/admin/orders/new");
  await page.getByLabel("WhatsApp").check();
  await page.getByLabel("Customer name").fill("Test Customer");
  await page.getByLabel("Phone").fill("01711000009");
  await page.getByLabel("Delivery address").fill("House 9, Test Road");
  await page.getByLabel(/^Dhaka City/).check();
  await page.getByLabel("SKU, line 1").fill(sku);
  await page.getByLabel("Quantity, line 1").fill("1");
  await page.getByRole("button", { name: "Create order" }).click();
  await expect(page.locator('[data-dimension="order"]')).toHaveText("Pending verification");

  await page.goto("/admin/stock-counts");
  await page.getByLabel("Only the SKUs listed below").check();
  await page.getByLabel("SKUs to count").fill(sku);
  await page.getByRole("button", { name: "Start count" }).click();
  await page.getByLabel(`Counted units of ${sku}`).fill("4");
  await page.getByRole("button", { name: "Save counts" }).click();
  await expect(page.getByTestId(`line-state-${sku}`)).toContainText("difference +1");
  await page.getByLabel("Reason").fill("Production smoke count");
  await page.getByRole("button", { name: "Apply corrections" }).click();
  await expect(page.getByTestId("count-status")).toContainText("applied");

  await page.goto("/admin/exports");
  await page.getByRole("combobox", { name: /^Dataset/ }).selectOption("stock");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download" }).click()]);
  const sheets = await readXlsxFile(readFileSync((await download.path()) as string));
  const [header, ...rows] = sheets[0].data;
  const row = rows.find((r) => r[header.indexOf("sku")] === sku) as unknown[];
  expect(row[header.indexOf("on_hand")]).toBe(4);
  expect(row[header.indexOf("reserved")]).toBe(1);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  await page.goto("/admin/exports");
  await expect(page).toHaveURL(/\/admin\/login$/);
});

test("the tracking page and the storefront preview send their private headers in the production build", async ({ page, request, baseURL }) => {
  const track = await request.get(`${baseURL}/track`);
  const csp = track.headers()["content-security-policy"] ?? "";
  for (const directive of ["default-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'"]) expect(csp).toContain(directive);
  expect(csp).not.toContain("unsafe-eval");
  expect(track.headers()["referrer-policy"]).toBe("no-referrer");
  expect(track.headers()["cache-control"]).toContain("no-store");

  await signIn(page);
  const preview = await page.goto("/admin/storefront-preview/en");
  const headers = preview?.headers() ?? {};
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-robots-tag"]).toContain("noindex");
  expect(headers["cache-control"]).toContain("no-store");
  await expect(page.getByTestId("preview-banner")).toHaveText("Storefront Preview — Not Live");
});
