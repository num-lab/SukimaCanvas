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
 * start passes, so the event is scheduled about a minute out and ends forty
 * seconds later: both participants join and draw while it is open, the close
 * pipeline then seals it within the test's wall clock.
 */
function startSoon(offsetMs = 0): string {
  return new Date(Date.now() + SERVICE_OFFSET_MS + 70_000 + offsetMs)
    .toISOString()
    .slice(0, 16);
}

test.describe("published canvas and public attribution policy", () => {
  test("audiences, attribution, anonymity, and revocation across one event", async ({
    page,
    browser,
    server,
  }) => {
    test.setTimeout(300_000);
    const password = "a solid publishing password";
    const stamp = Date.now();
    const ownerEmail = `owner-${stamp}@example.com`;
    const identifiedEmail = `artist-${stamp}@example.com`;
    const anonymousEmail = `ghost-${stamp}@example.com`;

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
    await page.getByLabel("Event name").fill("Publication Jam");
    await page.getByLabel("Start time").fill(startSoon());
    await page.getByLabel("End time").fill(startSoon(90_000));
    await page.getByLabel("Requested seats").fill("10");
    await page.getByLabel("Visibility").selectOption("public");
    await page.getByRole("button", { name: "Create draft" }).click();
    await expect(
      page.getByRole("heading", { name: "Publication Jam" }),
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
    const manageUrl = page.url();
    await page.getByRole("button", { name: "Generate new code" }).click();
    const accessCode = (
      await page.locator(".hosted-event-access-code-value").textContent()
    )?.trim();
    const publicHref = await page
      .getByRole("link", { name: "View public page" })
      .getAttribute("href");

    // While the session runs, publication is not offered yet.
    await expect(
      page.getByText(
        "The canvas can be published once the board session has closed and archived.",
      ),
    ).toBeVisible();

    // Two participants join through the access code: one stays identified,
    // one switches to anonymity before the close.
    const identifiedContext = await browser.newContext();
    const identifiedPage = await identifiedContext.newPage();
    await registerVerifyLogin(
      identifiedPage,
      server,
      identifiedEmail,
      password,
    );
    const identifiedEnter = identifiedPage.locator(".hosted-event-enter");
    await expect(async () => {
      await identifiedPage.goto(`${server.serverUrl}/${publicHref}?lang=en`);
      await expect(identifiedEnter).toBeVisible();
    }).toPass({ timeout: 150_000 });
    await identifiedPage
      .getByLabel("Access code", { exact: true })
      .fill(accessCode ?? "");
    await identifiedPage.getByRole("button", { name: "Enter event" }).click();
    await expect(
      identifiedPage.getByText(/Your membership for this event is active/),
    ).toBeVisible();

    const anonymousContext = await browser.newContext();
    const anonymousPage = await anonymousContext.newPage();
    await registerVerifyLogin(anonymousPage, server, anonymousEmail, password);
    const anonymousEnter = anonymousPage.locator(".hosted-event-enter");
    await expect(async () => {
      await anonymousPage.goto(`${server.serverUrl}/${publicHref}?lang=en`);
      await expect(anonymousEnter).toBeVisible();
    }).toPass({ timeout: 150_000 });
    await anonymousPage
      .getByLabel("Access code", { exact: true })
      .fill(accessCode ?? "");
    await anonymousPage.getByRole("button", { name: "Enter event" }).click();
    await expect(
      anonymousPage.getByText(/Your membership for this event is active/),
    ).toBeVisible();
    // The one-way anonymity switch: withdraws public attribution for every
    // existing and future item of this participant.
    await anonymousPage.getByRole("button", { name: "Go anonymous" }).click();
    await expect(
      anonymousPage.getByText(/You are participating anonymously/),
    ).toBeVisible();

    // Both draw a stroke in their own color while the session is open.
    const identifiedBoardHref = await identifiedPage
      .getByRole("link", { name: "Enter the board" })
      .getAttribute("href");
    await identifiedPage.goto(
      `${server.serverUrl}/${identifiedBoardHref}?lang=en`,
    );
    await expect(identifiedPage.locator("#canvas")).toBeVisible({
      timeout: 30_000,
    });
    const identifiedBoard = createBoardPage(identifiedPage, server);
    await identifiedBoard.waitForBoardWritable();
    await identifiedBoard.drawPencilPaths([
      {
        color: "#111111",
        points: [
          { x: 120, y: 120 },
          { x: 420, y: 260 },
        ],
      },
    ]);
    const anonymousBoardHref = await anonymousPage
      .getByRole("link", { name: "Enter the board" })
      .getAttribute("href");
    await anonymousPage.goto(
      `${server.serverUrl}/${anonymousBoardHref}?lang=en`,
    );
    await expect(anonymousPage.locator("#canvas")).toBeVisible({
      timeout: 30_000,
    });
    const anonymousBoard = createBoardPage(anonymousPage, server);
    await anonymousBoard.waitForBoardWritable();
    await anonymousBoard.drawPencilPaths([
      {
        color: "#222222",
        points: [
          { x: 200, y: 300 },
          { x: 500, y: 380 },
        ],
      },
    ]);

    // When the planned end passes and the drain finishes, the session ends
    // on the read-only completion state and the archive lands.
    await expect(identifiedPage.locator("#boardStatusTitle")).toHaveText(
      "The event has ended",
      { timeout: 180_000 },
    );

    // The Owner publishes with attribution for the event participants.
    await page.goto(`${manageUrl}?lang=en`);
    await page
      .getByLabel("Who can view")
      .selectOption({ label: "Event participants" });
    await page
      .getByLabel("Show participant identifiers beside their items")
      .check();
    await page.getByRole("button", { name: "Publish canvas" }).click();
    await expect(
      page.getByText("The canvas is now published for the chosen audience."),
    ).toBeVisible();
    // The members audience admits event members; the owner (not a member)
    // gets no view link here. The participant's event-page link below is
    // the member-facing surface.

    // A member reads the sanitized, read-only presentation: the identified
    // stroke keeps its Participant Identifier, the anonymous one has none.
    await identifiedPage.goto(`${server.serverUrl}/${publicHref}?lang=en`);
    await identifiedPage
      .getByRole("link", { name: "View published canvas" })
      .click();
    await expect(identifiedPage.locator("#hosted-canvas-title")).toHaveText(
      "Publication Jam",
    );
    await expect(identifiedPage.locator("#canvas")).toBeVisible();
    expect(
      await identifiedPage
        .locator('#canvas path[stroke="#111111"][data-wbo-created-by]')
        .count(),
    ).toBeGreaterThan(0);
    expect(
      await identifiedPage
        .locator('#canvas path[stroke="#222222"][data-wbo-created-by]')
        .count(),
    ).toBe(0);
    // The contributor list holds exactly the identified participant.
    await expect(
      identifiedPage.locator(".hosted-contributor-item"),
    ).toHaveCount(1);
    // Private archive material never reaches the published page.
    expect(await identifiedPage.content()).not.toContain("manifest.json");
    expect(await identifiedPage.content()).not.toContain("ledger.jsonl");

    // The anonymous member sees the same canvas: their items carry no
    // identifier anywhere in the artifact.
    await anonymousPage.goto(`${server.serverUrl}/${publicHref}?lang=en`);
    await anonymousPage
      .getByRole("link", { name: "View published canvas" })
      .click();
    await expect(anonymousPage.locator("#canvas")).toBeVisible();
    expect(await anonymousPage.locator("[data-wbo-created-by]").count()).toBe(
      await identifiedPage.locator("[data-wbo-created-by]").count(),
    );

    // Switching the audience to organizer-only locks members out.
    await page.goto(`${manageUrl}?lang=en`);
    await page
      .getByLabel("Who can view")
      .selectOption({ label: "Only organizer members" });
    await page.getByRole("button", { name: "Update publication" }).click();
    await expect(
      page.getByText("The publication settings are updated."),
    ).toBeVisible();
    await identifiedPage.goto(`${server.serverUrl}/${publicHref}?lang=en`);
    await expect(
      identifiedPage.getByRole("link", { name: "View published canvas" }),
    ).toHaveCount(0);
    expect(
      (
        await identifiedPage.request.get(
          `${server.serverUrl}/${publicHref}/canvas`,
        )
      ).status(),
    ).toBe(404);
    await page.getByRole("link", { name: "View published canvas" }).click();
    await expect(page.locator("#canvas")).toBeVisible();

    // The link audience reveals its share URL exactly once; a signed-out
    // holder can read it.
    await page.goto(`${manageUrl}?lang=en`);
    await page
      .getByLabel("Who can view")
      .selectOption({ label: "Anyone with the share link" });
    await page.getByRole("button", { name: "Update publication" }).click();
    const shareUrl = await page
      .locator(".hosted-publication-share-url")
      .textContent();
    expect(shareUrl).toMatch(/\/events\/[^/]+\/canvas\/[A-Za-z0-9_-]+$/);
    const strangerContext = await browser.newContext();
    const strangerPage = await strangerContext.newPage();
    await strangerPage.goto(`${server.serverUrl}${shareUrl}`);
    await expect(strangerPage.locator("#canvas")).toBeVisible();
    await expect(strangerPage.locator(".hosted-contributor-item")).toHaveCount(
      1,
    );

    // Revocation invalidates every audience and the share link immediately.
    await page.goto(`${manageUrl}?lang=en`);
    await page.getByRole("button", { name: "Withdraw publication" }).click();
    await expect(page).toHaveURL(/events\/[^/]+$/);
    expect(
      (
        await strangerPage.request.get(`${server.serverUrl}${shareUrl}`)
      ).status(),
    ).toBe(404);
    expect(
      (
        await identifiedPage.request.get(
          `${server.serverUrl}/${publicHref}/canvas`,
        )
      ).status(),
    ).toBe(404);

    // Publishing again mints a fresh link; the revoked one never returns.
    await page.goto(`${manageUrl}?lang=en`);
    await page
      .getByLabel("Who can view")
      .selectOption({ label: "Anyone with the share link" });
    await page.getByRole("button", { name: "Publish canvas" }).click();
    const newShareUrl = await page
      .locator(".hosted-publication-share-url")
      .textContent();
    expect(newShareUrl).toBeTruthy();
    expect(newShareUrl).not.toBe(shareUrl);
    await strangerPage.goto(`${server.serverUrl}${newShareUrl}`);
    await expect(strangerPage.locator("#canvas")).toBeVisible();
    expect(
      (
        await strangerPage.request.get(`${server.serverUrl}${shareUrl}`)
      ).status(),
    ).toBe(404);

    await strangerContext.close();
    await anonymousContext.close();
    await identifiedContext.close();
    await operatorContext.close();
  });
});
