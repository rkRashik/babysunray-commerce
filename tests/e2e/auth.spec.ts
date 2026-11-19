import { expect, test } from "@playwright/test";
import { clearSignInLimits, E2E_OWNER, signIn, testDatabase, uniqueName } from "./support";

// Sign-in, sign-out and access control in a real browser, against the real Better Auth handler and PostgreSQL.

test.beforeEach(clearSignInLimits);

test("an anonymous visitor is sent to the sign-in page from every Admin page", async ({ page }) => {
  for (const path of ["/admin", "/admin/products/new", "/admin/products/00000000-0000-4000-8000-000000000000", "/admin/skus/ANY-SKU"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/admin\/login$/);
    await expect(page.getByRole("heading", { level: 1, name: "Admin sign-in" })).toBeVisible();
  }
});

test("a wrong password shows a safe error and no session", async ({ page, context }) => {
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill(E2E_OWNER.email);
  await page.getByLabel("Password").fill("not the right password at all");
  await page.getByRole("button", { name: "Sign in" }).click();
  // Inside the page: Next.js also has a route announcer with role="alert".
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toHaveText("The email or password is not correct.");
  await expect(page).toHaveURL(/\/admin\/login$/);
  expect((await context.cookies()).filter((c) => c.name.includes("session_token"))).toHaveLength(0);
  // The same message for an unknown account: nothing tells which accounts exist.
  await page.getByLabel("Email").fill("nobody@example.test");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(alert).toHaveText("The email or password is not correct.");
});

test("the Owner signs in with an HttpOnly session cookie and no token in page storage", async ({ page, context }) => {
  await signIn(page);
  const session = (await context.cookies()).find((c) => c.name.includes("session_token"));
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe("Lax");
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie }));
  expect(stored).toBe(JSON.stringify({ local: {}, session: {}, cookie: "" }));
});

test("signing out ends the session on the server, and the old cookie no longer opens Admin", async ({ page, context, browser }) => {
  await signIn(page);
  const cookies = await context.cookies();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/);

  // Replay the cookie captured before sign-out in a fresh browser context: the server refuses it.
  const replay = await browser.newContext();
  await replay.addCookies(cookies);
  const other = await replay.newPage();
  await other.goto("/admin");
  await expect(other).toHaveURL(/\/admin\/login$/);
  await replay.close();
});

test("a signed-in Owner who opens the sign-in page goes to the products", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/login");
  await expect(page).toHaveURL(/\/admin$/);
});

test("repeated wrong passwords hit the sign-in rate limit with a clear message", async ({ page }) => {
  await page.goto("/admin/login");
  const alert = page.getByRole("main").getByRole("alert");
  await page.getByLabel("Email").fill(E2E_OWNER.email);
  await page.getByLabel("Password").fill("not the right password at all");
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(alert).toHaveText("The email or password is not correct.");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
  }
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(alert).toHaveText("Too many attempts. Wait a few seconds and try again.");
});

test("a session that expires while a form is open sends the Owner to sign-in and saves nothing", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/products/new");
  const { slug } = uniqueName("e2e-expired");
  await page.getByLabel("Slug").fill(slug);
  await page.getByLabel("Name (English)").fill("Never Saved");
  const db = await testDatabase();
  try {
    await db.query("update auth_sessions set expires_at = now() - interval '1 minute'");
    await page.getByRole("button", { name: "Create draft" }).click();
    await expect(page).toHaveURL(/\/admin\/login$/);
    const { rows } = await db.query("select count(*)::int as n from products where slug = $1", [slug]);
    expect(rows[0].n).toBe(0);
  } finally {
    await db.end();
  }
});

test("before the page's script runs, the sign-in form cannot be submitted, so a password never reaches a URL", async ({ browser, baseURL }) => {
  // No JavaScript at all: the state of every browser between the HTML arriving and the script taking over.
  const context = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true, baseURL });
  const page = await context.newPage();
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill(E2E_OWNER.email);
  await page.getByLabel("Password").fill("a fictional password long enough");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeDisabled();
  await page.getByLabel("Password").press("Enter");
  await page.waitForTimeout(500);
  expect(page.url()).not.toMatch(/password|email=/);
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.locator("form")).toHaveAttribute("method", "post");
  await context.close();
});

test("first-time setup is closed once an Owner exists, and recovery refuses a wrong code", async ({ page }) => {
  await page.goto("/admin/setup");
  await expect(page.getByTestId("setup-closed")).toContainText("already set up");
  await page.goto("/admin/login");
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await page.getByLabel("Owner email").fill("e2e-owner@example.test");
  await page.getByLabel("Recovery code").fill("AAAAA-BBBBB-CCCCC-DDDDD");
  await page.getByLabel("New password", { exact: true }).fill("a fictional new long password");
  await page.getByLabel("New password again").fill("a fictional new long password");
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.getByText("The email or recovery code is not right")).toBeVisible();
});
