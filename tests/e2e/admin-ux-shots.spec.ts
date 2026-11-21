import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import sharp from "sharp";
import { E2E_OWNER, ensureZones, signIn, testDatabase, uniqueName } from "./support";

// Review screenshots of the Admin's operational screens (Orders, Products, Dashboard, Reports, Catalogue preparation) at
// desktop (1440 px) and phone (390 px) widths, with empty, filtered and error states, and an index.html gallery. Opt-in:
// it does nothing unless ADMIN_SHOTS_DIR names a folder OUTSIDE the project. Every product, customer and order is
// fictional and goes into babysunray_test (reset by the e2e set-up). DESIGN_PHOTOS_DIR (outside the project) may hold
// licensed demo photos named <photo>-1.jpg; without it the products have no photos. Run:
//   ADMIN_SHOTS_DIR=<folder> DESIGN_PHOTOS_DIR=<folder> npx playwright test tests/e2e/admin-ux-shots.spec.ts

const OUT = process.env.ADMIN_SHOTS_DIR;
const PHOTOS = process.env.DESIGN_PHOTOS_DIR;
const outside = (dir: string) => !path.resolve(dir).toLowerCase().startsWith(path.resolve(process.cwd()).toLowerCase());

type Seed = { en: string; bn: string | null; price: number; photo: string | null; stock: number[]; complete: boolean; status?: "archived" };
const SEEDS: Seed[] = [
  { en: "Cloud Bodysuit", bn: "ক্লাউড বডিস্যুট", price: 65_000, photo: "bodysuit", stock: [8, 6, 5], complete: true },
  { en: "Fox Knit Set", bn: "ফক্স নিট সেট", price: 185_000, photo: "fox-set", stock: [3, 2, 4], complete: true },
  { en: "Rose Print Set", bn: "রোজ প্রিন্ট সেট", price: 145_000, photo: "rose-set", stock: [5, 0, 3], complete: true },
  { en: "Heart Crochet Cap", bn: "হার্ট ক্রোশে ক্যাপ", price: 39_000, photo: "heart-cap", stock: [6], complete: false },
  { en: "Bear-ear Knit Cap", bn: null, price: 45_000, photo: "bear-cap", stock: [9], complete: false },
  { en: "Soft Sleepsuit", bn: "সফট স্লিপস্যুট", price: 98_000, photo: "sleepsuit", stock: [0, 0, 0], complete: true },
  { en: "Muslin Wrap Blanket", bn: "মসলিন র‍্যাপ কম্বল", price: 54_000, photo: null, stock: [0], complete: false },
  { en: "Grey Button Romper", bn: "গ্রে বাটন রম্পার", price: 115_000, photo: "romper", stock: [6, 4, 3], complete: true },
  { en: "Striped Summer Set", bn: "স্ট্রাইপ সামার সেট", price: 120_000, photo: null, stock: [2, 2, 0], complete: false, status: "archived" },
];

async function seedCatalogue(): Promise<string[]> {
  const db = await testDatabase();
  const skus: string[] = [];
  try {
    const owner = (await db.query<{ id: string }>("select id from auth_users where email = $1", [E2E_OWNER.email])).rows[0].id;
    const category = (await db.query<{ id: string }>("insert into product_categories (slug, name_en, name_bn) values ($1, 'Rompers and sets', 'রম্পার ও সেট') returning id", [uniqueName("shots-cat").slug])).rows[0].id;
    for (const [i, seed] of SEEDS.entries()) {
      const { slug, sku } = uniqueName(`shots-${i}`);
      const product = await db.query<{ id: string }>(
        `insert into products (slug, name_en, name_bn, description_en, description_bn, category_id, fabric_en, fabric_bn, fabric_confirmed_at, fabric_confirmed_by_user_id, care_en, care_bn)
         values ($1, $2, $3, 'Fictional product text for the Admin review.', ${seed.complete ? "'অ্যাডমিন রিভিউয়ের জন্য কাল্পনিক লেখা।'" : "null"}, $4,
                 'Fictional cotton blend.', 'কাল্পনিক সুতির মিশ্রণ।', ${seed.complete ? "now()" : "null"}, ${seed.complete ? "$5" : "null"}, 'Fictional care text.', 'কাল্পনিক যত্নের লেখা।') returning id`,
        seed.complete ? [slug, seed.en, seed.bn, category, owner] : [slug, seed.en, seed.bn, i % 2 ? null : category],
      );
      const productId = product.rows[0].id;
      const sizes = seed.stock.length === 1 ? ["One size"] : ["0-3M", "3-6M", "6-12M"];
      for (const [k, size] of sizes.entries()) {
        const v = await db.query<{ id: string }>("insert into variants (product_id, sku, size, colour, price_paisa) values ($1, $2, $3, 'Natural', $4) returning id", [
          productId,
          `${sku}-${k}`,
          size,
          seed.price + k * 5_000,
        ]);
        await db.query("insert into inventory_balances (variant_id, on_hand) values ($1, $2)", [v.rows[0].id, seed.stock[k]]);
        if (seed.stock[k] > 0) await db.query("insert into stock_movements (variant_id, movement_type, quantity_delta, actor_type, actor_ref) values ($1, 'receipt', $2, 'system', 'shots-seed')", [v.rows[0].id, seed.stock[k]]);
        if (seed.complete) await db.query("insert into product_measurements (product_id, size, point, value_mm) values ($1, $2, 'chest', 260)", [productId, size]);
        skus.push(`${sku}-${k}`);
      }
      const file = PHOTOS && seed.photo ? path.join(PHOTOS, `${seed.photo}-1.jpg`) : null;
      if (file && existsSync(file)) {
        const image = readFileSync(file);
        const { width, height } = await sharp(image).metadata();
        const key = `${randomBytes(16).toString("hex")}.jpg`;
        writeFileSync(path.join(process.env.E2E_MEDIA_DIR!, key), image);
        await db.query(
          "insert into product_media (product_id, storage_key, content_type, byte_size, width, height, sha256, alt_en, alt_bn, position, created_by_user_id) values ($1, $2, 'image/jpeg', $3, $4, $5, $6, $7, $8, 0, $9)",
          [productId, key, image.length, width, height, createHash("sha256").update(image).digest("hex"), `${seed.en} (demo photo)`, seed.complete ? "ডেমো ছবি" : null, owner],
        );
      }
      if (seed.status) await db.query("update products set status = $2 where id = $1", [productId, seed.status]);
    }
  } finally {
    await db.end();
  }
  return skus;
}

// Fictional customers; the phone numbers are in the test pattern 01711 0000xx.
const CUSTOMERS = ["Farhana Demo", "Tanvir Demo", "Sadia Demo", "Rafiq Demo", "Mitu Demo", "Nayeem Demo", "Lamia Demo", "Imran Demo"];

async function createOrder(page: Page, n: number, lines: [string, number][]): Promise<string> {
  await page.goto("/admin/orders/new");
  await page.getByLabel(n % 3 === 0 ? "Messenger" : "WhatsApp").check();
  await page.getByLabel("Customer name").fill(CUSTOMERS[n]);
  await page.getByLabel("Phone").fill(`017110000${String(10 + n)}`);
  await page.getByLabel("Delivery address").fill(`House ${n + 3}, Fictional Road, Dhaka`);
  await page.getByLabel(n % 2 ? /^Outside Dhaka/ : /^Dhaka City/).check();
  for (const [i, [sku, quantity]] of lines.entries()) {
    await page.getByLabel(`SKU, line ${i + 1}`).fill(sku);
    await page.getByLabel(`Quantity, line ${i + 1}`).fill(String(quantity));
  }
  await page.getByRole("button", { name: "Create order" }).click();
  await expect(page.getByRole("status").first()).toContainText("Order created");
  return page.url().split("?")[0];
}

async function step(page: Page, url: string, button: string) {
  await page.goto(url);
  const before = await page.getByTestId("order-version").textContent();
  await page.getByRole("region", { name: "Next step" }).getByRole("button", { name: button }).click();
  await expect(page.getByTestId("order-version")).not.toHaveText(before ?? "");
}

type Shot = { file: string; caption: string; group: string };

test("Admin operational UX review screenshots (opt-in: ADMIN_SHOTS_DIR)", async ({ browser }) => {
  test.skip(!OUT, "Set ADMIN_SHOTS_DIR to a folder outside the project to write the screenshots.");
  test.setTimeout(900_000);
  expect(outside(OUT!)).toBe(true);
  if (PHOTOS) expect(outside(PHOTOS)).toBe(true);
  mkdirSync(OUT!, { recursive: true });
  await ensureZones();
  const skus = await seedCatalogue();
  // The screenshots show a named store, as a real installation would (Store settings).
  const named = await testDatabase();
  let romperSlug = "";
  let romperId = "";
  try {
    await named.query("insert into store_settings (id, store_name) values (1, 'BabySunRay') on conflict (id) do update set store_name = excluded.store_name");
    ({ slug: romperSlug, id: romperId } = (await named.query<{ slug: string; id: string }>("select slug, id from products where name_en = 'Grey Button Romper' order by created_at desc limit 1")).rows[0]);
  } finally {
    await named.end();
  }
  const shots: Shot[] = [];

  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-GB" });
  desktop.setDefaultTimeout(30_000);
  const page = await desktop.newPage();
  page.on("dialog", (dialog) => void dialog.accept());
  await signIn(page);

  // Orders in every state the list shows: two to verify (one overdue), confirmed, packed, dispatched, delivered, cancelled.
  const orders: string[] = [];
  // SKUs by seed: 0-2 bodysuit, 3-5 fox set, 6-8 rose set, 9 heart cap, 10 bear cap, 11-13 sleepsuit, 14 muslin, 15-17 romper.
  const plan: [string, number][][] = [[[skus[0], 1]], [[skus[3], 2]], [[skus[9], 1], [skus[1], 1]], [[skus[4], 1]], [[skus[15], 1]], [[skus[10], 1]], [[skus[16], 2]], [[skus[2], 1]]];
  for (const [n, lines] of plan.entries()) orders.push(await createOrder(page, n, lines));
  for (const n of [2, 3, 4, 5, 6]) await step(page, orders[n], "Confirm order (verified with the customer)");
  for (const n of [3, 4, 5]) await step(page, orders[n], "Mark packed");
  for (const n of [4, 5]) await step(page, orders[n], "Dispatch");
  await step(page, orders[5], "Record delivery");
  await step(page, orders[7], "Cancel order");
  const db = await testDatabase();
  try {
    await db.query("update orders set verification_expires_at = now() - interval '2 hours' where id = $1", [orders[1].split("/").at(-1)]);
  } finally {
    await db.end();
  }

  const capture = async (p: Page, file: string, caption: string, group: string) => {
    await p.waitForLoadState("networkidle");
    await p.evaluate(async () => {
      await Promise.race([Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = () => r(null); })))), new Promise((r) => setTimeout(r, 4000))]);
      await document.fonts.ready;
    });
    await p.screenshot({ path: path.join(OUT!, file), fullPage: true });
    shots.push({ file, caption, group });
  };
  const search = async (p: Page, term: string) => {
    await p.goto("/admin/orders");
    await p.getByLabel("Search orders").fill(term);
    await p.getByRole("button", { name: "Search" }).click();
    await p.waitForURL(/\/admin\/orders(\?|$)/);
  };

  await page.goto("/admin/orders");
  await capture(page, "desktop-01-orders.png", "Orders: table with queue chips, statuses and the next step per row", "Orders · desktop");
  await search(page, "01711 000013");
  await capture(page, "desktop-02-orders-phone-search.png", "Orders: search by phone (any form). The address bar shows only ?search=1", "Orders · desktop");
  await search(page, "sadia");
  await capture(page, "desktop-03-orders-name-search.png", "Orders: search by part of a name", "Orders · desktop");
  await search(page, "Nobody Fictional");
  await capture(page, "desktop-04-orders-no-match.png", "Orders: empty state for a search with no match", "Orders · desktop");
  await search(page, "0171");
  await capture(page, "desktop-05-orders-search-error.png", "Orders: an unusable search term explains what works", "Orders · desktop");
  await page.goto("/admin/orders?queue=to_pack");
  await capture(page, "desktop-06-orders-to-pack.png", "Orders: the To pack queue with its quick action", "Orders · desktop");
  await page.goto("/admin/orders?attention=true");
  await capture(page, "desktop-07-orders-attention.png", "Orders: Needs attention (overdue verification)", "Orders · desktop");

  await page.goto("/admin");
  await capture(page, "desktop-10-products.png", "Products: thumbnail, both names, status, category, price range, stock and information state", "Products · desktop");
  await page.goto("/admin?missing=photo");
  await capture(page, "desktop-11-products-filtered.png", "Products: filtered to those still missing a photo", "Products · desktop");
  await page.goto("/admin?q=no-such-product");
  await capture(page, "desktop-12-products-empty.png", "Products: empty state for a search with no match", "Products · desktop");

  await page.goto("/admin/dashboard");
  await capture(page, "desktop-20-dashboard.png", "Dashboard: urgent queues first, empty queues on one line, Refresh", "Dashboard · desktop");
  await page.goto("/admin/reports");
  await capture(page, "desktop-30-reports.png", "Reports: quick ranges, period summary, aligned tables, COD reconciliation", "Reports · desktop");
  await page.goto("/admin/reports?from=2026-11-20&to=2026-11-01");
  await capture(page, "desktop-31-reports-error.png", "Reports: an invalid date range", "Reports · desktop");
  await page.goto("/admin/reports?tab=cod");
  await capture(page, "desktop-32-reports-cod.png", "Reports: COD and reconciliation tab", "Reports · desktop");
  await page.goto("/admin/reports?tab=inventory");
  await capture(page, "desktop-33-reports-inventory.png", "Reports: inventory and costs tab", "Reports · desktop");
  await page.goto("/admin/orders");
  await page.locator("[data-quickview]").nth(3).click();
  await page.getByRole("region", { name: "Items" }).waitFor();
  await page.waitForTimeout(400);
  await capture(page, "desktop-09-quick-view.png", "Orders: quick view drawer", "Orders · desktop");
  await page.keyboard.press("Escape");
  await page.goto("/admin/catalogue-preparation");
  await capture(page, "desktop-40-preparation.png", "Catalogue preparation: business language, no requirement codes", "Catalogue preparation · desktop");
  await page.goto("/admin/products/new");
  await page.getByLabel("Name (English)").fill("Cotton Sleep Bag");
  await page.waitForTimeout(1200);
  await capture(page, "desktop-41-new-product.png", "New product: name first, language tabs, web address made from the name", "Products · desktop");
  // The shop as customers see it (the Owner's preview, its "preview" bar hidden for the picture).
  const hideBar = () => page.addStyleTag({ content: "*:has(> [data-testid=preview-banner]) { display: none !important } nextjs-portal { display: none !important }" });
  await page.goto("/admin/storefront-preview/en");
  await hideBar();
  await capture(page, "storefront.png", "Storefront home", "Storefront");
  await page.goto(`/admin/storefront-preview/en/products/${romperSlug}`);
  await hideBar();
  await capture(page, "product-page.png", "Product page with sizes and size chart", "Storefront");
  await page.goto("/admin/orders?queue=to_pack");
  await page.locator("input.of-check").first().check();
  await capture(page, "desktop-09-orders-bulk.png", "Orders: a selection offers one bulk step", "Orders · desktop");
  await page.goto(orders[4]);
  await capture(page, "desktop-60-order-detail.png", "One order (dispatched, COD to collect)", "Orders · desktop");
  await page.goto(`/admin/products/${romperId}`);
  await capture(page, "desktop-42-product.png", "One product: content, checklist, variants and stock", "Products · desktop");
  await page.goto("/admin/settings/store");
  await capture(page, "desktop-50-store-settings.png", "Store settings: saved details, logo and customer account emails", "Settings · desktop");
  const edit = page.getByRole("button", { name: "Edit details" });
  if (await edit.count()) {
    await edit.click();
    await page.getByLabel("Store name").fill("BabySunRay Kids");
    await capture(page, "desktop-51-store-settings-edit.png", "Store settings: editing, with Save changes and Cancel", "Settings · desktop");
  }
  const replace = page.getByRole("button", { name: "Replace logo" });
  if (await replace.count()) {
    await page.goto("/admin/settings/store");
    await page.getByRole("button", { name: "Replace logo" }).click();
    await page.getByLabel(/^New logo/).setInputFiles(path.join(process.cwd(), "public/brand/logo.png"));
    await capture(page, "desktop-52-store-logo-replace.png", "Store settings: a chosen replacement logo, previewed before saving", "Settings · desktop");
  }
  await desktop.close();

  // A smaller laptop: the order table scrolls sideways and keeps the row's action in view.
  const laptop = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-GB" });
  const small = await laptop.newPage();
  await signIn(small);
  await small.goto("/admin/orders");
  await capture(small, "desktop-08-orders-1280.png", "Orders at 1280 px: the action column stays in view", "Orders · desktop");
  await small.goto("/admin/dashboard");
  await small.getByTestId("generated-at").waitFor();
  await small.screenshot({ path: path.join(OUT!, "desktop-21-dashboard-1280-fold.png") });
  shots.push({ file: "desktop-21-dashboard-1280-fold.png", caption: "Dashboard at 1280 × 800, first screen only (what the Owner sees on opening)", group: "Dashboard · desktop" });
  await laptop.close();

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-GB" });
  phone.setDefaultTimeout(30_000);
  const mobile = await phone.newPage();
  await signIn(mobile);
  await mobile.goto("/admin/orders");
  await capture(mobile, "phone-01-orders.png", "Orders on a phone: compact cards with the next step", "Phone");
  await search(mobile, "demo");
  await capture(mobile, "phone-02-orders-search.png", "Orders on a phone: name search", "Phone");
  await mobile.goto("/admin");
  await capture(mobile, "phone-10-products.png", "Products on a phone: one large row per product", "Phone");
  await mobile.goto("/admin/dashboard");
  await capture(mobile, "phone-20-dashboard.png", "Dashboard on a phone", "Phone");
  await mobile.goto("/admin/orders");
  await mobile.locator("ul[aria-label=Orders] [data-quickview]").nth(3).tap();
  await mobile.getByRole("region", { name: "Items" }).waitFor();
  await mobile.waitForTimeout(400);
  await capture(mobile, "phone-03-quick-view.png", "Quick view on a phone", "Phone");
  await mobile.keyboard.press("Escape");
  await mobile.goto("/admin/reports?tab=cod");
  await capture(mobile, "phone-31-reports-cod.png", "Reports COD tab on a phone", "Phone");
  await mobile.goto("/admin/reports");
  await capture(mobile, "phone-30-reports.png", "Reports on a phone", "Phone");
  await mobile.goto(orders[4]);
  await capture(mobile, "phone-60-order-detail.png", "One order on a phone", "Phone");
  await mobile.goto(`/admin/products/${romperId}`);
  await capture(mobile, "phone-42-product.png", "One product on a phone", "Phone");
  await mobile.goto("/admin/settings/store");
  await capture(mobile, "phone-50-store-settings.png", "Store settings on a phone", "Phone");
  await mobile.getByRole("navigation", { name: "Quick links" }).getByRole("button", { name: "Menu" }).tap();
  await mobile.waitForTimeout(500);
  await mobile.screenshot({ path: path.join(OUT!, "phone-90-menu.png") });
  shots.push({ file: "phone-90-menu.png", caption: "The phone's Menu with every page", group: "Phone" });
  await phone.close();

  const groups = [...new Set(shots.map((s) => s.group))];
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  writeFileSync(
    path.join(OUT!, "index.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin Phase 1 review</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#f6f1ea;color:#2b211c}header{padding:24px 16px 8px;max-width:1500px;margin:auto}h1{margin:0 0 4px;font-size:24px}p{margin:0;color:#6b5d52}
section{max-width:1500px;margin:auto;padding:8px 16px 24px}h2{font-size:18px;margin:16px 0 12px}.grid{display:grid;gap:20px;grid-template-columns:repeat(auto-fill,minmax(420px,1fr))}
figure{margin:0;background:#fff;border:1px solid #e3d9cc;border-radius:14px;overflow:hidden}figure a{display:block;max-height:520px;overflow:hidden;border-bottom:1px solid #eee}img{width:100%;display:block}figcaption{padding:10px 12px;font-size:14px}code{font-size:12px;color:#8a7b6e}</style></head>
<body><header><h1>BabySunRay Admin · Phase 1 operational UX</h1><p>Real application, production-like data shapes, fictional customers and products only (babysunray_test). Select a screenshot to open it full size.</p></header>
${groups
  .map(
    (g) =>
      `<section><h2>${esc(g)}</h2><div class="grid">${shots
        .filter((s) => s.group === g)
        .map((s) => `<figure><a href="${s.file}" target="_blank"><img src="${s.file}" alt="${esc(s.caption)}" loading="lazy"></a><figcaption>${esc(s.caption)}<br><code>${s.file}</code></figcaption></figure>`)
        .join("")}</div></section>`,
  )
  .join("")}
</body></html>`,
  );
});
