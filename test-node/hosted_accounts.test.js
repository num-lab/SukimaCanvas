const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const { closeServer, createConfig, request } = require("./test_helpers.js");
const { createServerApp } = require("../server/server.mjs");

const {
  CLIENT_WEBROOT,
  STRONG_PASSWORD,
  MAX_FORM_BODY_BYTES,
  createHostedServer,
  requestWithCookies,
  formValue,
  cookiePair,
  cookieAttributes,
  pollOutbox,
  readOutboxMessages,
} = require("./helpers/hosted_http.js");

/**
 * Reads a verification message from the outbox, waiting past any previously
 * seen link when one is given. Outbox filenames are not order-bearing, so
 * messages are matched by content, not position.
 * @param {string} outboxDir
 * @param {string} [previousSearch] query string of an already-consumed link
 * @returns {Promise<{message: any, verifyUrl: URL}>}
 */
async function readVerificationEmail(outboxDir, previousSearch) {
  const message = await pollOutbox(async () =>
    (await readOutboxMessages(outboxDir)).find(
      (candidate) =>
        candidate.body.includes("/verify?token=") &&
        (previousSearch === undefined ||
          !candidate.body.includes(previousSearch)),
    ),
  );
  const urlMatch = /https?:\/\/\S+/.exec(message.body);
  assert.ok(urlMatch, "verification email must contain the verify link");
  return { message, verifyUrl: new URL(urlMatch[0]) };
}

test("register, verify, login, and logout work through the composed server", async () => {
  const { app, outboxDir } = await createHostedServer();
  try {
    // The register page renders localized copy with a CSRF token and cookie.
    const registerPage = await requestWithCookies(app, "/register?lang=zh-CN");
    assert.equal(registerPage.statusCode, 200);
    assert.match(registerPage.body, /创建你的账户/);
    assert.match(registerPage.body, /我确认本人已年满 18 周岁/);
    assert.match(registerPage.headers["cache-control"] || "", /no-store/);
    assert.match(registerPage.headers.vary || "", /Cookie/);
    const csrfToken = formValue(registerPage.body, "_csrf");
    assert.ok(csrfToken);
    const csrfCookie = cookiePair(registerPage.setCookie, "hosted-csrf-v1");
    assert.match(
      cookieAttributes(registerPage.setCookie, "hosted-csrf-v1"),
      /HttpOnly/,
    );
    assert.match(
      cookieAttributes(registerPage.setCookie, "hosted-csrf-v1"),
      /SameSite=Lax/,
    );

    const email = `flow-${Date.now()}@example.com`;
    const registered = await requestWithCookies(app, "/register?lang=zh-CN", {
      method: "POST",
      cookie: csrfCookie,
      body: new URLSearchParams({
        _csrf: csrfToken,
        email,
        password: STRONG_PASSWORD,
        ageConfirmation: "1",
      }).toString(),
    });
    assert.equal(registered.statusCode, 200);
    assert.match(registered.body, /验证链接已发送至/);
    assert.match(registered.body, new RegExp(email.replace(/[.@]/g, "\\$&")));
    // No credential material may appear in the response.
    assert.equal(registered.body.includes(STRONG_PASSWORD), false);
    assert.equal(registered.body.includes("token="), false);

    // The verification email goes to the outbox and nowhere near the response.
    const { message, verifyUrl } = await readVerificationEmail(outboxDir);
    assert.equal(message.to, email);
    assert.equal(verifyUrl.pathname, "/verify");
    assert.match(verifyUrl.searchParams.get("token") || "", /^[\w-]{20,}$/);

    const verified = await requestWithCookies(
      app,
      `${verifyUrl.pathname}${verifyUrl.search}`,
    );
    assert.equal(verified.statusCode, 303);
    assert.equal(verified.headers.location, "/login?verified=1");

    // Verification is single-use.
    const reused = await requestWithCookies(
      app,
      `${verifyUrl.pathname}${verifyUrl.search}`,
    );
    assert.equal(reused.statusCode, 403);
    assert.match(reused.body, /invalid, was already used, or has expired/);

    const loginPage = await requestWithCookies(
      app,
      "/login?verified=1&lang=zh-CN",
    );
    assert.match(loginPage.body, /邮箱验证完成/);
    const loginCsrf = formValue(loginPage.body, "_csrf");
    const loginCookie = cookiePair(loginPage.setCookie, "hosted-csrf-v1");
    const loggedIn = await requestWithCookies(app, "/login?lang=zh-CN", {
      method: "POST",
      cookie: loginCookie,
      body: new URLSearchParams({
        _csrf: loginCsrf,
        email,
        password: STRONG_PASSWORD,
      }).toString(),
    });
    assert.equal(loggedIn.statusCode, 303);
    assert.equal(loggedIn.headers.location, "/");
    const sessionCookie = cookiePair(loggedIn.setCookie, "hosted-session-v1");
    const sessionAttributes = cookieAttributes(
      loggedIn.setCookie,
      "hosted-session-v1",
    );
    assert.match(sessionAttributes, /HttpOnly/);
    assert.match(sessionAttributes, /SameSite=Lax/);
    assert.match(sessionAttributes, /Path=\//);

    const home = await requestWithCookies(app, "/?lang=zh-CN", {
      cookie: `${sessionCookie}; ${csrfCookie}`,
    });
    assert.match(home.body, new RegExp(email.replace(/[.@]/g, "\\$&")));
    assert.match(home.body, /退出登录/);

    const logoutPage = await requestWithCookies(app, "/logout?lang=zh-CN", {
      cookie: `${sessionCookie}; ${csrfCookie}`,
    });
    assert.equal(logoutPage.statusCode, 200);
    assert.match(logoutPage.body, /退出登录/);
    const loggedOut = await requestWithCookies(app, "/logout?lang=zh-CN", {
      method: "POST",
      cookie: `${sessionCookie}; ${csrfCookie}`,
      body: new URLSearchParams({
        _csrf: formValue(logoutPage.body, "_csrf"),
      }).toString(),
    });
    assert.equal(loggedOut.statusCode, 303);
    assert.match(
      cookieAttributes(loggedOut.setCookie, "hosted-session-v1"),
      /Max-Age=0/,
    );

    const afterLogout = await requestWithCookies(app, "/?lang=zh-CN", {
      cookie: sessionCookie,
    });
    assert.doesNotMatch(afterLogout.body, /退出登录/);
    assert.match(afterLogout.body, /登录/);
  } finally {
    await closeServer(app);
  }
});

test("login failures never reveal whether an email is registered", async () => {
  const { app, outboxDir } = await createHostedServer();
  try {
    const verifiedEmail = `enumerate-${Date.now()}@example.com`;
    const unverifiedEmail = `unverified-${Date.now()}@example.com`;
    const registerPage = await requestWithCookies(app, "/register?lang=en");
    const csrfCookie = cookiePair(registerPage.setCookie, "hosted-csrf-v1");
    /** @param {string} formEmail */
    const register = (formEmail) =>
      requestWithCookies(app, "/register", {
        method: "POST",
        cookie: csrfCookie,
        body: new URLSearchParams({
          _csrf: formValue(registerPage.body, "_csrf"),
          email: formEmail,
          password: STRONG_PASSWORD,
          ageConfirmation: "1",
        }).toString(),
      });
    await register(verifiedEmail);
    await register(unverifiedEmail);

    // Verify the first account only; the second stays unverified.
    const messages = await pollOutbox(async () => {
      const current = await readOutboxMessages(outboxDir);
      return current.length === 2 ? current : null;
    });
    assert.equal(messages.length, 2);
    for (const message of messages) {
      if (message.to === verifiedEmail) {
        const urlMatch = /https?:\/\/\S+/.exec(message.body);
        assert.ok(urlMatch);
        const verifyUrl = new URL(urlMatch[0]);
        await requestWithCookies(
          app,
          `${verifyUrl.pathname}${verifyUrl.search}`,
        );
      }
    }

    const loginPage = await requestWithCookies(app, "/login?lang=en");
    const loginCsrf = formValue(loginPage.body, "_csrf");
    const loginCookiePair = cookiePair(loginPage.setCookie, "hosted-csrf-v1");
    const post =
      /** @param {string} formEmail @param {string} password */
      (formEmail, password) =>
        requestWithCookies(app, "/login", {
          method: "POST",
          cookie: loginCookiePair,
          body: new URLSearchParams({
            _csrf: loginCsrf,
            email: formEmail,
            password,
          }).toString(),
        });

    const unknown = await post(
      `nobody-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    const wrongPassword = await post(
      verifiedEmail,
      "definitely-not-the-password",
    );
    const unverified = await post(unverifiedEmail, STRONG_PASSWORD);
    // All three failures produce the same status and generic copy; no
    // response may reveal whether an email is registered or verified.
    assert.equal(unknown.statusCode, wrongPassword.statusCode);
    assert.equal(wrongPassword.statusCode, unverified.statusCode);
    for (const failure of [unknown, wrongPassword, unverified]) {
      assert.equal(failure.statusCode, 401);
      // The error paragraph itself must stay generic: the page copy may
      // mention verification, but the failure response may not reveal any
      // account state.
      const errorMatch = /class="hosted-form-error"[^>]*>([^<]*)</.exec(
        failure.body,
      );
      assert.ok(errorMatch);
      assert.equal(errorMatch[1], "Incorrect email address or password.");
    }
  } finally {
    await closeServer(app);
  }
});

test("hostile registration input is rejected deterministically", async () => {
  const { app } = await createHostedServer();
  try {
    const registerPage = await requestWithCookies(app, "/register?lang=en");
    const csrfToken = formValue(registerPage.body, "_csrf");
    const csrfCookie = cookiePair(registerPage.setCookie, "hosted-csrf-v1");
    const post =
      /** @param {{[key: string]: string}} fields @param {{cookie?: string, headers?: {[key: string]: string}, method?: string}} [options] */
      (fields, options = {}) =>
        requestWithCookies(app, "/register", {
          method: options.method || "POST",
          cookie: options.cookie === undefined ? csrfCookie : options.cookie,
          headers: options.headers,
          body: new URLSearchParams(fields).toString(),
        });

    const base = {
      _csrf: csrfToken,
      email: `hostile-${Date.now()}@example.com`,
      password: STRONG_PASSWORD,
      ageConfirmation: "1",
    };

    const missingAge = await post({ ...base, ageConfirmation: "" });
    assert.equal(missingAge.statusCode, 400);
    assert.match(missingAge.body, /at least 18 years old/);

    const badEmail = await post({ ...base, email: "not-an-email" });
    assert.equal(badEmail.statusCode, 400);
    assert.match(badEmail.body, /valid email address/);

    const shortPassword = await post({ ...base, password: "short" });
    assert.equal(shortPassword.statusCode, 400);
    assert.match(shortPassword.body, /between 8 and 128/);

    const hugePassword = await post({ ...base, password: "x".repeat(129) });
    assert.equal(hugePassword.statusCode, 400);

    const missingCsrf = await post(base, { cookie: "" });
    assert.equal(missingCsrf.statusCode, 403);
    assert.match(missingCsrf.body, /form has expired/);

    const wrongCsrf = await post({ ...base, _csrf: "a".repeat(32) });
    assert.equal(wrongCsrf.statusCode, 403);

    const wrongContentType = await requestWithCookies(app, "/register", {
      method: "POST",
      cookie: csrfCookie,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(base),
    });
    assert.equal(wrongContentType.statusCode, 415);

    const oversized = await requestWithCookies(app, "/register", {
      method: "POST",
      cookie: csrfCookie,
      body: `email=${"x".repeat(MAX_FORM_BODY_BYTES + 1)}`,
    });
    assert.equal(oversized.statusCode, 413);

    const wrongMethod = await requestWithCookies(app, "/register", {
      method: "PUT",
    });
    assert.equal(wrongMethod.statusCode, 405);

    const verifyPost = await requestWithCookies(app, "/verify", {
      method: "POST",
      body: "token=abc",
    });
    assert.equal(verifyPost.statusCode, 405);
  } finally {
    await closeServer(app);
  }
});

test("duplicate registrations stay deterministic", async () => {
  const { app, outboxDir } = await createHostedServer();
  try {
    const email = `duplicate-${Date.now()}@example.com`;
    const registerPage = await requestWithCookies(app, "/register?lang=en");
    const csrfCookie = cookiePair(registerPage.setCookie, "hosted-csrf-v1");
    /** @param {string} password */
    const register = (password) =>
      requestWithCookies(app, "/register", {
        method: "POST",
        cookie: csrfCookie,
        body: new URLSearchParams({
          _csrf: formValue(registerPage.body, "_csrf"),
          email,
          password,
          ageConfirmation: "1",
        }).toString(),
      });

    const first = await register(STRONG_PASSWORD);
    assert.equal(first.statusCode, 200);
    const firstMessage = await readVerificationEmail(outboxDir);

    // Re-registering an unverified account resends a fresh single-use link.
    const second = await register("another fine password");
    assert.equal(second.statusCode, 200);
    assert.match(second.body, /verification link/);
    const secondMessage = await readVerificationEmail(
      outboxDir,
      firstMessage.verifyUrl.search,
    );
    assert.notEqual(
      firstMessage.verifyUrl.search,
      secondMessage.verifyUrl.search,
    );
    // The replaced link no longer verifies; the fresh one does.
    const staleLink = await requestWithCookies(
      app,
      `${firstMessage.verifyUrl.pathname}${firstMessage.verifyUrl.search}`,
    );
    assert.equal(staleLink.statusCode, 403);
    const freshLink = await requestWithCookies(
      app,
      `${secondMessage.verifyUrl.pathname}${secondMessage.verifyUrl.search}`,
    );
    assert.equal(freshLink.statusCode, 303);

    const third = await requestWithCookies(app, "/register", {
      method: "POST",
      cookie: csrfCookie,
      body: new URLSearchParams({
        _csrf: formValue(registerPage.body, "_csrf"),
        email,
        password: STRONG_PASSWORD,
        ageConfirmation: "1",
      }).toString(),
    });
    assert.equal(third.statusCode, 409);
    assert.match(third.body, /already registered/);
  } finally {
    await closeServer(app);
  }
});

test("expired verification tokens are rejected like invalid ones", async () => {
  const { app, outboxDir } = await createHostedServer({
    HOSTED_VERIFICATION_TOKEN_TTL_MS: 1,
  });
  try {
    const email = `expiry-${Date.now()}@example.com`;
    const registerPage = await requestWithCookies(app, "/register?lang=en");
    await requestWithCookies(app, "/register", {
      method: "POST",
      cookie: cookiePair(registerPage.setCookie, "hosted-csrf-v1"),
      body: new URLSearchParams({
        _csrf: formValue(registerPage.body, "_csrf"),
        email,
        password: STRONG_PASSWORD,
        ageConfirmation: "1",
      }).toString(),
    });
    const { verifyUrl } = await readVerificationEmail(outboxDir);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const expired = await requestWithCookies(
      app,
      `${verifyUrl.pathname}${verifyUrl.search}`,
    );
    assert.equal(expired.statusCode, 403);
    assert.match(expired.body, /invalid, was already used, or has expired/);
    assert.doesNotMatch(expired.body, /token/);
  } finally {
    await closeServer(app);
  }
});

test("registration and login are rate limited per IP and per email", async () => {
  const { app } = await createHostedServer({
    HOSTED_REGISTER_ATTEMPTS_LIMIT: 2,
    HOSTED_REGISTER_ATTEMPTS_WINDOW_MS: 60_000,
    HOSTED_LOGIN_ATTEMPTS_LIMIT: 2,
    HOSTED_LOGIN_ATTEMPTS_WINDOW_MS: 60_000,
  });
  try {
    const registerPage = await requestWithCookies(app, "/register?lang=en");
    const csrfToken = formValue(registerPage.body, "_csrf");
    const csrfCookie = cookiePair(registerPage.setCookie, "hosted-csrf-v1");
    /** @param {string} email */
    const register = (email) =>
      requestWithCookies(app, "/register", {
        method: "POST",
        cookie: csrfCookie,
        body: new URLSearchParams({
          _csrf: csrfToken,
          email,
          password: STRONG_PASSWORD,
          ageConfirmation: "1",
        }).toString(),
      });

    assert.equal(
      (await register(`a-${Date.now()}@example.com`)).statusCode,
      200,
    );
    assert.equal(
      (await register(`b-${Date.now()}@example.com`)).statusCode,
      200,
    );
    const limited = await register(`c-${Date.now()}@example.com`);
    assert.equal(limited.statusCode, 429);
    assert.match(limited.body, /Too many attempts/);

    const loginPage = await requestWithCookies(app, "/login?lang=en");
    const loginCsrf = formValue(loginPage.body, "_csrf");
    const loginCookiePair = cookiePair(loginPage.setCookie, "hosted-csrf-v1");
    /** @param {string} email */
    const login = (email) =>
      requestWithCookies(app, "/login", {
        method: "POST",
        cookie: loginCookiePair,
        body: new URLSearchParams({
          _csrf: loginCsrf,
          email,
          password: STRONG_PASSWORD,
        }).toString(),
      });

    assert.equal((await login(`d-${Date.now()}@example.com`)).statusCode, 401);
    assert.equal((await login(`e-${Date.now()}@example.com`)).statusCode, 401);
    const loginLimited = await login(`f-${Date.now()}@example.com`);
    assert.equal(loginLimited.statusCode, 429);
    assert.match(loginLimited.body, /Too many attempts/);
  } finally {
    await closeServer(app);
  }
});

test("the configurable CAPTCHA contract guards registration", async () => {
  // A local stub stands in for the Turnstile siteverify endpoint.
  /** @type {((result: unknown) => void) | undefined} */
  let respond;
  const stub = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        typeof respond === "function" ? respond(undefined) : { success: false },
      ),
    );
  });
  await new Promise((resolve) => {
    stub.once("listening", () => resolve(undefined));
    stub.listen(0, "127.0.0.1");
  });
  const stubAddress = stub.address();
  assert.ok(stubAddress && typeof stubAddress !== "string");
  const stubUrl = `http://127.0.0.1:${stubAddress.port}/siteverify`;

  try {
    const { app } = await createHostedServer({
      TURNSTILE_SECRET_KEY: "stub-secret",
      TURNSTILE_SITE_KEY: "stub-site-key",
      TURNSTILE_VERIFY_URL: stubUrl,
    });
    try {
      const registerPage = await requestWithCookies(app, "/register?lang=en");
      assert.match(registerPage.body, /cf-turnstile/);
      assert.match(registerPage.body, /stub-site-key/);

      const csrfToken = formValue(registerPage.body, "_csrf");
      const csrfCookie = cookiePair(registerPage.setCookie, "hosted-csrf-v1");
      /** @param {string} captchaResponse */
      const register = (captchaResponse) =>
        requestWithCookies(app, "/register", {
          method: "POST",
          cookie: csrfCookie,
          body: new URLSearchParams({
            _csrf: csrfToken,
            email: `captcha-${Date.now()}-${Math.random()}@example.com`,
            password: STRONG_PASSWORD,
            ageConfirmation: "1",
            "cf-turnstile-response": captchaResponse,
          }).toString(),
        });

      // The stub defaults to failure.
      const rejected = await register("bad-token");
      assert.equal(rejected.statusCode, 403);
      assert.match(rejected.body, /human verification failed/i);

      respond = () => ({ success: true });
      const accepted = await register("good-token");
      assert.equal(accepted.statusCode, 200);
      assert.match(accepted.body, /verification link/);
    } finally {
      await closeServer(app);
    }
  } finally {
    stub.closeAllConnections?.();
    await new Promise((resolve) => stub.close(resolve));
  }
});

test("hosted session cookies gain the Secure flag in production mode", async () => {
  const { app, outboxDir } = await createHostedServer({
    IS_DEVELOPMENT: false,
  });
  try {
    const email = `secure-${Date.now()}@example.com`;
    const registerPage = await requestWithCookies(app, "/register?lang=en");
    const csrfCookie = cookiePair(registerPage.setCookie, "hosted-csrf-v1");
    assert.match(
      cookieAttributes(registerPage.setCookie, "hosted-csrf-v1"),
      /Secure/,
    );
    await requestWithCookies(app, "/register", {
      method: "POST",
      cookie: csrfCookie,
      body: new URLSearchParams({
        _csrf: formValue(registerPage.body, "_csrf"),
        email,
        password: STRONG_PASSWORD,
        ageConfirmation: "1",
      }).toString(),
    });
    const { verifyUrl } = await readVerificationEmail(outboxDir);
    await requestWithCookies(app, `${verifyUrl.pathname}${verifyUrl.search}`);
    const loginPage = await requestWithCookies(app, "/login?lang=en");
    const loggedIn = await requestWithCookies(app, "/login", {
      method: "POST",
      cookie: cookiePair(loginPage.setCookie, "hosted-csrf-v1"),
      body: new URLSearchParams({
        _csrf: formValue(loginPage.body, "_csrf"),
        email,
        password: STRONG_PASSWORD,
      }).toString(),
    });
    assert.equal(loggedIn.statusCode, 303);
    assert.match(
      cookieAttributes(loggedIn.setCookie, "hosted-session-v1"),
      /Secure/,
    );
    assert.match(
      cookieAttributes(loggedIn.setCookie, "hosted-session-v1"),
      /Max-Age=\d{6,}/,
    );
  } finally {
    await closeServer(app);
  }
});

test("account pages render zh-CN and fall back to en for other languages", async () => {
  const { app } = await createHostedServer();
  try {
    const chinese = await requestWithCookies(app, "/register?lang=zh-CN");
    assert.match(chinese.body, /<html lang="zh-CN" dir="ltr">/);
    assert.match(chinese.body, /创建你的账户/);

    const english = await requestWithCookies(app, "/register?lang=fr");
    assert.match(english.body, /<html lang="en" dir="ltr">/);
    assert.match(english.body, /Create your account/);

    const regional = await requestWithCookies(app, "/login?lang=zh-TW");
    assert.match(regional.body, /<html lang="en" dir="ltr">/);

    // A logged-out visitor to /logout is redirected home.
    const logoutGuest = await requestWithCookies(app, "/logout?lang=zh-CN");
    assert.equal(logoutGuest.statusCode, 303);
    assert.equal(logoutGuest.headers.location, "/");
  } finally {
    await closeServer(app);
  }
});

test("legacy WBO mode rejects account routes and raw hosted templates", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "wbo-hosted-accounts-legacy-"),
  );
  const app = await createServerApp(
    createConfig({
      HOST: "127.0.0.1",
      PORT: 0,
      HISTORY_DIR: root,
      WEBROOT: CLIENT_WEBROOT,
      HOSTED_MODE: false,
    }),
    {
      logStarted: false,
      socketsModule: { async start() {}, async shutdown() {} },
    },
  );
  try {
    for (const routePath of ["/register", "/login", "/verify", "/logout"]) {
      const response = await request(app, routePath);
      assert.equal(
        response.statusCode,
        404,
        `${routePath} must 404 in legacy mode`,
      );
    }
    for (const template of [
      "/register.html",
      "/login.html",
      "/verify.html",
      "/logout.html",
      "/hosted.html",
      "/partials/hosted-layout.html",
    ]) {
      const response = await request(app, template);
      assert.equal(
        response.statusCode,
        404,
        `${template} must not be served raw in legacy mode`,
      );
    }
  } finally {
    await closeServer(app);
  }
});

test("hosted mode never serves raw page templates over their routes", async () => {
  const { app } = await createHostedServer();
  try {
    for (const template of [
      "/register.html",
      "/login.html",
      "/verify.html",
      "/logout.html",
      "/hosted.html",
      "/partials/hosted-layout.html",
    ]) {
      const response = await requestWithCookies(app, template);
      assert.equal(
        response.statusCode,
        404,
        `${template} must not be served raw in hosted mode`,
      );
    }
    const stylesheet = await requestWithCookies(app, "/hosted.css");
    assert.equal(stylesheet.statusCode, 200);
  } finally {
    await closeServer(app);
  }
});

test("disabled accounts cannot log in and failures stay generic", async () => {
  const { createFileAccountStore } = await import(
    "../server/hosted_event/accounts/store.mjs"
  );
  const { hashPassword } = await import(
    "../server/hosted_event/accounts/passwords.mjs"
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-hosted-disabled-"));
  const dataDir = path.join(root, "hosted-data");
  const store = createFileAccountStore({ dataDir });
  const account = await store.createAccount({
    email: `disabled-${Date.now()}@example.com`,
    passwordHash: await hashPassword(STRONG_PASSWORD),
  });
  await store.markAccountVerified(account.accountId, Date.now());
  await store.setAccountStatus(account.accountId, "disabled");
  await store.flush();

  const { app } = await createHostedServer({
    HOSTED_DATA_DIR: dataDir,
  });
  try {
    const loginPage = await requestWithCookies(app, "/login?lang=en");
    const loginResponse = await requestWithCookies(app, "/login", {
      method: "POST",
      cookie: cookiePair(loginPage.setCookie, "hosted-csrf-v1"),
      body: new URLSearchParams({
        _csrf: formValue(loginPage.body, "_csrf"),
        email: account.email,
        password: STRONG_PASSWORD,
      }).toString(),
    });
    assert.equal(loginResponse.statusCode, 401);
    assert.match(loginResponse.body, /Incorrect email address or password/);
  } finally {
    await closeServer(app);
  }
});
