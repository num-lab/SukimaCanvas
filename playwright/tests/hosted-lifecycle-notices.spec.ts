import * as fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test";
import { readAccountEmailLink } from "../helpers/hostedOutbox";
import type { TestServer } from "../helpers/testServer";

const OPERATOR_EMAIL = "operator@example.com";
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

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

function dateTimeLocal(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 16);
}

/**
 * Waits for the outbox to hold a lifecycle notice to the recipient whose body
 * matches, and returns its body.
 */
async function readLifecycleNotice(
  server: TestServer,
  recipient: string,
  bodyNeedle: string,
): Promise<string> {
  const dir = path.join(server.dataPath, "hosted-data", "mail-outbox");
  let body = "";
  await expect
    .poll(async () => {
      const files = (await fs.readdir(dir).catch(() => [])).sort();
      for (const file of files) {
        const message = JSON.parse(
          await fs.readFile(path.join(dir, file), "utf8"),
        );
        if (message.to === recipient && message.body.includes(bodyNeedle)) {
          body = message.body as string;
        }
      }
      return body;
    })
    .not.toBe("");
  return body;
}

test.describe("event lifecycle notices", () => {
  test("approval and cancellation show their trigger states and mail the organizer", async ({
    page,
    browser,
    server,
  }) => {
    test.setTimeout(120_000);
    const password = "a solid lifecycle password";
    const ownerEmail = `owner-${Date.now()}@example.com`;

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

    // Draft, submit, and get a future event approved. The operator console
    // shows no mail delivery retries: the vendor accepted everything so far.
    await operatorPage.goto(`${server.serverUrl}/operator?lang=en`);
    await expect(
      operatorPage.getByText("No mail is waiting for retry."),
    ).toBeVisible();

    await page.goto(`${server.serverUrl}/organizer?lang=en`);
    await page.getByRole("link", { name: "Manage" }).first().click();
    await page.getByRole("link", { name: "Reservations", exact: true }).click();
    await page.getByLabel("Event name").fill("Notice Jam");
    await page.getByLabel("Start time").fill(dateTimeLocal(2 * DAY));
    await page.getByLabel("End time").fill(dateTimeLocal(2 * DAY + HOUR));
    await page.getByLabel("Requested seats").fill("30");
    await page.getByLabel("Visibility").selectOption("public");
    await page.getByRole("button", { name: "Create draft" }).click();
    await expect(
      page.getByRole("heading", { name: "Notice Jam" }),
    ).toBeVisible();
    const reservationUrl = page.url();
    await page.getByRole("button", { name: "Submit for approval" }).click();

    await operatorPage.goto(
      `${server.serverUrl}/operator/reservations?lang=en`,
    );
    await operatorPage.getByRole("link", { name: "Review" }).first().click();
    await operatorPage.getByRole("button", { name: "Approve" }).click();

    // The approval trigger state is visible in the organizer console, and
    // the approval notice reached the organizer in both hosted languages.
    await page.goto(reservationUrl);
    await expect(page.getByText("Approved", { exact: true })).toBeVisible();
    const approvalBody = await readLifecycleNotice(
      server,
      ownerEmail,
      "has been approved",
    );
    expect(approvalBody).toContain("你好");
    expect(approvalBody).toContain("Hello,");
    expect(approvalBody).toContain("Notice Jam");

    // Cancelling the event shows the cancelled state and mails the
    // organizer; the operator console still lists no retrying mail.
    await page.getByRole("button", { name: "Cancel reservation" }).click();
    await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
    const cancellationBody = await readLifecycleNotice(
      server,
      ownerEmail,
      "has been cancelled",
    );
    expect(cancellationBody).toContain("Notice Jam");
    expect(cancellationBody).toContain("已取消");

    await operatorPage.goto(`${server.serverUrl}/operator?lang=en`);
    await expect(
      operatorPage.getByText("No mail is waiting for retry."),
    ).toBeVisible();

    await operatorContext.close();
  });
});
