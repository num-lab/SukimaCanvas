import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test";
import { readAccountEmailLink } from "../helpers/hostedOutbox";

const OPERATOR_EMAIL = "operator@example.com";
const HOUR = 60 * 60 * 1000;
/** The default service timezone (UTC+8); datetime-local values are wall clock. */
const SERVICE_OFFSET_MS = 8 * HOUR;

test.use({
  serverOptions: {
    env: {
      WBO_HOSTED_MODE: "true",
      WBO_HOSTED_OPERATOR_EMAILS: OPERATOR_EMAIL,
      // The durable lifecycle poker seals drained Board Sessions quickly so
      // the outcomes exist by the time the organizer deletes them.
      WBO_HOSTED_LIFECYCLE_POLL_MS: "1000",
      WBO_HOSTED_BOARD_SESSION_CLOSE_DRAIN_MS: "3000",
    },
  },
});

async function registerVerifyLogin(
  page: Page,
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

function startSoon(offsetMs = 0): string {
  return new Date(Date.now() + SERVICE_OFFSET_MS + 70_000 + offsetMs)
    .toISOString()
    .slice(0, 16);
}

test.describe("outcome deletion and account deregistration", () => {
  test("the organizer requests early deletion, sees the recovery window, and restores", async ({
    page,
    browser,
    server,
  }) => {
    test.setTimeout(300_000);
    const password = "a solid deletion password";
    const stamp = Date.now();
    const ownerEmail = `outcome-owner-${stamp}@example.com`;

    const operatorContext = await browser.newContext();
    const operatorPage = await operatorContext.newPage();
    await registerVerifyLogin(operatorPage, server, OPERATOR_EMAIL, password);

    await registerVerifyLogin(page, server, ownerEmail, password);
    await page.goto(`${server.serverUrl}/organizer/apply?lang=en`);
    await page.getByLabel("Organizer name").fill("Aurora Collective");
    await page.getByLabel("Contact person").fill("Mika Rin");
    await page.getByLabel("Contact email").fill("contact@example.com");
    await page.getByRole("button", { name: "Submit application" }).click();
    await expect(page.getByText(/under review/i)).toBeVisible();

    await operatorPage.goto(`${server.serverUrl}/operator?lang=en`);
    await operatorPage.getByRole("link", { name: "Review" }).first().click();
    await operatorPage.getByRole("button", { name: "Approve" }).click();
    await expect(
      operatorPage.getByText("Approved", { exact: true }),
    ).toBeVisible();

    await page.goto(`${server.serverUrl}/organizer?lang=en`);
    await page.getByRole("link", { name: "Manage" }).first().click();
    await page.getByRole("link", { name: "Reservations", exact: true }).click();
    await page.getByLabel("Event name").fill("Deletion Jam");
    await page.getByLabel("Start time").fill(startSoon());
    await page.getByLabel("End time").fill(startSoon(90_000));
    await page.getByLabel("Requested seats").fill("10");
    await page.getByLabel("Visibility").selectOption("unlisted");
    await page.getByRole("button", { name: "Create draft" }).click();
    await expect(
      page.getByRole("heading", { name: "Deletion Jam" }),
    ).toBeVisible();
    const reservationUrl = page.url();
    await page.getByRole("button", { name: "Submit for approval" }).click();
    await expect(page.getByText("Submitted", { exact: true })).toBeVisible();

    await operatorPage.goto(
      `${server.serverUrl}/operator/reservations?lang=en`,
    );
    await operatorPage.getByRole("link", { name: "Review" }).first().click();
    await operatorPage.getByRole("button", { name: "Approve" }).click();
    await expect(
      operatorPage.getByText("Approved", { exact: true }),
    ).toBeVisible();

    await page.goto(reservationUrl);
    await expect(page.getByText("Approved", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Manage event page" }).click();
    const consoleUrl = page.url();

    // The session drains, closes, and archives in the background; navigate
    // by GET so the authoritative lifecycle state renders.
    await expect(async () => {
      await page.goto(consoleUrl);
      await expect(page.getByText(/· Ended$/)).toBeVisible();
    }).toPass({ timeout: 240_000 });

    // The outcome section shows the server-derived retention deadline and
    // the deletion control once the archive exists; "Ended" only means the
    // drain window may still be running, so poll for the sealed state.
    await expect(async () => {
      await page.goto(consoleUrl);
      await expect(
        page.getByText(/retained until/i, { exact: false }),
      ).toBeVisible();
    }).toPass({ timeout: 60_000 });
    await page.getByRole("link", { name: "Outcomes & audit" }).click();
    await expect(
      page.getByRole("heading", { name: "Outcomes & audit" }),
    ).toBeVisible();
    await expect(
      page.getByText(/retained until/i, { exact: false }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Back to event management" }).click();
    await expect(
      page.getByRole("heading", { name: "Event page" }),
    ).toBeVisible();

    // Requesting early deletion enters the recoverable window; the console
    // confirms it and offers the restore action.
    await page.getByRole("button", { name: "Delete outcomes" }).click();
    await expect(
      page.getByText(/Deletion requested\. You can restore it/),
    ).toBeVisible();
    await expect(
      page.getByText(/Deletion requested —/i, { exact: false }),
    ).toBeVisible();

    // Restoring inside the window puts everything back; the console shows
    // the retention state again.
    await page.getByRole("button", { name: "Restore deletion" }).click();
    await expect(
      page.getByText(/Deletion restored\. All outcomes are available again\./),
    ).toBeVisible();
    await expect(
      page.getByText(/retained until/i, { exact: false }),
    ).toBeVisible();
  });

  test("an account holder deregisters and cannot sign in again", async ({
    page,
    server,
  }) => {
    const password = "a solid deregistration password";
    const stamp = Date.now();
    const email = `departing-${stamp}@example.com`;

    await registerVerifyLogin(page, server, email, password);
    await page.goto(`${server.serverUrl}/account?lang=en`);
    await expect(
      page.getByRole("heading", { name: "Delete account" }),
    ).toBeVisible();

    // The wrong password is refused; the account survives.
    await page.getByLabel("Current password").nth(1).fill("not the password");
    await page
      .getByRole("button", { name: "Delete account permanently" })
      .click();
    await expect(page.getByText(/Current password is incorrect/)).toBeVisible();

    // The correct password deregisters the account: sessions end and the
    // login page explains the pseudonymized outcome.
    await page.getByLabel("Current password").nth(1).fill(password);
    await page
      .getByRole("button", { name: "Delete account permanently" })
      .click();
    await expect(page).toHaveURL(/\/login\?deleted=1$/);
    await expect(page.getByText(/Your account has been deleted/)).toBeVisible();

    // Signing in with the old address is the same generic failure as an
    // unknown account.
    await page.goto(`${server.serverUrl}/login?lang=en`);
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(
      page.getByText(/Incorrect email address or password/),
    ).toBeVisible();
  });
});
