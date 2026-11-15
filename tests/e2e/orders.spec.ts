import { expect, type Page, test } from "@playwright/test";
import { clearSignInLimits, ensureZones, expectLabelledFields, seedSku, signIn, submitAndWait, testDatabase } from "./support";

// The Owner's order work and the customer's tracking page in a real browser, against the real server, Better
// Auth and PostgreSQL. Fictional customers and SKUs only.

test.beforeAll(ensureZones);

test.beforeEach(async ({ page }) => {
  await clearSignInLimits();
  page.on("dialog", (dialog) => void dialog.accept());
  await signIn(page);
});

async function configureZones(page: Page) {
  await page.getByRole("navigation", { name: "Owner Office" }).getByRole("link", { name: "Delivery charges" }).click();
  for (const zone of ["Dhaka City", "Outside Dhaka"]) {
    const section = page.getByRole("region", { name: zone });
    await section.getByLabel("Charge (BDT)").fill(zone === "Dhaka City" ? "60" : "120");
    await section.getByLabel("Take orders for this zone").check();
    await section.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status")).toHaveText("Delivery charge saved.");
  }
}

async function createOrder(page: Page, sku: string, quantity = 2) {
  await page.goto("/office/orders/new");
  await page.getByLabel("WhatsApp").check();
  await page.getByLabel("Customer name").fill("Test Customer");
  await page.getByLabel("Phone").fill("+880 1711-000005");
  await page.getByLabel("Delivery address").fill("House 5, Test Road, Dhaka");
  await page.getByLabel(/^Dhaka City/).check();
  await page.getByLabel("SKU, line 1").fill(sku.toLowerCase());
  await page.getByLabel("Quantity, line 1").fill(String(quantity));
  await page.getByRole("button", { name: "Create order" }).click();
  await expect(page.getByRole("status").first()).toContainText("Order created");
  return page.url().split("?")[0];
}

const dimension = (page: Page, name: string) => page.locator(`[data-dimension="${name}"]`);

const version = async (page: Page) => (await page.getByTestId("order-version").textContent()) ?? "";

/** Presses a lifecycle button and waits for the next order version, so later steps never act on a stale form. */
async function step(page: Page, button: string) {
  const before = await version(page);
  await page.getByRole("region", { name: "Actions" }).getByRole("button", { name: button }).click();
  await expect(page.getByTestId("order-version")).not.toHaveText(before);
}

/** Submits a form that changes the order and waits for the next version. */
async function save(page: Page, click: () => Promise<void>) {
  const before = await version(page);
  await click();
  await expect(page.getByTestId("order-version")).not.toHaveText(before);
}

async function stock(page: Page, sku: string) {
  await page.goto(`/office/skus/${sku}`);
  return { onHand: await page.getByTestId("on-hand").textContent(), reservation: await page.getByTestId("reservation").textContent() };
}

test("delivery charges, an assisted order, reservation, verification, packing, dispatch, delivery, COD and closing", async ({ page }) => {
  await configureZones(page);
  const sku = await seedSku(5, 50_000);
  const orderUrl = await createOrder(page, sku, 2);
  await expect(dimension(page, "order")).toHaveText("Pending verification");
  await expect(page.getByTestId("verification")).toContainText("Verify with the customer by");
  await expect(page.getByRole("region", { name: "Items" })).toContainText("৳ 1060.00");
  expect(await stock(page, sku)).toEqual({ onHand: "5", reservation: "Reserved for orders: 2 · Available for new orders: 3" });

  await page.goto(orderUrl);
  await step(page, "Confirm order (verified with the customer)");
  await expect(dimension(page, "order")).toHaveText("Confirmed");
  await step(page, "Mark packed");
  await expect(dimension(page, "fulfilment")).toHaveText("Packed");
  await step(page, "Dispatch");
  await expect(page.getByRole("status").first()).toContainText("Order dispatched");
  await page.reload();
  await expect(dimension(page, "fulfilment")).toHaveText("Dispatched");
  expect(await stock(page, sku)).toEqual({ onHand: "3", reservation: "Reserved for orders: 0 · Available for new orders: 3" });

  await page.goto(orderUrl);
  await step(page, "Mark delivered");
  await expect(dimension(page, "payment")).toHaveText("Nothing collected");
  const cod = page.getByRole("region", { name: "Cash on delivery" });
  await cod.getByLabel("Courier collected").check();
  await cod.getByLabel("Amount (BDT)").fill("1060");
  await save(page, () => cod.getByRole("button", { name: "Record amount" }).click());
  await expect(dimension(page, "payment")).toHaveText("Collected, not fully settled");
  await expect(page.getByRole("region", { name: "Actions" })).not.toContainText("Close order");
  await cod.getByLabel("Settled to me").check();
  await cod.getByLabel("Amount (BDT)").fill("1000");
  await save(page, () => cod.getByRole("button", { name: "Record amount" }).click());
  await expect(page.getByTestId("cod")).toContainText("৳ 60.00");
  await cod.getByLabel("Settled to me").check();
  await cod.getByLabel("Amount (BDT)").fill("60");
  await save(page, () => cod.getByRole("button", { name: "Record amount" }).click());
  await expect(dimension(page, "payment")).toHaveText("Settled");
  await step(page, "Close order");
  await expect(dimension(page, "order")).toHaveText("Closed");
  await expect(page.getByRole("list", { name: "Order history" })).toContainText("cod settled");
  for (const path of [orderUrl, "/office/orders", "/office/orders/new", "/office/settings/delivery"]) {
    await page.goto(path);
    await expectLabelledFields(page);
  }
});

test("an order past its 24-hour deadline shows for review and is confirmed only with fresh stock", async ({ page }) => {
  const sku = await seedSku(1);
  const orderUrl = await createOrder(page, sku, 1);
  const db = await testDatabase();
  try {
    await db.query("update orders set verification_expires_at = now() - interval '1 minute' where id = $1", [orderUrl.split("/").at(-1)]);
  } finally {
    await db.end();
  }
  await page.goto("/office/orders?attention=true");
  await expect(page.getByRole("list", { name: "Orders" })).toContainText("Verification deadline passed");
  await page.goto(orderUrl);
  await expect(page.getByTestId("verification")).toContainText("Verification expired — Owner review");
  // A second order releases the overdue hold first, then takes the unit.
  await createOrder(page, sku, 1);
  await page.goto(orderUrl);
  await page.getByRole("region", { name: "Actions" }).getByRole("button", { name: "Confirm order (verified with the customer)" }).click();
  await expect(page.getByRole("region", { name: "Actions" }).getByRole("alert")).toContainText("Not enough stock");
  await expect(dimension(page, "order")).toHaveText("Verification expired — Owner review");
});

test("readable errors: short stock, a wrong phone number, an unknown SKU", async ({ page }) => {
  const sku = await seedSku(1);
  await page.goto("/office/orders/new");
  await page.getByLabel("Messenger").check();
  await page.getByLabel("Customer name").fill("Test Customer");
  await page.getByLabel("Phone").fill("12345");
  await page.getByLabel("Delivery address").fill("House 6, Test Road");
  await page.getByLabel(/^Dhaka City/).check();
  await page.getByLabel("SKU, line 1").fill(sku);
  await page.getByLabel("Quantity, line 1").fill("1");
  const alert = page.getByRole("main").getByRole("alert");
  await submitAndWait(page, page.getByRole("button", { name: "Create order" }));
  await expect(alert).toContainText("Phone must be a Bangladesh mobile number");
  await expect(page.getByLabel("Customer name")).toHaveValue("Test Customer");
  await page.getByLabel("Phone").fill("01711000006");
  await page.getByLabel("Quantity, line 1").fill("2");
  await submitAndWait(page, page.getByRole("button", { name: "Create order" }));
  await expect(alert).toContainText(`Not enough stock for ${sku}: 1 available, 2 needed.`);
  await page.getByLabel("SKU, line 1").fill("NO-SUCH-SKU");
  await submitAndWait(page, page.getByRole("button", { name: "Create order" }));
  await expect(alert).toContainText("No variant has the SKU NO-SUCH-SKU.");
});

test("guest tracking: masked view, direct cancellation while pending, a request after confirmation, Owner approval", async ({ page, browser, baseURL }) => {
  const sku = await seedSku(4);
  const pendingUrl = await createOrder(page, sku, 1);
  const tracking = page.getByRole("region", { name: "Customer tracking link" });
  await tracking.getByRole("button", { name: "Create link" }).click();
  const link = await tracking.getByRole("textbox").inputValue();
  expect(link).toMatch(new RegExp(`^${baseURL}/track#t=[A-Za-z0-9_-]{43}$`));

  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  const requests: string[] = [];
  guestPage.on("request", (r) => requests.push(r.url()));
  guestPage.on("dialog", (d) => void d.accept());
  const response = await guestPage.goto(link);
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  expect(response?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(response?.headers()["cache-control"]).toContain("no-store");
  await expect(guestPage.getByRole("heading", { level: 1 })).toContainText("Order ORD-");
  await expect(guestPage.getByText("T*** (017******05)")).toBeVisible();
  await expect(guestPage.locator("body")).not.toContainText("Test Customer");
  await expect(guestPage.locator("body")).not.toContainText("House 5");
  await guestPage.getByRole("button", { name: "Cancel order" }).click();
  await expect(guestPage.getByRole("status")).toHaveText("Your order is cancelled.");
  await expect(guestPage.getByTestId("guest-order-status")).toHaveText("Cancelled");
  const token = link.split("#t=")[1];
  for (const url of requests) {
    expect(url.startsWith(baseURL!), `third-party request: ${url}`).toBe(true);
    expect(url).not.toContain(token);
  }

  await page.goto(pendingUrl);
  await expect(dimension(page, "order")).toHaveText("Cancelled");
  await expect(page.getByRole("list", { name: "Order history" })).toContainText("Customer (tracking link)");

  // Confirmed before dispatch: the customer can only ask; the Owner decides.
  const confirmedUrl = await createOrder(page, sku, 2);
  await step(page, "Confirm order (verified with the customer)");
  await page.getByRole("region", { name: "Customer tracking link" }).getByRole("button", { name: "Create link" }).click();
  const link2 = await page.getByRole("region", { name: "Customer tracking link" }).getByRole("textbox").inputValue();
  await guestPage.goto(link2);
  await expect(guestPage.getByRole("button", { name: "Cancel order" })).toHaveCount(0);
  await guestPage.getByRole("button", { name: "Ask the shop to cancel" }).click();
  await expect(guestPage.getByRole("status")).toContainText("Your request was sent");
  expect(await stock(page, sku)).toMatchObject({ reservation: "Reserved for orders: 2 · Available for new orders: 2" });
  await page.goto(confirmedUrl);
  const request = page.getByRole("region", { name: "Cancellation request" });
  await expect(request).toContainText("The customer asked to cancel");
  await request.getByRole("button", { name: "Approve: cancel the order" }).click();
  await expect(dimension(page, "order")).toHaveText("Cancelled");
  expect(await stock(page, sku)).toMatchObject({ onHand: "4", reservation: "Reserved for orders: 0 · Available for new orders: 4" });

  // A revoked link shows the same generic message as any invalid one.
  await page.goto(confirmedUrl);
  await page.getByRole("region", { name: "Customer tracking link" }).getByRole("button", { name: "Revoke link" }).click();
  await guestPage.goto(link2);
  await guestPage.reload();
  await expect(guestPage.getByRole("main").getByRole("alert")).toHaveText("This tracking link is not valid or has expired. Please contact the shop.");
  await guest.close();
});

test("RTO: the returned parcel goes to inspection, and only a passed inspection restocks it", async ({ page }) => {
  const sku = await seedSku(2);
  const orderUrl = await createOrder(page, sku, 2);
  for (const button of ["Confirm order (verified with the customer)", "Mark packed", "Dispatch"]) await step(page, button);
  await step(page, "Mark returned to sender (refused or undelivered)");
  await expect(dimension(page, "fulfilment")).toHaveText("Returning to sender (RTO)");
  await step(page, "Receive returned parcel into inspection");
  await expect(page.getByTestId("inspection-status")).toHaveText("awaiting inspection");
  expect(await stock(page, sku)).toMatchObject({ onHand: "0" });
  await page.goto(orderUrl);
  const cod = page.getByRole("region", { name: "Cash on delivery" });
  await cod.getByLabel("RTO charge billed by the courier (BDT)").fill("50");
  await save(page, () => cod.getByRole("button", { name: "Save RTO charge" }).click());
  await expect(page.getByTestId("cod")).toContainText("৳ 50.00");
  const inspection = page.getByRole("region", { name: "Inspection (quarantine)" });
  await inspection.getByLabel("Inspection note").fill("Sealed, tags on");
  await inspection.getByRole("button", { name: "Passed: back to stock" }).click();
  await expect(page.getByTestId("inspection-status")).toHaveText("restocked");
  expect(await stock(page, sku)).toMatchObject({ onHand: "2" });
  await expect(page.getByRole("table")).toContainText("return_restock");
});
