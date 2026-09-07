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
 * start passes, so the event is scheduled about a minute out. Values are
 * service-local wall clock (UTC+8).
 */
function startSoon(offsetMs = 0): string {
  return new Date(Date.now() + SERVICE_OFFSET_MS + 70_000 + offsetMs)
    .toISOString()
    .slice(0, 16);
}

/**
 * The presence list re-renders periodically and the panel closes on blur
 * when its focused row is replaced, so every interaction (re)opens the
 * panel first and retries.
 *
 * @param {Page} page
 */
async function ensurePresencePanelOpen(page: Page) {
  const panel = page.locator("#connectedUsersPanel");
  if (!(await panel.isVisible())) {
    await page.locator("#connectedUsersToggle").click();
  }
  await expect(panel).toBeVisible();
}

/**
 * Opens the presence panel, opens the hosted moderation dialog on the first
 * reportable participant, and resolves which page owns that target by its
 * own presence name.
 */
async function openModerationDialogAndResolveTarget(
  moderatorPage: Page,
  participants: { page: Page; ownName: () => Promise<string> }[],
): Promise<{ targetName: string; ownedBy: number }> {
  await expect(async () => {
    await ensurePresencePanelOpen(moderatorPage);
    // The presence rows re-render continuously; click the current node
    // in-page so actionability checks cannot race the re-render.
    await moderatorPage.evaluate(() => {
      const button = document.querySelector(
        ".connected-user-row:not(.connected-user-row-self) .connected-user-report:not([disabled]):not([hidden]):not(.connected-user-report-latched)",
      );
      if (button) (button as HTMLElement).click();
    });
    await expect(
      moderatorPage.locator(".moderation-action-dialog"),
    ).toBeVisible();
  }).toPass({ timeout: 30_000 });
  const title =
    (await moderatorPage.locator(".moderation-action-title").textContent()) ??
    "";
  const targetName = title.replace(/^Moderate\s+/, "").trim();
  for (let index = 0; index < participants.length; index += 1) {
    const ownName = await participants[index].ownName();
    if (ownName === targetName) return { targetName, ownedBy: index };
  }
  throw new Error(`dialog target "${targetName}" matched no participant page`);
}

/** Reads the participant's own presence name from its self row. */
function ownPresenceName(page: Page) {
  return async () => {
    await ensurePresencePanelOpen(page);
    const name = await page
      .locator(".connected-user-row-self .connected-user-name-text")
      .first()
      .textContent();
    return (name ?? "").trim();
  };
}

test.describe("event moderation: reports and moderator dispositions", () => {
  test("participants report, moderators warn and ban, and the console records everything", async ({
    page,
    browser,
    server,
  }) => {
    test.setTimeout(300_000);
    const password = "a solid moderation password";
    const stamp = Date.now();
    const ownerEmail = `owner-${stamp}@example.com`;
    const moderatorEmail = `mod-${stamp}@example.com`;
    const reporterEmail = `reporter-${stamp}@example.com`;
    const targetEmail = `target-${stamp}@example.com`;

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
    await page.getByLabel("Event name").fill("Moderation Jam");
    await page.getByLabel("Start time").fill(startSoon());
    await page.getByLabel("End time").fill(startSoon(HOUR));
    await page.getByLabel("Requested seats").fill("5");
    await page.getByLabel("Visibility").selectOption("public");
    await page.getByRole("button", { name: "Create draft" }).click();
    await expect(
      page.getByRole("heading", { name: "Moderation Jam" }),
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
    expect(accessCode).toMatch(/^[2-9A-HJKMNP-Z]{5}(-[2-9A-HJKMNP-Z]{5}){3}$/);
    const publicHref = await page
      .getByRole("link", { name: "View public page" })
      .getAttribute("href");
    expect(publicHref).toMatch(/^events\//);

    // Register the moderator before assigning it: the grant requires a
    // verified account.
    const moderatorContext = await browser.newContext();
    const moderatorPage = await moderatorContext.newPage();
    await registerVerifyLogin(moderatorPage, server, moderatorEmail, password);

    // --- Assign an Event Moderator from the console -------------------------
    await page
      .getByLabel("Assign a moderator by account email")
      .fill(moderatorEmail);
    await page.getByRole("button", { name: "Assign moderator" }).click();
    await expect(
      page.getByText("The event moderator has been assigned."),
    ).toBeVisible();
    await expect(
      page
        .locator(".hosted-moderator-item")
        .filter({ hasText: moderatorEmail }),
    ).toBeVisible();

    // --- The assigned moderator enters during the preparation window --------
    await moderatorPage.goto(`${server.serverUrl}/${publicHref}?lang=en`);
    await moderatorPage.getByRole("link", { name: "Enter the board" }).click();
    await expect(moderatorPage.locator("#canvas")).toBeVisible({
      timeout: 30_000,
    });
    // Event moderators govern but must never see the Clear tool.
    await expect(moderatorPage.locator("#toolID-clear")).toBeHidden();

    // The owner also enters the board for the ban disposition.
    await page.goto(`${server.serverUrl}/${publicHref}?lang=en`);
    await page.getByRole("link", { name: "Enter the board" }).click();
    await expect(page.locator("#canvas")).toBeVisible({ timeout: 30_000 });

    // --- Participants join once the session opens ----------------------------
    const reporterContext = await browser.newContext();
    const reporterPage = await reporterContext.newPage();
    await registerVerifyLogin(reporterPage, server, reporterEmail, password);
    const targetContext = await browser.newContext();
    const targetPage = await targetContext.newPage();
    await registerVerifyLogin(targetPage, server, targetEmail, password);

    const enterAndJoin = async (participantPage: Page) => {
      const enterForm = participantPage.locator(".hosted-event-enter");
      await expect(async () => {
        await participantPage.goto(`${server.serverUrl}/${publicHref}?lang=en`);
        await expect(enterForm).toBeVisible();
      }).toPass({ timeout: 150_000 });
      await participantPage
        .getByLabel("Access code", { exact: true })
        .fill(accessCode ?? "");
      await participantPage
        .getByRole("button", { name: "Enter event" })
        .click();
      await expect(
        participantPage.getByText(/Your membership for this event is active/),
      ).toBeVisible();
      const boardHref = await participantPage
        .getByRole("link", { name: "Enter the board" })
        .getAttribute("href");
      expect(boardHref).toMatch(/^b\/event-[0-9a-f]{24}$/);
      await participantPage.goto(`${server.serverUrl}/${boardHref}?lang=en`);
      await expect(participantPage.locator("#canvas")).toBeVisible({
        timeout: 30_000,
      });
    };
    await enterAndJoin(reporterPage);
    await enterAndJoin(targetPage);

    // --- Report flow ----------------------------------------------------------
    // The reporter reports the other participant; governance pages are
    // notified and nobody is disconnected.
    // Presence must be fully synced before the report: four connected
    // accounts (owner, moderator, reporter, target).
    await expect(async () => {
      await ensurePresencePanelOpen(reporterPage);
      await expect(
        reporterPage.locator("#connectedUsersList .connected-user-row"),
      ).toHaveCount(4);
    }).toPass({ timeout: 30_000 });
    // The presence list re-renders periodically; click the current visible
    // report button in-page and retry until the report latches.
    await expect(async () => {
      await ensurePresencePanelOpen(reporterPage);
      await reporterPage.evaluate(() => {
        const button = document.querySelector(
          ".connected-user-row:not(.connected-user-row-self) .connected-user-report:not([disabled]):not([hidden]):not(.connected-user-report-latched)",
        );
        if (button) (button as HTMLElement).click();
      });
      await expect(
        reporterPage.locator(".connected-user-report-latched").first(),
      ).toBeVisible();
    }).toPass({ timeout: 30_000 });

    await expect(page.getByText(/complained about/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(moderatorPage.getByText(/complained about/)).toBeVisible({
      timeout: 15_000,
    });
    // A hosted report never disconnects anyone.
    await expect(reporterPage.locator("#canvas")).toBeVisible();

    // --- Warn disposition (the event moderator acts) ---------------------------
    // The moderator's panel must also show all four participants first.
    await expect(async () => {
      await ensurePresencePanelOpen(moderatorPage);
      await expect(
        moderatorPage.locator("#connectedUsersList .connected-user-row"),
      ).toHaveCount(4);
    }).toPass({ timeout: 30_000 });
    const warnTargets = [
      { page: reporterPage, ownName: ownPresenceName(reporterPage) },
      { page: targetPage, ownName: ownPresenceName(targetPage) },
    ];
    const warned = await openModerationDialogAndResolveTarget(
      moderatorPage,
      warnTargets,
    );
    await moderatorPage
      .locator(".moderation-action-input")
      .fill("keep it friendly");
    await moderatorPage
      .locator(".moderation-action-segmented")
      .getByRole("button", { name: "Warn" })
      .click();
    await expect(
      moderatorPage.locator(".moderation-action-dialog"),
    ).toBeHidden();

    const warnedPage = warnTargets[warned.ownedBy].page;
    await expect(
      warnedPage.getByText(/A moderator has issued you a warning/),
    ).toBeVisible({ timeout: 15_000 });
    await expect(warnedPage.getByText("keep it friendly")).toBeVisible();
    await warnedPage.getByRole("button", { name: "I understand" }).click();
    // The warned participant stays on the board.
    await expect(warnedPage.locator("#canvas")).toBeVisible();

    // --- Ban disposition (the owner acts) ---------------------------------------
    await expect(async () => {
      await ensurePresencePanelOpen(page);
      await expect(
        page.locator("#connectedUsersList .connected-user-row"),
      ).toHaveCount(4);
    }).toPass({ timeout: 30_000 });
    const banTargets = [warnTargets[0], warnTargets[1]];
    const banResolved = await openModerationDialogAndResolveTarget(
      page,
      banTargets,
    );
    const banTargetPage = banTargets[banResolved.ownedBy].page;
    await page.locator(".moderation-action-input").fill("repeated harassment");
    await page
      .locator(".moderation-action-segmented")
      .getByRole("button", { name: "Ban from event" })
      .click();

    // The banned participant is told clearly, then routed to the event page.
    await expect(
      banTargetPage.getByText("A moderator has removed you from this event."),
    ).toBeVisible({ timeout: 15_000 });
    await banTargetPage.getByRole("button", { name: "I understand" }).click();
    await expect(banTargetPage).toHaveURL(/notice=banned$/, {
      timeout: 15_000,
    });
    await expect(
      banTargetPage.getByText("You cannot access this event's board."),
    ).toBeVisible();

    // The ban also blocked re-entry with the correct access code: the event
    // page shows the entry form again instead of an active membership.
    await banTargetPage.goto(`${server.serverUrl}/${publicHref}?lang=en`);
    await expect(
      banTargetPage.getByText(/Your membership for this event is active/),
    ).toHaveCount(0);

    // --- The console records the governance trail --------------------------------
    await page.goto(manageUrl);
    await expect(page.getByText("Warning issued")).toBeVisible();
    await expect(page.getByText("Participant banned")).toBeVisible();
    await expect(page.getByText("keep it friendly")).toBeVisible();
    await expect(page.getByText("repeated harassment")).toBeVisible();

    await reporterContext.close();
    await targetContext.close();
    await moderatorContext.close();
    await operatorContext.close();
  });
});
