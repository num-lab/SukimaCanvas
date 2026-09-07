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
 * @param {{seats?: number, eventName?: string}} [opts]
 */
async function approveEvent(app, ctx, now, opts = {}) {
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
        eventName: opts.eventName ?? "Board Page Jam",
        startsAt: dtLocal(start),
        endsAt: dtLocal(start + HOUR),
        requestedSeats: String(opts.seats ?? 30),
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
 * Mints the shared Access Code and returns its one-time raw value.
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
  assert.ok(code);
  return code;
}

/**
 * Joins a signed-in account to the event through its Access Code.
 *
 * @param {import("http").Server} app
 * @param {{sessionCookie: string, csrfCookie: string}} participant
 * @param {{publicId: string}} event
 * @param {string} code
 */
async function joinViaCode(app, participant, event, code) {
  const joined = await requestWithCookies(
    app,
    `/events/${event.publicId}/enter`,
    {
      method: "POST",
      cookie: jarCookie(participant),
      body: new URLSearchParams({
        _csrf: csrf(participant),
        accessCode: code,
        anonymity: "identified",
      }).toString(),
    },
  );
  assert.equal(joined.statusCode, 303);
}

/**
 * The board entry link the viewer's event page offers, or null. The link
 * carries the event's unguessable board name; nothing else publishes it.
 *
 * @param {import("http").Server} app
 * @param {{sessionCookie: string, csrfCookie: string}} viewer
 * @param {{publicId: string}} event
 * @returns {Promise<string | null>}
 */
async function resolveBoardHref(app, viewer, event) {
  const page = await requestWithCookies(
    app,
    `/events/${event.publicId}?lang=en`,
    { cookie: jarCookie(viewer) },
  );
  const href = /href="(b\/event-[0-9a-f]{24})"/.exec(page.body)?.[1];
  return href ? `/${href}` : null;
}

test("the hosted board page renders the event board for an admitted member", async () => {
  const holder = { now: Date.now() };
  const { app, outboxDir } = await createClockServer(holder);
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, holder.now);
    const code = await mintAccessCode(app, ctx, event);
    holder.now += DAY; // open the session

    const member = await signUpAndLogin(
      app,
      outboxDir,
      `member-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    await joinViaCode(app, member, event, code);

    const boardHref = await resolveBoardHref(app, member, event);
    assert.ok(boardHref, "an admitted member sees the board entry link");
    const boardPage = await requestWithCookies(app, boardHref, {
      cookie: jarCookie(member),
    });
    assert.equal(boardPage.statusCode, 200);
    // The real WBO board shell, bound to the event's unguessable board name.
    assert.match(boardPage.body, /event-[0-9a-f]{24} \| WBO/);
    assert.match(boardPage.body, /id="drawingArea"/);
    // The page must never carry internal event or board session ids.
    assert.doesNotMatch(boardPage.body, new RegExp(event.eventId));
    assert.doesNotMatch(boardPage.body, /boardSession/);
  } finally {
    await closeServer(app);
  }
});

test("the board page refuses non-members and closed sessions with coarse notices", async () => {
  const holder = { now: Date.now() };
  const { app, outboxDir } = await createClockServer(holder);
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, holder.now);
    const code = await mintAccessCode(app, ctx, event);

    // The board name is unguessable and never published to non-viewers:
    // probing a made-up name is an ordinary 404.
    const probe = await requestWithCookies(
      app,
      "/b/event-000000000000000000000000",
    );
    assert.equal(probe.statusCode, 404);

    // A signed-in account without membership cannot resolve a board link.
    const nonMember = await signUpAndLogin(
      app,
      outboxDir,
      `nonmember-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    assert.equal(await resolveBoardHref(app, nonMember, event), null);

    // Once open, a joined member gets the board; after the session drains
    // and closes, the same member is refused with the lifecycle notice.
    holder.now += DAY; // open the session
    const member = await signUpAndLogin(
      app,
      outboxDir,
      `member-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    await joinViaCode(app, member, event, code);
    const boardHref = await resolveBoardHref(app, member, event);
    assert.ok(boardHref);
    const openBoard = await requestWithCookies(app, boardHref, {
      cookie: jarCookie(member),
    });
    assert.equal(openBoard.statusCode, 200);

    holder.now += HOUR + 2 * MINUTE; // closing drains, session closes
    await requestWithCookies(app, "/?lang=en");
    const closedBoard = await requestWithCookies(app, boardHref, {
      cookie: jarCookie(member),
    });
    assert.equal(closedBoard.statusCode, 303);
    assert.match(
      closedBoard.headers.location || "",
      new RegExp(`/events/${event.publicId}\\?notice=not_open$`),
    );

    // The legacy route for any board stays closed in hosted mode.
    const legacy = await requestWithCookies(app, "/boards/some-board", {
      cookie: jarCookie(member),
    });
    assert.equal(legacy.statusCode, 404);
  } finally {
    await closeServer(app);
  }
});

test("the Owner enters the board during the Preparation Window before participants", async () => {
  const holder = { now: Date.now() };
  const { app, outboxDir } = await createClockServer(holder);
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, holder.now);

    // Scheduled: the Owner's event page offers the board link once the
    // 15-minute Preparation Window opens, and the board renders with the
    // owner's clear capability.
    holder.now += DAY - 10 * MINUTE; // just inside the Preparation Window
    const boardHref = await resolveBoardHref(app, ctx.owner, event);
    assert.ok(boardHref, "the owner sees the board link inside the window");
    const ownerBoard = await requestWithCookies(app, boardHref, {
      cookie: jarCookie(ctx.owner),
    });
    assert.equal(ownerBoard.statusCode, 200);
    assert.match(ownerBoard.body, /event-[0-9a-f]{24} \| WBO/);
  } finally {
    await closeServer(app);
  }
});
