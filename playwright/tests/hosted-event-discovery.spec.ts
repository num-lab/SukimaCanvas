import zlib from "node:zlib";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test";
import { readAccountEmailLink } from "../helpers/hostedOutbox";

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

/** A real, CRC-correct 1x1 PNG so the server-side image decoder accepts it. */
function validPng(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
    let crc = 0xffffffff;
    for (const byte of typeAndData) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) {
        crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }
    }
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([length, typeAndData, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

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

async function draftSubmitApprove(
  ownerPage: Page,
  operatorPage: Page,
  server: Parameters<typeof readAccountEmailLink>[0],
  eventName: string,
  visibility: "public" | "unlisted",
): Promise<string> {
  await ownerPage.goto(`${server.serverUrl}/organizer?lang=en`);
  await ownerPage.getByRole("link", { name: "Manage" }).first().click();
  await ownerPage
    .getByRole("link", { name: "Reservations", exact: true })
    .click();
  await ownerPage.getByLabel("Event name").fill(eventName);
  await ownerPage.getByLabel("Start time").fill(dateTimeLocal(DAY));
  await ownerPage.getByLabel("End time").fill(dateTimeLocal(DAY + HOUR));
  await ownerPage.getByLabel("Requested seats").fill("25");
  await ownerPage.getByLabel("Visibility").selectOption(visibility);
  await ownerPage.getByRole("button", { name: "Create draft" }).click();
  await expect(
    ownerPage.getByRole("heading", { name: eventName }),
  ).toBeVisible();
  const reservationUrl = ownerPage.url();
  await ownerPage.getByRole("button", { name: "Submit for approval" }).click();

  await operatorPage.goto(`${server.serverUrl}/operator/reservations?lang=en`);
  await operatorPage.getByRole("link", { name: "Review" }).first().click();
  await operatorPage.getByRole("button", { name: "Approve" }).click();
  await expect(
    operatorPage.getByText("Approved", { exact: true }),
  ).toBeVisible();

  await ownerPage.goto(reservationUrl);
  await expect(ownerPage.getByText("Approved", { exact: true })).toBeVisible();
  return reservationUrl;
}

test.describe("event discovery and brand assets", () => {
  test("public events are discoverable with a cover; unlisted stay link-only", async ({
    page,
    browser,
    server,
  }) => {
    const password = "a solid discovery password";
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

    // A public event, given a cover image through the management page.
    await draftSubmitApprove(
      page,
      operatorPage,
      server,
      "Gallery Opening",
      "public",
    );
    await page.getByRole("link", { name: "Manage event page" }).click();
    await page.getByLabel("Cover image", { exact: true }).setInputFiles({
      name: "cover.png",
      mimeType: "image/png",
      buffer: validPng(),
    });
    await page.getByRole("button", { name: "Upload cover" }).click();
    await expect(page.locator(".hosted-event-cover-preview")).toBeVisible();

    // An unlisted event, whose public link we keep for a direct visit.
    const unlistedReservationUrl = await draftSubmitApprove(
      page,
      operatorPage,
      server,
      "Closed Rehearsal",
      "unlisted",
    );
    await page.goto(unlistedReservationUrl);
    const unlistedPublicPath = (
      await page.locator("code").first().textContent()
    )?.trim();
    expect(unlistedPublicPath).toMatch(/\/events\//);

    // A fresh anonymous visitor sees only the public event on the home page.
    const visitorContext = await browser.newContext();
    const visitorPage = await visitorContext.newPage();
    await visitorPage.goto(`${server.serverUrl}/?lang=en`);
    await expect(visitorPage.getByText("Gallery Opening")).toBeVisible();
    await expect(visitorPage.getByText("Closed Rehearsal")).toHaveCount(0);

    // Opening the public event shows its brand cover and organizer name.
    await visitorPage.getByText("Gallery Opening").click();
    await expect(
      visitorPage.getByRole("heading", { name: "Gallery Opening" }),
    ).toBeVisible();
    await expect(visitorPage.getByText("Aurora Collective")).toBeVisible();
    await expect(visitorPage.locator(".hosted-event-cover")).toBeVisible();

    // The unlisted event is not listed but opens directly by its public link.
    await visitorPage.goto(`${server.serverUrl}${unlistedPublicPath}?lang=en`);
    await expect(
      visitorPage.getByRole("heading", { name: "Closed Rehearsal" }),
    ).toBeVisible();

    await visitorContext.close();
    await operatorContext.close();
  });
});
