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

const OPERATOR_EMAIL = "operator@example.com";
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const DRAIN = MINUTE;

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
 * UTC service timezone, so datetime-local values map exactly to epoch ms and
 * lifecycle transitions are deterministic. The background poker stays off.
 *
 * @param {{now: number}} holder
 * @param {{[key: string]: any}} [overrides]
 */
function createClockServer(holder, overrides = {}) {
  return createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
    HOSTED_CLOCK: () => holder.now,
    HOSTED_SERVICE_UTC_OFFSET_MINUTES: 0,
    HOSTED_BOARD_SESSION_CLOSE_DRAIN_MS: DRAIN,
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
 * Approves an event starting a day out; returns its ids and exact times.
 *
 * @param {import("http").Server} app
 * @param {{operator: any, owner: any, organizerId: string}} ctx
 * @param {number} now
 * @param {{seats?: number}} [opts]
 */
async function approveEvent(app, ctx, now, opts = {}) {
  const { operator, owner, organizerId } = ctx;
  const start = minute(now + DAY);
  const end = start + HOUR;
  const created = await requestWithCookies(
    app,
    `/organizers/${organizerId}/reservations`,
    {
      method: "POST",
      cookie: jarCookie(owner),
      body: new URLSearchParams({
        _csrf: csrf(owner),
        eventName: "Launch Party",
        startsAt: dtLocal(start),
        endsAt: dtLocal(end),
        requestedSeats: String(opts.seats ?? 30),
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
  assert.ok(publicId);
  return { reservationId, publicId, start, end };
}

test("an amend is submitted, reviewed with capacity impact, and applied by an operator", async () => {
  const holder = { now: minute(Date.now()) };
  const { app, outboxDir } = await createClockServer(holder);
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, holder.now, { seats: 30 });
    const detailUrl = `/organizers/${ctx.organizerId}/reservations/${event.reservationId}`;

    // The owner requests a capacity change (30 -> 45 seats).
    const changed = await requestWithCookies(app, `${detailUrl}/change`, {
      method: "POST",
      cookie: jarCookie(ctx.owner),
      body: new URLSearchParams({
        _csrf: csrf(ctx.owner),
        startsAt: dtLocal(event.start),
        endsAt: dtLocal(event.end),
        requestedSeats: "45",
      }).toString(),
    });
    assert.equal(changed.statusCode, 303);

    // The reservation is unchanged and shows a pending change request.
    const pending = await requestWithCookies(app, `${detailUrl}?lang=en`, {
      cookie: jarCookie(ctx.owner),
    });
    assert.match(pending.body, /Pending change request/i);

    // The operator sees the change queue and its capacity impact.
    const queue = await requestWithCookies(app, "/operator/changes?lang=en", {
      cookie: jarCookie(ctx.operator),
    });
    assert.match(queue.body, /Launch Party/);
    const changeId = /operator\/changes\/([^"/]+)"/.exec(queue.body)?.[1];
    assert.ok(changeId);
    const review = await requestWithCookies(
      app,
      `/operator/changes/${changeId}?lang=en`,
      { cookie: jarCookie(ctx.operator) },
    );
    assert.match(review.body, /Capacity impact/i);
    assert.match(review.body, /45/);

    // Approval applies the new capacity to the reservation.
    const approved = await requestWithCookies(
      app,
      `/operator/changes/${changeId}/approve`,
      {
        method: "POST",
        cookie: jarCookie(ctx.operator),
        body: new URLSearchParams({ _csrf: csrf(ctx.operator) }).toString(),
      },
    );
    assert.equal(approved.statusCode, 303);
    const afterApply = await requestWithCookies(app, `${detailUrl}?lang=en`, {
      cookie: jarCookie(ctx.owner),
    });
    assert.match(afterApply.body, /Change history/i);
    assert.match(afterApply.body, /Applied/);
  } finally {
    await closeServer(app);
  }
});

test("an amend that would exceed capacity is refused with a deterministic conflict", async () => {
  const holder = { now: minute(Date.now()) };
  const { app, outboxDir } = await createClockServer(holder, {
    HOSTED_MAX_CONCURRENT_SEATS: 50,
  });
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    // Two overlapping approved events at 15 seats each (30 total <= 50).
    await approveEvent(app, ctx, holder.now, { seats: 15 });
    const b = await approveEvent(app, ctx, holder.now, { seats: 15 });
    const detailUrl = `/organizers/${ctx.organizerId}/reservations/${b.reservationId}`;
    // Amend B to 40 -> peak 15 + 40 = 55 > 50.
    await requestWithCookies(app, `${detailUrl}/change`, {
      method: "POST",
      cookie: jarCookie(ctx.owner),
      body: new URLSearchParams({
        _csrf: csrf(ctx.owner),
        startsAt: dtLocal(b.start),
        endsAt: dtLocal(b.end),
        requestedSeats: "40",
      }).toString(),
    });
    const queue = await requestWithCookies(app, "/operator/changes?lang=en", {
      cookie: jarCookie(ctx.operator),
    });
    const changeId = /operator\/changes\/([^"/]+)"/.exec(queue.body)?.[1];
    assert.ok(changeId);
    const refused = await requestWithCookies(
      app,
      `/operator/changes/${changeId}/approve`,
      {
        method: "POST",
        cookie: jarCookie(ctx.operator),
        body: new URLSearchParams({ _csrf: csrf(ctx.operator) }).toString(),
      },
    );
    assert.equal(refused.statusCode, 409);
    assert.match(refused.body, /capacity/i);
  } finally {
    await closeServer(app);
  }
});

test("cancelling a future event hides it and shows a cancelled event page", async () => {
  const holder = { now: minute(Date.now()) };
  const { app, outboxDir } = await createClockServer(holder);
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, holder.now);
    const detailUrl = `/organizers/${ctx.organizerId}/reservations/${event.reservationId}`;

    // It is discoverable before cancellation.
    const homeBefore = await requestWithCookies(app, "/?lang=en");
    assert.match(homeBefore.body, /Launch Party/);

    const cancelled = await requestWithCookies(app, `${detailUrl}/cancel`, {
      method: "POST",
      cookie: jarCookie(ctx.owner),
      body: new URLSearchParams({ _csrf: csrf(ctx.owner) }).toString(),
    });
    assert.equal(cancelled.statusCode, 303);

    const homeAfter = await requestWithCookies(app, "/?lang=en");
    assert.doesNotMatch(homeAfter.body, /Launch Party/);
    const eventPage = await requestWithCookies(
      app,
      `/events/${event.publicId}?lang=en`,
    );
    assert.match(eventPage.body, /cancelled/i);
  } finally {
    await closeServer(app);
  }
});

test("the durable lifecycle advances by the clock, shown consistently in the console", async () => {
  const holder = { now: minute(Date.now()) };
  const { app, outboxDir } = await createClockServer(holder);
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, holder.now);
    const detailUrl = `/organizers/${ctx.organizerId}/reservations/${event.reservationId}?lang=en`;
    /** @param {{sessionCookie: string, csrfCookie: string}} jar */
    const lifecycle = async (jar) =>
      (await requestWithCookies(app, detailUrl, { cookie: jarCookie(jar) }))
        .body;

    // Reading the console lazily advances the durable lifecycle by the clock,
    // so the displayed status always matches the authoritative state.
    assert.match(await lifecycle(ctx.owner), /Scheduled/);
    holder.now = event.start;
    assert.match(await lifecycle(ctx.owner), /Open/);
    holder.now = event.end;
    assert.match(await lifecycle(ctx.owner), /Closing/);
    holder.now = event.end + DRAIN;
    assert.match(await lifecycle(ctx.owner), /Closed/);

    // A change can no longer be requested once the session has opened/closed.
    const lateChange = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/reservations/${event.reservationId}/change`,
      {
        method: "POST",
        cookie: jarCookie(ctx.owner),
        body: new URLSearchParams({
          _csrf: csrf(ctx.owner),
          startsAt: dtLocal(event.start + 2 * DAY),
          endsAt: dtLocal(event.start + 2 * DAY + HOUR),
          requestedSeats: "20",
        }).toString(),
      },
    );
    assert.equal(lateChange.statusCode, 409);
  } finally {
    await closeServer(app);
  }
});

test("an interrupted lifecycle is recovered on restart without a duplicate transition", async () => {
  const holder = { now: minute(Date.now()) };
  const first = await createClockServer(holder);
  const dataDir = path.join(first.root, "hosted-data");
  const ctx = await provisionOrganizer(first.app, first.outboxDir);
  const event = await approveEvent(first.app, ctx, holder.now);
  // The service goes down while the event is still scheduled (never advanced).
  await closeServer(first.app);

  // A fresh instance on the same data directory, whose clock is well past the
  // whole window, catches the session all the way up to closed on the first
  // read — and a second read makes no further (duplicate) transition.
  const holder2 = { now: event.end + DRAIN + HOUR };
  const restarted = await createClockServer(holder2, {
    HOSTED_DATA_DIR: dataDir,
  });
  try {
    const detailUrl = `/organizers/${ctx.organizerId}/reservations/${event.reservationId}?lang=en`;
    const recovered = await requestWithCookies(restarted.app, detailUrl, {
      cookie: jarCookie(ctx.owner),
    });
    assert.match(recovered.body, /Closed/);
    const again = await requestWithCookies(restarted.app, detailUrl, {
      cookie: jarCookie(ctx.owner),
    });
    assert.match(again.body, /Closed/);
  } finally {
    await closeServer(restarted.app);
  }
});
