import { expect, type Page, test } from "@playwright/test";
import { clearSignInLimits, signIn, submitAndWait, testDatabase, uniqueName } from "./support";

// The Owner's catalogue and stock work in a real browser: every step goes through the Server Actions, the
// shared operations and PostgreSQL. Fictional products only.

test.beforeEach(async ({ page }) => {
  await clearSignInLimits();
  await signIn(page);
});

const BANGLA_NAME = "সুতির রম্পার";
const BANGLA_DESCRIPTION = "নরম সুতি, শিশুর ত্বকের জন্য।";

async function createProduct(page: Page, slug: string, nameEn = "E2E Cotton Romper"): Promise<string> {
  await page.getByRole("link", { name: "New product" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New draft product" })).toBeVisible();
  await page.getByLabel("Slug").fill(slug);
  await page.getByLabel("Name (English)").fill(nameEn);
  await page.getByLabel("Name (Bangla)").fill(BANGLA_NAME);
  await page.getByLabel("Description (Bangla)").fill(BANGLA_DESCRIPTION);
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByRole("status")).toHaveText("Draft product created.");
  const match = /\/admin\/products\/([0-9a-f-]{36})/.exec(page.url());
  if (!match) throw new Error("Not on a product page.");
  return match[1];
}

async function addVariant(page: Page, sku: string, price = "850.50"): Promise<void> {
  const form = page.getByRole("region", { name: "Add a variant" });
  await form.getByLabel("SKU").fill(sku.toLowerCase());
  await form.getByLabel("Size").fill("0-3M");
  await form.getByLabel("Colour").fill("Ivory");
  await form.getByLabel("Price (BDT)").fill(price);
  await form.getByRole("button", { name: "Add variant" }).click();
  await expect(page.getByRole("status")).toHaveText("Variant added.");
}

async function onHand(page: Page): Promise<string> {
  return (await page.getByTestId("on-hand").textContent()) ?? "";
}

async function movementsOf(sku: string): Promise<{ type: string; delta: number; reason: string | null }[]> {
  const db = await testDatabase();
  try {
    const { rows } = await db.query<{ type: string; delta: number; reason: string | null }>(
      `select m.movement_type as type, m.quantity_delta as delta, m.reason
         from stock_movements m join variants v on v.id = m.variant_id where v.sku = $1 order by m.id`,
      [sku],
    );
    return rows;
  } finally {
    await db.end();
  }
}

test("create a draft product with a Bangla name, add a SKU, receive and adjust stock, and see it all after reload", async ({ page }) => {
  const { slug, sku } = uniqueName("e2e-flow");
  const productId = await createProduct(page, slug);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("E2E Cotton Romper");
  // Bangla text is stored and shown exactly as typed.
  await expect(page.getByText(BANGLA_NAME, { exact: true })).toBeVisible();
  await expect(page.getByText(BANGLA_DESCRIPTION, { exact: true })).toBeVisible();

  await addVariant(page, sku);
  const row = page.getByRole("row", { name: new RegExp(sku) });
  await expect(row).toContainText("850.50");
  await expect(row).toContainText("0-3M");

  await row.getByRole("link", { name: sku, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(sku);
  expect(await onHand(page)).toBe("0");

  const receive = page.getByRole("region", { name: "Receive stock" });
  await receive.getByLabel("Units received").fill("12");
  await receive.getByLabel("Note").fill("E2E delivery 1");
  await receive.getByRole("button", { name: "Record receipt" }).click();
  await expect(page.getByRole("status")).toHaveText("Stock receipt recorded.");
  expect(await onHand(page)).toBe("12");

  const adjust = page.getByRole("region", { name: "Adjust stock" });
  await adjust.getByLabel("Remove units").check();
  await adjust.getByRole("textbox", { name: /^Units/ }).fill("2");
  await adjust.getByLabel("Reason").fill("Two damaged in storage");
  await adjust.getByRole("button", { name: "Record adjustment" }).click();
  await expect(page.getByRole("status")).toHaveText("Stock adjustment recorded.");
  expect(await onHand(page)).toBe("10");

  await page.reload();
  expect(await onHand(page)).toBe("10");
  const ledger = page.getByRole("table");
  await expect(ledger.getByRole("row")).toHaveCount(3);
  await expect(ledger.getByRole("row").nth(1)).toContainText("+12");
  await expect(ledger.getByRole("row").nth(1)).toContainText("E2E delivery 1");
  await expect(ledger.getByRole("row").nth(2)).toContainText("-2");
  await expect(ledger.getByRole("row").nth(2)).toContainText("Two damaged in storage");
  await expect(ledger.getByRole("row").nth(2)).toContainText("You");

  await page.goto(`/admin/products/${productId}`);
  await expect(page.getByRole("row", { name: new RegExp(sku) })).toContainText("10");
  expect(await movementsOf(sku)).toEqual([
    { type: "receipt", delta: 12, reason: "E2E delivery 1" },
    { type: "adjustment", delta: -2, reason: "Two damaged in storage" },
  ]);
});

test("a double-click on a stock form records one movement", async ({ page }) => {
  const { slug, sku } = uniqueName("e2e-dbl");
  await createProduct(page, slug);
  await addVariant(page, sku);
  await page.goto(`/admin/skus/${sku}`);
  const receive = page.getByRole("region", { name: "Receive stock" });
  await receive.getByLabel("Units received").fill("5");
  await receive.getByRole("button", { name: "Record receipt" }).dblclick();
  await expect(page.getByRole("status")).toHaveText("Stock receipt recorded.");
  expect(await onHand(page)).toBe("5");
  expect(await movementsOf(sku)).toHaveLength(1);
});

test("a retry after a lost response does not record the movement twice", async ({ page }) => {
  const { slug, sku } = uniqueName("e2e-retry");
  await createProduct(page, slug);
  await addVariant(page, sku);
  await page.goto(`/admin/skus/${sku}`);

  // The first submission reaches the server and is committed, but the browser never sees the answer.
  let dropped = false;
  await page.route(`**/admin/skus/${sku}`, async (route) => {
    if (route.request().method() === "POST" && !dropped) {
      dropped = true;
      await route.fetch();
      await route.abort("connectionreset");
      return;
    }
    await route.continue();
  });
  const adjust = page.getByRole("region", { name: "Adjust stock" });
  await adjust.getByLabel("Add units").check();
  await adjust.getByRole("textbox", { name: /^Units/ }).fill("7");
  await adjust.getByLabel("Reason").fill("Found in back room");
  await adjust.getByRole("button", { name: "Record adjustment" }).click();
  await expect(adjust.getByRole("alert")).toContainText("could not be reached");
  expect(await movementsOf(sku)).toHaveLength(1);

  // The same form (same idempotency key) is sent again: the first result is returned, nothing is added.
  await adjust.getByRole("button", { name: "Record adjustment" }).click();
  await expect(page.getByRole("status")).toHaveText("Stock adjustment recorded.");
  expect(await onHand(page)).toBe("7");
  expect(await movementsOf(sku)).toHaveLength(1);
});

test("wrong inputs get understandable errors and keep what was typed", async ({ page }) => {
  const { slug, sku } = uniqueName("e2e-err");
  await page.getByRole("link", { name: "New product" }).click();
  await page.getByLabel("Slug").fill("Not A Valid Slug!");
  await page.getByLabel("Name (Bangla)").fill(BANGLA_NAME);
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Slug");
  await expect(page.getByLabel("Slug")).toHaveValue("Not A Valid Slug!");
  await expect(page.getByLabel("Name (Bangla)")).toHaveValue(BANGLA_NAME);

  await page.getByLabel("Slug").fill(slug);
  await page.getByLabel("Name (Bangla)").fill("");
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("name in English or Bangla");

  await page.getByLabel("Name (Bangla)").fill(BANGLA_NAME);
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByRole("status")).toHaveText("Draft product created.");

  const form = page.getByRole("region", { name: "Add a variant" });
  await form.getByLabel("SKU").fill(sku);
  for (const price of ["abc", "8.505", "-5", "0"]) {
    await form.getByLabel("Price (BDT)").fill(price);
    await submitAndWait(page, form.getByRole("button", { name: "Add variant" }));
    await expect(form.getByRole("alert")).toContainText("Price");
    await expect(form.getByLabel("Price (BDT)")).toHaveValue(price);
  }
  await form.getByLabel("Price (BDT)").fill("100");
  await form.getByRole("button", { name: "Add variant" }).click();
  await expect(page.getByRole("status")).toHaveText("Variant added.");

  // A second variant with the same SKU (in another case) is refused.
  await form.getByLabel("SKU").fill(sku.toLowerCase());
  await form.getByLabel("Price (BDT)").fill("100");
  await form.getByRole("button", { name: "Add variant" }).click();
  await expect(form.getByRole("alert")).toContainText("already exists");

  await page.goto(`/admin/skus/${sku}`);
  const receive = page.getByRole("region", { name: "Receive stock" });
  for (const quantity of ["0", "-3", "2.5", "many"]) {
    await receive.getByLabel("Units received").fill(quantity);
    await submitAndWait(page, receive.getByRole("button", { name: "Record receipt" }));
    await expect(receive.getByRole("alert")).toBeVisible();
  }
  const adjust = page.getByRole("region", { name: "Adjust stock" });
  await adjust.getByLabel("Remove units").check();
  await adjust.getByRole("textbox", { name: /^Units/ }).fill("1");
  await adjust.getByLabel("Reason").fill("Counting error");
  await adjust.getByRole("button", { name: "Record adjustment" }).click();
  await expect(adjust.getByRole("alert")).toContainText("Not enough stock");
  // A missing reason is stopped in the browser before anything is sent.
  await adjust.getByLabel("Reason").fill("");
  await adjust.getByRole("button", { name: "Record adjustment" }).click();
  expect(await adjust.getByLabel("Reason").evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
  expect(await movementsOf(sku)).toHaveLength(0);
  expect(await onHand(page)).toBe("0");
});
