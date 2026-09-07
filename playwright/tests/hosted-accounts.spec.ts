import { expect, test } from "../fixtures/test";
import { readAccountEmailLink } from "../helpers/hostedOutbox";

test.use({
  serverOptions: {
    env: { WBO_HOSTED_MODE: "true" },
  },
});

test.describe("hosted account lifecycle", () => {
  test("register, verify, log in, and log out in the browser", async ({
    page,
    server,
  }) => {
    const email = `browser-${Date.now()}@example.com`;
    const password = "a sturdy browser password";

    await page.goto(`${server.serverUrl}/register?lang=en`);
    await expect(
      page.getByRole("heading", { name: "Create your account" }),
    ).toBeVisible();

    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("checkbox", { name: /18 years old/ }).check();
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(
      page.getByRole("heading", { name: "Check your inbox" }),
    ).toBeVisible();
    await expect(page.locator(".hosted-account-note")).toContainText(email);

    // The verification link arrives in the durable mail outbox.
    const verifyLink = await readAccountEmailLink(server, email, "verify");
    await page.goto(verifyLink);
    await expect(page).toHaveURL(/\/login\?verified=1$/);
    await expect(
      page.getByText(/Your email address is verified/),
    ).toBeVisible();

    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Log in" }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator(".hosted-account-email")).toHaveText(email);

    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find(
      (candidate) => candidate.name === "hosted-session-v1",
    );
    expect(sessionCookie).toBeTruthy();
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(sessionCookie?.sameSite).toBe("Lax");

    // Log out; the session is revoked and the shell shows the logged-out nav.
    await page.goto(`${server.serverUrl}/logout?lang=en`);
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page.locator(".hosted-account-email")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Log in" }).first(),
    ).toBeVisible();

    // The old session cookie no longer authenticates the browser.
    await page.goto(`${server.serverUrl}/?lang=en`);
    await expect(page.locator(".hosted-account-email")).toHaveCount(0);
  });

  test("account pages offer the zh-CN experience", async ({ page, server }) => {
    await page.goto(`${server.serverUrl}/register?lang=zh-CN`);
    await expect(
      page.getByRole("heading", { name: "创建你的账户" }),
    ).toBeVisible();
    await expect(page.getByText("我确认本人已年满 18 周岁。")).toBeVisible();
    await expect(page.locator('header nav a[href="login"]')).toHaveText("登录");
  });
});
