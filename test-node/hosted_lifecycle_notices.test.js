const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");

const { closeServer } = require("./test_helpers.js");
const {
  STRONG_PASSWORD,
  createHostedServer,
  requestWithCookies,
  signUpAndLogin,
  registerAccount,
  pollOutbox,
  readOutboxMessages,
} = require("./helpers/hosted_http.js");

const OPERATOR_EMAIL = "operator@example.com";
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const csrf = (/** @type {{csrfCookie: string}} */ jar) =>
  jar.csrfCookie.split("=")[1] || "";
const jarCookie = (
  /** @type {{sessionCookie: string, csrfCookie: string}} */ jar,
) => `${jar.sessionCookie}; ${jar.csrfCookie}`;
/** @param {number} ms */
const dtLocal = (ms) => new Date(ms).toISOString().slice(0, 16);
/** @param {number} ms */
const minute = (ms) => Math.floor(ms / MINUTE) * MINUTE;

/**
 * A composed hosted server driven by an injected clock and a UTC service
 * timezone, so event times are deterministic. The background poker stays off;
 * notice delivery kicks itself per enqueue and is coalesced through the
 * module's drain seam.
 *
 * @param {{now: number}} holder
 * @param {{[key: string]: any}} [overrides]
 */
async function createNoticeServer(holder, overrides = {}) {
  return createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
    HOSTED_CLOCK: () => holder.now,
    HOSTED_SERVICE_UTC_OFFSET_MINUTES: 0,
    HOSTED_LIFECYCLE_POLL_MS: 0,
    HOSTED_SESSION_IDLE_TIMEOUT_MS: 1000 * DAY,
    HOSTED_SESSION_MAX_AGE_MS: 1000 * DAY,
    ...overrides,
  });
}

/**
 * Provisions the operator and an organizer owner through the real HTTP
 * flows, returning both cookie jars, the organizer id, and the emails.
 *
 * @param {import("http").Server} app
 * @param {string} outboxDir
 */
async function provisionOrganizer(app, outboxDir) {
  const operatorEmail = OPERATOR_EMAIL;
  const ownerEmail = `owner-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}@example.com`;
  const operator = await signUpAndLogin(
    app,
    outboxDir,
    operatorEmail,
    STRONG_PASSWORD,
  );
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
  return { operator, owner, organizerId, operatorEmail, ownerEmail };
}

/**
 * Creates, submits, and approves an event starting `startOffsetMs` out.
 *
 * @param {import("http").Server} app
 * @param {{operator: any, owner: any, organizerId: string}} ctx
 * @param {number} now
 * @param {string} eventName
 * @param {number} startOffsetMs
 */
async function approveEvent(app, ctx, now, eventName, startOffsetMs) {
  const { operator, owner, organizerId } = ctx;
  const start = minute(now + startOffsetMs);
  const created = await requestWithCookies(
    app,
    `/organizers/${organizerId}/reservations`,
    {
      method: "POST",
      cookie: jarCookie(owner),
      body: new URLSearchParams({
        _csrf: csrf(owner),
        eventName,
        startsAt: dtLocal(start),
        endsAt: dtLocal(start + HOUR),
        requestedSeats: "30",
        visibility: "public",
        description: "Draw with us.",
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
  return { reservationId, publicId, eventId, start, end: start + HOUR };
}

/**
 * Mints the event access code, revealed exactly once on the console page.
 *
 * @param {import("http").Server} app
 * @param {{owner: any, organizerId: string}} ctx
 * @param {{eventId: string}} event
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
  assert.ok(code, "the raw access code must be revealed once");
  return code;
}

/**
 * Admits a signed-in participant to the event through its access code.
 *
 * @param {import("http").Server} app
 * @param {{sessionCookie: string, csrfCookie: string}} participant
 * @param {string} publicId
 * @param {string} code
 */
async function joinEvent(app, participant, publicId, code) {
  const joined = await requestWithCookies(app, `/events/${publicId}/enter`, {
    method: "POST",
    cookie: jarCookie(participant),
    body: new URLSearchParams({
      _csrf: csrf(participant),
      accessCode: code,
      anonymity: "identified",
    }).toString(),
  });
  assert.equal(joined.statusCode, 303);
}

/**
 * Waits until the outbox holds `count` mails to the recipient whose body
 * matches, and returns them.
 *
 * @param {string} outboxDir
 * @param {string} recipient
 * @param {string} bodyNeedle
 * @param {number} count
 */
async function waitForMails(outboxDir, recipient, bodyNeedle, count) {
  return pollOutbox(async () => {
    const matching = (await readOutboxMessages(outboxDir)).filter(
      (message) =>
        message.to === recipient && message.body.includes(bodyNeedle),
    );
    return matching.length >= count ? matching : null;
  });
}

test("lifecycle notices reach exactly the right recipients through the composed server", async () => {
  const holder = { now: minute(Date.now()) };
  const server = await createNoticeServer(holder, {
    HOSTED_BOARD_SESSION_CLOSE_DRAIN_MS: MINUTE,
  });
  const { app, outboxDir, hostedEventModule } = server;
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    // Two events: A will open, admit a participant, and archive; B stays
    // scheduled and gets cancelled.
    const eventA = await approveEvent(
      app,
      ctx,
      holder.now,
      "Launch Party",
      DAY,
    );
    const eventB = await approveEvent(
      app,
      ctx,
      holder.now,
      "Cancel Party",
      DAY + 3 * HOUR,
    );

    // The approval notices go to the organizer owner only — the approving
    // operator is not an organizer member and stays unreachable.
    const approvals = await waitForMails(
      outboxDir,
      ctx.ownerEmail,
      "has been approved",
      2,
    );
    assert.match(approvals[0]?.subject || "", /已通过/);
    assert.match(approvals[0]?.body || "", /你好/);
    assert.match(approvals[0]?.body || "", /Hello,/);
    assert.doesNotMatch(approvals[0]?.body || "", /https?:\/\//);
    const mailsToOperator = (await readOutboxMessages(outboxDir)).filter(
      (message) =>
        message.to === ctx.operatorEmail &&
        message.body.includes("has been approved"),
    );
    assert.equal(mailsToOperator.length, 0);

    // Cancelling the still-scheduled event B notifies the members; nobody
    // without a relation to B is told, not even an admitted participant of
    // the same organizer's other event.
    const cancelled = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/reservations/${eventB.reservationId}/cancel`,
      {
        method: "POST",
        cookie: jarCookie(ctx.owner),
        body: new URLSearchParams({ _csrf: csrf(ctx.owner) }).toString(),
      },
    );
    assert.equal(cancelled.statusCode, 303);
    const cancellation = await waitForMails(
      outboxDir,
      ctx.ownerEmail,
      "已取消",
      1,
    );
    assert.match(cancellation[0]?.body || "", /Cancel Party/);
    assert.match(cancellation[0]?.body || "", /has been cancelled/);

    // A participant joins event A once its session opens; a registered
    // outsider never establishes a membership.
    const code = await mintAccessCode(app, ctx, eventA);
    const participantEmail = `p-${Date.now()}@example.com`;
    const outsiderEmail = `outsider-${Date.now()}@example.com`;
    const participant = await signUpAndLogin(
      app,
      outboxDir,
      participantEmail,
      STRONG_PASSWORD,
    );
    const outsider = await signUpAndLogin(
      app,
      outboxDir,
      outsiderEmail,
      STRONG_PASSWORD,
    );
    holder.now = eventA.start + MINUTE;
    await joinEvent(app, participant, eventA.publicId, code);

    // When event A's session drains, the close pipeline seals it and the
    // archive notices reach the organizer and exactly its participants.
    holder.now = eventA.end + 3 * MINUTE;
    await hostedEventModule.refreshEventLifecycle();
    const organizerClosed = await waitForMails(
      outboxDir,
      ctx.ownerEmail,
      "have been archived",
      1,
    );
    assert.match(organizerClosed[0]?.body || "", /Launch Party/);
    const participantClosed = await waitForMails(
      outboxDir,
      participantEmail,
      "Thank you for taking part!",
      1,
    );
    assert.match(participantClosed[0]?.body || "", /Launch Party/);
    const outsiderNotices = (await readOutboxMessages(outboxDir)).filter(
      (message) =>
        message.to === outsiderEmail &&
        (message.body.includes("取消") ||
          message.body.includes("cancelled by its organizer") ||
          message.body.includes("Thank you for taking part!")),
    );
    assert.equal(outsiderNotices.length, 0);
    void outsider;

    // The console-facing trigger state is visible: the cancelled event page.
    const eventPage = await requestWithCookies(
      app,
      `/events/${eventB.publicId}?lang=en`,
    );
    assert.match(eventPage.body, /cancelled/i);
  } finally {
    await closeServer(app);
  }
});

test("a broken mail vendor keeps requests working and retries observable on the operator console", async () => {
  const holder = { now: minute(Date.now()) };
  const server = await createNoticeServer(holder);
  const { app, outboxDir, hostedEventModule } = server;
  try {
    // The operator signs up while the vendor still works.
    const operator = await signUpAndLogin(
      app,
      outboxDir,
      OPERATOR_EMAIL,
      STRONG_PASSWORD,
    );

    // The vendor goes down: the outbox directory becomes unwritable.
    await fs.chmod(outboxDir, 0o555);
    try {
      // Registration still succeeds end to end — the mail is queued, not
      // sent inline, so the vendor outage cannot fail the request.
      const victimEmail = `victim-${Date.now()}@example.com`;
      await registerAccount(app, victimEmail, STRONG_PASSWORD);

      // The failed delivery is recorded as an observable retry.
      await hostedEventModule.runDueNoticeSends();
      const consolePage = await requestWithCookies(app, "/operator?lang=en", {
        cookie: jarCookie(operator),
      });
      assert.equal(consolePage.statusCode, 200);
      assert.match(consolePage.body, /Mail delivery retries/);
      assert.match(consolePage.body, new RegExp(victimEmail));
      assert.match(consolePage.body, /Attempts/);
    } finally {
      await fs.chmod(outboxDir, 0o755);
    }
  } finally {
    await closeServer(app);
  }
});
