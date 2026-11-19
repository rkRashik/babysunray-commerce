import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import sharp from "sharp";
import { E2E_OWNER, ensureZones, signIn, testDatabase, uniqueName } from "./support";

// Design review screenshots and a phone walkthrough video of the Owner-only storefront preview. Opt-in: it does nothing
// unless DESIGN_SHOTS_DIR names a folder OUTSIDE the project. It writes PNGs of every storefront screen and state at phone
// widths (360, 390, 430 px) and desktop (1440 px), in English and Bangla, a WebM walkthrough and an index.html gallery.
// All products and orders are fictional and go into babysunray_test. Photos: DESIGN_PHOTOS_DIR (outside the project) may
// hold licensed demo photos named <photo>-1.jpg / <photo>-2.jpg; they are stored as the fictional products' photos and
// described as demo photos. Without it, the products have no photos. Run:
//   DESIGN_SHOTS_DIR=<folder> DESIGN_PHOTOS_DIR=<folder> npm run test:e2e -- tests/e2e/design-preview.spec.ts

const OUT = process.env.DESIGN_SHOTS_DIR;
const PHOTOS = process.env.DESIGN_PHOTOS_DIR;
const PREVIEW = "/office/storefront-preview";
const outside = (dir: string) => !path.resolve(dir).toLowerCase().startsWith(path.resolve(process.cwd()).toLowerCase());

type Seed = { name: [string, string]; category: "rompers" | "sets" | "accessories"; featured: boolean; price: number; colour: string; photo: string | null; stock: number[] };
const CATEGORIES = { rompers: ["Rompers", "রম্পার"], sets: ["Sets", "সেট"], accessories: ["Accessories", "এক্সেসরিজ"] } as const;
// Inserted in this order; the list shows featured first, then the newest. The last one opens the home page.
const SEEDS: Seed[] = [
  { name: ["Cloud Bodysuit", "ক্লাউড বডিস্যুট"], category: "rompers", featured: true, price: 65_000, colour: "White", photo: "bodysuit", stock: [8, 6, 5] },
  { name: ["Fox Knit Set", "ফক্স নিট সেট"], category: "sets", featured: true, price: 185_000, colour: "Red", photo: "fox-set", stock: [3, 2, 4] },
  { name: ["Rose Print Set", "রোজ প্রিন্ট সেট"], category: "sets", featured: true, price: 145_000, colour: "Rose", photo: "rose-set", stock: [5, 5, 3] },
  { name: ["Heart Crochet Cap", "হার্ট ক্রোশে ক্যাপ"], category: "accessories", featured: true, price: 39_000, colour: "Cream", photo: "heart-cap", stock: [6] },
  { name: ["Bear-ear Knit Cap", "বেয়ার-ইয়ার নিট ক্যাপ"], category: "accessories", featured: false, price: 45_000, colour: "Grey", photo: "bear-cap", stock: [9] },
  { name: ["Soft Sleepsuit", "সফট স্লিপস্যুট"], category: "rompers", featured: false, price: 98_000, colour: "White", photo: "sleepsuit", stock: [4, 2, 0] },
  { name: ["Muslin Wrap Blanket", "মসলিন র‍্যাপ কম্বল"], category: "accessories", featured: false, price: 54_000, colour: "Natural", photo: null, stock: [0] },
  { name: ["Grey Button Romper", "গ্রে বাটন রম্পার"], category: "rompers", featured: false, price: 115_000, colour: "Grey", photo: "romper", stock: [6, 4, 3] },
];

type Made = { slug: string; name: [string, string]; skus: string[] };
// The categories this run created (unique slugs), so a link is chosen by its own slug and never by a name that other
// tests in a shared database may also use ("Sets").
const categorySlugs: Record<string, string> = {};

async function seedCatalogue(): Promise<Made[]> {
  const db = await testDatabase();
  const made: Made[] = [];
  try {
    const owner = (await db.query<{ id: string }>("select id from auth_users where email = $1", [E2E_OWNER.email])).rows[0].id;
    const ids = new Map<string, string>();
    for (const [key, [en, bn]] of Object.entries(CATEGORIES)) {
      const { slug } = uniqueName(`design-${key}`);
      categorySlugs[key] = slug;
      ids.set(key, (await db.query<{ id: string }>("insert into product_categories (slug, name_en, name_bn) values ($1, $2, $3) returning id", [slug, en, bn])).rows[0].id);
    }
    for (const [i, seed] of SEEDS.entries()) {
      const { slug, sku } = uniqueName(`design-${i}`);
      const product = await db.query<{ id: string }>(
        `insert into products (slug, name_en, name_bn, description_en, description_bn, category_id, fabric_en, fabric_bn, fabric_confirmed_at, fabric_confirmed_by_user_id, care_en, care_bn, size_guidance_en, size_guidance_bn, featured)
         values ($1, $2, $3, $4, $5, $6, 'Fictional soft cotton blend.', 'কাল্পনিক নরম সুতির মিশ্রণ।', now(), $7, 'Fictional care text for the design review.', 'ডিজাইন রিভিউয়ের জন্য কাল্পনিক যত্নের লেখা।', 'Fictional guidance: measure the chest and choose the next size up if in between.', 'কাল্পনিক পরামর্শ: বুকের মাপ নিন, মাঝামাঝি হলে পরের সাইজ নিন।', $8) returning id`,
        [slug, seed.name[0], seed.name[1], "Fictional product text for the design review. It is not a real product and nothing about it is a claim.", "ডিজাইন রিভিউয়ের জন্য কাল্পনিক পণ্যের লেখা। এটি আসল পণ্য নয়, এবং এর কিছুই কোনো দাবি নয়।", ids.get(seed.category), owner, seed.featured],
      );
      const productId = product.rows[0].id;
      const skus: string[] = [];
      const sizes = (seed.category === "accessories" ? [["A", "One size"]] : [["A", "0-3M"], ["B", "3-6M"], ["C", "6-12M"]]) as [string, string][];
      for (const [k, [code, size]] of sizes.entries()) {
        const price = seed.price + (code === "C" ? 6_000 : 0);
        const v = await db.query<{ id: string }>("insert into variants (product_id, sku, size, colour, price_paisa) values ($1, $2, $3, $4, $5) returning id", [productId, `${sku}-${code}`, size, seed.colour, price]);
        await db.query("insert into inventory_balances (variant_id, on_hand) values ($1, $2)", [v.rows[0].id, seed.stock[k]]);
        if (seed.stock[k] > 0) await db.query("insert into stock_movements (variant_id, movement_type, quantity_delta, actor_type, actor_ref) values ($1, 'receipt', $2, 'system', 'design-seed')", [v.rows[0].id, seed.stock[k]]);
        skus.push(`${sku}-${code}`);
      }
      if (seed.category !== "accessories") {
        for (const [size, point, mm] of [["0-3M", "chest", 245], ["0-3M", "length", 380], ["3-6M", "chest", 260], ["3-6M", "length", 410], ["6-12M", "chest", 275], ["6-12M", "length", 440]] as const) {
          await db.query("insert into product_measurements (product_id, size, point, value_mm) values ($1, $2, $3, $4)", [productId, size, point, mm]);
        }
      }
      for (const position of [0, 1]) {
        const file = PHOTOS && seed.photo ? path.join(PHOTOS, `${seed.photo}-${position + 1}.jpg`) : null;
        if (!file || !existsSync(file)) continue;
        const image = readFileSync(file);
        const { width, height } = await sharp(image).metadata();
        const key = `${randomBytes(16).toString("hex")}.jpg`;
        writeFileSync(path.join(process.env.E2E_MEDIA_DIR!, key), image);
        await db.query(
          "insert into product_media (product_id, storage_key, content_type, byte_size, width, height, sha256, alt_en, alt_bn, position, created_by_user_id) values ($1, $2, 'image/jpeg', $3, $4, $5, $6, $7, $8, $9, $10)",
          [productId, key, image.length, width, height, createHash("sha256").update(image).digest("hex"), `${seed.name[0]} (demo photo)`, `${seed.name[1]} (ডেমো ছবি)`, position, owner],
        );
      }
      made.push({ slug, name: seed.name, skus });
    }
  } finally {
    await db.end();
  }
  return made;
}

const chip = (page: Page, text: string) => page.locator("label").filter({ has: page.getByRole("radio", { name: new RegExp(`^${text}`) }) });

/** Scrolls through the page so every lazy photo loads, then back to the top. */
async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  const height = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < height; y += 500) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(100);
  }
  await page.evaluate(async () => {
    // Lazy photos off to the side (a rail, the gallery's next slide) never start loading: wait at most a few seconds.
    const loaded = Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = () => r(null); }))));
    await Promise.race([loaded, new Promise((r) => setTimeout(r, 4000))]);
    await document.fonts.ready;
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(350);
}

type Shot = { file: string; caption: string; group: string };

test("design review screenshots and walkthrough (opt-in: DESIGN_SHOTS_DIR)", async ({ browser }) => {
  test.skip(!OUT, "Set DESIGN_SHOTS_DIR to a folder outside the project to write the screenshots.");
  test.setTimeout(1_500_000);
  expect(outside(OUT!)).toBe(true);
  if (PHOTOS) expect(outside(PHOTOS)).toBe(true);
  mkdirSync(OUT!, { recursive: true });
  await ensureZones();
  const catalogue = await seedCatalogue();
  const [bodysuit, fox, , , , sleepsuit, muslin, romper] = catalogue;
  const shots: Shot[] = [];

  const open = async (viewport: { width: number; height: number }, mobile: boolean, extra: Parameters<typeof browser.newContext>[0] = {}) => {
    const context = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, ignoreHTTPSErrors: true, locale: "en-GB", ...extra });
    // Playwright's default for actions and navigation is no limit at all: a step that cannot finish would hang for the whole
    // test timeout. A limit turns it into an error with a call log.
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(60_000);
    const page = await context.newPage();
    await signIn(page);
    return { context, page };
  };
  const capture = async (page: Page, file: string, caption: string, group: string, fullPage = true) => {
    if (fullPage) await settle(page);
    else await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(OUT!, file), fullPage });
    shots.push({ file, caption, group });
  };
  const go = async (page: Page, url: string) => {
    await page.goto(`${PREVIEW}${url}`);
    await expect(page.locator("main h1").first()).toBeVisible();
  };
  const fillBag = async (page: Page) => {
    for (const [item, size] of [[romper, "3-6M"], [fox, "0-3M"]] as const) {
      await go(page, `/en/products/${item.slug}`);
      await chip(page, size).click();
      await page.getByRole("button", { name: /^Add to Bag/ }).first().click();
      await expect(page.getByTestId("add-message")).toContainText("added");
    }
  };

  for (const [device, viewport, mobile] of [["desktop", { width: 1440, height: 900 }, false], ["phone", { width: 390, height: 844 }, true]] as const) {
    const { context, page } = await open(viewport, mobile);
    const label = device === "phone" ? "Phone 390 px" : "Desktop 1440 px";
    await go(page, "/en");
    await capture(page, `${device}-01-home-en.png`, `${label}: home, English`, "Home");
    await go(page, "/bn");
    await capture(page, `${device}-02-home-bn.png`, `${label}: home, Bangla`, "Home");
    await go(page, "/en/products");
    await capture(page, `${device}-03-shop-en.png`, `${label}: Shop All`, "Browse");
    await page.getByTestId("filter-button").click();
    await expect(page.getByTestId("filter-sheet")).toBeVisible();
    await capture(page, `${device}-04-filter-sheet-en.png`, `${label}: filter sheet`, "Browse", false);
    await page.keyboard.press("Escape");
    await page.getByRole("list", { name: "Categories" }).locator(`a[href*="category=${categorySlugs.sets}"]`).click();
    await expect(page.locator("main h1")).toHaveText("Sets");
    await capture(page, `${device}-05-category-en.png`, `${label}: one category`, "Browse");
    await go(page, `/bn/products?q=${encodeURIComponent("রম্পার")}`);
    await capture(page, `${device}-06-search-bn.png`, `${label}: search results, Bangla`, "Browse");
    if (mobile) {
      await go(page, "/en");
      await page.getByTestId("tab-search").click();
      await capture(page, `${device}-07-search-sheet-en.png`, `${label}: search sheet from the tab bar`, "Browse", false);
      await page.keyboard.press("Escape");
    }
    await go(page, `/en/products/${romper.slug}`);
    await capture(page, `${device}-08-product-en.png`, `${label}: product, English`, "Product");
    await chip(page, "3-6M").click();
    await page.getByRole("button", { name: /^Add to Bag/ }).first().click();
    await expect(page.getByTestId("add-message")).toContainText("added");
    await capture(page, `${device}-09-added-en.png`, `${label}: size chosen, added to bag`, "Product", false);
    await page.getByRole("button", { name: "Size guide" }).click();
    await expect(page.getByTestId("size-guide-sheet")).toBeVisible();
    await capture(page, `${device}-10-size-guide-en.png`, `${label}: size guide sheet`, "Product", false);
    await page.keyboard.press("Escape");
    await go(page, `/bn/products/${romper.slug}`);
    await capture(page, `${device}-11-product-bn.png`, `${label}: product, Bangla`, "Product");
    await go(page, `/en/products/${muslin.slug}`);
    await capture(page, `${device}-12-no-photo-sold-out-en.png`, `${label}: product without a photo, sold out`, "Product");
    await go(page, `/en/products/${sleepsuit.slug}`);
    await chip(page, "6-12M").click();
    await capture(page, `${device}-13-size-sold-out-en.png`, `${label}: one size sold out`, "Product", false);

    await page.evaluate(() => localStorage.clear());
    await go(page, "/en/cart");
    await capture(page, `${device}-14-bag-empty-en.png`, `${label}: empty bag`, "Bag");
    await fillBag(page);
    await go(page, "/en/cart");
    await page.locator("label").filter({ hasText: "Dhaka City" }).click();
    await expect(page.getByTestId("total")).not.toHaveText("—");
    await capture(page, `${device}-15-bag-en.png`, `${label}: bag, English`, "Bag");
    await go(page, "/bn/cart");
    await page.locator("label").filter({ hasText: "ঢাকা সিটি" }).click();
    await capture(page, `${device}-16-bag-bn.png`, `${label}: bag, Bangla`, "Bag");

    await go(page, "/en/checkout");
    await capture(page, `${device}-17-checkout-contact-en.png`, `${label}: checkout step 1, contact`, "Checkout");
    await page.getByLabel("Full name").fill("Fictional Customer");
    await page.getByLabel("Mobile number").fill("01711000070");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByLabel("Delivery address")).toBeVisible();
    await page.getByLabel("Delivery address").fill("House 70, Road 7, Fictional Area, Dhaka");
    await page.locator("label").filter({ hasText: "Dhaka City" }).click();
    await capture(page, `${device}-18-checkout-delivery-en.png`, `${label}: checkout step 2, delivery`, "Checkout");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByTestId("checkout-review")).toBeVisible();
    await capture(page, `${device}-19-checkout-review-en.png`, `${label}: checkout step 3, review`, "Checkout");
    await page.getByRole("button", { name: "Place order (simulation)" }).click();
    await expect(page.getByTestId("simulation-result")).toBeVisible();
    await capture(page, `${device}-20-confirmation-en.png`, `${label}: confirmation (simulation)`, "Checkout");
    await go(page, "/bn/checkout");
    await page.getByLabel("পুরো নাম").fill("কাল্পনিক ক্রেতা");
    await page.getByLabel("মোবাইল নম্বর").fill("01711000070");
    await capture(page, `${device}-21-checkout-contact-bn.png`, `${label}: checkout step 1, Bangla`, "Checkout");
    await context.close();
  }

  // The narrowest and widest common phones: home and product.
  for (const width of [360, 430]) {
    const { context, page } = await open({ width, height: width === 360 ? 780 : 932 }, true);
    await go(page, "/en");
    await capture(page, `phone${width}-01-home-en.png`, `Phone ${width} px: home`, "Other phone widths");
    await go(page, `/bn/products/${fox.slug}`);
    await capture(page, `phone${width}-02-product-bn.png`, `Phone ${width} px: product, Bangla`, "Other phone widths");
    await go(page, "/en/products");
    await capture(page, `phone${width}-03-shop-en.png`, `Phone ${width} px: Shop All`, "Other phone widths", false);
    await context.close();
  }

  // A recorded phone walkthrough: home, a category, a product, size, Add to Bag, the bag, checkout, confirmation.
  {
    const videoDir = path.join(OUT!, "video-tmp");
    const { context, page } = await open({ width: 390, height: 844 }, true, { recordVideo: { dir: videoDir, size: { width: 390, height: 844 } } });
    await page.evaluate(() => localStorage.clear());
    const pause = (ms = 900) => page.waitForTimeout(ms);
    await go(page, "/en");
    await settle(page);
    await pause(1200);
    await page.mouse.wheel(0, 700);
    await pause();
    await page.getByRole("link", { name: "Shop", exact: true }).click();
    await expect(page.locator("main h1")).toHaveText("Shop All");
    await pause();
    await page.getByRole("list", { name: "Categories" }).getByRole("link", { name: "Rompers" }).click();
    await pause();
    await page.getByRole("link", { name: /^Grey Button Romper/ }).first().click();
    await expect(page.locator("main h1")).toHaveText("Grey Button Romper");
    await pause(1200);
    await page.getByTestId("gallery-main").evaluate((el) => el.scrollIntoView());
    await page.mouse.move(300, 400);
    await chip(page, "3-6M").click();
    await pause();
    await page.getByRole("button", { name: /^Add to Bag/ }).first().click();
    await pause(1600);
    await page.getByRole("link", { name: "View Bag" }).click();
    await expect(page.locator("main h1")).toHaveText("Your Bag");
    await page.locator("label").filter({ hasText: "Dhaka City" }).click();
    await pause(1200);
    await page.getByRole("link", { name: "Checkout" }).first().click();
    await page.getByLabel("Full name").fill("Fictional Customer");
    await page.getByLabel("Mobile number").fill("01711000070");
    await pause();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Delivery address").fill("House 70, Road 7, Fictional Area, Dhaka");
    await page.locator("label").filter({ hasText: "Dhaka City" }).click();
    await pause();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByTestId("checkout-review")).toBeVisible();
    await pause(1500);
    await page.getByRole("button", { name: "Place order (simulation)" }).click();
    await expect(page.getByTestId("simulation-result")).toBeVisible();
    await pause(2200);
    const video = page.video();
    await context.close();
    if (video) renameSync(await video.path(), path.join(OUT!, "walkthrough-phone-390.webm"));
  }

  // The customer's tracking page: the Owner creates a fictional order and its link; the guest opens it in a new browser.
  const owner = await browser.newContext({ ignoreHTTPSErrors: true });
  const ownerPage = await owner.newPage();
  await signIn(ownerPage);
  await ownerPage.goto("/office/orders/new");
  await ownerPage.getByLabel("WhatsApp").check();
  await ownerPage.getByLabel("Customer name").fill("Fictional Customer");
  await ownerPage.getByLabel("Phone").fill("+880 1711-000071");
  await ownerPage.getByLabel("Delivery address").fill("House 71, Fictional Road, Dhaka");
  await ownerPage.getByLabel(/^Dhaka City/).check();
  await ownerPage.getByLabel("SKU, line 1").fill(bodysuit.skus[1].toLowerCase());
  await ownerPage.getByLabel("Quantity, line 1").fill("2");
  await ownerPage.getByRole("button", { name: "Create order" }).click();
  await expect(ownerPage.getByRole("status").first()).toContainText("Order created");
  const orderUrl = ownerPage.url();
  const tracking = ownerPage.getByRole("region", { name: "Customer tracking link" });
  await tracking.getByRole("button", { name: "Create link" }).click();
  const link = await tracking.getByRole("textbox").inputValue();
  await owner.close();

  // The Owner Office: sign-in and the main screens, desktop and phone.
  for (const [device, viewport, mobile] of [["desktop", { width: 1440, height: 900 }, false], ["phone", { width: 390, height: 844 }, true]] as const) {
    const label = device === "phone" ? "Phone 390 px" : "Desktop 1440 px";
    const signedOut = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, ignoreHTTPSErrors: true, locale: "en-GB" });
    const login = await signedOut.newPage();
    await login.goto("/office/login");
    await expect(login.getByRole("heading", { level: 1 })).toBeVisible();
    await capture(login, `${device}-30-office-login.png`, `${label}: Owner Office sign-in`, "Owner Office");
    await signedOut.close();
    const { context, page } = await open(viewport, mobile);
    const screens: [string, string, string][] = [
      ["/office/dashboard", "31-office-dashboard", "dashboard"],
      ["/office/orders", "32-office-orders", "orders"],
      [orderUrl.replace(/^https?:\/\/[^/]+/, ""), "33-office-order", "one order"],
      ["/office", "34-office-products", "products"],
      ["/office/stock-counts", "36-office-stock-counts", "stock counts"],
      ["/office/reports", "37-office-reports", "reports"],
      ["/office/exports", "38-office-exports", "exports"],
      ["/office/launch-readiness", "39-office-launch", "launch readiness"],
    ];
    for (const [url, file, caption] of screens) {
      await page.goto(url);
      await expect(page.locator("main h1").first()).toBeVisible();
      await capture(page, `${device}-${file}.png`, `${label}: Office ${caption}`, "Owner Office");
    }
    await page.goto("/office");
    await page.getByRole("link", { name: "Grey Button Romper" }).first().click();
    await expect(page.locator("main h1")).toHaveText("Grey Button Romper");
    await capture(page, `${device}-35-office-product.png`, `${label}: Office product, readiness and variants`, "Owner Office");
    await context.close();
  }
  for (const [device, viewport, mobile] of [["desktop", { width: 1440, height: 900 }, false], ["phone", { width: 390, height: 844 }, true]] as const) {
    const guest = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, ignoreHTTPSErrors: true });
    const page = await guest.newPage();
    await page.goto(link);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Order ORD-");
    await page.waitForTimeout(600);
    const file = `${device}-22-tracking.png`;
    await page.screenshot({ path: path.join(OUT!, file), fullPage: true });
    shots.push({ file, caption: `${device === "phone" ? "Phone 390 px" : "Desktop 1440 px"}: order tracking (guest)`, group: "Tracking" });
    await guest.close();
  }

  const groups = [...new Set(shots.map((s) => s.group))];
  const sections = groups
    .map((g) => `<h2>${g}</h2><div class="row">${shots.filter((s) => s.group === g).map((s) => `<figure class="${s.file.startsWith("desktop") ? "wide" : ""}"><a href="${s.file}"><img src="${s.file}" alt="${s.caption}" loading="lazy"></a><figcaption>${s.caption}</figcaption></figure>`).join("")}</div>`)
    .join("\n");
  writeFileSync(
    path.join(OUT!, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>First Light design review</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f4f4f2;color:#332923}header{padding:24px 24px 8px}h1{margin:0 0 4px;font-size:24px}p{margin:4px 0;max-width:70ch}h2{margin:28px 24px 12px;font-size:18px}.row{display:flex;gap:20px;overflow-x:auto;padding:0 24px 12px;align-items:flex-start}figure{margin:0;flex:0 0 auto;width:250px}figure.wide{width:560px}img{width:100%;border-radius:10px;border:1px solid #ddd;background:#fff;display:block}figcaption{font-size:13px;margin-top:6px;color:#6b5f57}video{display:block;margin:0 24px;border-radius:16px;border:1px solid #ddd;max-height:80vh}</style>
<header><h1>First Light design review</h1><p>Owner-only preview with fictional products and orders. Product photos, when DESIGN_PHOTOS_DIR is set, are <strong>demo photos</strong> (their source and licence are recorded with them); they are not BabySunray products, and nothing shown is for sale. Click a picture to open it at full size.</p></header>
<h2>Phone walkthrough (390 px)</h2><video src="walkthrough-phone-390.webm" controls muted playsinline></video>
${sections}`,
  );
});
