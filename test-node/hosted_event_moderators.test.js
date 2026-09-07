const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { closeServer } = require("./test_helpers.js");
const {
  STRONG_PASSWORD,
  createHostedServer,
  requestWithCookies,
  signUpAndLogin,
} = require("./helpers/hosted_http.js");
const {
  createFileAccountStore,
} = require("../server/hosted_event/accounts/store.mjs");

const OPERATOR_EMAIL = "operator@example.com";
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/** @param {{csrfCookie: string}} jar */
const csrf = (jar) => jar.csrfCookie.split("=")[1] || "";
/** @param {{sessionCookie: string, csrfCookie: string}} jar */
const jarCookie = (jar) => `${jar.sessionCookie}; ${jar.csrfCookie}`;
/**
 * With the service offset at 0, a UTC minute string round-trips to `ms`.
 *
 * @param {number} ms
 * @returns {string}
 */
const dtLocal = (ms) => new Date(ms).toISOString().slice(0, 16);
/** @param {number} ms */
const minute = (ms) => Math.floor(ms / MINUTE) * MINUTE;

/**
 * A composed hosted server driven by an injected, minute-aligned clock.
 *
 * @param {{now: number}} holder
 */
function createClockServer(holder) {
  return createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
    HOSTED_CLOCK: () => holder.now,
    HOSTED_SERVICE_UTC_OFFSET_MINUTES: 0,
    HOSTED_BOARD_SESSION_CLOSE_DRAIN_MS: MINUTE,
    HOSTED_LIFECYCLE_POLL_MS: 0,
    HOSTED_SESSION_IDLE_TIMEOUT_MS: 1000 * DAY,
    HOSTED_SESSION_MAX_AGE_MS: 1000 * DAY,
  });
}

/**
 * @param {import("http").Server} app
 * @param {string} outboxDir
 */
async function provisionOrganizer(app, outboxDir) {
  const operator = await signUpAndLogin(
    app,
    outboxDir,
    OPERATOR_EMAIL,
    STRONG_PASSWORD,
  );
  const ownerEmail = `owner-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}@example.com`;
  const owner = await signUpAndLogin(
    app,
    outboxDir,
    ownerEmail,
    STRONG_PASSWORD,
  );
  const applied = await requestWithCookies(app, "/organizer/apply?lang=en", {
    method: "POST",
    cookie: jarCookie(owner),
    body: new URLSearchParams({
      _csrf: csrf(owner),
      organizerName: "Aurora Collective",
      contactName: "Mika Rin",
      contactEmail: "contact@example.com",
      description: "Jams.",
    }).toString(),
  });
  assert.equal(applied.statusCode, 303);
  const queue = await requestWithCookies(app, "/operator?lang=en", {
    cookie: jarCookie(operator),
  });
  const applicationId = /operator\/applications\/([^"]+)"/.exec(
    queue.body,
  )?.[1];
  assert.ok(applicationId);
  await requestWithCookies(
    app,
    `/operator/applications/${applicationId}/approve`,
    {
      method: "POST",
      cookie: jarCookie(operator),
      body: new URLSearchParams({ _csrf: csrf(operator) }).toString(),
    },
  );
  const consolePage = await requestWithCookies(app, "/organizer?lang=en", {
    cookie: jarCookie(owner),
  });
  const organizerId = /organizers\/([^"/]+)"/.exec(consolePage.body)?.[1];
  assert.ok(organizerId);
  return { operator, owner, ownerEmail, organizerId };
}

/**
 * Drafts, submits, and approves one event starting one day out.
 *
 * @param {import("http").Server} app
 * @param {{operator: any, owner: any, organizerId: string}} ctx
 * @param {number} now
 */
async function approveEvent(app, ctx, now) {
  const { operator, owner, organizerId } = ctx;
  const start = minute(now + DAY);
  const created = await requestWithCookies(
    app,
    `/organizers/${organizerId}/reservations?lang=en`,
    {
      method: "POST",
      cookie: jarCookie(owner),
      body: new URLSearchParams({
        _csrf: csrf(owner),
        eventName: "Moderation Jam",
        startsAt: dtLocal(start),
        endsAt: dtLocal(start + HOUR),
        requestedSeats: "30",
        visibility: "public",
        description: "Come draw with us.",
      }).toString(),
    },
  );
  const reservationId = /reservations\/([^"/]+)$/.exec(
    created.headers.location || "",
  )?.[1];
  assert.ok(reservationId);
  await requestWithCookies(
    app,
    `/organizers/${organizerId}/reservations/${reservationId}/submit`,
    {
      method: "POST",
      cookie: jarCookie(owner),
      body: new URLSearchParams({ _csrf: csrf(owner) }).toString(),
    },
  );
  const approved = await requestWithCookies(
    app,
    `/operator/reservations/${reservationId}/approve`,
    {
      method: "POST",
      cookie: jarCookie(operator),
      body: new URLSearchParams({ _csrf: csrf(operator) }).toString(),
    },
  );
  assert.equal(approved.statusCode, 303);
  const detail = await requestWithCookies(
    app,
    `/organizers/${organizerId}/reservations/${reservationId}?lang=en`,
    { cookie: jarCookie(owner) },
  );
  const publicId = /\/events\/([A-Za-z0-9_-]+)/.exec(detail.body)?.[1];
  const eventId = /organizers\/[^"/]+\/events\/([^"/]+)"/.exec(
    detail.body,
  )?.[1];
  assert.ok(publicId && eventId);
  return { reservationId, publicId, eventId };
}

/**
 * @param {import("http").Server} app
 * @param {{owner: any, organizerId: string}} ctx
 * @param {{eventId: string}} event
 * @returns {Promise<string>}
 */
async function mintAccessCode(app, ctx, event) {
  const minted = await requestWithCookies(
    app,
    `/organizers/${ctx.organizerId}/events/${event.eventId}/access-code`,
    {
      method: "POST",
      cookie: jarCookie(ctx.owner),
      body: new URLSearchParams({ _csrf: csrf(ctx.owner) }).toString(),
    },
  );
  assert.equal(minted.statusCode, 200);
  const code = /access-code-value">([^<]+)</.exec(minted.body)?.[1];
  assert.ok(code);
  return code;
}

/**
 * Submits the access code form as a participant.
 *
 * @param {import("http").Server} app
 * @param {{sessionCookie: string, csrfCookie: string}} participant
 * @param {string} publicId
 * @param {{code?: string}} [fields]
 */
function submitCode(app, participant, publicId, fields = {}) {
  return requestWithCookies(app, `/events/${publicId}/enter`, {
    method: "POST",
    cookie: jarCookie(participant),
    body: new URLSearchParams({
      _csrf: csrf(participant),
      accessCode: fields.code ?? "",
      anonymity: "identified",
    }).toString(),
  });
}

/**
 * Assigns an event moderator by email from the console.
 *
 * @param {import("http").Server} app
 * @param {{organizerId: string}} ctx
 * @param {{eventId: string}} event
 * @param {any} jar
 * @param {string} email
 */
function grantModerator(app, ctx, event, jar, email) {
  return requestWithCookies(
    app,
    `/organizers/${ctx.organizerId}/events/${event.eventId}/moderators`,
    {
      method: "POST",
      cookie: jarCookie(jar),
      body: new URLSearchParams({ _csrf: csrf(jar), email }).toString(),
    },
  );
}

/**
 * Revokes one event moderator from the console.
 *
 * @param {import("http").Server} app
 * @param {{organizerId: string}} ctx
 * @param {{eventId: string}} event
 * @param {any} jar
 * @param {string} accountId
 */
function revokeModerator(app, ctx, event, jar, accountId) {
  return requestWithCookies(
    app,
    `/organizers/${ctx.organizerId}/events/${event.eventId}/moderators/${accountId}/revoke`,
    {
      method: "POST",
      cookie: jarCookie(jar),
      body: new URLSearchParams({ _csrf: csrf(jar) }).toString(),
    },
  );
}

test("Owner assigns and revokes Event Moderators; strangers and bad targets are refused", async () => {
  const holder = { now: Date.now() };
  const { app, outboxDir } = await createClockServer(holder);
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, holder.now);

    const moderatorEmail = `mod-${Date.now()}@example.com`;
    const moderatorJar = await signUpAndLogin(
      app,
      outboxDir,
      moderatorEmail,
      STRONG_PASSWORD,
    );
    const strangerJar = await signUpAndLogin(
      app,
      outboxDir,
      `stranger-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );

    // A signed-in non-member gets the same 404 as an unknown organizer: the
    // console exists but never reveals that.
    const strangerGrant = await grantModerator(
      app,
      ctx,
      event,
      strangerJar,
      moderatorEmail,
    );
    assert.equal(strangerGrant.statusCode, 404);

    // Granting to an email without a verified account fails deterministically.
    const unknownGrant = await grantModerator(
      app,
      ctx,
      event,
      ctx.owner,
      "nobody-here@example.com",
    );
    assert.equal(unknownGrant.statusCode, 400);
    assert.match(
      unknownGrant.body,
      /hosted_event_moderator_error_unknown|No verified account matches this email/,
    );

    // Granting to an organizer member is refused: they already hold
    // organizer-wide rights beyond any single event.
    const memberGrant = await grantModerator(
      app,
      ctx,
      event,
      ctx.owner,
      ctx.ownerEmail,
    );
    assert.equal(memberGrant.statusCode, 400);
    assert.match(
      memberGrant.body,
      /hosted_event_moderator_error_organizer_member|already holds organizer-wide access/,
    );

    const granted = await grantModerator(
      app,
      ctx,
      event,
      ctx.owner,
      moderatorEmail,
    );
    assert.equal(granted.statusCode, 200);
    assert.match(
      granted.body,
      /hosted_event_moderator_granted|event moderator has been assigned/,
    );
    assert.match(granted.body, new RegExp(moderatorEmail));

    // Granting the same moderator again reports the idempotent outcome.
    const again = await grantModerator(
      app,
      ctx,
      event,
      ctx.owner,
      moderatorEmail,
    );
    assert.equal(again.statusCode, 200);
    assert.match(
      again.body,
      /hosted_event_moderator_already|already a moderator of this event/,
    );

    // The assigned moderator has no organizer console access: the organizer
    // management page 404s for them.
    const moderatorConsole = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}?lang=en`,
      { cookie: jarCookie(moderatorJar) },
    );
    assert.equal(moderatorConsole.statusCode, 404);

    // Revoke: the management page lists the moderator for revocation.
    const managePage = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/events/${event.eventId}?lang=en`,
      { cookie: jarCookie(ctx.owner) },
    );
    const accountId = /moderators\/([^"/]+)\/revoke/.exec(managePage.body)?.[1];
    assert.ok(accountId);
    const revoked = await revokeModerator(
      app,
      ctx,
      event,
      ctx.owner,
      accountId,
    );
    assert.equal(revoked.statusCode, 303);
    const afterRevocation = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/events/${event.eventId}?lang=en`,
      { cookie: jarCookie(ctx.owner) },
    );
    assert.doesNotMatch(afterRevocation.body, /moderators\/[^"/]+\/revoke/);

    // Revoking an account that is not a moderator fails deterministically.
    const notModerator = await revokeModerator(
      app,
      ctx,
      event,
      ctx.owner,
      "not-an-account-id",
    );
    assert.equal(notModerator.statusCode, 400);
    assert.match(
      notModerator.body,
      /hosted_event_moderator_error_not_moderator|not a moderator of this event/,
    );
  } finally {
    await closeServer(app);
  }
});

test("an Event Ban overrides the Access Code with the uniform refusal", async () => {
  const holder = { now: Date.now() };
  const { app, outboxDir, root, hostedEventModule } =
    await createClockServer(holder);
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, holder.now);
    const code = await mintAccessCode(app, ctx, event);
    holder.now += DAY; // open the session

    const bannedEmail = `banned-${Date.now()}@example.com`;
    const banned = await signUpAndLogin(
      app,
      outboxDir,
      bannedEmail,
      STRONG_PASSWORD,
    );
    const control = await signUpAndLogin(
      app,
      outboxDir,
      `control-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    for (const jar of [banned, control]) {
      const admitted = await submitCode(app, jar, event.publicId, { code });
      assert.equal(admitted.statusCode, 303);
    }

    // Ban the banned account through the running server's own governance
    // API (ban actuation over sockets is covered by the socket integration
    // tests; this is the HTTP re-entry contract).
    const dataDir = path.join(root, "hosted-data");
    const accountStore = createFileAccountStore({ dataDir });
    const bannedAccount = accountStore.getAccountByEmail(bannedEmail);
    assert.ok(bannedAccount);
    const bannedViaApi = await hostedEventModule.applyModeration({
      eventId: event.eventId,
      action: "ban",
      reason: "test ban",
      operatorAccountId: "operator-account",
      targetAccountId: bannedAccount.accountId,
      targetParticipantId: null,
      targetName: "",
    });
    assert.deepEqual(bannedViaApi, { ok: true });

    // The banned account's correct code now fails exactly like a wrong
    // code: one uniform, non-enumerating response.
    const bannedRetry = await submitCode(app, banned, event.publicId, {
      code,
    });
    assert.equal(bannedRetry.statusCode, 403);
    assert.match(
      bannedRetry.body,
      /hosted_event_enter_error_invalid|Entry was not accepted/,
    );

    // The control account still enters with the same code.
    const controlRetry = await submitCode(app, control, event.publicId, {
      code,
    });
    assert.equal(controlRetry.statusCode, 303);

    // The refusals are indistinguishable: a wrong code for the banned
    // account produces the identical response shape.
    const wrongCode = await submitCode(app, control, event.publicId, {
      code: "wrong-code",
    });
    assert.equal(wrongCode.statusCode, bannedRetry.statusCode);
    const extract = (/** @type {string} */ body) =>
      /class="hosted-form-error[^"]*"[^>]*>([^<]+)</.exec(body)?.[1] || "";
    assert.equal(extract(bannedRetry.body), extract(wrongCode.body));
  } finally {
    await closeServer(app);
  }
});
