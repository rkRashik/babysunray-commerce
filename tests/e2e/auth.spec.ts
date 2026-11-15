import { expect, test } from "@playwright/test";
import { clearSignInLimits, E2E_OWNER, signIn } from "./support";

// Sign-in, sign-out and access control in a real browser, against the real Better Auth handler and PostgreSQL.

test.beforeEach(clearSignInLimits);

test("an anonymous visitor is sent to the sign-in page from every Office page", async ({ page }) => {
  for (const path of ["/office", "/office/products/new", "/office/products/00000000-0000-4000-8000-000000000000", "/office/skus/ANY-SKU"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/office\/login$/);
    await expect(page.getByRole("heading", { level: 1, name: "Owner Office sign-in" })).toBeVisible();
  }
});

test("a wrong password shows a safe error and no session", async ({ page, context }) => {
  await page.goto("/office/login");
  await page.getByLabel("Email").fill(E2E_OWNER.email);
  await page.getByLabel("Password").fill("not the right password at all");
  await page.getByRole("button", { name: "Sign in" }).click();
  // Inside the page: Next.js also has a route announcer with role="alert".
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toHaveText("The email or password is not correct.");
  await expect(page).toHaveURL(/\/office\/login$/);
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

test("signing out ends the session on the server, and the old cookie no longer opens the Office", async ({ page, context, browser }) => {
  await signIn(page);
  const cookies = await context.cookies();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/office\/login$/);
  await page.goto("/office");
  await expect(page).toHaveURL(/\/office\/login$/);

  // Replay the cookie captured before sign-out in a fresh browser context: the server refuses it.
  const replay = await browser.newContext();
  await replay.addCookies(cookies);
  const other = await replay.newPage();
  await other.goto("/office");
  await expect(other).toHaveURL(/\/office\/login$/);
  await replay.close();
});

test("a signed-in Owner who opens the sign-in page goes to the products", async ({ page }) => {
  await signIn(page);
  await page.goto("/office/login");
  await expect(page).toHaveURL(/\/office$/);
});

test("repeated wrong passwords hit the sign-in rate limit with a clear message", async ({ page }) => {
  await page.goto("/office/login");
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
