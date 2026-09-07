const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  createHostedServer,
  requestWithCookies,
  formValue,
  cookiePair,
  verifyAccount,
  registerAccount,
  loginSession,
  STRONG_PASSWORD,
} = require("./helpers/hosted_http.js");
const {
  createFileAccountStore,
} = require("../server/hosted_event/accounts/store.mjs");
const {
  createFileOrganizerStore,
} = require("../server/hosted_event/organizers/store.mjs");
const {
  createFileModerationStore,
} = require("../server/hosted_event/moderation/store.mjs");
const { closeServer } = require("./test_helpers.js");

const DAY = 24 * 60 * 60 * 1000;

test("account deregistration pseudonymizes irreversibly while security audit stays accountable", async () => {
  const holder = { now: Date.now() };
  const server = await createHostedServer({
    HOSTED_CLOCK: () => holder.now,
    HOSTED_SESSION_MAX_AGE_MS: 400 * DAY,
    HOSTED_SESSION_IDLE_TIMEOUT_MS: 400 * DAY,
  });
  try {
    const email = "departing@example.com";
    await registerAccount(server.app, email, STRONG_PASSWORD);
    await verifyAccount(server.app, server.outboxDir, email);
    const session = await loginSession(server.app, email, STRONG_PASSWORD);
    const dataDir = path.join(server.root, "hosted-data");
    const accountStore = createFileAccountStore({
      dataDir,
      clock: () => holder.now,
    });
    const account = accountStore.getAccountByEmail(email);
    assert.ok(account);
    const accountId = account.accountId;

    // Seed durable security audit that names the account internally: the
    // organizer trail and the event moderation log.
    const organizerStore = createFileOrganizerStore({
      dataDir,
      clock: () => holder.now,
    });
    const application = await organizerStore.submitApplication({
      accountId,
      organizerName: "Departing Collective",
      contactName: "Mika Rin",
      contactEmail: email,
    });
    assert.ok(application.ok);
    const approved = await organizerStore.approveApplication({
      applicationId: application.application.applicationId,
      operatorAccountId: "seed-operator",
    });
    assert.ok(approved.ok);
    const moderationStore = createFileModerationStore({
      dataDir,
      clock: () => holder.now,
    });
    await moderationStore.record({
      eventId: "seed-event",
      action: "warn",
      operatorAccountId: accountId,
      targetAccountId: "target-account",
      targetParticipantId: "ptarget",
      targetName: "target name",
      reason: "seed reason",
    });
    await moderationStore.flush();

    // The account page offers the deletion and requires the password again.
    const accountPage = await requestWithCookies(
      server.app,
      "/account?lang=en",
      {
        cookie: session.sessionCookie,
      },
    );
    assert.equal(accountPage.statusCode, 200);
    assert.ok(accountPage.body.includes("Delete account"));
    const csrfToken = formValue(accountPage.body, "_csrf");
    const cookies = `${session.sessionCookie}; ${cookiePair(
      accountPage.setCookie,
      "hosted-csrf-v1",
    )}`;

    const wrongPassword = await requestWithCookies(
      server.app,
      "/account/delete",
      {
        method: "POST",
        cookie: cookies,
        body: new URLSearchParams({
          _csrf: csrfToken,
          currentPassword: "not the password",
        }).toString(),
      },
    );
    assert.equal(
      wrongPassword.statusCode,
      401,
      "deletion re-proves the current password",
    );

    // The deletion itself: cookie cleared, CSRF rotated, login page explains.
    const deleted = await requestWithCookies(server.app, "/account/delete", {
      method: "POST",
      cookie: cookies,
      body: new URLSearchParams({
        _csrf: csrfToken,
        currentPassword: STRONG_PASSWORD,
      }).toString(),
    });
    assert.equal(deleted.statusCode, 303);
    const loginAfter = await requestWithCookies(
      server.app,
      "/login?deleted=1&lang=en",
    );
    assert.equal(loginAfter.statusCode, 200);
    assert.ok(
      loginAfter.body.includes("Your account has been deleted"),
      "the login page confirms the deletion",
    );

    // The old session no longer resolves: the account page redirects to login.
    const afterDeletion = await requestWithCookies(
      server.app,
      "/account?lang=en",
      { cookie: session.sessionCookie },
    );
    assert.equal(afterDeletion.statusCode, 303);

    // Login with the old address is the same generic failure as an unknown
    // account, and the store no longer maps the email anywhere. The login
    // form carries its own fresh CSRF pair, exactly like a real browser.
    const loginForm = await requestWithCookies(server.app, "/login?lang=en");
    const loginCookies = cookiePair(loginForm.setCookie, "hosted-csrf-v1");
    const loginAttempt = await requestWithCookies(server.app, "/login", {
      method: "POST",
      cookie: loginCookies,
      body: new URLSearchParams({
        _csrf: formValue(loginForm.body, "_csrf"),
        email,
        password: STRONG_PASSWORD,
      }).toString(),
    });
    assert.equal(loginAttempt.statusCode, 401);
    assert.ok(
      /hosted_login_invalid|Incorrect email address or password/.test(
        loginAttempt.body,
      ),
      `the failure is the generic credentials message: ${loginAttempt.body.slice(0, 400)}`,
    );

    // The deletion mutated and persisted the server's own store instance;
    // verify the durable record through a freshly loaded one.
    const durableAccounts = createFileAccountStore({
      dataDir,
      clock: () => holder.now,
    });
    const deletedRecord = durableAccounts.getAccountById(accountId);
    assert.ok(deletedRecord);
    assert.equal(deletedRecord.status, "deleted");
    assert.equal(deletedRecord.passwordHash, "");
    assert.ok(deletedRecord.email.startsWith("deleted-"));
    assert.ok(!deletedRecord.email.includes("example.com"));
    assert.equal(durableAccounts.getAccountByEmail(email), null);

    // Deregistration is terminal: a second deletion is refused.
    const secondDeletion = await durableAccounts.deleteAccount(accountId);
    assert.equal(secondDeletion.ok, false);
    assert.equal(secondDeletion.reason, "already_deleted");

    // Security audit keeps its accountability boundary: the internal account
    // id survives in the organizer Change Audit and the moderation log, while
    // no remaining field maps it back to the identity.
    const applicationAudit = organizerStore.listAuditForApplication(
      application.application.applicationId,
    );
    assert.ok(
      applicationAudit.some(
        (record) =>
          record.actorAccountId === accountId &&
          record.action === "organizer_application.submitted",
      ),
      "the organizer Change Audit retains the internal actor",
    );
    const moderationRecords = await moderationStore.listForEvent("seed-event", {
      limit: 10,
    });
    assert.ok(
      moderationRecords.some(
        (record) => record.operatorAccountId === accountId,
      ),
      "the moderation log retains the internal operator",
    );
  } finally {
    await closeServer(server.app);
  }
});

test("the pseudonymized account record survives a restart and never signs in again", async () => {
  const holder = { now: Date.now() };
  const server = await createHostedServer({
    HOSTED_CLOCK: () => holder.now,
    HOSTED_SESSION_MAX_AGE_MS: 400 * DAY,
    HOSTED_SESSION_IDLE_TIMEOUT_MS: 400 * DAY,
  });
  try {
    const email = "restarting@example.com";
    await registerAccount(server.app, email, STRONG_PASSWORD);
    await verifyAccount(server.app, server.outboxDir, email);
    const session = await loginSession(server.app, email, STRONG_PASSWORD);
    const dataDir = path.join(server.root, "hosted-data");
    const accountStore = createFileAccountStore({
      dataDir,
      clock: () => holder.now,
    });
    const account = accountStore.getAccountByEmail(email);
    assert.ok(account);
    const deleted = await accountStore.deleteAccount(account.accountId);
    assert.equal(deleted.ok, true);
    await accountStore.flush();

    // A freshly loaded store sees the same terminal record — a restart does
    // not resurrect the identity.
    const reloaded = createFileAccountStore({
      dataDir,
      clock: () => holder.now,
    });
    const reloadedRecord = reloaded.getAccountById(account.accountId);
    assert.ok(reloadedRecord);
    assert.equal(reloadedRecord.status, "deleted");
    assert.equal(reloadedRecord.email.startsWith("deleted-"), true);
    assert.equal(reloaded.getAccountByEmail(email), null);

    // The revoked session no longer resolves: the raw session id from the
    // cookie is dead in the reloaded store, so a restart cannot resurrect it.
    const rawSessionId = session.sessionCookie.split("=")[1] || "";
    assert.equal(await reloaded.resolveSession(rawSessionId), null);
  } finally {
    await closeServer(server.app);
  }
});

test("the store refuses to delete unknown accounts", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-del-"));
  const store = createFileAccountStore({ dataDir });
  const missing = await store.deleteAccount("no-such-account");
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "not_found");
});
