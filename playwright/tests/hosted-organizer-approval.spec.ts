import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test";
import { readAccountEmailLink } from "../helpers/hostedOutbox";

const OPERATOR_EMAIL = "operator@example.com";

test.use({
  serverOptions: {
    env: {
      WBO_HOSTED_MODE: "true",
      WBO_HOSTED_OPERATOR_EMAILS: OPERATOR_EMAIL,
    },
  },
});

/**
 * Registers, verifies through the outbox link, and logs in on the given page.
 */
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

/**
 * Submits an organizer application from a signed-in applicant page.
 */
async function submitApplication(
  page: Page,
  server: Parameters<typeof readAccountEmailLink>[0],
  organizerName: string,
) {
  await page.goto(`${server.serverUrl}/organizer/apply?lang=en`);
  await page.getByLabel("Organizer name").fill(organizerName);
  await page.getByLabel("Contact person").fill("Mika Rin");
  await page.getByLabel("Contact email").fill("contact@example.com");
  await page.getByLabel("About your events").fill("Community drawing jams.");
  await page.getByRole("button", { name: "Submit application" }).click();
  await expect(page.getByText(/under review/i)).toBeVisible();
}

test.describe("organizer application and operator approval", () => {
  test("an applicant and an operator complete approval across consoles", async ({
    page,
    browser,
    server,
  }) => {
    const applicantEmail = `approve-${Date.now()}@example.com`;
    const password = "a solid organizer password";

    const operatorContext = await browser.newContext();
    const operatorPage = await operatorContext.newPage();
    await registerVerifyLogin(operatorPage, server, OPERATOR_EMAIL, password);

    await registerVerifyLogin(page, server, applicantEmail, password);
    await submitApplication(page, server, "Aurora Collective");

    // An ordinary account cannot reach the operator console.
    await page.goto(`${server.serverUrl}/operator?lang=en`);
    await expect(page.getByText(/do not have access/i)).toBeVisible();

    // The operator reviews the pending queue and approves.
    await operatorPage.goto(`${server.serverUrl}/operator?lang=en`);
    await expect(
      operatorPage.getByRole("heading", { name: "Operator console" }),
    ).toBeVisible();
    await expect(operatorPage.getByText("Aurora Collective")).toBeVisible();
    await operatorPage.getByRole("link", { name: "Review" }).first().click();
    await expect(
      operatorPage.getByRole("heading", {
        name: "Review organizer application",
      }),
    ).toBeVisible();
    await operatorPage.getByText(applicantEmail).first().waitFor();
    await operatorPage.getByRole("button", { name: "Approve" }).click();

    // The decision is recorded in the audit trail with the operator identity.
    await expect(
      operatorPage.getByText("Approved", { exact: true }),
    ).toBeVisible();
    await expect(operatorPage.getByText("Application approved")).toBeVisible();

    // The applicant now sees the approval and their ownership.
    await page.goto(`${server.serverUrl}/organizer/apply?lang=en`);
    await expect(page.getByText("Approved", { exact: true })).toBeVisible();
    await expect(page.getByText(/owner of Aurora Collective/)).toBeVisible();

    await operatorContext.close();
  });

  test("a rejected applicant sees a clear status but not the operator note", async ({
    page,
    browser,
    server,
  }) => {
    const applicantEmail = `reject-${Date.now()}@example.com`;
    const password = "another organizer password";
    const secretNote = "OPERATOR-ONLY: incomplete registration details";

    const operatorContext = await browser.newContext();
    const operatorPage = await operatorContext.newPage();
    await registerVerifyLogin(operatorPage, server, OPERATOR_EMAIL, password);

    await registerVerifyLogin(page, server, applicantEmail, password);
    await submitApplication(page, server, "Nightshade Studio");

    await operatorPage.goto(`${server.serverUrl}/operator?lang=en`);
    await operatorPage.getByRole("link", { name: "Review" }).first().click();
    await operatorPage.getByLabel(/Internal note/).fill(secretNote);
    await operatorPage.getByRole("button", { name: "Reject" }).click();
    await expect(
      operatorPage.getByText("Not approved", { exact: true }),
    ).toBeVisible();
    // The operator retains the note on their console.
    await expect(operatorPage.getByText(secretNote)).toBeVisible();

    // The applicant sees a clear rejection but never the operator note.
    await page.goto(`${server.serverUrl}/organizer/apply?lang=en`);
    await expect(page.getByText("Not approved", { exact: true })).toBeVisible();
    await expect(page.getByText(secretNote)).toHaveCount(0);
    // A rejected applicant may re-apply.
    await expect(page.getByLabel("Organizer name")).toBeVisible();

    await operatorContext.close();
  });
});
