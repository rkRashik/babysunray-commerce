import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { clearSignInLimits, ensureZones, expectLabelledFields, seedSku, signIn, submitAndWait, testDatabase, openPanel } from "./support";

// The Owner's order work and the customer's tracking page in a real browser, against the real server, Better
// Auth and PostgreSQL. Fictional customers and SKUs only.

test.beforeAll(ensureZones);

test.beforeEach(async ({ page }) => {
  await clearSignInLimits();
  page.on("dialog", (dialog) => void dialog.accept());
  await signIn(page);
});

async function configureZones(page: Page) {
  // Settings is a folded sidebar group: open it first.
  const nav = page.getByRole("navigation", { name: "Admin" });
  await nav.locator("summary").filter({ hasText: /^Settings$/ }).click();
  await nav.getByRole("link", { name: "Delivery charges" }).click();
  for (const zone of ["Dhaka City", "Outside Dhaka"]) {
    const section = page.getByRole("region", { name: zone });
    // Saved charges are shown as text until you choose to change them.
    await section.getByRole("button", { name: /^(Change|Set) charge$/ }).click();
    await section.getByLabel("Charge (BDT)").fill(zone === "Dhaka City" ? "60" : "120");
    await section.getByLabel("Take orders for this zone").check();
    await section.getByRole("button", { name: "Save charge" }).click();
    await expect(page.getByRole("status")).toHaveText("Delivery charge saved.");
  }
}

async function createOrder(page: Page, sku: string, quantity = 2) {
  await page.goto("/admin/orders/new");
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
  await page.getByRole("region", { name: "Next step" }).getByRole("button", { name: button }).click();
  await expect(page.getByTestId("order-version")).not.toHaveText(before);
}

/** Submits a form that changes the order and waits for the next version. */
async function save(page: Page, click: () => Promise<void>) {
  const before = await version(page);
  await click();
  await expect(page.getByTestId("order-version")).not.toHaveText(before);
}

async function stock(page: Page, sku: string) {
  await page.goto(`/admin/skus/${sku}`);
  return { onHand: await page.getByTestId("on-hand").textContent(), reservation: `Reserved for orders: ${await page.getByTestId("reserved").textContent()} · Available for new orders: ${await page.getByTestId("available").textContent()}` };
}

test("delivery charges, an assisted order, reservation, verification, packing, dispatch, delivery, COD and closing", async ({ page }) => {
  await configureZones(page);
  const sku = await seedSku(5, 50_000);
  const orderUrl = await createOrder(page, sku, 2);
  await expect(dimension(page, "order")).toHaveText("Pending verification");
  await expect(page.getByTestId("verification")).toContainText("Verify with the customer by");
  await expect(page.getByRole("region", { name: "Items" })).toContainText("৳ 1,060");
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
  await step(page, "Record delivery");
  await expect(dimension(page, "payment")).toHaveText("Nothing collected");
  const cod = page.getByRole("region", { name: "Cash on delivery" });
  await openPanel(page, "Record a payment");
  await cod.getByLabel("Courier collected").check();
  await cod.getByLabel("Amount (BDT)").fill("1060");
  await save(page, () => cod.getByRole("button", { name: "Record amount" }).click());
  await expect(dimension(page, "payment")).toHaveText("Collected, not fully settled");
  await expect(page.getByRole("region", { name: "Next step" })).not.toContainText("Close order");
  await openPanel(page, "Record a payment");
  await cod.getByLabel("Settled to me").check();
  await cod.getByLabel("Amount (BDT)").fill("1000");
  await save(page, () => cod.getByRole("button", { name: "Record amount" }).click());
  await expect(page.getByTestId("cod")).toContainText("৳ 60");
  await openPanel(page, "Record a payment");
  await cod.getByLabel("Settled to me").check();
  await cod.getByLabel("Amount (BDT)").fill("60");
  await save(page, () => cod.getByRole("button", { name: "Record amount" }).click());
  await expect(dimension(page, "payment")).toHaveText("Settled");
  // Settled, but delivered today: the order stays open until the 7-day return window has ended.
  await expect(page.getByRole("region", { name: "Next step" })).not.toContainText("Close order");
  await expect(page.getByTestId("close-hint")).toContainText("Can be closed after");
  const db = await testDatabase();
  try {
    await db.query("update orders set delivered_at = now() - interval '7 days 1 minute' where id = $1", [orderUrl.split("/").at(-1)]);
  } finally {
    await db.end();
  }
  await page.reload();
  await step(page, "Close order");
  await expect(dimension(page, "order")).toHaveText("Closed");
  await expect(page.getByRole("list", { name: "Order history" })).toContainText("COD settled to you");
  for (const path of [orderUrl, "/admin/orders", "/admin/orders/new", "/admin/settings/delivery"]) {
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
  await page.goto("/admin/orders?attention=true");
  await expect(page.getByRole("table", { name: "Orders" })).toContainText("Overdue by");
  await page.goto(orderUrl);
  await expect(page.getByTestId("verification")).toContainText("Verification expired — Owner review");
  // A second order releases the overdue hold first, then takes the unit.
  await createOrder(page, sku, 1);
  await page.goto(orderUrl);
  await page.getByRole("region", { name: "Next step" }).getByRole("button", { name: "Confirm order (verified with the customer)" }).click();
  await expect(page.getByRole("region", { name: "Next step" }).getByRole("alert")).toContainText("Not enough stock");
  await expect(dimension(page, "order")).toHaveText("Verification expired — Owner review");
});

test("readable errors: short stock, a wrong phone number, an unknown SKU", async ({ page }) => {
  const sku = await seedSku(1);
  await page.goto("/admin/orders/new");
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
  // No browser dialog is used on the tracking page: the question is asked in the page itself.
  guestPage.on("dialog", () => {
    throw new Error("The tracking page opened a browser dialog.");
  });
  const response = await guestPage.goto(link);
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  expect(response?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(response?.headers()["cache-control"]).toContain("no-store");
  await expect(guestPage.getByRole("heading", { level: 1 })).toContainText("Order ORD-");
  await expect(guestPage.getByText("T*** (017******05)")).toBeVisible();
  await expect(guestPage.locator("body")).not.toContainText("Test Customer");
  await expect(guestPage.locator("body")).not.toContainText("House 5");
  // Accessible and usable on a 360-pixel phone, in both languages; the language switch never touches the link.
  await guestPage.setViewportSize({ width: 360, height: 740 });
  for (const lang of ["English", "বাংলা"]) {
    if (lang !== "English") await guestPage.getByRole("button", { name: lang }).click();
    expect(await guestPage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    const axe = await new AxeBuilder({ page: guestPage }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    for (const el of await guestPage.locator("header button, header a, main button, main a").all()) {
      const box = await el.boundingBox();
      if (box) expect(Math.min(box.width, box.height), await el.innerText()).toBeGreaterThanOrEqual(43.5);
    }
  }
  await expect(guestPage.locator('[lang="bn"]').first()).toBeVisible();
  await guestPage.getByRole("button", { name: "English" }).click();
  // The cancel question is asked in the page; "No" changes nothing, "Yes" cancels.
  await guestPage.getByRole("button", { name: "Cancel order" }).click();
  await expect(guestPage.getByTestId("cancel-question")).toBeFocused();
  await guestPage.getByRole("button", { name: "No, keep the order" }).click();
  await expect(guestPage.getByTestId("cancel-question")).toHaveCount(0);
  await expect(guestPage.getByTestId("guest-order-status")).toHaveText("Received, waiting for the shop to confirm with you");
  await guestPage.getByRole("button", { name: "Cancel order" }).click();
  await guestPage.getByRole("button", { name: "Yes, cancel the order" }).click();
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
  await guestPage.getByRole("button", { name: "Yes, send the request" }).click();
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
  await submitAndWait(page, page.getByRole("region", { name: "Customer tracking link" }).getByRole("button", { name: "Revoke link" }));
  await guestPage.goto(link2);
  await expect(guestPage.getByRole("main").getByRole("alert")).toHaveText("This tracking link is not valid or has expired. Please contact the shop.");
  await guest.close();
});

test("guest tracking: the link leaves the address bar and the tab's history once opened; reloading needs the link again", async ({ page, browser, baseURL }) => {
  const sku = await seedSku(2);
  await createOrder(page, sku, 1);
  const tracking = page.getByRole("region", { name: "Customer tracking link" });
  await tracking.getByRole("button", { name: "Create link" }).click();
  const link = await tracking.getByRole("textbox").inputValue();
  const token = link.split("#t=")[1];

  const guest = await browser.newContext();
  const g = await guest.newPage();
  const requests: string[] = [];
  g.on("request", (r) => requests.push(r.url()));
  await g.goto(link);
  await expect(g.getByRole("heading", { level: 1 })).toContainText("Order ORD-");
  expect(g.url()).toBe(`${baseURL}/track`);
  expect(await g.evaluate(() => [window.location.hash, window.history.state === null || !JSON.stringify(window.history.state).includes("#t=")])).toEqual(["", true]);
  // Nothing is kept in the browser: no storage entry and no cookie.
  expect(await g.evaluate(() => JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage }))).not.toContain(token);
  expect(await guest.cookies()).toEqual([]);

  // Back to this entry from another page, or a reload: the token is gone, so the page asks for the link.
  await g.goto(`${baseURL}/`);
  await expect(g).toHaveURL(`${baseURL}/`);
  await g.goBack();
  await expect(g).toHaveURL(`${baseURL}/track`);
  await expect(g.getByRole("main").getByRole("alert")).toContainText("Open the tracking link from the shop's message");
  await g.reload();
  await expect(g.getByRole("main").getByRole("alert")).toContainText("needs the link again");

  // Opening the original link again works, and is cleaned up again.
  await g.goto(link);
  await expect(g.getByRole("heading", { level: 1 })).toContainText("Order ORD-");
  expect(g.url()).toBe(`${baseURL}/track`);
  for (const url of requests) {
    expect(url.startsWith(baseURL!), `third-party request: ${url}`).toBe(true);
    expect(url).not.toContain(token);
  }
  await guest.close();
});

test("RTO: the returned parcel goes to inspection, and only a passed inspection restocks it", async ({ page }) => {
  const sku = await seedSku(2);
  const orderUrl = await createOrder(page, sku, 2);
  for (const button of ["Confirm order (verified with the customer)", "Mark packed", "Dispatch"]) await step(page, button);
  await step(page, "Mark returned to sender (refused or undelivered)");
  await expect(dimension(page, "fulfilment")).toHaveText("Returning to sender (RTO)");
  // The progress strip: on its way back is the current step, not done, until the parcel is received.
  const progress = page.getByTestId("order-progress");
  await expect(progress.locator("[aria-current=step]")).toContainText("Returning to sender (next)");
  await expect(progress.locator("[data-done=true]")).toHaveCount(3);
  await step(page, "Receive returned parcel into inspection");
  await expect(page.getByTestId("inspection-status")).toHaveText("Awaiting inspection");
  await expect(progress.locator("[data-done=true]")).toHaveCount(4);
  await expect(progress.locator("[aria-current=step]")).toContainText("Closed (next)");
  expect(await stock(page, sku)).toMatchObject({ onHand: "0" });
  await page.goto(orderUrl);
  const cod = page.getByRole("region", { name: "Cash on delivery" });
  await openPanel(page, "Record the RTO charge");
  await cod.getByLabel("RTO charge billed by the courier (BDT)").fill("50");
  await save(page, () => cod.getByRole("button", { name: "Save RTO charge" }).click());
  await expect(page.getByTestId("cod")).toContainText("৳ 50");
  const inspection = page.getByRole("region", { name: "Inspection (quarantine)" });
  await inspection.getByLabel("Inspection note").fill("Sealed, tags on");
  await inspection.getByRole("button", { name: "Passed: back to stock" }).click();
  await expect(page.getByTestId("inspection-status")).toHaveText("Passed: back in stock");
  expect(await stock(page, sku)).toMatchObject({ onHand: "2" });
  await expect(page.getByRole("table")).toContainText("Returned to stock");
});

test("the order list finds an order by phone or name without putting either in the URL, and packs it from the row", async ({ page }) => {
  const sku = await seedSku(2);
  const orderUrl = await createOrder(page, sku, 1);
  const orderId = orderUrl.split("/").at(-1)!;
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto("/admin/orders");
  const search = page.getByRole("search", { name: "Find orders" });
  await search.getByLabel("Search orders").fill("01711 000005");
  await search.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/\/admin\/orders\?search=1$/);
  const table = page.getByRole("table", { name: "Orders" });
  await expect(table.locator(`[data-order="${orderId}"]`)).toBeVisible();
  await search.getByLabel("Search orders").fill("test custom");
  await search.getByRole("button", { name: "Search" }).click();
  await expect(table.locator(`[data-order="${orderId}"]`)).toBeVisible();
  // Neither the phone number nor the name ever appeared in a requested URL.
  expect(requests.filter((u) => /01711000005|1711-000005|01711%20000005|test(%20|\+)custom/i.test(u))).toEqual([]);
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page).toHaveURL(/\/admin\/orders$/);
  await expect(page.getByLabel("Search orders")).toHaveValue("");

  await page.goto(orderUrl);
  await step(page, "Confirm order (verified with the customer)");
  await page.goto("/admin/orders?queue=to_pack");
  await table.locator(`[data-order="${orderId}"]`).getByRole("button", { name: "Mark packed" }).click();
  await expect(page).toHaveURL(/\/admin\/orders\?queue=to_pack&done=pack$/);
  await expect(page.getByRole("status").first()).toHaveText("Order packed.");
  await expect(table.locator(`[data-order="${orderId}"]`)).toHaveCount(0);
  await page.goto(orderUrl);
  await expect(dimension(page, "fulfilment")).toHaveText("Packed");
  await expectNoAxe(page, "/admin/orders");
});

async function expectNoAxe(page: Page, path: string) {
  await page.goto(path);
  const results = await new AxeBuilder({ page }).include("main").analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
}

test("the order list packs several orders at once, confirms an overdue order with its warning, and filters as you type", async ({ page }) => {
  const sku = await seedSku(6);
  const urls = [await createOrder(page, sku, 1), await createOrder(page, sku, 1), await createOrder(page, sku, 1)];
  const ids = urls.map((u) => u.split("/").at(-1)!);
  // The third order passed its 24-hour deadline: it can still be verified, with a clear warning.
  const db = await testDatabase();
  try {
    await db.query("update orders set verification_expires_at = now() - interval '2 hours' where id = $1", [ids[2]]);
  } finally {
    await db.end();
  }
  const table = page.getByRole("table", { name: "Orders" });
  await page.goto("/admin/orders?attention=true");
  await expect(table.locator(`[data-order="${ids[2]}"]`)).toContainText("Overdue by");
  await table.locator(`[data-order="${ids[2]}"]`).getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("status").first()).toHaveText("Order confirmed.");
  await page.goto(urls[2]);
  await expect(dimension(page, "order")).toHaveText("Confirmed");

  for (const url of urls.slice(0, 2)) {
    await page.goto(url);
    await step(page, "Confirm order (verified with the customer)");
  }
  await page.goto("/admin/orders?queue=to_pack");
  for (const id of ids) await table.locator(`[data-order="${id}"] input.of-check`).check();
  await page.getByRole("button", { name: "Mark 3 packed" }).click();
  await expect(page.getByRole("region", { name: "Bulk result" })).toContainText("All 3 orders updated.");
  for (const url of urls) {
    await page.goto(url);
    await expect(dimension(page, "fulfilment")).toHaveText("Packed");
  }

  // Part of a phone number, mid-typing: a calm hint (a status, not an alert), and no list of everyone's orders.
  await page.goto("/admin/orders");
  await page.getByLabel("Search orders").fill("0171");
  await expect(page.getByTestId("search-hint")).toContainText("Keep typing");
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
  await expect(table).toHaveCount(0);

  // Filters apply as they change; nothing personal reaches the address.
  await page.goto("/admin/orders");
  await page.getByLabel("Order status").selectOption("confirmed");
  await expect(page).toHaveURL(/\/admin\/orders\?status=confirmed$/);
  await page.getByLabel("Search orders").fill("test custom");
  await expect(page).toHaveURL(/\/admin\/orders\?status=confirmed&search=1$/);
  await expect(table.locator(`[data-order="${ids[0]}"]`)).toBeVisible();
  await expect(page.getByLabel("Search orders")).toHaveValue("test custom");
});

test("a customer search does not survive signing out, and the quick view opens, closes and returns focus", async ({ page }) => {
  const sku = await seedSku(2);
  const orderUrl = await createOrder(page, sku, 1);
  const id = orderUrl.split("/").at(-1)!;
  await page.goto("/admin/orders");
  await page.getByLabel("Search orders").fill("test custom");
  await expect(page).toHaveURL(/\?search=1$/);
  expect((await page.context().cookies()).filter((c) => c.name === "bsr_order_search")).toHaveLength(1);

  // Quick view: the order's details without leaving the list; Escape closes it and focus returns to its button.
  const trigger = page.locator(`[data-order="${id}"] [data-quickview]`);
  await trigger.click();
  const drawer = page.getByRole("dialog", { name: "Order quick view" });
  await expect(drawer.getByRole("region", { name: "Items" })).toBeVisible();
  await expect(drawer.getByRole("region", { name: "Customer" })).toContainText("Test Customer");
  await expect(drawer.getByRole("link", { name: "Open full order" })).toHaveAttribute("href", `/admin/orders/${id}`);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();

  // Signing out forgets the search; signing in again does not bring it back.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  expect((await page.context().cookies()).filter((c) => c.name === "bsr_order_search")).toHaveLength(0);
  await clearSignInLimits();
  await signIn(page);
  await page.goto("/admin/orders?search=1");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("expired");
  await expect(page.getByLabel("Search orders")).toHaveValue("");
});
