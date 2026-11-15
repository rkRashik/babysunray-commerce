import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { clearSignInLimits, signIn, testDatabase, uniqueName } from "./support";

// The catalogue import wizard in a real browser against the real server and babysunray_test: templates, a file with
// problems, the corrected file, the import, a lost answer and its retry (no duplicates), then the new drafts in the
// product list and the preparation overview. Fictional products only.

test.beforeEach(async ({ page }) => {
  await clearSignInLimits();
  await signIn(page);
});

const HEADER = "product_slug,name_en,name_bn,description_en,category_slug,fabric_en,featured,sku,size,colour,price_bdt,chest_cm";
const upload = (name: string, text: string) => ({ name, mimeType: "text/csv", buffer: Buffer.from(text, "utf8") });

async function counts(prefix: string) {
  const db = await testDatabase();
  try {
    const one = async (sql: string) => Number((await db.query(sql, [`${prefix}%`])).rows[0].n);
    return {
      products: await one("select count(*) as n from products where slug like $1"),
      variants: await one("select count(*) as n from variants where lower(sku) like $1"),
      movements: await one("select count(*) as n from stock_movements m join variants v on v.id = m.variant_id where lower(v.sku) like $1"),
    };
  } finally {
    await db.end();
  }
}

test("templates, a file with problems, the corrected import, a lost answer retried without duplicates", async ({ page }) => {
  const { slug: tag } = uniqueName("e2e-imp");
  await page.goto("/office/import");
  for (const format of ["csv", "xlsx"]) {
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: `Download the ${format.toUpperCase()} template` }).click()]);
    expect(download.suggestedFilename()).toBe(`catalogue-import-template.${format}`);
    const bytes = readFileSync((await download.path()) as string);
    if (format === "csv") expect(bytes.toString("utf8")).toContain("product_slug,name_en,name_bn");
    else expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  }

  const broken = [
    HEADER,
    `${tag}-romper,Fictional Romper,কাল্পনিক রম্পার,A fictional romper.,,Fictional fabric,yes,${tag}-r1,0-3M,Ivory,850,24.5`,
    `${tag}-romper,,,,,,,${tag}-r1,3-6M,Ivory,850.555,26`,
    `${tag}-cap,=1+1,,,,,,${tag}-c1,,,120,`,
  ].join("\r\n");
  await page.getByLabel(/^Catalogue file/).setInputFiles(upload("catalogue.csv", broken));
  await page.getByRole("button", { name: "Check file (nothing is saved)" }).click();
  const preview = page.getByTestId("import-preview");
  await expect(preview).toBeVisible();
  const issues = page.getByTestId("import-issues");
  await expect(issues).toContainText("is also on row 2");
  await expect(issues).toContainText("price_bdt must be Taka");
  await expect(issues).toContainText("could run as a formula");
  await expect(page.getByRole("button", { name: /^Import \d/ })).toHaveCount(0);
  const [report] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download the problem list (CSV)" }).click()]);
  const reportText = readFileSync((await report.path()) as string, "utf8");
  expect(reportText).toContain("duplicate_sku");
  expect(reportText).not.toContain("=1+1");
  expect(await counts(tag)).toEqual({ products: 0, variants: 0, movements: 0 });

  const fixed = [
    HEADER,
    `${tag}-romper,Fictional Romper,কাল্পনিক রম্পার,A fictional romper.,,Fictional fabric,yes,${tag}-r1,0-3M,Ivory,850,24.5`,
    `${tag}-romper,,,,,,,${tag}-r2,3-6M,Ivory,850.50,26`,
    `${tag}-cap,Fictional Cap,,,,,,${tag}-c1,,,120,`,
  ].join("\r\n");
  await page.getByLabel(/^Catalogue file/).setInputFiles(upload("catalogue.csv", fixed));
  await page.getByRole("button", { name: "Check file (nothing is saved)" }).click();
  await expect(page.getByTestId("import-counts")).toContainText("Products2SKUs3");
  await expect(preview).toContainText("Fabric statements are imported as not confirmed");
  expect(await counts(tag)).toEqual({ products: 0, variants: 0, movements: 0 });

  // The server imports, but the answer never reaches the browser: pressing Import again returns the first result.
  let dropped = false;
  await page.route("**/office/import/confirm", async (route) => {
    if (dropped) return route.continue();
    dropped = true;
    await route.fetch();
    await route.abort("connectionreset");
  });
  await page.getByRole("button", { name: "Import 2 products" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Press Import again");
  expect(await counts(tag)).toEqual({ products: 2, variants: 3, movements: 0 });
  await page.getByRole("button", { name: "Import 2 products" }).click();
  const result = page.getByTestId("import-result");
  await expect(result).toContainText("Already imported: 2 draft products, 3 SKUs");
  expect(await counts(tag)).toEqual({ products: 2, variants: 3, movements: 0 });

  // Previewing the same file again shows that every slug and SKU now exists: nothing can be imported twice.
  await page.getByRole("button", { name: "Check file (nothing is saved)" }).click();
  await expect(page.getByTestId("import-issues")).toContainText("already exists");
  await expect(page.getByRole("button", { name: /^Import \d/ })).toHaveCount(0);

  await page.goto(`/office?q=${tag}&missing=photo`);
  const romper = page.getByTestId(`product-${tag}-romper`);
  await expect(romper).toContainText("Fictional Romper");
  await expect(romper.getByTestId("readiness-tally")).toContainText("approved 2/3");
  await romper.getByRole("link", { name: /fabric statement/ }).click();
  await expect(page).toHaveURL(/\/edit$/);
  await page.goto("/office/catalogue-preparation");
  await expect(page.getByTestId("preparation-fabric")).toBeVisible();
  await expect(page.getByRole("button", { name: /publish/i })).toHaveCount(0);
});
