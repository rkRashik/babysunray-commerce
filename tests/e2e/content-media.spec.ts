import { readdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { clearSignInLimits, productOf, seedSku, signIn, submitAndWait, testDatabase, uniqueName } from "./support";

// Product content and photos in a real browser against the real server: bilingual content with the fabric
// confirmation, the size chart in centimetres, the advisory readiness checklist, categories, and fictional
// photos uploaded, described, reordered, replaced and removed. Photos go to the run's throwaway media folder.

test.beforeEach(async ({ page }) => {
  await clearSignInLimits();
  page.on("dialog", (dialog) => void dialog.accept());
  await signIn(page);
});

const photo = async (colour: number, format: "png" | "jpeg" = "png") =>
  sharp({ create: { width: 480, height: 360, channels: 3, background: { r: colour, g: 120, b: 90 } } })[format]().toBuffer();
const met = (page: import("@playwright/test").Page, id: string) => page.getByTestId(`readiness-${id}`);

test("bilingual content, a confirmed fabric statement, a category and a size chart, with the readiness checklist", async ({ page }) => {
  const sku = await seedSku(2);
  const product = await productOf(sku);
  await page.goto(`/office/products/${product.id}`);
  await expect(page.getByTestId("readiness")).toContainText("Advisory only");
  await expect(met(page, "name")).toHaveAttribute("data-met", "false");
  await expect(met(page, "name")).toContainText("Missing: Bangla.");
  await expect(met(page, "policies")).toHaveAttribute("data-met", "false");
  await expect(page.getByRole("button", { name: /publish/i })).toHaveCount(0);

  const { slug } = uniqueName("e2e-cat");
  await page.goto("/office/categories");
  await page.getByLabel("Slug").fill(slug);
  await page.getByLabel("Name (English)", { exact: true }).fill("Fictional sets");
  await page.getByLabel("Name (Bangla)", { exact: true }).fill("কাল্পনিক সেট");
  await submitAndWait(page, page.getByRole("button", { name: "Create category" }));
  await expect(page.getByRole("status")).toHaveText("Category created.");

  await page.goto(`/office/products/${product.id}/edit`);
  await page.getByLabel("Name (Bangla)").fill("কাল্পনিক রম্পার");
  await page.getByLabel("Description (English)").fill("A fictional romper for the browser test.");
  await page.getByLabel("Description (Bangla)").fill("ব্রাউজার পরীক্ষার জন্য একটি কাল্পনিক রম্পার।");
  await page.getByLabel("Category").selectOption({ label: "Fictional sets" });
  await page.getByLabel("Fabric (English)").fill("Fictional fabric statement for testing");
  await page.getByLabel("Fabric (Bangla)").fill("পরীক্ষার জন্য কাল্পনিক কাপড়ের বিবরণ");
  await page.getByLabel(/I confirm the fabric statement/).check();
  await page.getByLabel("Care instructions (English)").fill("Fictional care text");
  await page.getByLabel("Care instructions (Bangla)").fill("কাল্পনিক যত্নের নির্দেশনা");
  await page.getByLabel(/^Featured/).check();
  await submitAndWait(page, page.getByRole("button", { name: "Save changes" }));
  await expect(page).toHaveURL(new RegExp(`/office/products/${product.id}\\?done=updated$`));
  await expect(page.getByTestId("fabric-confirmation")).toContainText("Confirmed by you");
  for (const id of ["name", "description", "fabric", "care", "category"]) await expect(met(page, id), id).toHaveAttribute("data-met", "true");
  await expect(met(page, "measurements")).toHaveAttribute("data-met", "false");
  await expect(page.locator("main")).toContainText("কাল্পনিক রম্পার");

  // Changing the fabric text without confirming again withdraws the confirmation.
  await page.goto(`/office/products/${product.id}/edit`);
  await page.getByLabel("Fabric (English)").fill("Changed fictional fabric statement");
  await page.getByLabel(/I confirm the fabric statement/).uncheck();
  await submitAndWait(page, page.getByRole("button", { name: "Save changes" }));
  await expect(page.getByTestId("fabric-confirmation")).toHaveText("Not confirmed");
  await expect(met(page, "fabric")).toHaveAttribute("data-met", "false");

  await page.getByRole("link", { name: "Edit size chart" }).click();
  await page.getByLabel("Chest (cm), size 0-3M", { exact: true }).fill("24.55");
  await page.getByLabel("Length (cm), size 0-3M", { exact: true }).fill("38");
  await submitAndWait(page, page.getByRole("button", { name: "Save size chart" }));
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Chest for size 0-3M must be centimetres with at most one decimal");
  await expect(page.getByLabel("Length (cm), size 0-3M", { exact: true })).toHaveValue("38");
  await page.getByLabel("Chest (cm), size 0-3M", { exact: true }).fill("24.5");
  await submitAndWait(page, page.getByRole("button", { name: "Save size chart" }));
  await expect(page.getByRole("status")).toHaveText("Size chart saved.");
  const chart = page.getByRole("region", { name: "Size chart (cm)" });
  await expect(chart.getByRole("row", { name: /0-3M/ })).toContainText("24.5");
  await expect(chart.getByRole("row", { name: /0-3M/ })).toContainText("38");
  await expect(met(page, "measurements")).toHaveAttribute("data-met", "true");

  const db = await testDatabase();
  try {
    const { rows } = await db.query("select point, value_mm from product_measurements where product_id = $1 order by point", [product.id]);
    expect(rows).toEqual([{ point: "chest", value_mm: 245 }, { point: "length", value_mm: 380 }]);
  } finally {
    await db.end();
  }
});

test("fictional photos: upload, refuse a fake image, describe, reorder, replace and remove, files kept in step", async ({ page, browser, baseURL }) => {
  const sku = await seedSku(1);
  const product = await productOf(sku);
  await page.goto(`/office/products/${product.id}/photos`);
  const add = page.getByRole("region", { name: "Add a photo" });
  await add.getByLabel(/^Photo/).setInputFiles({ name: "front.png", mimeType: "image/png", buffer: await photo(200) });
  await add.getByLabel("What the photo shows (English)").fill("Fictional romper, front");
  await add.getByRole("button", { name: "Upload photo" }).click();
  await expect(page.getByRole("status")).toHaveText("Photo uploaded.");
  const first = page.getByTestId("photo-0").getByRole("img");
  await expect(first).toHaveAttribute("alt", "Fictional romper, front");
  // The image really loaded through the Owner-only route.
  await expect.poll(() => first.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);

  // A text file pretending to be a PNG is refused, and nothing is stored.
  await add.getByLabel(/^Photo/).setInputFiles({ name: "fake.png", mimeType: "image/png", buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>") });
  await add.getByRole("button", { name: "Upload photo" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("must be a JPEG, PNG or WebP photo");

  await add.getByLabel(/^Photo/).setInputFiles({ name: "back.jpg", mimeType: "image/jpeg", buffer: await photo(60, "jpeg") });
  await add.getByRole("button", { name: "Upload photo" }).click();
  await expect(page.getByRole("status")).toHaveText("Photo uploaded.");
  const second = page.getByTestId("photo-1");
  await second.getByLabel("What the photo shows (English)").fill("Fictional romper, back");
  await second.getByLabel("What the photo shows (Bangla)").fill("কাল্পনিক রম্পার, পেছন");
  await submitAndWait(page, second.getByRole("button", { name: "Save descriptions" }));
  await expect(page.getByRole("status")).toHaveText("Photo descriptions saved.");
  await submitAndWait(page, page.getByRole("button", { name: "Show photo 2 first" }));
  await expect(page.getByTestId("photo-0").getByRole("img")).toHaveAttribute("alt", "Fictional romper, back");

  // Replace the second photo (now the front one): same place, same description, new file.
  const files = () => readdirSync(process.env.E2E_MEDIA_DIR!).filter((f) => f.endsWith(".png") || f.endsWith(".jpg") || f.endsWith(".webp"));
  const before = files().length;
  await page.getByTestId("photo-1").getByText("Replace photo 2").click();
  await page.getByTestId("photo-1").getByLabel(/^New photo/).setInputFiles({ name: "front-2.png", mimeType: "image/png", buffer: await photo(10) });
  await page.getByTestId("photo-1").getByRole("button", { name: "Replace photo" }).click();
  await expect(page.getByRole("status")).toContainText("Photo replaced");
  await expect(page.getByTestId("photo-1").getByRole("img")).toHaveAttribute("alt", "Fictional romper, front");
  expect(files().length).toBe(before);

  // Removing needs the tick as well as the dialog; the stored file goes with the record.
  const remove = page.getByTestId("photo-1");
  await submitAndWait(page, remove.getByRole("button", { name: "Remove photo 2" }));
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Tick the box");
  await remove.getByLabel("Yes, remove photo 2 and delete its stored file").check();
  await submitAndWait(page, remove.getByRole("button", { name: "Remove photo 2" }));
  await expect(page.getByRole("status")).toHaveText("Photo removed and its stored file deleted.");
  await expect(page.getByTestId("photo-1")).toHaveCount(0);
  expect(files().length).toBe(before - 1);

  // Signed out, a photo is not served.
  const src = await page.getByTestId("photo-0").getByRole("img").getAttribute("src");
  const anonymous = await browser.newContext({ ignoreHTTPSErrors: true });
  const response = await anonymous.request.get(`${baseURL}${src}`);
  expect(response.status()).toBe(401);
  await anonymous.close();

  // The photo storage check agrees: every record has its file.
  await page.goto("/office/media-health");
  await expect(page.getByTestId("media-summary")).toContainText("No record is missing its file.");
});
