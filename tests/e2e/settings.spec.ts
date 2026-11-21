import { expect, type Page, test } from "@playwright/test";
import sharp from "sharp";
import { clearSignInLimits, ensureZones, expectLabelledFields, expectNoAxeViolations, productOf, seedSku, signIn, smallTargets } from "./support";

// Store settings and Delivery charges in a real browser: saved values shown as text until "Edit", Cancel and the
// unsaved-changes questions, a validation error that keeps what was typed, the logo replacement (choose, preview,
// client-side rejection, cancel, save, a file the server rejects, removal), the customer account email status, the
// folded sidebar groups and the staging notice. Fictional values only, in babysunray_test.

test.beforeEach(async ({ page }) => {
  await clearSignInLimits();
  await signIn(page);
});

const logoPng = () => sharp({ create: { width: 360, height: 96, channels: 4, background: { r: 120, g: 80, b: 50, alpha: 1 } } }).png().toBuffer();

test("store details are text until Edit; Cancel and leaving ask first; saving shows the saved values", async ({ page }) => {
  const name = `Fictional Kids ${Date.now().toString(36)}`;
  await page.goto("/admin/settings/store");
  await expect(page.getByTestId("staging-notice")).toContainText("Test database (staging)");
  const details = page.getByRole("region", { name: "Store details" });
  await expect(details.getByRole("textbox")).toHaveCount(0);
  await expectNoAxeViolations(page);

  // Cancel with nothing typed: no question, back to the text view, focus on Edit details.
  await details.getByRole("button", { name: "Edit details" }).click();
  await expect(details.getByLabel("Store name")).toBeFocused();
  await expect(details.getByRole("button", { name: "Save changes" })).toBeVisible();
  await expectLabelledFields(page);
  await expectNoAxeViolations(page);
  await details.getByRole("button", { name: "Cancel" }).click();
  await expect(details.getByRole("textbox")).toHaveCount(0);
  await expect(details.getByRole("button", { name: "Edit details" })).toBeFocused();

  // Typed changes: following a link asks first (refused: still here, nothing lost); Cancel asks to discard.
  await details.getByRole("button", { name: "Edit details" }).click();
  await details.getByLabel("Store name").fill(name);
  let asked = "";
  page.once("dialog", (dialog) => {
    asked = dialog.message();
    void dialog.dismiss();
  });
  await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Dashboard" }).click();
  await expect.poll(() => asked).toContain("not been saved");
  await expect(page).toHaveURL(/\/admin\/settings\/store/);
  await expect(details.getByLabel("Store name")).toHaveValue(name);
  page.once("dialog", (dialog) => void dialog.accept());
  await details.getByRole("button", { name: "Cancel" }).click();
  await expect(details.getByRole("textbox")).toHaveCount(0);
  await expect(details).not.toContainText(name);

  // A rejected value keeps what was typed and stays in the form; a valid save shows the text view with the new name.
  await details.getByRole("button", { name: "Edit details" }).click();
  await details.getByLabel("Store name").fill(name);
  await details.getByLabel("Email").fill("not-an-email");
  await details.getByRole("button", { name: "Save changes" }).click();
  await expect(details.getByRole("alert")).toContainText("email");
  await expect(details.getByLabel("Store name")).toHaveValue(name);
  await details.getByLabel("Email").fill("");
  await details.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toHaveText("Store details saved.");
  await expect(details.getByRole("textbox")).toHaveCount(0);
  await expect(details.getByTestId("store-details")).toContainText(name);
});

test("the logo is replaced only after choosing, previewing and saving; a rejected file changes nothing", async ({ page }) => {
  await page.goto("/admin/settings/store");
  const logo = page.getByRole("region", { name: "Logo" });
  await expect(logo.getByText("In use")).toBeVisible();
  await expect(logo.locator("input[type=file]")).toHaveCount(0);

  // Choose: a file of the wrong type is refused in the page; Cancel closes without a change.
  await logo.getByRole("button", { name: "Replace logo" }).click();
  const picker = logo.getByLabel(/^New logo/);
  await expect(picker).toBeFocused();
  await expect(logo.getByRole("button", { name: "Save logo" })).toBeDisabled();
  await picker.setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not an image") });
  await expect(logo.getByRole("alert")).toContainText("cannot be used");
  await expect(logo.getByRole("button", { name: "Save logo" })).toBeDisabled();
  await picker.setInputFiles({ name: "fictional-logo.png", mimeType: "image/png", buffer: await logoPng() });
  await expect(logo.getByRole("img", { name: "Preview of the chosen file" })).toBeVisible();
  await expect(logo).toContainText("fictional-logo.png");
  await expectNoAxeViolations(page);
  await logo.getByRole("button", { name: "Cancel" }).click();
  await expect(logo.locator("input[type=file]")).toHaveCount(0);
  await expect(logo.getByRole("button", { name: "Replace logo" })).toBeFocused();

  // Save: the uploaded logo is in use.
  await logo.getByRole("button", { name: "Replace logo" }).click();
  await logo.getByLabel(/^New logo/).setInputFiles({ name: "fictional-logo.png", mimeType: "image/png", buffer: await logoPng() });
  await logo.getByRole("button", { name: "Save logo" }).click();
  await expect(page.getByRole("status")).toHaveText("Logo saved.");
  await expect(logo.getByTestId("logo-source")).toContainText("Uploaded here");

  // A file that claims to be a PNG but is not one: the server refuses it and the logo in use stays.
  // The save above reloaded the whole page (a plain form post and redirect); "Replace logo" only works once the page's
  // scripts have loaded, and a click before that is lost (seen under `next dev`, where the first load compiles).
  await page.waitForLoadState("networkidle");
  await logo.getByRole("button", { name: "Replace logo" }).click();
  await logo.getByLabel(/^New logo/).setInputFiles({ name: "fake.png", mimeType: "image/png", buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>") });
  await logo.getByRole("button", { name: "Save logo" }).click();
  await expect(logo.getByRole("alert")).toContainText("The logo in use has not changed.");
  await expect(logo.getByTestId("logo-source")).toContainText("Uploaded here");

  // Removal asks first; refusing sends nothing.
  page.once("dialog", (dialog) => void dialog.dismiss());
  await logo.getByRole("button", { name: "Remove uploaded logo" }).click();
  await expect(logo.getByRole("button", { name: "Remove uploaded logo" })).toBeEnabled();
  await expect(logo.getByTestId("logo-source")).toContainText("Uploaded here");
  page.once("dialog", (dialog) => void dialog.accept());
  await logo.getByRole("button", { name: "Remove uploaded logo" }).click();
  await expect(page.getByRole("status")).toHaveText("Logo removed.");
  await expect(logo.getByTestId("logo-source")).toContainText("No logo uploaded here");
});

test("customer account emails say what they are and never claim delivery was checked", async ({ page }) => {
  await page.goto("/admin/settings/store");
  const email = page.getByRole("region", { name: "Customer account emails" });
  await expect(email).toContainText("verification email");
  await expect(email).toContainText("password reset email");
  await expect(email.getByTestId("email-state")).toContainText("Email service");
  await expect(email.getByTestId("email-state")).toContainText("Not checked");
  // Setting names are for whoever sets up the website: never on view by default.
  await expect(email.getByText(/RESEND_API_KEY/)).toBeHidden();
});

test("delivery charges are text until changed; the folded Settings group opens with the keyboard", async ({ page }) => {
  await ensureZones();
  await page.goto("/admin/dashboard");
  const nav = page.getByRole("navigation", { name: "Admin" });
  await expect(nav.getByRole("link", { name: "Delivery charges" })).toBeHidden();
  await nav.locator("summary").filter({ hasText: /^Settings$/ }).focus();
  await page.keyboard.press("Enter");
  await nav.getByRole("link", { name: "Delivery charges" }).click();
  // On a settings page its group is open and the page is marked current.
  await expect(nav.getByRole("link", { name: "Delivery charges" })).toHaveAttribute("aria-current", "page");

  const zone = page.getByRole("region", { name: "Dhaka City" });
  await expect(zone.getByTestId("zone-dhaka_city")).toContainText("৳");
  await expect(zone.getByRole("textbox")).toHaveCount(0);
  await zone.getByRole("button", { name: "Change charge" }).click();
  await expect(zone.getByLabel("Charge (BDT)")).toBeFocused();
  await zone.getByRole("button", { name: "Cancel" }).click();
  await expect(zone.getByRole("textbox")).toHaveCount(0);
  await expectNoAxeViolations(page);
});

/** The file picker opens the system file dialog from the keyboard and shows a focus ring when reached with the keyboard. */
async function expectKeyboardFilePicker(page: Page, label: RegExp) {
  // Keys sent before the page has finished loading its scripts can be lost.
  await page.waitForLoadState("networkidle");
  const picker = page.getByLabel(label);
  await picker.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(picker).toBeFocused();
  const ring = await picker.evaluate((input) => getComputedStyle(input.closest(".of-file")!).outlineStyle);
  expect(ring).toBe("solid");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 10_000 }), page.keyboard.press("Space")]);
  expect(chooser.isMultiple()).toBe(false);
}

test("the changed pages work with the keyboard, pass axe, and fit a phone with 44-pixel controls", async ({ page }) => {
  await ensureZones();
  const { id } = await productOf(await seedSku(2));

  // Product photos and catalogue import use the same file picker.
  await page.goto(`/admin/products/${id}/photos`);
  await expectKeyboardFilePicker(page, /^Photo \(required\)$/);
  await expectNoAxeViolations(page);
  await page.goto("/admin/import");
  await expectKeyboardFilePicker(page, /^Catalogue file/);
  await expectNoAxeViolations(page);
  await page.goto("/admin/settings/store");
  await page.getByRole("button", { name: "Replace logo" }).click();
  await expectKeyboardFilePicker(page, /^New logo/);

  // A phone: no sideways scrolling and no control under 44 px, in every state of the changed pages.
  await page.setViewportSize({ width: 390, height: 844 });
  const check = async (state: string) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${state}: sideways scroll`).toBeLessThanOrEqual(0);
    expect(await smallTargets(page), state).toEqual([]);
  };
  for (const path of ["/admin/dashboard", "/admin/settings/store", "/admin/settings/delivery", "/admin/import", `/admin/products/${id}/photos`]) {
    await page.goto(path);
    await check(path);
  }
  await page.goto("/admin/settings/store");
  await page.getByRole("button", { name: "Edit details" }).click();
  await check("store details, editing");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Replace logo" }).click();
  await page.getByLabel(/^New logo/).setInputFiles({ name: "fictional-logo.png", mimeType: "image/png", buffer: await logoPng() });
  await check("logo, file chosen");
  await page.goto("/admin/settings/delivery");
  await page.getByRole("region", { name: "Dhaka City" }).getByRole("button", { name: "Change charge" }).click();
  await check("delivery charge, editing");
});
