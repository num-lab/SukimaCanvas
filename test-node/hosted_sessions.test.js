const test = require("node:test");
const assert = require("node:assert/strict");

const { closeServer } = require("./test_helpers.js");
const {
  STRONG_PASSWORD,
  createHostedServer,
  requestWithCookies,
  formValue,
  cookiePair,
  verifyAccount,
  loginSession,
  pollOutbox,
  readOutboxMessages,
} = require("./helpers/hosted_http.js");

/**
 * Creates a hosted server driven by a controlled clock adapter so absolute
 * expiry, idle expiry, and reset-token expiry are exercised against
 * server-authoritative time without sleeps.
 *
 * @param {{[key: string]: any}} [overrides]
 * @returns {Promise<{app: import("http").Server, outboxDir: string, now: {ms: number}, advance: (ms: number) => void}>}
 */
async function createClockControlledServer(overrides = {}) {
  const clock = { ms: 1_700_000_000_000 };
  const { app, outboxDir } = await createHostedServer({
    HOSTED_CLOCK: () => clock.ms,
    ...overrides,
  });
  return {
    app,
    outboxDir,
    now: clock,
    advance(ms) {
      clock.ms += ms;
    },
  };
}

/**
 * @param {string} outboxDir
 * @param {string} recipient
 * @returns {Promise<{message: any, resetUrl: URL}>}
 */
async function readResetEmail(outboxDir, recipient) {
  const message = await pollOutbox(async () =>
    (await readOutboxMessages(outboxDir))
      .reverse()
      .find(
        (candidate) =>
          candidate.to === recipient &&
          candidate.body.includes("/reset?token="),
      ),
  );
  const match = /https?:\/\/\S+/.exec(message.body);
  assert.ok(match, "reset email must contain the reset link");
  return { message, resetUrl: new URL(match[0]) };
}

/**
 * Registers, verifies, and logs an account in, returning the session cookie
 * pair, csrf cookie pair, and email.
 *
 * @param {import("http").Server} app
 * @param {string} email
 * @param {string} [password]
 */
async function createSignedInSession(app, email, password = STRONG_PASSWORD) {
  const registerPage = await requestWithCookies(app, "/register?lang=en");
  const registerCsrf = cookiePair(registerPage.setCookie, "hosted-csrf-v1");
  await requestWithCookies(app, "/register", {
    method: "POST",
    cookie: registerCsrf,
    body: new URLSearchParams({
      _csrf: formValue(registerPage.body, "_csrf"),
      email,
      password,
      ageConfirmation: "1",
    }).toString(),
  });
  return { email, password, registerCsrf };
}

test("forgot-password responses never reveal whether an account exists", async () => {
  const { app, outboxDir } = await createClockControlledServer();
  try {
    const email = `forgot-${Date.now()}@example.com`;
    const known = await createSignedInSession(app, email);
    await verifyAccount(app, outboxDir, email);

    const forgotPage = await requestWithCookies(app, "/forgot?lang=en");
    assert.equal(forgotPage.statusCode, 200);
    assert.match(forgotPage.body, /Send reset link/);
    const csrfCookie = cookiePair(forgotPage.setCookie, "hosted-csrf-v1");
    const csrfToken = formValue(forgotPage.body, "_csrf");

    const knownResponse = await requestWithCookies(app, "/forgot", {
      method: "POST",
      cookie: csrfCookie,
      body: new URLSearchParams({
        _csrf: csrfToken,
        email,
      }).toString(),
    });
    assert.equal(knownResponse.statusCode, 200);
    assert.match(knownResponse.body, /reset link is on its way/);
    assert.equal(knownResponse.body.includes(email), false);

    const unknownResponse = await requestWithCookies(app, "/forgot", {
      method: "POST",
      cookie: csrfCookie,
      body: new URLSearchParams({
        _csrf: formValue(forgotPage.body, "_csrf"),
        email: `unknown-${Date.now()}@example.com`,
      }).toString(),
    });
    assert.equal(unknownResponse.statusCode, 200);
    // Identical status and body: nothing reveals which addresses exist.
    assert.equal(unknownResponse.body, knownResponse.body);

    // Only the known, verified account produced an email.
    const { resetUrl } = await readResetEmail(outboxDir, email);
    assert.equal(resetUrl.pathname, "/reset");
    void known;
  } finally {
    await closeServer(app);
  }
});

test("unverified and disabled accounts receive no reset email", async () => {
  const { app, outboxDir } = await createClockControlledServer();
  try {
    const unverifiedEmail = `unverified-${Date.now()}@example.com`;
    await createSignedInSession(app, unverifiedEmail);
    const disabledEmail = `disabled-${Date.now()}@example.com`;
    await createSignedInSession(app, disabledEmail);
    await verifyAccount(app, outboxDir, disabledEmail);

    const forgotPage = await requestWithCookies(app, "/forgot?lang=en");
    const csrfCookie = cookiePair(forgotPage.setCookie, "hosted-csrf-v1");
    const csrfToken = formValue(forgotPage.body, "_csrf");
    const response = await requestWithCookies(app, "/forgot", {
      method: "POST",
      cookie: csrfCookie,
      body: new URLSearchParams({
        _csrf: csrfToken,
        email: unverifiedEmail,
      }).toString(),
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /reset link is on its way/);
    await assert.rejects(() => readResetEmail(outboxDir, unverifiedEmail));
    await assert.rejects(() => readResetEmail(outboxDir, disabledEmail));
  } finally {
    await closeServer(app);
  }
});

test("password reset sets the new password and revokes every session", async () => {
  const { app, outboxDir, advance } = await createClockControlledServer();
  try {
    const email = `reset-flow-${Date.now()}@example.com`;
    await createSignedInSession(app, email);
    await verifyAccount(app, outboxDir, email);
    // Advance past the touch interval so this session is distinct in time.
    advance(5 * 60 * 1000);
    const oldSession = await loginSession(app, email, STRONG_PASSWORD);
    const home = await requestWithCookies(app, "/?lang=en", {
      cookie: oldSession.sessionCookie,
    });
    assert.match(home.body, /Log out/);

    // Request the reset and open the link.
    const forgotPage = await requestWithCookies(app, "/forgot?lang=en");
    await requestWithCookies(app, "/forgot", {
      method: "POST",
      cookie: cookiePair(forgotPage.setCookie, "hosted-csrf-v1"),
      body: new URLSearchParams({
        _csrf: formValue(forgotPage.body, "_csrf"),
        email,
      }).toString(),
    });
    const { resetUrl } = await readResetEmail(outboxDir, email);

    const resetForm = await requestWithCookies(
      app,
      `${resetUrl.pathname}${resetUrl.search}`,
    );
    assert.equal(resetForm.statusCode, 200);
    assert.match(resetForm.body, /Choose a new password/);
    const resetCsrf = cookiePair(resetForm.setCookie, "hosted-csrf-v1");
    const newPassword = "a brand new strong password";
    const reset = await requestWithCookies(app, "/reset", {
      method: "POST",
      cookie: resetCsrf,
      body: new URLSearchParams({
        _csrf: formValue(resetForm.body, "_csrf"),
        token: resetUrl.searchParams.get("token") || "",
        password: newPassword,
      }).toString(),
    });
    assert.equal(reset.statusCode, 303);
    assert.equal(reset.headers.location, "/login?reset=1");

    // The pre-reset session is revoked.
    const afterReset = await requestWithCookies(app, "/?lang=en", {
      cookie: oldSession.sessionCookie,
    });
    assert.doesNotMatch(afterReset.body, /Log out/);

    // The new password works and the notice is shown; the old one fails
    // with the generic message.
    const loginPage = await requestWithCookies(app, "/login?reset=1&lang=en");
    assert.match(loginPage.body, /password has been changed/);
    const newLogin = await loginSession(app, email, newPassword);
    const newHome = await requestWithCookies(app, "/?lang=en", {
      cookie: newLogin.sessionCookie,
    });
    assert.match(newHome.body, /Log out/);

    const oldPasswordPage = await requestWithCookies(app, "/login?lang=en");
    const oldPasswordAttempt = await requestWithCookies(app, "/login", {
      method: "POST",
      cookie: cookiePair(oldPasswordPage.setCookie, "hosted-csrf-v1"),
      body: new URLSearchParams({
        _csrf: formValue(oldPasswordPage.body, "_csrf"),
        email,
        password: STRONG_PASSWORD,
      }).toString(),
    });
    assert.equal(oldPasswordAttempt.statusCode, 401);
  } finally {
    await closeServer(app);
  }
});

test("reset tokens are single-use and expire by server-authoritative time", async () => {
  const { app, outboxDir, advance } = await createClockControlledServer();
  try {
    const email = `reset-token-${Date.now()}@example.com`;
    await createSignedInSession(app, email);
    await verifyAccount(app, outboxDir, email);

    const forgotPage = await requestWithCookies(app, "/forgot?lang=en");
    await requestWithCookies(app, "/forgot", {
      method: "POST",
      cookie: cookiePair(forgotPage.setCookie, "hosted-csrf-v1"),
      body: new URLSearchParams({
        _csrf: formValue(forgotPage.body, "_csrf"),
        email,
      }).toString(),
    });
    const { resetUrl } = await readResetEmail(outboxDir, email);

    // A second request replaces the first token.
    await requestWithCookies(app, "/forgot", {
      method: "POST",
      cookie: cookiePair(forgotPage.setCookie, "hosted-csrf-v1"),
      body: new URLSearchParams({
        _csrf: formValue(forgotPage.body, "_csrf"),
        email,
      }).toString(),
    });

    // The replaced token is dead.
    const stale = await requestWithCookies(
      app,
      `${resetUrl.pathname}${resetUrl.search}`,
    );
    assert.equal(stale.statusCode, 403);
    assert.match(stale.body, /invalid, was already used, or has expired/);

    // Request again and expire the token by advancing the controlled clock.
    await requestWithCookies(app, "/forgot", {
      method: "POST",
      cookie: cookiePair(forgotPage.setCookie, "hosted-csrf-v1"),
      body: new URLSearchParams({
        _csrf: formValue(forgotPage.body, "_csrf"),
        email,
      }).toString(),
    });
    const { resetUrl: freshUrl } = await readResetEmail(outboxDir, email);
    advance(60 * 60 * 1000 + 1);
    const expired = await requestWithCookies(
      app,
      `${freshUrl.pathname}${freshUrl.search}`,
    );
    assert.equal(expired.statusCode, 403);
    assert.equal(expired.body.includes("token="), false);
  } finally {
    await closeServer(app);
  }
});

test("sessions expire by absolute age and idle timeout on server time", async () => {
  const { app, outboxDir, advance } = await createClockControlledServer();
  try {
    const email = `expiry-${Date.now()}@example.com`;
    await createSignedInSession(app, email);
    await verifyAccount(app, outboxDir, email);

    // Idle expiry: twelve hours of inactivity kill the session.
    const idleSession = await loginSession(app, email, STRONG_PASSWORD);
    advance(12 * 60 * 60 * 1000 + 1000);
    const afterIdle = await requestWithCookies(app, "/account", {
      cookie: idleSession.sessionCookie,
    });
    assert.equal(afterIdle.statusCode, 303);
    assert.match(afterIdle.headers.location || "", /\/login/);

    // Absolute expiry: a session older than thirty days dies even when
    // continuously active, because expiry is server-authoritative. The
    // session is kept warm (idle limit never crossed) until the absolute
    // limit ends it.
    advance(60 * 1000);
    const absoluteSession = await loginSession(app, email, STRONG_PASSWORD);
    let aliveSteps = 0;
    const maxSteps = Math.ceil((30 * 24) / 11) + 5;
    while (aliveSteps < maxSteps) {
      advance(11 * 60 * 60 * 1000);
      const response = await requestWithCookies(app, "/account", {
        cookie: absoluteSession.sessionCookie,
      });
      if (response.statusCode !== 200) break;
      aliveSteps += 1;
    }
    assert.ok(aliveSteps >= 65, `died early at step ${aliveSteps}`);
    assert.ok(aliveSteps < maxSteps, "session outlived its absolute age");

    // Within both limits the session survives.
    advance(60 * 1000);
    const freshSession = await loginSession(app, email, STRONG_PASSWORD);
    advance(11 * 60 * 60 * 1000);
    const alive = await requestWithCookies(app, "/account", {
      cookie: freshSession.sessionCookie,
    });
    assert.equal(alive.statusCode, 200);
    assert.match(alive.body, /Active sessions/);
  } finally {
    await closeServer(app);
  }
});

test("the account page lists sessions and revokes them individually", async () => {
  const { app, outboxDir } = await createClockControlledServer();
  try {
    const email = `sessions-${Date.now()}@example.com`;
    await createSignedInSession(app, email);
    await verifyAccount(app, outboxDir, email);

    const primary = await loginSession(app, email, STRONG_PASSWORD);
    const secondary = await loginSession(app, email, STRONG_PASSWORD);

    const accountPage = await requestWithCookies(app, "/account?lang=en", {
      cookie: `${primary.sessionCookie}; ${primary.csrfCookie}`,
    });
    assert.equal(accountPage.statusCode, 200);
    assert.match(accountPage.body, /Active sessions/);
    assert.match(accountPage.body, /This device/);
    assert.match(accountPage.body, /Revoke all other sessions/);
    const publicIds = [
      ...accountPage.body.matchAll(/name="publicId" value="([0-9a-f]{10})"/g),
    ].map((match) => match[1]);
    assert.equal(publicIds.length, 2);

    // Revoke the secondary session from the primary device.
    const otherPublicId = publicIds.find(
      (_id) => !accountPage.body.includes(`This device`),
    );
    void otherPublicId;
    const csrfToken = formValue(accountPage.body, "_csrf");
    const targetPublicId =
      /** @type {string[]} */ (publicIds)[publicIds.length - 1] || "";
    const revoke = await requestWithCookies(app, "/account/sessions/revoke", {
      method: "POST",
      cookie: `${primary.sessionCookie}; ${primary.csrfCookie}`,
      body: new URLSearchParams({
        _csrf: csrfToken,
        publicId: targetPublicId,
      }).toString(),
    });
    assert.equal(revoke.statusCode, 303);

    // The revoked session no longer authenticates its browser; the primary
    // still does.
    const revokedAlive = await requestWithCookies(app, "/account", {
      cookie: secondary.sessionCookie,
    });
    assert.equal(revokedAlive.statusCode, 303);
    const primaryAlive = await requestWithCookies(app, "/account", {
      cookie: primary.sessionCookie,
    });
    assert.equal(primaryAlive.statusCode, 200);

    // Revoking an unknown public id is an idempotent no-op.
    const unknown = await requestWithCookies(app, "/account/sessions/revoke", {
      method: "POST",
      cookie: `${primary.sessionCookie}; ${primary.csrfCookie}`,
      body: new URLSearchParams({
        _csrf: csrfToken,
        publicId: "0000000000",
      }).toString(),
    });
    assert.equal(unknown.statusCode, 303);
  } finally {
    await closeServer(app);
  }
});

test("revoke-others keeps the current device signed in", async () => {
  const { app, outboxDir } = await createClockControlledServer();
  try {
    const email = `others-${Date.now()}@example.com`;
    await createSignedInSession(app, email);
    await verifyAccount(app, outboxDir, email);

    const primary = await loginSession(app, email, STRONG_PASSWORD);
    await loginSession(app, email, STRONG_PASSWORD);
    await loginSession(app, email, STRONG_PASSWORD);

    const accountPage = await requestWithCookies(app, "/account?lang=en", {
      cookie: `${primary.sessionCookie}; ${primary.csrfCookie}`,
    });
    const revokeOthers = await requestWithCookies(
      app,
      "/account/sessions/revoke-others",
      {
        method: "POST",
        cookie: `${primary.sessionCookie}; ${primary.csrfCookie}`,
        body: new URLSearchParams({
          _csrf: formValue(accountPage.body, "_csrf"),
        }).toString(),
      },
    );
    assert.equal(revokeOthers.statusCode, 303);

    const after = await requestWithCookies(app, "/account?lang=en", {
      cookie: primary.sessionCookie,
    });
    assert.equal(after.statusCode, 200);
    assert.equal(
      (after.body.match(/name="publicId"/g) || []).length,
      1,
      "only the current session remains",
    );
  } finally {
    await closeServer(app);
  }
});

test("authenticated password change revokes other sessions but keeps this one", async () => {
  const { app, outboxDir } = await createClockControlledServer();
  try {
    const email = `change-${Date.now()}@example.com`;
    await createSignedInSession(app, email);
    await verifyAccount(app, outboxDir, email);

    const primary = await loginSession(app, email, STRONG_PASSWORD);
    const secondary = await loginSession(app, email, STRONG_PASSWORD);

    const accountPage = await requestWithCookies(app, "/account?lang=en", {
      cookie: `${primary.sessionCookie}; ${primary.csrfCookie}`,
    });
    const newPassword = "yet another strong password";

    // The wrong current password fails without changing anything.
    const wrongCurrent = await requestWithCookies(app, "/account/password", {
      method: "POST",
      cookie: `${primary.sessionCookie}; ${primary.csrfCookie}`,
      body: new URLSearchParams({
        _csrf: formValue(accountPage.body, "_csrf"),
        currentPassword: "not the current password",
        password: newPassword,
      }).toString(),
    });
    assert.equal(wrongCurrent.statusCode, 401);
    assert.match(wrongCurrent.body, /Current password is incorrect/);

    const changed = await requestWithCookies(app, "/account/password", {
      method: "POST",
      cookie: `${primary.sessionCookie}; ${primary.csrfCookie}`,
      body: new URLSearchParams({
        _csrf: formValue(accountPage.body, "_csrf"),
        currentPassword: STRONG_PASSWORD,
        password: newPassword,
      }).toString(),
    });
    assert.equal(changed.statusCode, 200);
    assert.match(changed.body, /password has been updated/);

    // The secondary session is revoked; the primary keeps working.
    const secondaryGone = await requestWithCookies(app, "/account", {
      cookie: secondary.sessionCookie,
    });
    assert.equal(secondaryGone.statusCode, 303);
    const primaryAlive = await requestWithCookies(app, "/account", {
      cookie: primary.sessionCookie,
    });
    assert.equal(primaryAlive.statusCode, 200);

    // Re-login requires the new password.
    const newLogin = await loginSession(app, email, newPassword);
    assert.ok(newLogin.sessionCookie);
  } finally {
    await closeServer(app);
  }
});

test("CSRF tokens are rotated at login and rejected after rotation", async () => {
  const { app, outboxDir } = await createClockControlledServer();
  try {
    const email = `rotation-${Date.now()}@example.com`;
    await createSignedInSession(app, email);
    await verifyAccount(app, outboxDir, email);

    const loginPage = await requestWithCookies(app, "/login?lang=en");
    const preLoginCsrf = cookiePair(loginPage.setCookie, "hosted-csrf-v1");
    const preLoginToken = formValue(loginPage.body, "_csrf");
    const loggedIn = await requestWithCookies(app, "/login", {
      method: "POST",
      cookie: preLoginCsrf,
      body: new URLSearchParams({
        _csrf: preLoginToken,
        email,
        password: STRONG_PASSWORD,
      }).toString(),
    });
    assert.equal(loggedIn.statusCode, 303);
    // A successful login rotates the CSRF token.
    const rotatedCookie = cookiePair(loggedIn.setCookie, "hosted-csrf-v1");
    assert.notEqual(rotatedCookie, preLoginCsrf);

    // Reusing the pre-rotation form token against the rotated cookie is
    // deterministically rejected.
    const sessionCookie = cookiePair(loggedIn.setCookie, "hosted-session-v1");
    const reused = await requestWithCookies(
      app,
      "/account/sessions/revoke-others",
      {
        method: "POST",
        cookie: `${sessionCookie}; ${rotatedCookie}`,
        body: new URLSearchParams({ _csrf: preLoginToken }).toString(),
      },
    );
    assert.equal(reused.statusCode, 403);

    // Cross-jar and malformed tokens are rejected too.
    const otherJarPage = await requestWithCookies(app, "/login?lang=en");
    const crossToken = formValue(otherJarPage.body, "_csrf");
    const cross = await requestWithCookies(
      app,
      "/account/sessions/revoke-others",
      {
        method: "POST",
        cookie: `${sessionCookie}; ${rotatedCookie}`,
        body: new URLSearchParams({ _csrf: crossToken }).toString(),
      },
    );
    assert.equal(cross.statusCode, 403);

    const malformed = await requestWithCookies(
      app,
      "/account/sessions/revoke-others",
      {
        method: "POST",
        cookie: `${sessionCookie}; ${rotatedCookie}`,
        body: new URLSearchParams({ _csrf: "short" }).toString(),
      },
    );
    assert.equal(malformed.statusCode, 403);
  } finally {
    await closeServer(app);
  }
});

test("forgot-password submissions are rate limited", async () => {
  const { app } = await createClockControlledServer({
    HOSTED_FORGOT_ATTEMPTS_LIMIT: 2,
    HOSTED_FORGOT_ATTEMPTS_WINDOW_MS: 60_000,
  });
  try {
    const forgotPage = await requestWithCookies(app, "/forgot?lang=en");
    const csrfCookie = cookiePair(forgotPage.setCookie, "hosted-csrf-v1");
    const csrfToken = formValue(forgotPage.body, "_csrf");
    /** @param {string} email */
    const requestReset = (email) =>
      requestWithCookies(app, "/forgot", {
        method: "POST",
        cookie: csrfCookie,
        body: new URLSearchParams({ _csrf: csrfToken, email }).toString(),
      });

    assert.equal(
      (await requestReset(`a-${Date.now()}@example.com`)).statusCode,
      200,
    );
    assert.equal(
      (await requestReset(`b-${Date.now()}@example.com`)).statusCode,
      200,
    );
    const limited = await requestReset(`c-${Date.now()}@example.com`);
    assert.equal(limited.statusCode, 429);
    assert.match(limited.body, /Too many attempts/);
  } finally {
    await closeServer(app);
  }
});
