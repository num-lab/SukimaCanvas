const test = require("node:test");
const assert = require("node:assert/strict");

const { closeServer } = require("./test_helpers.js");
const {
  STRONG_PASSWORD,
  createHostedServer,
  requestWithCookies,
  formValue,
  signUpAndLogin,
} = require("./helpers/hosted_http.js");

const OPERATOR_EMAIL = "operator@example.com";
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
/** The default service timezone (UTC+8); datetime-local values are wall clock. */
const SERVICE_OFFSET_MS = 8 * HOUR;

/** @param {{csrfCookie: string}} jar */
const csrf = (jar) => jar.csrfCookie.split("=")[1] || "";
/** @param {{sessionCookie: string, csrfCookie: string}} jar */
const jarCookie = (jar) => `${jar.sessionCookie}; ${jar.csrfCookie}`;
/**
 * @param {number} ms
 * Service wall clock (UTC+8): the entered epoch is shifted into the service
 * timezone so the parsed absolute instant matches.
 */
const dtLocal = (ms) =>
  new Date(ms + SERVICE_OFFSET_MS).toISOString().slice(0, 16);

/**
 * Registers the operator and an owner, applies for the organizer, and
 * approves it. Returns the two cookie jars plus the organizer id.
 *
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
 * Drafts, submits, and approves one reservation, returning the reservation,
 * event, and public ids.
 *
 * @param {import("http").Server} app
 * @param {{operator: any, owner: any, organizerId: string}} ctx
 * @param {{startsAtMs: number, endsAtMs: number}} times
 */
async function approveEvent(app, ctx, times) {
  const { operator, owner, organizerId } = ctx;
  const created = await requestWithCookies(
    app,
    `/organizers/${organizerId}/reservations?lang=en`,
    {
      method: "POST",
      cookie: jarCookie(owner),
      body: new URLSearchParams({
        _csrf: csrf(owner),
        eventName: "Publication Jam",
        startsAt: dtLocal(times.startsAtMs),
        endsAt: dtLocal(times.endsAtMs),
        requestedSeats: "10",
        visibility: "public",
        description: "Come draw with us.",
      }).toString(),
    },
  );
  const reservationId = /reservations\/([^"/]+)$/.exec(
    created.headers.location || "",
  )?.[1];
  assert.ok(reservationId, "reservation must be created");
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
  assert.ok(publicId, "an event public id must be shown");
  assert.ok(eventId, "an event management link must be shown");
  return { reservationId, publicId, eventId };
}

/**
 * Renders the event manage page and returns the parsed CSRF token.
 *
 * @param {import("http").Server} app
 * @param {{sessionCookie: string, csrfCookie: string}} jar
 * @param {string} organizerId
 * @param {string} eventId
 */
async function manageEventPage(app, jar, organizerId, eventId) {
  const page = await requestWithCookies(
    app,
    `/organizers/${organizerId}/events/${eventId}?lang=en`,
    { cookie: jarCookie(jar) },
  );
  assert.equal(page.statusCode, 200);
  return page;
}

/**
 * Publishes from the manage page form, mirroring what the browser sends.
 *
 * @param {import("http").Server} app
 * @param {{sessionCookie: string, csrfCookie: string}} jar
 * @param {string} organizerId
 * @param {string} eventId
 * @param {{audience: string, showAttribution?: boolean}} policy
 */
async function publishFromManagePage(app, jar, organizerId, eventId, policy) {
  const page = await manageEventPage(app, jar, organizerId, eventId);
  return requestWithCookies(
    app,
    `/organizers/${organizerId}/events/${eventId}/publication`,
    {
      method: "POST",
      cookie: jarCookie(jar),
      body: new URLSearchParams({
        _csrf: formValue(page.body, "_csrf"),
        audience: policy.audience,
        ...(policy.showAttribution ? { showAttribution: "1" } : {}),
      }).toString(),
    },
  );
}

test("a published canvas is audience-gated, read-only, non-indexable, and revocable", async () => {
  // The injected service clock drives the durable lifecycle: the event is
  // created, opened (a participant joins), ended, and closed without sleeps.
  const holder = { now: Date.now() };
  const { app, outboxDir } = await createHostedServer({
    HOSTED_CLOCK: () => holder.now,
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
  });
  try {
    const organizer = await provisionOrganizer(app, outboxDir);
    // A short event a few service-minutes out: accounts register and act
    // within the session idle window while the injected clock advances the
    // lifecycle through open, end, drain, and close.
    const startsAtMs = holder.now + 5 * MINUTE;
    const { publicId, eventId } = await approveEvent(app, organizer, {
      startsAtMs,
      endsAtMs: startsAtMs + 5 * MINUTE,
    });

    // Before the session closes there is nothing to publish, and the manage
    // page says so.
    const earlyPage = await manageEventPage(
      app,
      organizer.owner,
      organizer.organizerId,
      eventId,
    );
    assert.ok(
      earlyPage.body.includes(
        "can be published once the board session has closed",
      ),
      "the manage page explains publication needs a closed session",
    );
    assert.ok(
      !earlyPage.body.includes('name="audience"'),
      "no publish form is offered before the session closed",
    );

    // A participant joins while the session is open (identified choice).
    const participant = await signUpAndLogin(
      app,
      outboxDir,
      `joiner-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    holder.now = startsAtMs + MINUTE;
    const eventPage = await requestWithCookies(
      app,
      `/events/${publicId}?lang=en`,
      { cookie: jarCookie(participant) },
    );
    assert.ok(
      eventPage.body.includes('name="accessCode"'),
      "the enter form appears while the session is open",
    );
    // The organizer mints the access code on the manage page.
    const codePage = await manageEventPage(
      app,
      organizer.owner,
      organizer.organizerId,
      eventId,
    );
    const minted = await requestWithCookies(
      app,
      `/organizers/${organizer.organizerId}/events/${eventId}/access-code`,
      {
        method: "POST",
        cookie: jarCookie(organizer.owner),
        body: new URLSearchParams({
          _csrf: formValue(codePage.body, "_csrf"),
        }).toString(),
      },
    );
    assert.equal(minted.statusCode, 200);
    const accessCodeValue =
      /class="hosted-event-access-code-value">([^<]+)</.exec(minted.body)?.[1];
    assert.ok(accessCodeValue);
    const entered = await requestWithCookies(app, `/events/${publicId}/enter`, {
      method: "POST",
      cookie: jarCookie(participant),
      body: new URLSearchParams({
        _csrf: formValue(eventPage.body, "_csrf"),
        accessCode: accessCodeValue,
        anonymity: "identified",
      }).toString(),
    });
    assert.equal(entered.statusCode, 303);

    // End the session and let the drain elapse: the next publish advances
    // the durable lifecycle and seals the empty session.
    holder.now = startsAtMs + 20 * MINUTE;

    // Publish for members with attribution.
    const published = await publishFromManagePage(
      app,
      organizer.owner,
      organizer.organizerId,
      eventId,
      { audience: "members", showAttribution: true },
    );
    assert.equal(published.statusCode, 200);
    assert.ok(
      published.body.includes(
        "The canvas is now published for the chosen audience.",
      ),
    );
    assert.ok(
      published.body.includes("Event participants"),
      "the manage page shows the chosen audience",
    );

    const canvasPath = `/events/${publicId}/canvas`;
    // A signed-in member may read; the page is a noindex, read-only shell.
    const memberView = await requestWithCookies(app, `${canvasPath}?lang=en`, {
      cookie: jarCookie(participant),
    });
    assert.equal(memberView.statusCode, 200);
    assert.equal(memberView.headers["x-robots-tag"], "noindex, nofollow");
    assert.ok(
      memberView.body.includes(
        '<meta name="robots" content="noindex, nofollow" />',
      ),
    );
    assert.ok(memberView.body.includes('data-wbo-readonly="true"'));
    assert.ok(memberView.body.includes('id="drawingArea"'));
    assert.ok(!memberView.body.includes("data-wbo-created-by"));
    // The empty canvas is a valid archived presentation without attribution.
    const ownerView = await requestWithCookies(app, `${canvasPath}?lang=en`, {
      cookie: jarCookie(organizer.owner),
    });
    // The owner is not an event member, so the members audience refuses them.
    assert.equal(ownerView.statusCode, 404);
    const signedOut = await requestWithCookies(app, `${canvasPath}?lang=en`);
    assert.equal(signedOut.statusCode, 404);

    // The organizer-only audience admits the owner and refuses the member.
    const organizerPublished = await publishFromManagePage(
      app,
      organizer.owner,
      organizer.organizerId,
      eventId,
      { audience: "organizer" },
    );
    assert.equal(organizerPublished.statusCode, 200);
    assert.ok(
      organizerPublished.body.includes("The publication settings are updated."),
    );
    const ownerOnly = await requestWithCookies(app, `${canvasPath}?lang=en`, {
      cookie: jarCookie(organizer.owner),
    });
    assert.equal(ownerOnly.statusCode, 200);
    assert.equal(
      (
        await requestWithCookies(app, `${canvasPath}?lang=en`, {
          cookie: jarCookie(participant),
        })
      ).statusCode,
      404,
    );

    // The link audience reveals the share URL exactly once on the response.
    const linkPublished = await publishFromManagePage(
      app,
      organizer.owner,
      organizer.organizerId,
      eventId,
      { audience: "link" },
    );
    assert.equal(linkPublished.statusCode, 200);
    const sharePath = /class="hosted-publication-share-url">([^<]+)</.exec(
      linkPublished.body,
    )?.[1];
    assert.ok(sharePath, "the share URL is revealed exactly once");
    const linkView = await requestWithCookies(app, `${sharePath}?lang=en`);
    assert.equal(linkView.statusCode, 200);
    // Tampered tokens and the bare URL are the same 404.
    assert.equal(
      (await requestWithCookies(app, `${sharePath.slice(0, -2)}xx?lang=en`))
        .statusCode,
      404,
    );
    assert.equal(
      (await requestWithCookies(app, `${canvasPath}?lang=en`)).statusCode,
      404,
    );

    // Revocation invalidates every audience and the share link immediately.
    const revokePage = await manageEventPage(
      app,
      organizer.owner,
      organizer.organizerId,
      eventId,
    );
    const revoked = await requestWithCookies(
      app,
      `/organizers/${organizer.organizerId}/events/${eventId}/publication/revoke`,
      {
        method: "POST",
        cookie: jarCookie(organizer.owner),
        body: new URLSearchParams({
          _csrf: formValue(revokePage.body, "_csrf"),
        }).toString(),
      },
    );
    assert.equal(revoked.statusCode, 303);
    for (const request of [
      requestWithCookies(app, `${canvasPath}?lang=en`, {
        cookie: jarCookie(participant),
      }),
      requestWithCookies(app, `${canvasPath}?lang=en`, {
        cookie: jarCookie(organizer.owner),
      }),
      requestWithCookies(app, `${sharePath}?lang=en`),
    ]) {
      assert.equal((await request).statusCode, 404);
    }

    // Publishing again works and mints a fresh link, never the old one.
    const republished = await publishFromManagePage(
      app,
      organizer.owner,
      organizer.organizerId,
      eventId,
      { audience: "link", showAttribution: false },
    );
    assert.equal(republished.statusCode, 200);
    const newSharePath = /class="hosted-publication-share-url">([^<]+)</.exec(
      republished.body,
    )?.[1];
    assert.ok(newSharePath && newSharePath !== sharePath);
    assert.equal(
      (await requestWithCookies(app, `${newSharePath}?lang=en`)).statusCode,
      200,
    );
    assert.equal(
      (await requestWithCookies(app, `${sharePath}?lang=en`)).statusCode,
      404,
      "a revoked share link is never resurrected",
    );
    assert.equal(
      (await requestWithCookies(app, `${newSharePath}?lang=en`)).headers[
        "x-robots-tag"
      ],
      "noindex, nofollow",
    );
  } finally {
    await closeServer(app);
  }
});

test("the published canvas routes do not exist in legacy mode", async () => {
  const holder = { now: Date.now() };
  const { app } = await createHostedServer({
    HOSTED_MODE: false,
    HOSTED_CLOCK: () => holder.now,
  });
  try {
    const response = await requestWithCookies(app, "/events/whatever/canvas");
    assert.ok(response.statusCode >= 400);
  } finally {
    await closeServer(app);
  }
});
