import { expect, type Page, test } from "@playwright/test";
import { clearSignInLimits, fillNewProduct, signIn, submitAndWait, testDatabase, uniqueName, openPanel } from "./support";

// Draft editing, archive and deactivate confirmations, and product search, in a real browser.

test.beforeEach(async ({ page }) => {
  await clearSignInLimits();
  await signIn(page);
});

async function createProductWithVariant(page: Page, prefix: string, names = { en: "Edit Me Romper", bn: "সম্পাদনার রম্পার" }) {
  const { slug, sku } = uniqueName(prefix);
  await page.goto("/admin/products/new");
  await fillNewProduct(page, { slug, nameEn: names.en, nameBn: names.bn });
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByRole("status")).toHaveText("Draft product created.");
  const productUrl = page.url().split("?")[0];
  await openPanel(page, "Add a variant");
  const form = page.getByRole("region", { name: "Add a variant" });
  await form.getByLabel("SKU").fill(sku);
  await form.getByLabel("Size").fill("0-3M");
  await form.getByLabel("Price (BDT)").fill("850.50");
  await form.getByRole("button", { name: "Add variant" }).click();
  await expect(page.getByRole("status")).toHaveText("Variant added.");
  return { slug, sku, productUrl };
}

test("edit a draft product: values are prefilled, Bangla is kept, and the page shows the saved text", async ({ page }) => {
  const { productUrl } = await createProductWithVariant(page, "e2e-edit");
  await page.getByRole("link", { name: "Edit details" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Edit details" })).toBeVisible();
  await expect(page.getByLabel("Name (English)")).toHaveValue("Edit Me Romper");
  await page.getByLabel("Name (English)").fill("Edited Romper");
  await page.getByRole("tab", { name: "Bangla" }).click();
  await expect(page.getByLabel("Name (Bangla)")).toHaveValue("সম্পাদনার রম্পার");
  await page.getByLabel("Description (Bangla)").fill("নরম সুতি, ০-৩ মাস");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toHaveText("Product details saved.");
  expect(page.url().split("?")[0]).toBe(productUrl);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Edited Romper");
  await expect(page.getByText("নরম সুতি, ০-৩ মাস", { exact: true })).toBeVisible();

  // Emptying every name is refused, with the typed values kept.
  await page.getByRole("link", { name: "Edit details" }).click();
  await page.getByLabel("Name (English)").fill("");
  await page.getByRole("tab", { name: "Bangla" }).click();
  await page.getByLabel("Name (Bangla)").fill("");
  await submitAndWait(page, page.getByRole("button", { name: "Save changes" }));
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("A product needs a name in English or Bangla.");
  await expect(page.getByLabel("Description (Bangla)")).toHaveValue("নরম সুতি, ০-৩ মাস");
});

test("a stale edit form is refused instead of overwriting a newer change", async ({ page, context }) => {
  const { productUrl } = await createProductWithVariant(page, "e2e-stale");
  const other = await context.newPage();
  await other.goto(`${productUrl}/edit`);
  await page.goto(`${productUrl}/edit`);

  await other.getByLabel("Name (English)").fill("Saved in the other tab");
  await other.getByRole("button", { name: "Save changes" }).click();
  await expect(other.getByRole("status")).toHaveText("Product details saved.");

  await page.getByLabel("Name (English)").fill("Typed in a stale tab");
  await submitAndWait(page, page.getByRole("button", { name: "Save changes" }));
  await expect(page.getByRole("main").getByRole("alert")).toContainText("changed after you loaded it");
  await expect(page.getByLabel("Name (English)")).toHaveValue("Typed in a stale tab");
  await page.reload();
  await expect(page.getByLabel("Name (English)")).toHaveValue("Saved in the other tab");
});

test("edit a variant's price exactly, without changing its stock", async ({ page }) => {
  const { sku, productUrl } = await createProductWithVariant(page, "e2e-price");
  await page.goto(`/admin/skus/${sku}`);
  const receive = page.getByRole("region", { name: "Receive stock" });
  await receive.getByLabel("Units received").fill("4");
  await receive.getByRole("button", { name: "Record receipt" }).click();
  await expect(page.getByRole("status")).toHaveText("Stock receipt recorded.");

  await page.goto(productUrl);
  await page.getByRole("link", { name: `Edit ${sku}` }).click();
  await expect(page.getByLabel("Price (BDT)")).toHaveValue("850.50");
  await expect(page.getByLabel("Size")).toHaveValue("0-3M");
  await page.getByLabel("Price (BDT)").fill("999.99");
  await page.getByLabel("Size").fill("");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toHaveText("Variant saved.");
  const row = page.getByRole("row", { name: new RegExp(sku) });
  await expect(row).toContainText("999.99");
  // Cells after the SKU row header: size, colour, price, on hand.
  await expect(row.getByRole("cell").nth(3)).toHaveText("4");
  const db = await testDatabase();
  try {
    const { rows } = await db.query("select price_paisa, size from variants where sku = $1", [sku]);
    expect(rows).toEqual([{ price_paisa: "99999", size: null }]);
  } finally {
    await db.end();
  }
});

test("archive and deactivate ask first; cancelling changes nothing", async ({ page }) => {
  const { sku, productUrl } = await createProductWithVariant(page, "e2e-confirm");

  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("region", { name: "Variants and stock" }).getByRole("button", { name: "Deactivate" }).click();
  await expect(page.getByRole("row", { name: new RegExp(sku) })).toContainText("Active");
  await expect(page.getByRole("link", { name: `Edit ${sku}` })).toBeVisible();

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain(`Deactivate ${sku}?`);
    void dialog.accept();
  });
  await page.getByRole("region", { name: "Variants and stock" }).getByRole("button", { name: "Deactivate" }).click();
  await expect(page.getByRole("status")).toHaveText("Variant deactivated.");
  await expect(page.getByRole("row", { name: new RegExp(sku) })).toContainText("Inactive");
  await expect(page.getByRole("link", { name: `Edit ${sku}` })).toHaveCount(0);

  page.once("dialog", (dialog) => void dialog.dismiss());
  await openPanel(page, "Archive this product");
  await page.getByRole("button", { name: "Archive product" }).click();
  await expect(page.getByRole("link", { name: "Edit details" })).toBeVisible();

  page.once("dialog", (dialog) => void dialog.accept());
  await openPanel(page, "Archive this product");
  await page.getByRole("button", { name: "Archive product" }).click();
  await expect(page.getByRole("status")).toHaveText("Product archived.");
  await expect(page.getByRole("link", { name: "Edit details" })).toHaveCount(0);
  await page.goto(`${productUrl}/edit`);
  await expect(page.getByRole("status")).toContainText("archived, so it cannot be edited");
});

test("search by English name, Bangla name, slug and SKU, filter by status, and keep it all in the URL", async ({ page }) => {
  const tag = uniqueName("tag").slug.slice(4);
  const one = await createProductWithVariant(page, "e2e-find", { en: `Muslin Wrap ${tag}`, bn: `মসলিন মোড়ক ${tag}` });
  await createProductWithVariant(page, "e2e-find", { en: `Cotton Cap ${tag}`, bn: `সুতির টুপি ${tag}` });

  await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Products" }).click();
  const search = page.getByRole("search", { name: "Search products" });
  const results = page.getByRole("table", { name: "Products" });
  for (const term of [`muslin wrap ${tag}`, `মসলিন মোড়ক ${tag}`, one.slug.toUpperCase(), one.sku.toLowerCase()]) {
    await search.getByLabel("Search").fill(term);
    await search.getByRole("button", { name: "Search" }).click();
    await expect(results.locator("tbody tr")).toHaveCount(1);
    await expect(results).toContainText(`Muslin Wrap ${tag}`);
  }
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(one.sku.toLowerCase());

  await search.getByLabel("Search").fill(tag);
  await search.getByLabel("Status").selectOption("archived");
  await search.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("main").getByRole("status")).toContainText("No products match");
  await search.getByLabel("Status").selectOption("draft");
  await search.getByRole("button", { name: "Search" }).click();
  await expect(results.locator("tbody tr")).toHaveCount(2);
  await page.reload();
  await expect(search.getByLabel("Search")).toHaveValue(tag);
  await expect(search.getByLabel("Status")).toHaveValue("draft");
  await expect(results.locator("tbody tr")).toHaveCount(2);

  for (const term of ["%", "' or 1=1 --", `no-such-product-${tag}`]) {
    await search.getByLabel("Search").fill(term);
    await search.getByRole("button", { name: "Search" }).click();
    await expect(page.getByRole("main").getByRole("status")).toContainText("No products match");
  }
  await expect(search.getByLabel("Search")).toHaveAttribute("maxlength", "100");
  await page.goto(`/admin?q=${"x".repeat(101)}`);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("at most 100 characters");
  await page.getByRole("link", { name: "Clear" }).click();
  await expect(page).toHaveURL(/\/admin$/);
});

test("search results page through with Next and First links, keeping the search", async ({ page }) => {
  const tag = uniqueName("pg").slug.slice(3);
  const db = await testDatabase();
  try {
    // 27 fictional drafts straight into the test database, so the list needs two pages of 25.
    await db.query(
      `insert into products (slug, name_en, created_at) select 'e2e-page-' || $1 || '-' || n, 'Paged Bib ' || $1 || ' ' || n, now() + n * interval '1 millisecond' from generate_series(1, 27) n`,
      [tag],
    );
  } finally {
    await db.end();
  }
  await page.goto(`/admin?q=${encodeURIComponent(`paged bib ${tag}`)}`);
  const results = page.getByRole("table", { name: "Products" });
  await expect(results.locator("tbody tr")).toHaveCount(25);
  await expect(results.locator("tbody tr").first()).toContainText(`Paged Bib ${tag} 1`);
  await page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Next page" }).click();
  await expect(results.locator("tbody tr")).toHaveCount(2);
  await expect(results.locator("tbody tr").last()).toContainText(`Paged Bib ${tag} 27`);
  expect(new URL(page.url()).searchParams.get("q")).toBe(`paged bib ${tag}`);
  await page.getByRole("link", { name: "First page" }).click();
  await expect(results.locator("tbody tr")).toHaveCount(25);
});

test("the product list filters as you type and sets a category on several drafts at once", async ({ page }) => {
  const tag = uniqueName("bulk").slug.slice(5);
  const names = [`Bulk Bib ${tag} A`, `Bulk Bib ${tag} B`];
  for (const name of names) await createProductWithVariant(page, "e2e-bulk", { en: name, bn: `ব্যাচ ${name}` });
  const db = await testDatabase();
  try {
    await db.query("insert into product_categories (slug, name_en) values ($1, 'Bulk bibs')", [`bulk-${tag}`]);
  } finally {
    await db.end();
  }
  await page.goto("/admin");
  await page.getByLabel("Search", { exact: true }).fill(`bulk bib ${tag}`);
  await expect(page).toHaveURL(new RegExp(`q=bulk[+]bib[+]${tag}`));
  const rows = page.getByRole("table", { name: "Products" }).locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await page.getByLabel("Select every draft product on this page").check();
  await page.getByLabel("Category", { exact: true }).last().selectOption({ label: "Bulk bibs" });
  await page.getByRole("button", { name: "Apply category to 2" }).click();
  await expect(page.getByRole("region", { name: "Bulk result" })).toContainText("All 2 products updated.");
  await expect(rows.first()).toContainText("Bulk bibs");
  await page.getByLabel("Select every draft product on this page").check();
  // Archiving asks first: declining changes nothing, accepting archives both.
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("button", { name: "Archive 2" }).click();
  await expect(rows.first()).toContainText("Draft");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Archive 2" }).click();
  await expect(rows.first()).toContainText("Archived");
  await expect(rows.first()).toContainText("Not for sale");
});
