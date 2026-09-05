import type { Page } from "@playwright/test";
import { createBoardPage, expect, test } from "../fixtures/test";
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
      // the close flow completes within the test's wall clock.
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

/**
 * With a real service clock the Board Session opens only when the scheduled
 * start passes, so the event is scheduled about a minute out and ends twenty
 * seconds later: the session closes while the test keeps the participant's
 * board open, and the close pipeline then seals it.
 */
function startSoon(offsetMs = 0): string {
  return new Date(Date.now() + SERVICE_OFFSET_MS + 70_000 + offsetMs)
    .toISOString()
    .slice(0, 16);
}

test.describe("board session close and private archive", () => {
  test("participants end on a read-only completion state and cannot re-enter", async ({
    page,
    browser,
    server,
  }) => {
    test.setTimeout(300_000);
    const password = "a solid closing password";
    const stamp = Date.now();
    const ownerEmail = `owner-${stamp}@example.com`;
    const participantEmail = `closer-${stamp}@example.com`;

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

    // A short event: it ends about 100 seconds out, then the drain window
    // elapses and the durable poker seals the session.
    await page.goto(`${server.serverUrl}/organizer?lang=en`);
    await page.getByRole("link", { name: "Manage" }).first().click();
    await page.getByRole("link", { name: "Reservations", exact: true }).click();
    await page.getByLabel("Event name").fill("Closing Jam");
    await page.getByLabel("Start time").fill(startSoon());
    await page.getByLabel("End time").fill(startSoon(90_000));
    await page.getByLabel("Requested seats").fill("10");
    await page.getByLabel("Visibility").selectOption("public");
    await page.getByRole("button", { name: "Create draft" }).click();
    await expect(
      page.getByRole("heading", { name: "Closing Jam" }),
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
    const publicHref = await page
      .getByRole("link", { name: "View public page" })
      .getAttribute("href");
    expect(publicHref).toMatch(/^events\//);

    // The participant joins while the session is open and draws something.
    const participantContext = await browser.newContext();
    const participantPage = await participantContext.newPage();
    await registerVerifyLogin(
      participantPage,
      server,
      participantEmail,
      password,
    );
    await participantPage.goto(`${server.serverUrl}/${publicHref}?lang=en`);
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

    const boardHref = await participantPage
      .getByRole("link", { name: "Enter the board" })
      .getAttribute("href");
    await participantPage.goto(`${server.serverUrl}/${boardHref}?lang=en`);
    await expect(participantPage.locator("#canvas")).toBeVisible({
      timeout: 30_000,
    });
    // Draw through the runtime's own write path so the stroke lands reliably.
    const participantBoard = createBoardPage(participantPage, server);
    await participantBoard.waitForBoardWritable();
    await participantBoard.drawPencilPaths([
      {
        color: "#321321",
        points: [
          { x: 200, y: 200 },
          { x: 500, y: 320 },
        ],
      },
    ]);
    await expect(
      participantPage.locator('#canvas path[stroke="#321321"]'),
    ).toBeVisible();

    // When the planned end passes and the drain finishes, the connection
    // ends on the read-only completion state — no reconnect, no tools.
    await expect(participantPage.locator("#boardStatusTitle")).toHaveText(
      "The event has ended",
      { timeout: 180_000 },
    );
    await expect(participantPage.locator("#boardStatusNotice")).toHaveText(
      "The board is now read-only and has been archived. Thank you for contributing!",
    );
    await expect(participantPage.locator("#toolID-pencil")).toBeHidden();

    // The board page is gone for good: reloading routes back to the event
    // page, which explains the completed event. (The browser keeps the
    // board's viewport hash across the redirect, so no URL anchor.)
    await participantPage.reload();
    await expect(participantPage).toHaveURL(/notice=not_open/);
    await expect(
      participantPage.getByText("Ended", { exact: true }),
    ).toBeVisible();

    await participantContext.close();
    await operatorContext.close();
  });
});
