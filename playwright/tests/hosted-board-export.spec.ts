import fs from "node:fs/promises";
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
      // the archive exists by the time the organizer requests the export.
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
 * seconds later: the session closes and archives while the test waits.
 */
function startSoon(offsetMs = 0): string {
  return new Date(Date.now() + SERVICE_OFFSET_MS + 70_000 + offsetMs)
    .toISOString()
    .slice(0, 16);
}

test.describe("board image export", () => {
  test("the organizer requests a PNG export of the archived session and downloads it", async ({
    page,
    browser,
    server,
  }) => {
    test.setTimeout(300_000);
    const password = "a solid export password";
    const stamp = Date.now();
    const ownerEmail = `export-owner-${stamp}@example.com`;

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

    // A short event: it ends about 100 seconds out and the durable poker
    // seals it with its Private Board Archive shortly after.
    await page.goto(`${server.serverUrl}/organizer?lang=en`);
    await page.getByRole("link", { name: "Manage" }).first().click();
    await page.getByRole("link", { name: "Reservations", exact: true }).click();
    await page.getByLabel("Event name").fill("Export Jam");
    await page.getByLabel("Start time").fill(startSoon());
    await page.getByLabel("End time").fill(startSoon(90_000));
    await page.getByLabel("Requested seats").fill("10");
    await page.getByLabel("Visibility").selectOption("public");
    await page.getByRole("button", { name: "Create draft" }).click();
    await expect(
      page.getByRole("heading", { name: "Export Jam" }),
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

    // Before the archive exists, an export request is refused honestly.
    await page.getByRole("button", { name: "Request export" }).click();
    await expect(page.getByText(/has not been archived yet/i)).toBeVisible();

    // The session drains, closes, and archives in the background; the
    // console always renders the authoritative lifecycle state. Navigate by
    // GET — reloading a POST response would resubmit the form.
    await expect(async () => {
      await page.goto(consoleUrl);
      await expect(page.getByText(/· Ended$/)).toBeVisible();
    }).toPass({ timeout: 240_000 });

    // Requesting the export enqueues a background job. Right after "Ended"
    // the drain window may still be running, so the request can honestly be
    // refused; the organizer retries until the archive exists.
    await expect(async () => {
      await page.goto(consoleUrl);
      await page.getByRole("button", { name: "Request export" }).click();
      await expect(page.getByText(/^(Queued|Processing|Ready)$/)).toBeVisible({
        timeout: 10_000,
      });
    }).toPass({ timeout: 240_000 });

    // The pipeline settles the job; refreshing the console shows the result
    // and the authorized, expiring download link.
    await expect(async () => {
      await page.goto(consoleUrl);
      await expect(page.getByText("Ready", { exact: true })).toBeVisible();
    }).toPass({ timeout: 60_000 });
    const downloadLink = page.getByRole("link", { name: "Download image" });
    await expect(downloadLink).toBeVisible();
    await expect(page.getByText(/Link valid until/)).toBeVisible();

    // The link serves the sanitized PNG through the organizer's session.
    const href = await downloadLink.getAttribute("href");
    expect(href).toMatch(/^organizers\/.+\/exports\/.+\/download\?token=/);
    const authorized = await page.request.get(
      new URL(href ?? "", server.serverUrl).href,
      { maxRedirects: 0 },
    );
    expect(authorized.status()).toBe(200);
    expect(authorized.headers()["content-type"]).toBe("image/png");
    expect(authorized.headers()["cache-control"]).toBe("no-store");
    const body = await authorized.body();
    expect(body.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(body.length).toBeGreaterThan(100);

    // Clicking the link downloads the file under its derived name.
    const downloadPromise = page.waitForEvent("download");
    await downloadLink.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.png$/);
    const downloaded = await download.path();
    const downloadedBytes = await fs.readFile(downloaded);
    expect(downloadedBytes.length).toBe(body.length);

    // A signed-out context is redirected to login: the link alone is not
    // authorization.
    const anonymousContext = await browser.newContext();
    const anonymous = await anonymousContext.request.get(
      new URL(href ?? "", server.serverUrl).href,
      { maxRedirects: 0 },
    );
    expect(anonymous.status()).toBe(303);

    // Revoking the link kills it immediately.
    await page.getByRole("button", { name: "Revoke link" }).click();
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Download image" }),
    ).toBeHidden();
    const revoked = await page.request.get(
      new URL(href ?? "", server.serverUrl).href,
      { maxRedirects: 0 },
    );
    expect(revoked.status()).toBe(404);

    await anonymousContext.close();
    await operatorContext.close();
  });
});
