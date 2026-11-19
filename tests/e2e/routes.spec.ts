import { expect, type Page, test } from "@playwright/test";
import { ensureZones, seedSku, seedStorefrontProduct, signIn, testDatabase } from "./support";

// Every route of the First Light implementation, on a desktop and on a phone, signed in: it answers, shows a level-1 heading,
// logs no console or page error, requests nothing that fails (no missing logo, font, photo or script), draws every image, and
// the logo and the fonts it needs really load. Fictional data only.

test.beforeAll(ensureZones);

type Problem = string;

function watch(page: Page): { problems: Problem[]; seen: Set<string> } {
  const problems: Problem[] = [];
  const seen = new Set<string>();
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text().slice(0, 200)}`));
  page.on("pageerror", (e) => problems.push(`page error: ${e.message.slice(0, 200)}`));
  page.on("requestfailed", (r) => !r.url().endsWith("/favicon.ico") && problems.push(`request failed: ${r.url().slice(0, 160)}`));
  page.on("response", (r) => {
    const url = new URL(r.url());
    seen.add(`${url.pathname} ${r.status()}`);
    if (r.status() >= 400 && url.pathname !== "/favicon.ico") problems.push(`HTTP ${r.status()}: ${url.pathname}`);
  });
  return { problems, seen };
}

test("every storefront, tracking and Owner Office route loads cleanly on a desktop and a phone, with its logo, fonts and images", async ({ page }) => {
  test.setTimeout(420_000);
  const sku = await seedSku(3);
  const shop = await seedStorefrontProduct({ featured: true });
  const db = await testDatabase();
  let variantId: string;
  let productId: string;
  try {
    productId = (await db.query<{ id: string }>("select product_id as id from variants where sku = $1", [sku])).rows[0].id;
    variantId = (await db.query<{ id: string }>("select id from variants where sku = $1", [sku])).rows[0].id;
  } finally {
    await db.end();
  }
  await signIn(page);

  // One order, made through the form, for the order routes.
  await page.goto("/office/orders/new");
  await page.getByLabel("Messenger").check();
  await page.getByLabel("Customer name").fill("Fictional Customer");
  await page.getByLabel("Phone").fill("01711000090");
  await page.getByLabel("Delivery address").fill("House 90, Fictional Road");
  await page.getByLabel(/^Dhaka City/).check();
  await page.getByLabel("SKU, line 1").fill(sku);
  await page.getByLabel("Quantity, line 1").fill("1");
  await page.getByRole("button", { name: "Create order" }).click();
  await expect(page.getByRole("status").first()).toContainText("Order created");
  const orderPath = new URL(page.url()).pathname;

  const shopBase = "/office/storefront-preview";
  const routes = [
    "/office", "/office/dashboard", "/office/orders", "/office/orders/new", orderPath, "/office/products/new", `/office/products/${productId}`,
    `/office/products/${productId}/edit`, `/office/products/${productId}/measurements`, `/office/products/${productId}/photos`, `/office/variants/${variantId}/edit`,
    `/office/skus/${sku}`, "/office/import", "/office/catalogue-preparation", "/office/product-reviews", "/office/categories", "/office/settings/delivery",
    "/office/reports", "/office/stock-counts", "/office/exports", "/office/media-health", "/office/policies", "/office/launch-readiness",
    "/office/print/picking", "/office/print/cod", shopBase,
    ...["en", "bn"].flatMap((l) => [`${shopBase}/${l}`, `${shopBase}/${l}/products`, `${shopBase}/${l}/products/${shop.slug}`, `${shopBase}/${l}/cart`, `${shopBase}/${l}/checkout`, `${shopBase}/${l}/order`]),
    "/",
  ];

  const logoStatuses: string[] = [];
  const fontFiles = new Set<string>();
  for (const [device, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(viewport);
    const { problems, seen } = watch(page);
    for (const route of routes) {
      const before = problems.length;
      const response = await page.goto(route);
      expect(response?.status(), `${device} ${route}`).toBe(200);
      if (route !== "/") await expect(page.locator("h1").first(), `${device} ${route}`).toBeVisible();
      await page.waitForLoadState("networkidle");
      // Every image on the page is drawn (a missing file or a broken photo has no natural width).
      const broken = await page.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.currentSrc || i.src));
      expect(broken, `${device} ${route}: images that did not load`).toEqual([]);
      expect(problems.slice(before), `${device} ${route}`).toEqual([]);
    }
    logoStatuses.push(...[...seen].filter((s) => s.startsWith("/brand/")));
    for (const s of seen) if (/\.woff2 200$/.test(s)) fontFiles.add(s.split(" ")[0]);
    expect(problems).toEqual([]);
  }
  // The approved logo and the self-hosted fonts were served from this origin.
  expect(logoStatuses).toContain("/brand/logo.png 200");
  expect(logoStatuses).toContain("/brand/mark.png 200");
  expect(fontFiles.size).toBeGreaterThanOrEqual(1);

  // The guest tracking page and the sign-in page, signed out.
  await page.context().clearCookies();
  for (const route of ["/track", "/office/login"]) {
    const { problems } = watch(page);
    const response = await page.goto(route);
    expect(response?.status(), route).toBe(200);
    await page.waitForLoadState("networkidle");
    expect(problems, route).toEqual([]);
  }
});
