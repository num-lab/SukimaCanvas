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
 * start passes, so this test schedules the event about a minute out. Values
 * are service-local wall clock (UTC+8).
 */
function startSoon(offsetMs = 0): string {
  return new Date(Date.now() + SERVICE_OFFSET_MS + 70_000 + offsetMs)
    .toISOString()
    .slice(0, 16);
}

test.describe("organizer entry grants", () => {
  test("a participant follows the organizer's fragment link, logs in, and lands in the event", async ({
    page,
    browser,
    server,
  }) => {
    test.setTimeout(240_000);
    const password = "a solid entry-grant password";
    const stamp = Date.now();
    const ownerEmail = `grant-owner-${stamp}@example.com`;

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
    await page.getByLabel("Event name").fill("Entry Grant Jam");
    await page.getByLabel("Start time").fill(startSoon());
    await page.getByLabel("End time").fill(startSoon(HOUR));
    await page.getByLabel("Requested seats").fill("25");
    await page.getByLabel("Visibility").selectOption("unlisted");
    await page.getByRole("button", { name: "Create draft" }).click();
    await expect(
      page.getByRole("heading", { name: "Entry Grant Jam" }),
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

    // The owner mints an API credential on the organizer management page; the
    // secret is revealed exactly once.
    await page.goto(`${server.serverUrl}/organizer?lang=en`);
    await page.getByRole("link", { name: "Manage" }).first().click();
    await page.getByRole("button", { name: "Create API credential" }).click();
    const credentialToken = (
      await page.locator(".hosted-credential-secret-value").textContent()
    )?.trim();
    expect(credentialToken).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    // Navigating away and back (a GET, not the minting POST) never
    // re-reveals the secret.
    await page.goto(`${server.serverUrl}/organizer?lang=en`);
    await page.getByRole("link", { name: "Manage" }).first().click();
    await expect(
      page.getByRole("button", { name: "Create API credential" }),
    ).toBeVisible();
    await expect(page.locator(".hosted-credential-secret-value")).toHaveCount(
      0,
    );

    // The organizer backend exchanges the credential for an Entry Grant.
    await page.goto(reservationUrl);
    await page.getByRole("link", { name: "Manage event page" }).click();
    const publicHref =
      (await page
        .getByRole("link", { name: "View public page" })
        .getAttribute("href")) ?? "";
    expect(publicHref).toBeTruthy();
    // The template renders a relative href; normalize it once.
    const publicPath = new URL(publicHref, server.serverUrl).pathname;
    const publicId = publicPath.split("/")[2];
    const grantResponse = await fetch(
      `${server.serverUrl}/api/v1/events/${publicId}/entry-grants`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentialToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ externalReference: "customer-42" }),
      },
    );
    expect(grantResponse.status).toBe(201);
    const { entryGrant } = (await grantResponse.json()) as {
      entryGrant: { entryGrantPath: string; externalReference: string | null };
    };
    expect(entryGrant.entryGrantPath).toMatch(
      new RegExp(`^${publicPath}#entryGrant=[A-Za-z0-9_-]{20,128}$`),
    );
    expect(entryGrant.externalReference).toBe("customer-42");

    // Participant 1 signs in and waits for the session to open; a
    // non-member sees the entry form only then.
    const participantContext = await browser.newContext();
    const participantPage = await participantContext.newPage();
    await registerVerifyLogin(
      participantPage,
      server,
      `joiner-${stamp}@example.com`,
      password,
    );
    await participantPage.goto(`${server.serverUrl}${publicPath}?lang=en`);
    // The session opens when the scheduled start passes; poll with reloads.
    const enterForm = participantPage.locator(".hosted-event-enter");
    await expect(async () => {
      await participantPage.reload();
      await expect(enterForm).toBeVisible();
    }).toPass({ timeout: 150_000 });

    // Then they follow the organizer's link: the grant is redeemed and the
    // fragment is cleared immediately.
    await participantPage.goto(
      `${server.serverUrl}${entryGrant.entryGrantPath}`,
    );
    await expect(
      participantPage.locator(".hosted-event-membership"),
    ).toBeVisible();
    expect(participantPage.url()).not.toContain("entryGrant=");
    expect(participantPage.url()).not.toContain("#");

    // The grant was single-use: the same link fails for the next person.
    const secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    await registerVerifyLogin(
      secondPage,
      server,
      `late-${stamp}@example.com`,
      password,
    );
    await secondPage.goto(`${server.serverUrl}${entryGrant.entryGrantPath}`);
    await expect(
      secondPage.getByText(/invalid, expired, or has already been used/),
    ).toBeVisible();
    expect(secondPage.url()).not.toContain("entryGrant=");

    // A signed-out visitor completes Hosted Account login first; the grant
    // waits in the tab and is redeemed when they return to the event page.
    const grantResponse2 = await fetch(
      `${server.serverUrl}/api/v1/events/${publicId}/entry-grants`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentialToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    expect(grantResponse2.status).toBe(201);
    const { entryGrant: entryGrant2 } = (await grantResponse2.json()) as {
      entryGrant: { entryGrantPath: string };
    };
    const returningContext = await browser.newContext();
    const returningPage = await returningContext.newPage();
    // The participant registers once, signs out, and only then follows the
    // organizer's link signed out.
    await registerVerifyLogin(
      returningPage,
      server,
      `returning-${stamp}@example.com`,
      password,
    );
    await returningPage.goto(`${server.serverUrl}/logout?lang=en`);
    await returningPage.getByRole("button", { name: "Log out" }).click();
    await expect(returningPage.locator(".hosted-account-email")).toHaveCount(0);
    await returningPage.goto(
      `${server.serverUrl}${entryGrant2.entryGrantPath}`,
    );
    // Signed out: the page only offers login and clears the fragment.
    await expect(
      returningPage.getByRole("link", { name: "Log in to enter" }),
    ).toBeVisible();
    expect(returningPage.url()).not.toContain("entryGrant=");
    await returningPage.getByRole("link", { name: "Log in to enter" }).click();
    await returningPage
      .getByLabel("Email address")
      .fill(`returning-${stamp}@example.com`);
    await returningPage.getByLabel("Password", { exact: true }).fill(password);
    await returningPage.getByRole("button", { name: "Log in" }).click();
    await expect(returningPage.locator(".hosted-account-email")).toBeVisible();
    // Back on the event page, the pending grant redeems automatically.
    await returningPage.goto(`${server.serverUrl}${publicPath}?lang=en`);
    await expect(
      returningPage.locator(".hosted-event-membership"),
    ).toBeVisible();
    expect(returningPage.url()).not.toContain("entryGrant=");
  });
});
