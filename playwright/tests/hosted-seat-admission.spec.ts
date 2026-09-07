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
 * start passes, so the event is scheduled about a minute out and the test
 * polls the event page until entry becomes possible. Values are
 * service-local wall clock (UTC+8).
 */
function startSoon(offsetMs = 0): string {
  return new Date(Date.now() + SERVICE_OFFSET_MS + 70_000 + offsetMs)
    .toISOString()
    .slice(0, 16);
}

test.describe("participant seats and realtime admission", () => {
  test("preparation window, seat capacity, and one writable tab per account", async ({
    page,
    browser,
    server,
  }) => {
    test.setTimeout(240_000);
    const password = "a solid seating password";
    const stamp = Date.now();
    const ownerEmail = `owner-${stamp}@example.com`;
    const participantEmail = `seated-${stamp}@example.com`;
    const lateEmail = `late-${stamp}@example.com`;

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

    // One seat only: the capacity refusal is reachable with a single holder.
    await page.goto(`${server.serverUrl}/organizer?lang=en`);
    await page.getByRole("link", { name: "Manage" }).first().click();
    await page.getByRole("link", { name: "Reservations", exact: true }).click();
    await page.getByLabel("Event name").fill("Seating Jam");
    await page.getByLabel("Start time").fill(startSoon());
    await page.getByLabel("End time").fill(startSoon(HOUR));
    await page.getByLabel("Requested seats").fill("1");
    await page.getByLabel("Visibility").selectOption("public");
    await page.getByRole("button", { name: "Create draft" }).click();
    await expect(
      page.getByRole("heading", { name: "Seating Jam" }),
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
    await page.getByRole("button", { name: "Generate new code" }).click();
    const accessCode = (
      await page.locator(".hosted-event-access-code-value").textContent()
    )?.trim();
    expect(accessCode).toMatch(/^[2-9A-HJKMNP-Z]{5}(-[2-9A-HJKMNP-Z]{5}){3}$/);
    const publicHref = await page
      .getByRole("link", { name: "View public page" })
      .getAttribute("href");
    expect(publicHref).toMatch(/^events\//);

    // --- Preparation Window -------------------------------------------------
    // The owner opens the public event page and enters the board before the
    // scheduled start; the shell loads.
    await page.goto(`${server.serverUrl}/${publicHref}?lang=en`);
    const boardHref = await page
      .getByRole("link", { name: "Enter the board" })
      .getAttribute("href");
    expect(boardHref).toMatch(/^b\/event-[0-9a-f]{24}$/);
    await page.getByRole("link", { name: "Enter the board" }).click();
    await expect(page.locator("#canvas")).toBeVisible({ timeout: 30_000 });
    await page.goBack();

    // --- Participant before start -------------------------------------------
    const participantContext = await browser.newContext();
    const participantPage = await participantContext.newPage();
    await registerVerifyLogin(
      participantPage,
      server,
      participantEmail,
      password,
    );
    await participantPage.goto(`${server.serverUrl}/${publicHref}?lang=en`);
    // Before the start the participant sees no board link and no entry form —
    // both appear only once the session opens.
    await expect(
      participantPage.getByRole("link", { name: "Enter the board" }),
    ).toHaveCount(0);
    await expect(participantPage.locator(".hosted-event-enter")).toHaveCount(0);

    // --- Wait for the open window, then join ---------------------------------
    const enterForm = participantPage.locator(".hosted-event-enter");
    await expect(async () => {
      await participantPage.goto(`${server.serverUrl}/${publicHref}?lang=en`);
      await expect(enterForm).toBeVisible();
    }).toPass({ timeout: 150_000 });
    await participantPage
      .getByLabel("Access code", { exact: true })
      .fill(accessCode ?? "");
    await participantPage.getByRole("button", { name: "Enter event" }).click();
    await expect(
      participantPage.getByText(/Your membership for this event is active/),
    ).toBeVisible();

    // The member now gets the board link and the board loads with tools.
    await participantPage.goto(`${server.serverUrl}/${boardHref}?lang=en`);
    await expect(participantPage.locator("#canvas")).toBeVisible({
      timeout: 30_000,
    });
    await expect(participantPage.locator("#toolID-pencil")).toBeVisible();

    // --- One writable connection per account ---------------------------------
    // A second tab of the same account connects read-only: editing tools are
    // hidden there while the first tab keeps them.
    const secondTabPage = await participantContext.newPage();
    await secondTabPage.goto(`${server.serverUrl}/${boardHref}?lang=en`);
    await expect(secondTabPage.locator("#canvas")).toBeVisible({
      timeout: 30_000,
    });
    await expect(secondTabPage.locator("#toolID-pencil")).toBeHidden();
    await expect(participantPage.locator("#toolID-pencil")).toBeVisible();

    // --- Capacity -------------------------------------------------------------
    const lateContext = await browser.newContext();
    const latePage = await lateContext.newPage();
    await registerVerifyLogin(latePage, server, lateEmail, password);
    await latePage.goto(`${server.serverUrl}/${publicHref}?lang=en`);
    await latePage
      .getByLabel("Access code", { exact: true })
      .fill(accessCode ?? "");
    await latePage.getByRole("button", { name: "Enter event" }).click();
    await expect(
      latePage.getByText(/Your membership for this event is active/),
    ).toBeVisible();

    // The single seat is taken; the member is sent back with the notice.
    await latePage.goto(`${server.serverUrl}/${boardHref}?lang=en`);
    await expect(latePage).toHaveURL(/notice=full$/);
    await expect(
      latePage.getByText(/The event is at capacity right now/),
    ).toBeVisible();

    await lateContext.close();
    await secondTabPage.close();
    await participantContext.close();
    await operatorContext.close();
  });
});
