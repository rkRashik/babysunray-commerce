import { expect, type Page, test } from "@playwright/test";
import { clearSignInLimits, ensureZones, expectLabelledFields, expectNoAxeViolations, seedStorefrontProduct, signIn, testDatabase } from "./support";

// Staff & access and manual advance payments (ADR-0013) in real browsers against the real server, Better Auth and
// PostgreSQL: the Owner invites Orders Staff, the invitation is accepted in another browser, staff see only their pages
// and are refused the Owner's; the Owner sets up bKash, a separate shopper (founder acceptance) orders and pays "by bKash",
// sends a transaction ID on the private tracking page, and only the Owner's verification marks the money received.
// Fictional people, numbers and references only.

const STAFF_PASSWORD = "a long staff password for the browser test";
const chip = (page: Page, text: string) => page.locator("label").filter({ has: page.getByText(text, { exact: true }) }).first();

test.beforeAll(ensureZones);

// The shop and later specs see cash on delivery only again (test database only).
test.afterAll(async () => {
  const db = await testDatabase();
  try {
    await db.query("delete from payment_methods");
  } finally {
    await db.end();
  }
});

test.beforeEach(async ({ page }) => {
  await clearSignInLimits();
  page.on("dialog", (dialog) => void dialog.accept());
});

test("the Owner invites Orders Staff, who join with their own password and see only their pages", async ({ page, browser }) => {
  await signIn(page);
  await page.goto("/admin/staff");
  await expect(page.getByRole("heading", { level: 1, name: "Staff & access" })).toBeVisible();
  await expect(page.getByTestId("role-guide")).toContainText("Orders Staff");
  await expectLabelledFields(page);
  await expectNoAxeViolations(page);
  const email = `e2e-staff-${Date.now()}@example.test`;
  const invite = page.getByRole("region", { name: "Invite someone" });
  await invite.getByLabel("Their email").fill(email);
  await invite.getByLabel("Role").selectOption("orders");
  await invite.getByRole("button", { name: /Send invitation|Create invitation link/ }).click();
  // Email is not set up in the browser tests: the link is shown once, to pass on privately.
  const link = await page.getByTestId("one-time-link").getByRole("textbox").inputValue();
  expect(link).toMatch(/\/admin\/invite#t=[A-Za-z0-9_-]{43}$/);

  // In another browser, the person accepts with their own name and password; the link leaves the address bar.
  const staffContext = await browser.newContext();
  const staff = await staffContext.newPage();
  await staff.goto(link);
  await expect(staff.getByTestId("invite-form")).toContainText("Orders Staff");
  expect(staff.url()).not.toContain("#t=");
  await staff.getByLabel("Your name").fill("E2E Orders Staff");
  await staff.getByLabel("Password", { exact: true }).fill(STAFF_PASSWORD);
  await staff.getByLabel("Password again").fill(STAFF_PASSWORD);
  await staff.getByRole("button", { name: "Create my account" }).click();
  await expect(staff.getByTestId("invite-done")).toContainText("Your account is ready");
  // The same link never works twice (opened afresh, as from the message again).
  await staff.goto("about:blank");
  await staff.goto(link);
  await expect(staff.getByTestId("invite-error")).toContainText("not valid");

  await staff.goto("/admin/login");
  await staff.getByLabel("Email").fill(email);
  await staff.getByLabel("Password").fill(STAFF_PASSWORD);
  await staff.getByRole("button", { name: "Sign in" }).click();
  await expect(staff).toHaveURL(/\/admin$/);
  await expect(staff.getByTestId("admin-role")).toHaveText("Orders Staff");
  const nav = staff.getByRole("navigation", { name: "Admin" });
  await expect(nav.getByRole("link", { name: "Orders" })).toBeVisible();
  for (const hidden of ["Staff & access", "Payment methods", "Store settings", "Exports", "Reports", "Dashboard"]) await expect(nav.getByRole("link", { name: hidden })).toHaveCount(0);
  // Typing an Owner page's address is refused on the server, not only hidden.
  for (const path of ["/admin/staff", "/admin/settings/payments", "/admin/settings/store", "/admin/exports"]) {
    await staff.goto(path);
    await expect(staff.getByRole("heading", { name: "This page could not be shown" }), path).toBeVisible();
  }

  // The Owner sees the new person, with the history naming who did what; disabling signs them out at once.
  await page.reload();
  const member = page.getByTestId("staff-member").filter({ hasText: email });
  await expect(member.getByTestId("staff-role")).toHaveText("Orders Staff");
  await expect(page.getByTestId("access-history")).toContainText("accepted the invitation as Orders Staff");
  await member.locator("summary").click();
  await member.getByRole("button", { name: "Disable access" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Access disabled" })).toBeVisible();
  await staff.goto("/admin/orders");
  await expect(staff).toHaveURL(/\/admin\/login$/);
  await staffContext.close();
});

test("bKash advance payment: the Owner sets it up, a shopper pays, sends the ID, and only the Owner's check marks it received", async ({ page, browser }) => {
  test.setTimeout(300_000);
  await signIn(page);

  // Payment methods: off until the Owner enters the receiving details and approves them.
  await page.goto("/admin/settings/payments");
  await expect(page.getByTestId("method-bkash")).toContainText("Not set up");
  const bkash = page.getByRole("region", { name: "bKash" });
  await bkash.getByRole("button", { name: "Set up" }).click();
  await bkash.getByLabel("Account name").fill("E2E Test Shop");
  await bkash.getByLabel("bKash receiving number").fill("01811000999");
  await bkash.getByLabel("Account type").selectOption("merchant");
  await bkash.getByLabel("Offer bKash to customers").check();
  await bkash.getByRole("button", { name: "Save payment method" }).click();
  await expect(bkash.getByRole("alert")).toContainText("confirm that this account may receive");
  // What was typed and chosen stays after the error.
  await expect(bkash.getByLabel("Account type")).toHaveValue("merchant");
  await bkash.getByLabel(/I confirm this account is mine/).check();
  await bkash.getByRole("button", { name: "Save payment method" }).click();
  await expect(page.getByTestId("method-bkash-state")).toHaveText("Offered to customers");
  await expectNoAxeViolations(page);

  // A published product and a separate shopper in founder acceptance (the test database is marked staging).
  const product = await seedStorefrontProduct();
  await page.goto(`/admin/products/${product.productId}`);
  await page.getByRole("button", { name: "Mark the current content as reviewed" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Review recorded" })).toBeVisible();
  await page.getByRole("button", { name: "Publish to the shop" }).click();
  await expect(page.getByTestId("publication-state")).toContainText("Published");
  const shopperContext = await browser.newContext();
  const shopper = await shopperContext.newPage();
  await clearSignInLimits();
  await signIn(shopper);
  await shopper.goto("/admin/acceptance");
  await shopper.getByRole("button", { name: "Start acceptance in this browser" }).click();
  await expect(shopper.getByTestId("pass-state")).toContainText("Holds an acceptance pass");
  await shopperContext.clearCookies({ name: /session_token/ });

  await shopper.goto(`/en/products/${product.slug}`);
  await chip(shopper, "0-3M").click();
  await chip(shopper, "Ivory").click();
  await shopper.getByRole("button", { name: "Add to Bag", exact: true }).click();
  await expect(shopper.getByTestId("cart-count")).toHaveText("1");
  await shopper.goto("/en/checkout");
  await shopper.getByLabel("Full name").fill("Fictional Advance Customer");
  await shopper.getByLabel("Mobile number").fill("01711000124");
  await shopper.getByRole("button", { name: "Continue" }).click();
  await shopper.getByLabel("Delivery address").fill("House 14, Fictional Road, Dhaka");
  await chip(shopper, "Dhaka City").click();
  await shopper.getByRole("button", { name: "Continue" }).click();
  const choice = shopper.getByTestId("payment-choice");
  await expect(choice).toContainText("Cash on Delivery");
  await choice.getByLabel(/Pay in advance by bKash/).check();
  await expect(choice).toContainText("This is not an online payment");
  await expectNoAxeViolations(shopper);
  const answered = shopper.waitForResponse((r) => r.url().endsWith("/api/shop/checkout"));
  await shopper.getByRole("button", { name: "Place order" }).click();
  expect((await answered).status()).toBe(201);
  // Where to send the exact total, and the reminder that nothing is paid yet.
  const instructions = shopper.getByTestId("payment-instructions");
  await expect(instructions).toContainText("bKash");
  await expect(shopper.getByTestId("payment-number")).toHaveText("01811000999");
  await expect(shopper.getByTestId("payment-amount")).toHaveText("৳ 910");
  const reference = ((await shopper.getByTestId("order-reference").textContent()) ?? "").trim();
  const trackingUrl = ((await shopper.getByTestId("tracking-url").textContent()) ?? "").trim();

  // On the private order page: waiting for the payment; the shopper sends the transaction ID.
  await shopper.goto(trackingUrl);
  await expect(shopper.getByTestId("guest-payment-state")).toHaveText("Waiting for your advance payment");
  await shopper.getByLabel("Transaction ID").fill("9e2e7b6c5d");
  await shopper.getByRole("button", { name: "Send transaction ID" }).click();
  await expect(shopper.getByTestId("guest-payment-state")).toHaveText("Transaction ID received: awaiting the shop's verification");
  await expectNoAxeViolations(shopper);

  // The Owner finds it waiting, checks the account, and verifies what arrived.
  await page.goto("/admin/orders?queue=payment_to_verify");
  await page.getByRole("link", { name: reference, exact: true }).click();
  const manual = page.getByRole("region", { name: "Manual payment" });
  await expect(manual.getByTestId("advance-reference")).toContainText("9E2E7B6C5D");
  await expect(manual.getByTestId("advance-received")).toHaveText("৳ 0");
  await expect(page.locator('[data-dimension="payment"]')).toHaveText("Nothing received");
  await manual.getByRole("button", { name: "Verify: money received" }).click();
  await expect(page.getByRole("status").filter({ hasText: "verified" })).toBeVisible();
  await expect(manual.getByTestId("advance-received")).toHaveText("৳ 910");
  await expect(manual.getByTestId("advance-due")).toHaveText("৳ 0");
  await expect(page.getByRole("list", { name: "Order history" })).toContainText("Advance payment verified as received");
  // Verifying money never confirms the order: that is still the Owner's call with the customer.
  await expect(page.locator('[data-dimension="order"]')).toHaveText("Pending verification");
  await expectNoAxeViolations(page);

  await shopper.goto(trackingUrl);
  await expect(shopper.getByTestId("guest-payment-state")).toHaveText("Payment verified by the shop");
  await expect(shopper.getByTestId("reference-form")).toHaveCount(0);
  await shopperContext.close();
});
