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

/**
 * With a real service clock the Board Session opens only when the scheduled
 * start passes, so this test schedules the event about a minute out and waits
 * for the entry form to appear. Values are service-local wall clock (UTC+8).
 */
function startSoon(offsetMs = 0): string {
  return new Date(Date.now() + SERVICE_OFFSET_MS + 70_000 + offsetMs)
    .toISOString()
    .slice(0, 16);
}

test.describe("access code admission and event membership", () => {
  test("a participant joins through the access code and the membership persists", async ({
    page,
    browser,
    server,
  }) => {
    test.setTimeout(180_000);
    const password = "a solid admission password";
    const stamp = Date.now();
    const ownerEmail = `owner-${stamp}@example.com`;
    const participantEmail = `joiner-${stamp}@example.com`;

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

    // Draft, submit, and approve an event starting about a minute out.
    await page.goto(`${server.serverUrl}/organizer?lang=en`);
    await page.getByRole("link", { name: "Manage" }).first().click();
    await page.getByRole("link", { name: "Reservations", exact: true }).click();
    await page.getByLabel("Event name").fill("Access Code Jam");
    await page.getByLabel("Start time").fill(startSoon());
    await page.getByLabel("End time").fill(startSoon(HOUR));
    await page.getByLabel("Requested seats").fill("25");
    await page.getByLabel("Visibility").selectOption("public");
    await page.getByRole("button", { name: "Create draft" }).click();
    await expect(
      page.getByRole("heading", { name: "Access Code Jam" }),
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

    // The owner mints the shared Access Code on the event management page.
    await page.goto(reservationUrl);
    await expect(page.getByText("Approved", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Manage event page" }).click();
    await expect(page.getByText(/No access code exists yet/)).toBeVisible();
    await page.getByRole("button", { name: "Generate new code" }).click();
    const accessCode = (
      await page.locator(".hosted-event-access-code-value").textContent()
    )?.trim();
    expect(accessCode).toMatch(/^[2-9A-HJKMNP-Z]{5}(-[2-9A-HJKMNP-Z]{5}){3}$/);
    // Navigating away and back never re-reveals the code (a GET, not the
    // POST that minted it).
    await page.getByRole("link", { name: "Back to reservation" }).click();
    await page.getByRole("link", { name: "Manage event page" }).click();
    await expect(page.locator(".hosted-event-access-code-value")).toHaveCount(
      0,
    );
    await expect(
      page.getByText(/A shared access code is active/),
    ).toBeVisible();

    // The public event URL is shown on the management page.
    const publicHref = await page
      .getByRole("link", { name: "View public page" })
      .getAttribute("href");
    expect(publicHref).toMatch(/^events\//);

    // A signed-out visitor sees only a login prompt, never the entry form.
    const visitorContext = await browser.newContext();
    const visitorPage = await visitorContext.newPage();
    await visitorPage.goto(`${server.serverUrl}/${publicHref}?lang=en`);
    await expect(
      visitorPage.getByRole("heading", { name: "Access Code Jam" }),
    ).toBeVisible();
    await expect(
      visitorPage.getByRole("link", { name: "Log in to enter this event." }),
    ).toBeVisible();

    // The signed-in participant joins through the shared code once the
    // session opens. A wrong code first shows the uniform failure.
    await registerVerifyLogin(visitorPage, server, participantEmail, password);
    await visitorPage.goto(`${server.serverUrl}/${publicHref}?lang=en`);
    // The session opens when the scheduled start passes; poll with reloads.
    const enterForm = visitorPage.locator(".hosted-event-enter");
    await expect(async () => {
      await visitorPage.reload();
      await expect(enterForm).toBeVisible();
    }).toPass({ timeout: 150_000 });
    const codeInput = visitorPage.getByLabel("Access code", { exact: true });
    await codeInput.fill("WRONG-CODE-0000");
    await visitorPage.getByRole("button", { name: "Enter event" }).click();
    await expect(visitorPage.getByText("Entry was not accepted")).toBeVisible();

    await codeInput.fill(accessCode ?? "");
    await visitorPage
      .getByRole("radio", { name: "Participate anonymously" })
      .check();
    await visitorPage.getByRole("button", { name: "Enter event" }).click();

    // The membership is established and announced on the page.
    await expect(
      visitorPage.getByText(/Your membership for this event is active/),
    ).toBeVisible();
    await expect(
      visitorPage.getByText(/You are participating anonymously/),
    ).toBeVisible();

    // The membership survives a page refresh without re-entering the code.
    await visitorPage.reload();
    await expect(
      visitorPage.getByText(/Your membership for this event is active/),
    ).toBeVisible();
    await expect(visitorPage.locator(".hosted-event-enter")).toHaveCount(0);

    await visitorContext.close();
    await operatorContext.close();
  });
});
