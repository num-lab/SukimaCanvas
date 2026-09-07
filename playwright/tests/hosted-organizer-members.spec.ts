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

test.describe("organizer invitations and member management", () => {
  test("owner invites a member who accepts, then is managed and removed", async ({
    page,
    browser,
    server,
  }) => {
    const password = "a solid membership password";
    const ownerEmail = `owner-${Date.now()}@example.com`;
    const memberEmail = `member-${Date.now()}@example.com`;

    // The operator provisions the organizer by approving the owner's
    // application.
    const operatorContext = await browser.newContext();
    const operatorPage = await operatorContext.newPage();
    await registerVerifyLogin(operatorPage, server, OPERATOR_EMAIL, password);

    await registerVerifyLogin(page, server, ownerEmail, password);
    await page.goto(`${server.serverUrl}/organizer/apply?lang=en`);
    await page.getByLabel("Organizer name").fill("Aurora Collective");
    await page.getByLabel("Contact person").fill("Mika Rin");
    await page.getByLabel("Contact email").fill("contact@example.com");
    await page.getByLabel("About your events").fill("Community jams.");
    await page.getByRole("button", { name: "Submit application" }).click();
    await expect(page.getByText(/under review/i)).toBeVisible();

    await operatorPage.goto(`${server.serverUrl}/operator?lang=en`);
    await operatorPage.getByRole("link", { name: "Review" }).first().click();
    await operatorPage.getByRole("button", { name: "Approve" }).click();
    await expect(
      operatorPage.getByText("Approved", { exact: true }),
    ).toBeVisible();

    // The owner opens the console and the organizer management page.
    await page.goto(`${server.serverUrl}/organizer?lang=en`);
    await expect(page.getByText("Aurora Collective")).toBeVisible();
    await page.getByRole("link", { name: "Manage" }).first().click();
    await expect(
      page.getByRole("heading", { name: "Aurora Collective" }),
    ).toBeVisible();
    const manageUrl = page.url();

    // The owner invites a member.
    await page.getByLabel("Email address").fill(memberEmail);
    await page.getByLabel("Role").selectOption("admin");
    await page.getByRole("button", { name: "Send invitation" }).click();
    await expect(page.getByText(memberEmail)).toBeVisible();

    // The member registers, sees the invitation, and accepts.
    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    await registerVerifyLogin(memberPage, server, memberEmail, password);
    await memberPage.goto(`${server.serverUrl}/organizer?lang=en`);
    await expect(memberPage.getByText("Aurora Collective")).toBeVisible();
    await memberPage.getByRole("button", { name: "Accept" }).click();
    await expect(
      memberPage.getByRole("heading", { name: "Aurora Collective" }),
    ).toBeVisible();
    // An admin sees no owner-only invite form.
    await expect(
      memberPage.getByRole("button", { name: "Send invitation" }),
    ).toHaveCount(0);

    // The owner sees the new member and removes them.
    await page.goto(`${manageUrl}?lang=en`);
    const memberRow = page
      .locator(".hosted-member-item")
      .filter({ hasText: memberEmail });
    await expect(memberRow).toHaveCount(1);
    await memberRow.getByRole("button", { name: "Remove" }).click();
    await expect(
      page.locator(".hosted-member-item").filter({ hasText: memberEmail }),
    ).toHaveCount(0);

    // The removed member immediately loses access to the organizer.
    const afterRemoval = await memberPage.goto(manageUrl);
    expect(afterRemoval?.status()).toBe(404);

    await operatorContext.close();
    await memberContext.close();
  });
});
