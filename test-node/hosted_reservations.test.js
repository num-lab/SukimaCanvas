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

/** @param {{csrfCookie: string}} jar */
const csrf = (jar) => jar.csrfCookie.split("=")[1] || "";
/** @param {{sessionCookie: string, csrfCookie: string}} jar */
const jarCookie = (jar) => `${jar.sessionCookie}; ${jar.csrfCookie}`;
/** @param {number} ms */
const dtLocal = (ms) => new Date(ms).toISOString().slice(0, 16);

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
  const console = await requestWithCookies(app, "/organizer?lang=en", {
    cookie: jarCookie(owner),
  });
  const organizerId = /organizers\/([^"/]+)"/.exec(console.body)?.[1];
  assert.ok(organizerId);
  return { operator, owner, organizerId };
}

/**
 * @param {import("http").Server} app
 * @param {{sessionCookie: string, csrfCookie: string}} jar
 * @param {string} organizerId
 * @param {{[key: string]: string}} fields
 */
async function createDraft(app, jar, organizerId, fields) {
  const response = await requestWithCookies(
    app,
    `/organizers/${organizerId}/reservations?lang=en`,
    {
      method: "POST",
      cookie: jarCookie(jar),
      body: new URLSearchParams({ _csrf: csrf(jar), ...fields }).toString(),
    },
  );
  const reservationId = /reservations\/([^"/]+)$/.exec(
    response.headers.location || "",
  )?.[1];
  return { response, reservationId };
}

/**
 * @param {number} [startOffset]
 * @param {number} [durationMs]
 * @param {number} [seats]
 */
function draftFields(startOffset = DAY, durationMs = HOUR, seats = 30) {
  const start = Date.now() + startOffset;
  return {
    eventName: "Launch Party",
    startsAt: dtLocal(start),
    endsAt: dtLocal(start + durationMs),
    requestedSeats: String(seats),
    visibility: "public",
    description: "Come draw with us.",
  };
}

test("organizer drafts and submits, operator approves, and a public id is minted", async () => {
  const { app, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
  });
  try {
    const { operator, owner, organizerId } = await provisionOrganizer(
      app,
      outboxDir,
    );
    const { response, reservationId } = await createDraft(
      app,
      owner,
      organizerId,
      draftFields(),
    );
    assert.equal(response.statusCode, 303);
    assert.ok(reservationId);

    const submitted = await requestWithCookies(
      app,
      `/organizers/${organizerId}/reservations/${reservationId}/submit`,
      {
        method: "POST",
        cookie: jarCookie(owner),
        body: new URLSearchParams({ _csrf: csrf(owner) }).toString(),
      },
    );
    assert.equal(submitted.statusCode, 303);

    // The operator sees the reservation and its capacity impact.
    const opQueue = await requestWithCookies(
      app,
      "/operator/reservations?lang=en",
      {
        cookie: jarCookie(operator),
      },
    );
    assert.match(opQueue.body, /Launch Party/);
    const opDetail = await requestWithCookies(
      app,
      `/operator/reservations/${reservationId}?lang=en`,
      { cookie: jarCookie(operator) },
    );
    assert.match(opDetail.body, /Capacity impact/);
    assert.match(opDetail.body, /1 \/ 20/); // one board session at peak

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

    // The organizer sees the approval and an unguessable public event link.
    const detail = await requestWithCookies(
      app,
      `/organizers/${organizerId}/reservations/${reservationId}?lang=en`,
      { cookie: jarCookie(owner) },
    );
    assert.match(detail.body, /Approved/);
    const publicPath = /\/events\/([A-Za-z0-9_-]+)/.exec(detail.body)?.[1];
    assert.ok(publicPath, "an event public id must be shown");
    assert.ok(publicPath.length >= 16);
    // The public id is not the internal reservation id.
    assert.notEqual(publicPath, reservationId);
  } finally {
    await closeServer(app);
  }
});

test("reservation input boundaries are enforced deterministically", async () => {
  const { app, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
  });
  try {
    const { owner, organizerId } = await provisionOrganizer(app, outboxDir);
    /** @param {{[key: string]: string}} overrides */
    const create = (overrides) =>
      createDraft(app, owner, organizerId, { ...draftFields(), ...overrides });

    assert.equal((await create({ eventName: "" })).response.statusCode, 400);
    assert.equal(
      (await create({ requestedSeats: "0" })).response.statusCode,
      400,
    );
    assert.equal(
      (await create({ requestedSeats: "51" })).response.statusCode,
      400,
    );
    assert.equal(
      (await create({ requestedSeats: "1" })).response.statusCode,
      303,
    );
    assert.equal(
      (await create({ requestedSeats: "50" })).response.statusCode,
      303,
    );

    // End before start.
    const start = Date.now() + DAY;
    assert.equal(
      (
        await create({
          startsAt: dtLocal(start),
          endsAt: dtLocal(start - HOUR),
        })
      ).response.statusCode,
      400,
    );

    // Missing CSRF.
    const noCsrf = await requestWithCookies(
      app,
      `/organizers/${organizerId}/reservations`,
      {
        method: "POST",
        cookie: jarCookie(owner),
        body: new URLSearchParams(draftFields()).toString(),
      },
    );
    assert.equal(noCsrf.statusCode, 403);
  } finally {
    await closeServer(app);
  }
});

test("a past start cannot be submitted and submitted reservations are frozen", async () => {
  const { app, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
  });
  try {
    const { owner, organizerId } = await provisionOrganizer(app, outboxDir);
    // A draft with a past start can be saved but not submitted.
    const past = await createDraft(app, owner, organizerId, {
      ...draftFields(),
      startsAt: dtLocal(Date.now() - 2 * HOUR),
      endsAt: dtLocal(Date.now() - HOUR),
    });
    assert.equal(past.response.statusCode, 303);
    const submitPast = await requestWithCookies(
      app,
      `/organizers/${organizerId}/reservations/${past.reservationId}/submit`,
      {
        method: "POST",
        cookie: jarCookie(owner),
        body: new URLSearchParams({ _csrf: csrf(owner) }).toString(),
      },
    );
    assert.equal(submitPast.statusCode, 400);

    // A future draft, once submitted, rejects direct edits.
    const future = await createDraft(app, owner, organizerId, draftFields());
    await requestWithCookies(
      app,
      `/organizers/${organizerId}/reservations/${future.reservationId}/submit`,
      {
        method: "POST",
        cookie: jarCookie(owner),
        body: new URLSearchParams({ _csrf: csrf(owner) }).toString(),
      },
    );
    const edit = await requestWithCookies(
      app,
      `/organizers/${organizerId}/reservations/${future.reservationId}`,
      {
        method: "POST",
        cookie: jarCookie(owner),
        body: new URLSearchParams({
          _csrf: csrf(owner),
          ...draftFields(DAY, HOUR, 45),
        }).toString(),
      },
    );
    assert.equal(edit.statusCode, 409);
  } finally {
    await closeServer(app);
  }
});

test("a capacity conflict blocks a second overlapping approval", async () => {
  const { app, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
    HOSTED_MAX_CONCURRENT_SEATS: 50,
  });
  try {
    const { operator, owner, organizerId } = await provisionOrganizer(
      app,
      outboxDir,
    );
    const start = Date.now() + DAY;
    /** @param {number} seats */
    const submit = async (seats) => {
      const { reservationId } = await createDraft(app, owner, organizerId, {
        eventName: "Overlap",
        startsAt: dtLocal(start),
        endsAt: dtLocal(start + HOUR),
        requestedSeats: String(seats),
        visibility: "public",
      });
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
      return reservationId;
    };
    const first = await submit(30);
    const second = await submit(30);
    /** @param {string} id */
    const approve = (id) =>
      requestWithCookies(app, `/operator/reservations/${id}/approve`, {
        method: "POST",
        cookie: jarCookie(operator),
        body: new URLSearchParams({ _csrf: csrf(operator) }).toString(),
      });
    assert.equal((await approve(first)).statusCode, 303);
    const blocked = await approve(second);
    assert.equal(blocked.statusCode, 409);
    assert.match(blocked.body, /capacity/i);
  } finally {
    await closeServer(app);
  }
});

test("concurrent approvals of overlapping reservations never oversell", async () => {
  const { app, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
    HOSTED_MAX_CONCURRENT_SEATS: 50,
  });
  try {
    const { operator, owner, organizerId } = await provisionOrganizer(
      app,
      outboxDir,
    );
    const start = Date.now() + DAY;
    const submit = async () => {
      const { reservationId } = await createDraft(app, owner, organizerId, {
        eventName: "Race",
        startsAt: dtLocal(start),
        endsAt: dtLocal(start + HOUR),
        requestedSeats: "30",
        visibility: "public",
      });
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
      return reservationId;
    };
    const a = await submit();
    const b = await submit();
    /** @param {string} id */
    const approve = (id) =>
      requestWithCookies(app, `/operator/reservations/${id}/approve`, {
        method: "POST",
        cookie: jarCookie(operator),
        body: new URLSearchParams({ _csrf: csrf(operator) }).toString(),
      });
    const [ra, rb] = await Promise.all([approve(a), approve(b)]);
    const codes = [ra.statusCode, rb.statusCode].sort();
    assert.deepEqual(codes, [303, 409]);
  } finally {
    await closeServer(app);
  }
});

test("reservation authorization is enforced across roles and organizers", async () => {
  const { app, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
  });
  try {
    const { owner, organizerId } = await provisionOrganizer(app, outboxDir);
    const { reservationId } = await createDraft(
      app,
      owner,
      organizerId,
      draftFields(),
    );
    await requestWithCookies(
      app,
      `/organizers/${organizerId}/reservations/${reservationId}/submit`,
      {
        method: "POST",
        cookie: jarCookie(owner),
        body: new URLSearchParams({ _csrf: csrf(owner) }).toString(),
      },
    );

    // A non-member account cannot see or create reservations in this organizer.
    const stranger = await signUpAndLogin(
      app,
      outboxDir,
      `stranger-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    const strangerView = await requestWithCookies(
      app,
      `/organizers/${organizerId}/reservations`,
      { cookie: jarCookie(stranger) },
    );
    assert.equal(strangerView.statusCode, 404);

    // A non-operator cannot approve.
    const strangerApprove = await requestWithCookies(
      app,
      `/operator/reservations/${reservationId}/approve`,
      {
        method: "POST",
        cookie: jarCookie(stranger),
        body: new URLSearchParams({ _csrf: csrf(stranger) }).toString(),
      },
    );
    assert.equal(strangerApprove.statusCode, 403);

    // Signed-out visitors are redirected to login.
    const signedOut = await requestWithCookies(
      app,
      `/organizers/${organizerId}/reservations`,
    );
    assert.equal(signedOut.statusCode, 303);
    assert.equal(signedOut.headers.location, "/login");
  } finally {
    await closeServer(app);
  }
});
