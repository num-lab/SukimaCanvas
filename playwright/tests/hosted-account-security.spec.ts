import { expect, test } from "../fixtures/test";
import { readAccountEmailLink } from "../helpers/hostedOutbox";

test.use({
  serverOptions: {
    env: { WBO_HOSTED_MODE: "true" },
  },
});

/**
 * Registers, verifies through the outbox link, and logs in, leaving the page
 * signed in on the current context.
 */
async function registerVerifyAndLogin(
  page: import("@playwright/test").Page,
  server: Parameters<typeof readAccountEmailLink>[0],
  email: string,
  password: string,
) {
  await page.goto(`${server.serverUrl}/register?lang=en`);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("checkbox", { name: /18 years old/ }).check();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your inbox" }),
  ).toBeVisible();

  const verifyLink = await readAccountEmailLink(server, email, "verify");
  await page.goto(verifyLink);
  await expect(page).toHaveURL(/\/login\?verified=1$/);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.locator(".hosted-account-email")).toHaveText(email);
}

test.describe("hosted account recovery and session security", () => {
  test("forgotten passwords are recovered through a single-use email link", async ({
    page,
    server,
  }) => {
    const email = `recover-${Date.now()}@example.com`;
    const originalPassword = "the original long password";
    const newPassword = "the replacement password";
    await registerVerifyAndLogin(page, server, email, originalPassword);
    await page.goto(`${server.serverUrl}/logout?lang=en`);
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page.locator(".hosted-account-email")).toHaveCount(0);

    // Request the reset; the response never echoes account state.
    await page.goto(`${server.serverUrl}/forgot?lang=en`);
    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText(/reset link is on its way/)).toBeVisible();

    const resetLink = await readAccountEmailLink(server, email, "reset");
    await page.goto(resetLink);
    await page.getByLabel("New password", { exact: true }).fill(newPassword);
    await page.getByRole("button", { name: "Save new password" }).click();
    await expect(page).toHaveURL(/\/login\?reset=1$/);
    await expect(page.getByText(/password has been changed/)).toBeVisible();

    // The old password is dead; the new one signs in.
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(originalPassword);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(
      page.getByText("Incorrect email address or password."),
    ).toBeVisible();

    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(newPassword);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.locator(".hosted-account-email")).toHaveText(email);
  });

  test("the account page lists sessions and revokes other devices", async ({
    page,
    browser,
    server,
  }) => {
    const email = `sessions-${Date.now()}@example.com`;
    const password = "a sturdy session password";
    await registerVerifyAndLogin(page, server, email, password);

    // A second device signs into the same account.
    const secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    await secondPage.goto(`${server.serverUrl}/login?lang=en`);
    await secondPage.getByLabel("Email address").fill(email);
    await secondPage.getByLabel("Password", { exact: true }).fill(password);
    await secondPage.getByRole("button", { name: "Log in" }).click();
    await expect(secondPage.locator(".hosted-account-email")).toHaveText(email);

    // The primary device sees both sessions and marks its own.
    await page.goto(`${server.serverUrl}/account?lang=en`);
    await expect(
      page.getByRole("heading", { name: "Active sessions" }),
    ).toBeVisible();
    await expect(page.locator(".hosted-session-item")).toHaveCount(2);
    await expect(page.getByText("This device")).toHaveCount(1);

    // Revoking the other device's session locks that browser out while the
    // primary device keeps working.
    const otherRow = page
      .locator(".hosted-session-item")
      .filter({ hasNot: page.getByText("This device") });
    await otherRow.getByRole("button", { name: "Revoke" }).click();
    await expect(page.locator(".hosted-session-item")).toHaveCount(1);

    await secondPage.goto(`${server.serverUrl}/account`);
    await expect(secondPage).toHaveURL(/\/login$/);

    await page.goto(`${server.serverUrl}/account`);
    await expect(page.locator(".hosted-account-email")).toHaveText(email);
    await secondContext.close();
  });

  test("changing the password from the account page keeps this device signed in", async ({
    page,
    server,
  }) => {
    const email = `change-${Date.now()}@example.com`;
    const originalPassword = "the original long password";
    const newPassword = "the replacement password";
    await registerVerifyAndLogin(page, server, email, originalPassword);

    await page.goto(`${server.serverUrl}/account?lang=en`);
    // The account page also carries the delete-account form with its own
    // current-password field; scope the locator to the change-password form.
    const changePasswordForm = page.locator('form[action="account/password"]');
    await changePasswordForm
      .getByLabel("Current password")
      .fill(originalPassword);
    await page.getByLabel("New password", { exact: true }).fill(newPassword);
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByText(/password has been updated/)).toBeVisible();

    // The current session survives; a fresh login needs the new password.
    await page.goto(`${server.serverUrl}/logout?lang=en`);
    await page.getByRole("button", { name: "Log out" }).click();
    await page.goto(`${server.serverUrl}/login?lang=en`);
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(newPassword);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.locator(".hosted-account-email")).toHaveText(email);
  });
});
