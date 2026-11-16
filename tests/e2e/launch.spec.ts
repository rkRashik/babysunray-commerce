import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { clearSignInLimits, seedStorefrontProduct, signIn, testDatabase } from "./support";

// Launch preparation in a real browser (Gate H.26): the readiness page, private policy drafts and the product
// review queue. All Owner-only; nothing here may publish anything or open checkout. Fictional data only.

test.beforeEach(clearSignInLimits);

async function expectNoAxeViolations(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function sql(text: string, params: unknown[] = []) {
  const db = await testDatabase();
  try {
    return (await db.query(text, params)).rows;
  } finally {
    await db.end();
  }
}

const MARKUP = `Fictional delivery draft.\n<script>window.__policyXss = 1</script><img src=x onerror="window.__policyXss = 2">`;

test("signed out, no launch, policy or review page is shown, and no draft text leaks", async ({ browser, baseURL }) => {
  await sql(
    "insert into policy_drafts (kind, body_en, updated_by_user_id) select 'privacy', 'Secret fictional privacy draft', id from auth_users where email = 'e2e-owner@example.test' on conflict (kind) do nothing",
  );
  const anonymous = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await anonymous.newPage();
  for (const path of ["/office/launch-readiness", "/office/policies", "/office/product-reviews"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/office\/login$/);
    const raw = await anonymous.request.get(`${baseURL}${path}`, { maxRedirects: 0 });
    expect([303, 307, 308], path).toContain(raw.status());
    expect(await raw.text()).not.toContain("Secret fictional privacy draft");
  }
  await anonymous.close();
});

test("policy drafts: unsaved state, plain-text markup, a stale tab, review only with both languages, and the gate stays closed", async ({ page, context }) => {
  await signIn(page);
  await page.goto("/office/policies");
  await expect(page.getByRole("heading", { level: 1, name: "Policy drafts" })).toBeVisible();
  const editor = page.getByTestId("policy-editor-delivery");
  const state = page.getByTestId("policy-state-delivery");
  const before = (await state.textContent()) ?? "";
  await editor.getByLabel("Delivery policy: English text").fill(MARKUP);
  await expect(state).toHaveText("Unsaved changes.");
  await expectNoAxeViolations(page);

  // A second tab opened before the save.
  const stale = await context.newPage();
  await stale.goto("/office/policies");

  await editor.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft saved. It is private and not published." })).toBeVisible();
  await expect(page.getByTestId("policy-status-delivery")).toContainText("Drafted, not reviewed");
  await expect(page.getByTestId("policy-editor-delivery").getByLabel("Delivery policy: English text")).toHaveValue(MARKUP);
  expect(await page.evaluate(() => (window as unknown as { __policyXss?: number }).__policyXss)).toBeUndefined();
  expect(before).not.toBe("Unsaved changes.");

  await stale.getByTestId("policy-editor-delivery").getByLabel("Delivery policy: English text").fill("Typed in a stale tab.");
  await stale.getByTestId("policy-editor-delivery").getByRole("button", { name: "Save draft" }).click();
  await expect(stale.getByTestId("policy-editor-delivery").getByRole("alert")).toContainText("changed after you opened it");
  await expect(stale.getByTestId("policy-editor-delivery").getByLabel("Delivery policy: English text")).toHaveValue("Typed in a stale tab.");
  await stale.close();

  await expect(page.getByRole("button", { name: "Mark this version as reviewed" })).toHaveCount(0);
  await page.getByTestId("policy-editor-delivery").getByLabel("Delivery policy: Bangla text").fill("কাল্পনিক ডেলিভারি খসড়া।");
  await page.getByTestId("policy-editor-delivery").getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByTestId("policy-status-delivery")).toContainText("Drafted, not reviewed");
  await page.locator("#delivery").getByRole("button", { name: "Mark this version as reviewed" }).click();
  await expect(page.getByTestId("policy-status-delivery")).toContainText("Reviewed by you · not approved for publication · not published");
  const events = await sql("select event, version from policy_draft_events where kind = 'delivery' order by id");
  expect(events.map((e) => e.event)).toEqual(["saved", "saved", "marked_reviewed"]);

  await page.goto("/office/launch-readiness");
  await expect(page.getByRole("note")).toContainText("The public shop is closed.");
  await expect(page.getByTestId("gate-blockers")).toContainText("No customer policy is founder-approved and published");
  await expect(page.getByTestId("check-policy_delivery")).toContainText("Requires founder approval");
  await expect(page.getByTestId("check-checkout_disabled")).toContainText("Ready");
  await expect(page.getByTestId("check-integrity")).toContainText("Ready");
  await expectNoAxeViolations(page);
});

test("product reviews: the queue, a review on the product page, outdated after a price change, and nothing published", async ({ page }) => {
  const product = await seedStorefrontProduct();
  await signIn(page);
  await page.goto(`/office/product-reviews?q=${product.slug}`);
  const row = page.getByTestId(`review-row-${product.slug}`);
  await expect(page.getByTestId(`review-status-${product.slug}`)).toHaveText("Not reviewed");
  await expect(row.getByRole("link", { name: "Customer preview" })).toHaveAttribute("href", `/office/storefront-preview/en/products/${product.slug}`);
  await expectNoAxeViolations(page);

  await row.getByRole("link", { name: product.nameEn }).click();
  await expect(page.getByTestId("review-state")).toHaveText("Not reviewed yet.");
  await page.getByRole("button", { name: "Mark the current content as reviewed" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Review recorded" })).toBeVisible();
  await expect(page.getByTestId("review-state")).toContainText("the content has not changed since");
  await page.goto(`/office/product-reviews?q=${product.slug}`);
  await expect(page.getByTestId(`review-status-${product.slug}`)).toContainText("Current");

  await sql("update variants set price_paisa = price_paisa + 100, version = version + 1 where sku = $1", [product.skus[0]]);
  await page.reload();
  await expect(page.getByTestId(`review-status-${product.slug}`)).toHaveText("Outdated: changed since review");
  const [{ status }] = await sql("select status from products where id = $1", [product.productId]);
  expect(status).toBe("draft");
});
