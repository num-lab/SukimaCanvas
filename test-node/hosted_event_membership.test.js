const test = require("node:test");
const assert = require("node:assert/strict");

const { closeServer } = require("./test_helpers.js");
const {
  STRONG_PASSWORD,
  createHostedServer,
  requestWithCookies,
  signUpAndLogin,
} = require("./helpers/hosted_http.js");

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
 * A composed hosted server driven by an injected, minute-aligned clock and a
 * UTC service timezone, so events can be opened deterministically by jumping
 * the clock across their scheduled start.
 *
 * @param {{now: number}} holder
 * @param {{[key: string]: any}} [overrides]
 */
function createClockServer(holder, overrides = {}) {
  return createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
    HOSTED_CLOCK: () => holder.now,
    HOSTED_SERVICE_UTC_OFFSET_MINUTES: 0,
    HOSTED_BOARD_SESSION_CLOSE_DRAIN_MS: MINUTE,
    HOSTED_LIFECYCLE_POLL_MS: 0,
    // Keep sessions valid across the large clock jumps these tests drive.
    HOSTED_SESSION_IDLE_TIMEOUT_MS: 1000 * DAY,
    HOSTED_SESSION_MAX_AGE_MS: 1000 * DAY,
    ...overrides,
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
  const owner = await signUpAndLogin(
    app,
    outboxDir,
    `owner-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
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
  return { operator, owner, organizerId };
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
        eventName: "Membership Jam",
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
  assert.ok(code, "the raw access code must be revealed once");
  // The management page must not keep rendering the code afterwards.
  const again = await requestWithCookies(
    app,
    `/organizers/${ctx.organizerId}/events/${event.eventId}?lang=en`,
    { cookie: jarCookie(ctx.owner) },
  );
  assert.ok(
    !again.body.includes(code),
    "the code must not persist on the page",
  );
  return code;
}

/**
 * Submits the access code form as a participant.
 *
 * @param {import("http").Server} app
 * @param {{sessionCookie: string, csrfCookie: string}} participant
 * @param {string} publicId
 * @param {{code?: string, anonymity?: string}} [fields]
 */
function submitCode(app, participant, publicId, fields = {}) {
  return requestWithCookies(app, `/events/${publicId}/enter`, {
    method: "POST",
    cookie: jarCookie(participant),
    body: new URLSearchParams({
      _csrf: csrf(participant),
      accessCode: fields.code ?? "",
      anonymity: fields.anonymity ?? "identified",
    }).toString(),
  });
}

test("access code admission creates a durable membership that survives refresh", async () => {
  const holder = { now: Date.now() };
  const { app, outboxDir } = await createClockServer(holder);
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, holder.now);
    const code = await mintAccessCode(app, ctx, event);
    holder.now += DAY; // open the session

    const participant = await signUpAndLogin(
      app,
      outboxDir,
      `p-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    // Before admission the page shows the entry form and no membership.
    const before = await requestWithCookies(
      app,
      `/events/${event.publicId}?lang=en`,
      { cookie: jarCookie(participant) },
    );
    assert.match(before.body, /hosted-event-access-code/);
    assert.doesNotMatch(before.body, /hosted-event-membership/);

    const joined = await submitCode(app, participant, event.publicId, { code });
    assert.equal(joined.statusCode, 303);

    // The membership renders after admission and survives refreshes.
    const page = await requestWithCookies(
      app,
      `/events/${event.publicId}?lang=en`,
      { cookie: jarCookie(participant) },
    );
    assert.match(page.body, /hosted-event-membership/);
    assert.doesNotMatch(page.body, /hosted-event-access-code/);

    // A wrong code after membership is still rejected: the enter form never
    // becomes an oracle, and the member keeps their membership.
    const wrong = await submitCode(app, participant, event.publicId, {
      code: "NOPE-NOPE-NOPE-NOPE",
    });
    assert.equal(wrong.statusCode, 403);
    const stillMember = await requestWithCookies(
      app,
      `/events/${event.publicId}?lang=en`,
      { cookie: jarCookie(participant) },
    );
    assert.match(stillMember.body, /hosted-event-membership/);

    // A different signed-in account without a code still sees the entry form,
    // not someone else's membership.
    const other = await signUpAndLogin(
      app,
      outboxDir,
      `other-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    const strangerPage = await requestWithCookies(
      app,
      `/events/${event.publicId}?lang=en`,
      { cookie: jarCookie(other) },
    );
    assert.doesNotMatch(strangerPage.body, /hosted-event-membership/);
    assert.match(strangerPage.body, /hosted-event-access-code/);
  } finally {
    await closeServer(app);
  }
});

test("a wrong code, unknown event, and locked event get non-enumerating responses with limits", async () => {
  const holder = { now: Date.now() };
  const { app, outboxDir } = await createClockServer(holder, {
    HOSTED_ACCESS_CODE_ATTEMPTS_LIMIT: 3,
    HOSTED_ACCESS_CODE_ATTEMPTS_WINDOW_MS: 15 * MINUTE,
  });
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, holder.now);
    const code = await mintAccessCode(app, ctx, event);
    holder.now += DAY;

    const participant = await signUpAndLogin(
      app,
      outboxDir,
      `p-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );

    // A wrong code and a locked event are indistinguishable: same uniform
    // message, same status.
    const wrong = await submitCode(app, participant, event.publicId, {
      code: "WRONG-CODE-0000",
    });
    assert.equal(wrong.statusCode, 403);
    assert.match(
      wrong.body,
      /hosted_event_enter_error_invalid|Entry was not accepted/,
    );

    // An unknown Public ID on the POST path is a plain 404.
    const unknown = await submitCode(app, participant, "deadbeefdeadbeef", {
      code,
    });
    assert.equal(unknown.statusCode, 404);

    // Rate limiting kicks in per account after the limit is exhausted.
    let lastStatus = 0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await submitCode(app, participant, event.publicId, {
        code: "WRONG-CODE-0000",
      });
      lastStatus = response.statusCode;
    }
    assert.equal(lastStatus, 429);

    // A correct code submitted after exhausting the budget is also refused:
    // the limit does not leak whether the code would have been right.
    const throttled = await submitCode(app, participant, event.publicId, {
      code,
    });
    assert.equal(throttled.statusCode, 429);
  } finally {
    await closeServer(app);
  }
});

test("the per-IP attempt budget throttles every account from the same address", async () => {
  const holder = { now: Date.now() };
  const { app, outboxDir } = await createClockServer(holder, {
    HOSTED_ACCESS_CODE_ATTEMPTS_LIMIT: 2,
    HOSTED_ACCESS_CODE_ATTEMPTS_WINDOW_MS: 15 * MINUTE,
  });
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, holder.now);
    const code = await mintAccessCode(app, ctx, event);
    holder.now += DAY;

    // Every request in this test comes from 127.0.0.1. The first two wrong
    // attempts exhaust the IP bucket; afterwards even fresh accounts with the
    // correct code are refused, because the address itself is throttled.
    const first = await signUpAndLogin(
      app,
      outboxDir,
      `ip-a-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    assert.equal(
      (await submitCode(app, first, event.publicId, { code: "WRONG" }))
        .statusCode,
      403,
    );
    assert.equal(
      (await submitCode(app, first, event.publicId, { code: "WRONG" }))
        .statusCode,
      403,
    );

    const second = await signUpAndLogin(
      app,
      outboxDir,
      `ip-b-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    assert.equal(
      (await submitCode(app, second, event.publicId, { code })).statusCode,
      429,
    );
  } finally {
    await closeServer(app);
  }
});

test("rotating the access code blocks future entry but keeps existing memberships", async () => {
  const holder = { now: Date.now() };
  const { app, outboxDir } = await createClockServer(holder);
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, holder.now);
    const firstCode = await mintAccessCode(app, ctx, event);
    holder.now += DAY;

    const early = await signUpAndLogin(
      app,
      outboxDir,
      `early-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    assert.equal(
      (await submitCode(app, early, event.publicId, { code: firstCode }))
        .statusCode,
      303,
    );

    const rotatedCode = await mintAccessCode(app, ctx, event);
    assert.notEqual(rotatedCode, firstCode);

    // The old code no longer admits new participants...
    const late = await signUpAndLogin(
      app,
      outboxDir,
      `late-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    const rejected = await submitCode(app, late, event.publicId, {
      code: firstCode,
    });
    assert.equal(rejected.statusCode, 403);

    // ...but the early member keeps their membership.
    const earlyPage = await requestWithCookies(
      app,
      `/events/${event.publicId}?lang=en`,
      { cookie: jarCookie(early) },
    );
    assert.match(earlyPage.body, /hosted-event-membership/);

    // And the new code admits.
    assert.equal(
      (await submitCode(app, late, event.publicId, { code: rotatedCode }))
        .statusCode,
      303,
    );
  } finally {
    await closeServer(app);
  }
});

test("the event lock blocks new admission while existing memberships remain", async () => {
  const holder = { now: Date.now() };
  const { app, outboxDir } = await createClockServer(holder);
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, holder.now);
    const code = await mintAccessCode(app, ctx, event);
    holder.now += DAY;

    const member = await signUpAndLogin(
      app,
      outboxDir,
      `member-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    assert.equal(
      (await submitCode(app, member, event.publicId, { code })).statusCode,
      303,
    );

    // The owner enables the entry lock.
    const locked = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/events/${event.eventId}/entry-lock`,
      {
        method: "POST",
        cookie: jarCookie(ctx.owner),
        body: new URLSearchParams({
          _csrf: csrf(ctx.owner),
          locked: "1",
        }).toString(),
      },
    );
    assert.equal(locked.statusCode, 303);

    // New participants are refused even with the correct code.
    const blocked = await signUpAndLogin(
      app,
      outboxDir,
      `blocked-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    const rejected = await submitCode(app, blocked, event.publicId, { code });
    assert.equal(rejected.statusCode, 403);

    // The member keeps their membership and the anonymity switch.
    const memberPage = await requestWithCookies(
      app,
      `/events/${event.publicId}?lang=en`,
      { cookie: jarCookie(member) },
    );
    assert.match(memberPage.body, /hosted-event-membership/);
    assert.match(memberPage.body, /hosted-event-anonymity/);

    // Unlocking reopens admission for the previously blocked participant.
    const unlocked = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/events/${event.eventId}/entry-lock`,
      {
        method: "POST",
        cookie: jarCookie(ctx.owner),
        body: new URLSearchParams({
          _csrf: csrf(ctx.owner),
          locked: "0",
        }).toString(),
      },
    );
    assert.equal(unlocked.statusCode, 303);
    assert.equal(
      (await submitCode(app, blocked, event.publicId, { code })).statusCode,
      303,
    );
  } finally {
    await closeServer(app);
  }
});

test("the anonymity choice is changeable until the session closes, then frozen", async () => {
  const holder = { now: Date.now() };
  const { app, outboxDir } = await createClockServer(holder);
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, holder.now);
    const code = await mintAccessCode(app, ctx, event);
    holder.now += DAY;

    const participant = await signUpAndLogin(
      app,
      outboxDir,
      `anon-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    assert.equal(
      (await submitCode(app, participant, event.publicId, { code })).statusCode,
      303,
    );

    // The member flips to anonymous while the session is open.
    const anonymous = await requestWithCookies(
      app,
      `/events/${event.publicId}/anonymity`,
      {
        method: "POST",
        cookie: jarCookie(participant),
        body: new URLSearchParams({ _csrf: csrf(participant) }).toString(),
      },
    );
    assert.equal(anonymous.statusCode, 303);
    const page = await requestWithCookies(
      app,
      `/events/${event.publicId}?lang=en`,
      { cookie: jarCookie(participant) },
    );
    assert.match(page.body, /You are participating anonymously/);

    // Close the session: open -> closing -> closed (the event runs one hour).
    const end = holder.now + HOUR;
    holder.now = end + 2 * MINUTE;
    await requestWithCookies(app, "/?lang=en");

    const frozenPage = await requestWithCookies(
      app,
      `/events/${event.publicId}?lang=en`,
      { cookie: jarCookie(participant) },
    );
    assert.match(frozenPage.body, /anonymity choice can no longer change/);

    // A further anonymity change is refused with 409 and the note.
    const late = await requestWithCookies(
      app,
      `/events/${event.publicId}/anonymity`,
      {
        method: "POST",
        cookie: jarCookie(participant),
        body: new URLSearchParams({ _csrf: csrf(participant) }).toString(),
      },
    );
    assert.equal(late.statusCode, 409);
    assert.match(late.body, /anonymity choice can no longer change/);
  } finally {
    await closeServer(app);
  }
});

test("hosted mode rejects every legacy WBO entry without redirects", async () => {
  const { app, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
  });
  try {
    const participant = await signUpAndLogin(
      app,
      outboxDir,
      `legacy-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    for (const path of [
      "/boards/whatever",
      "/boards/whatever.svg",
      "/boards/?name=whatever",
      "/boards?name=whatever",
      "/download/whatever",
      "/preview/whatever",
      "/export/whatever",
      "/random",
    ]) {
      const response = await requestWithCookies(app, path, {
        cookie: jarCookie(participant),
      });
      assert.ok(
        response.statusCode === 404 || response.statusCode === 400,
        `${path} must be rejected, got ${response.statusCode}`,
      );
      assert.equal(
        response.headers.location,
        undefined,
        `${path} must not redirect`,
      );
    }
  } finally {
    await closeServer(app);
  }
});

test("public URLs never expose internal board session ids and guesses gain nothing", async () => {
  const holder = { now: Date.now() };
  const { app, outboxDir } = await createClockServer(holder);
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, holder.now);
    const code = await mintAccessCode(app, ctx, event);
    holder.now += DAY;

    const participant = await signUpAndLogin(
      app,
      outboxDir,
      `url-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    assert.equal(
      (await submitCode(app, participant, event.publicId, { code })).statusCode,
      303,
    );

    // The redirect target is the public event URL only.
    const rejoin = await submitCode(app, participant, event.publicId, { code });
    assert.match(rejoin.headers.location || "", /\/events\/[A-Za-z0-9_-]+$/);

    const page = await requestWithCookies(
      app,
      `/events/${event.publicId}?lang=en`,
      { cookie: jarCookie(participant) },
    );
    // The internal event and board session ids never appear in the page.
    assert.doesNotMatch(page.body, new RegExp(event.eventId));
    assert.doesNotMatch(page.body, /boardSession/);

    // Membership cannot be established by guessing internal identifiers:
    // there is no route keyed by event id.
    const guess = await requestWithCookies(
      app,
      `/events/${event.eventId}?lang=en`,
      { cookie: jarCookie(participant) },
    );
    assert.equal(guess.statusCode, 404);
  } finally {
    await closeServer(app);
  }
});

test("anonymity, rotation, and lock state persist across a store reload", async () => {
  const holder = { now: Date.now() };
  const { app, outboxDir, root } = await createClockServer(holder);
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, holder.now);
    const code = await mintAccessCode(app, ctx, event);
    holder.now += DAY;
    const participant = await signUpAndLogin(
      app,
      outboxDir,
      `persist-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    assert.equal(
      (await submitCode(app, participant, event.publicId, { code })).statusCode,
      303,
    );
    await requestWithCookies(app, `/events/${event.publicId}/anonymity`, {
      method: "POST",
      cookie: jarCookie(participant),
      body: new URLSearchParams({ _csrf: csrf(participant) }).toString(),
    });
    await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/events/${event.eventId}/entry-lock`,
      {
        method: "POST",
        cookie: jarCookie(ctx.owner),
        body: new URLSearchParams({
          _csrf: csrf(ctx.owner),
          locked: "1",
        }).toString(),
      },
    );
  } finally {
    await closeServer(app);
  }
  // Reload the persisted files directly to prove durable state. The write
  // queues flush asynchronously, so poll instead of assuming a fixed delay.
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const file = path.join(root, "hosted-data", "event_memberships.json");
  /** @type {{memberships: {anonymity: string}[]}} */
  let stored = { memberships: [] };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      stored = JSON.parse(await fs.readFile(file, "utf8"));
      if (stored.memberships.length > 0) break;
    } catch {
      // The file may not exist yet while the queue drains.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(stored.memberships.length >= 1);
  assert.equal(stored.memberships[0]?.anonymity, "anonymous");
  /** @type {{events: {entryLocked: boolean}[]}} */
  let events = { events: [{ entryLocked: false }] };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      events = JSON.parse(
        await fs.readFile(
          path.join(root, "hosted-data", "events.json"),
          "utf8",
        ),
      );
      if (events.events[0]?.entryLocked) break;
    } catch {
      // The file may not exist yet while the queue drains.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(events.events[0]?.entryLocked, true);
});
