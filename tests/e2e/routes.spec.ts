import { expect, type Page, test } from "@playwright/test";
import { type CancelledPhoto, photoId, unprovenCancellations } from "./cancelled-photos";
import { ensureZones, seedSku, seedStorefrontProduct, signIn, testDatabase } from "./support";

// Every route of the First Light implementation, on a desktop and on a phone, signed in: it answers, shows a level-1 heading,
// logs no console or page error, requests nothing that fails (no missing logo, font, photo or script), draws every image, and
// the logo and the fonts it needs really load. Fictional data only.

test.beforeAll(ensureZones);

type Problem = string;

function watch(page: Page): { problems: Problem[]; settle: () => Promise<Problem[]> } {
  const problems: Problem[] = [];
  const cancelled: CancelledPhoto[] = [];
  const served = new Set<string>();
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text().slice(0, 200)}`));
  page.on("pageerror", (e) => problems.push(`page error: ${e.message.slice(0, 200)}`));
  page.on("requestfailed", (r) => {
    if (r.url().endsWith("/favicon.ico")) return;
    // A cancelled photo image request is judged once the page settles (cancelled-photos.ts), never accepted here.
    const id = photoId(r.url());
    if (id && r.resourceType() === "image" && r.failure()?.errorText === "net::ERR_ABORTED") {
      cancelled.push({ id, url: r.url() });
      return;
    }
    // The bag's read-only price check (a Server Action) starts after hydration and is cancelled by this test's own next
    // navigation; that abort is the test leaving, not a failure of the page. Any other failure counts.
    if (r.headers()["next-action"] && r.failure()?.errorText === "net::ERR_ABORTED") return;
    // A link prefetch (an RSC request) is cancelled when the test moves to the next page: the browser, not a failure.
    if (/[?&]_rsc=/.test(r.url()) && r.method() === "GET" && r.failure()?.errorText === "net::ERR_ABORTED") return;
    problems.push(`request failed: ${r.method()} ${r.url().slice(0, 160)} (${r.failure()?.errorText ?? "?"})`);
  });
  page.on("response", (r) => {
    const url = new URL(r.url());
    if (r.status() >= 400 && url.pathname !== "/favicon.ico") problems.push(`HTTP ${r.status()}: ${url.pathname}`);
    const id = photoId(r.url());
    if (id && r.status() === 200 && (r.headers()["content-type"] ?? "").startsWith("image/")) served.add(id);
  });
  // Once a page has settled: the cancelled photo requests without proof that the same photo loaded and is drawn.
  const settle = async (): Promise<Problem[]> => {
    const drawn = await page.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth > 0).map((i) => i.currentSrc || i.src));
    const unproven = unprovenCancellations(cancelled.splice(0), served, drawn);
    served.clear();
    problems.push(...unproven);
    return unproven;
  };
  return { problems, settle };
}

test("every storefront, tracking and Admin route loads cleanly on a desktop and a phone, with its logo, fonts and images", async ({ page }) => {
  test.setTimeout(420_000);
  const sku = await seedSku(3);
  const shop = await seedStorefrontProduct({ featured: true });
  const db = await testDatabase();
  let variantId: string;
  let productId: string;
  try {
    productId = (await db.query<{ id: string }>("select product_id as id from variants where sku = $1", [sku])).rows[0].id;
    variantId = (await db.query<{ id: string }>("select id from variants where sku = $1", [sku])).rows[0].id;
    // The real shop shows published products only (fictional test data; the publish action itself is covered by acceptance.spec).
    await db.query("update products set status = 'published' where id = $1", [shop.productId]);
  } finally {
    await db.end();
  }
  // The logo and font answers of the whole test, from the sign-in page on: the browser first fetches them there (200) and may
  // later only revalidate them (304), so a watcher started after sign-in can miss the 200.
  const assets = new Set<string>();
  page.on("response", (r) => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith("/brand/") || path.endsWith(".woff2")) assets.add(`${path} ${r.status()}`);
  });
  await signIn(page);

  // One order, made through the form, for the order routes.
  await page.goto("/admin/orders/new");
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
  // Founder acceptance in this browser, so the real shop answers (the test database is marked staging).
  await page.goto("/admin/acceptance");
  await page.getByRole("button", { name: "Start acceptance in this browser" }).click();
  await expect(page.getByTestId("pass-state")).toContainText("Holds an acceptance pass");

  const shopBase = "/admin/storefront-preview";
  const routes = [
    "/admin", "/admin/dashboard", "/admin/orders", "/admin/orders/new", orderPath, "/admin/products/new", `/admin/products/${productId}`,
    `/admin/products/${productId}/edit`, `/admin/products/${productId}/measurements`, `/admin/products/${productId}/photos`, `/admin/variants/${variantId}/edit`,
    `/admin/skus/${sku}`, "/admin/import", "/admin/catalogue-preparation", "/admin/product-reviews", "/admin/categories", "/admin/settings/delivery",
    "/admin/reports", "/admin/stock-counts", "/admin/exports", "/admin/media-health", "/admin/policies", "/admin/launch-readiness",
    "/admin/print/picking", "/admin/print/cod", "/admin/acceptance", "/admin/onboarding", "/admin/settings/store", "/admin/settings/publication", "/admin/settings/security", shopBase,
    ...["en", "bn"].flatMap((l) => [`${shopBase}/${l}`, `${shopBase}/${l}/products`, `${shopBase}/${l}/products/${shop.slug}`, `${shopBase}/${l}/cart`, `${shopBase}/${l}/checkout`, `${shopBase}/${l}/order`]),
    "/",
    ...["en", "bn"].flatMap((l) => [`/${l}`, `/${l}/products`, `/${l}/products/${shop.slug}`, `/${l}/cart`, `/${l}/checkout`, `/${l}/order`, `/${l}/account`]),
  ];

  for (const [device, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(viewport);
    const { problems, settle } = watch(page);
    for (const route of routes) {
      const before = problems.length;
      const response = await page.goto(route);
      expect(response?.status(), `${device} ${route}`).toBe(200);
      if (route !== "/") await expect(page.locator("h1").first(), `${device} ${route}`).toBeVisible();
      await page.waitForLoadState("networkidle");
      // Every image on the page is drawn (a missing file or a broken photo has no natural width).
      const broken = await page.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.currentSrc || i.src));
      expect(broken, `${device} ${route}: images that did not load`).toEqual([]);
      await settle();
      expect(problems.slice(before), `${device} ${route}`).toEqual([]);
    }
    expect(problems).toEqual([]);
  }
  // The approved logo and the self-hosted fonts were served from this origin.
  expect([...assets]).toContain("/brand/logo.png 200");
  expect([...assets]).toContain("/brand/mark.png 200");
  expect([...assets].filter((s) => /\.woff2 200$/.test(s)).length).toBeGreaterThanOrEqual(1);

  // The guest tracking page and the sign-in page, signed out.
  await page.context().clearCookies();
  for (const route of ["/track", "/admin/login", "/admin/setup", "/admin/recover"]) {
    const { problems, settle } = watch(page);
    const response = await page.goto(route);
    expect(response?.status(), route).toBe(200);
    await page.waitForLoadState("networkidle");
    await settle();
    expect(problems, route).toEqual([]);
  }
});
