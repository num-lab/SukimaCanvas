const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { closeServer } = require("./test_helpers.js");
const {
  STRONG_PASSWORD,
  createHostedServer,
  requestWithCookies,
  loginSession,
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
 * Provisions one organizer (an operator, its Owner, and the approved
 * organizer) through the real HTTP flows. The operator account is shared
 * across organizers of the same server: pass a previous result's `operator`
 * back in via `reuseOperator` instead of registering a second one.
 *
 * @param {import("http").Server} app
 * @param {string} outboxDir
 * @param {{email?: string, reuseOperator?: {sessionCookie: string, csrfCookie: string}}} [options]
 */
async function provisionOrganizer(app, outboxDir, options = {}) {
  const operator = options.reuseOperator
    ? options.reuseOperator
    : await signUpAndLogin(app, outboxDir, OPERATOR_EMAIL, STRONG_PASSWORD);
  const owner = await signUpAndLogin(
    app,
    outboxDir,
    options.email ||
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
 * Drafts, submits, and approves one event starting `startOffsetMs` out.
 *
 * @param {import("http").Server} app
 * @param {{operator: any, owner: any, organizerId: string}} ctx
 * @param {number} now
 * @param {number} [startOffsetMs]
 */
async function approveEvent(app, ctx, now, startOffsetMs = DAY) {
  const { operator, owner, organizerId } = ctx;
  const start = minute(now + startOffsetMs);
  const created = await requestWithCookies(
    app,
    `/organizers/${organizerId}/reservations?lang=en`,
    {
      method: "POST",
      cookie: jarCookie(owner),
      body: new URLSearchParams({
        _csrf: csrf(owner),
        eventName: "Grant Jam",
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
 * Creates an API credential through the owner console and returns the
 * one-time bearer token plus the credential id from the management page.
 *
 * @param {import("http").Server} app
 * @param {{owner: any, organizerId: string}} ctx
 */
async function createCredential(app, ctx) {
  const created = await requestWithCookies(
    app,
    `/organizers/${ctx.organizerId}/credentials`,
    {
      method: "POST",
      cookie: jarCookie(ctx.owner),
      body: new URLSearchParams({ _csrf: csrf(ctx.owner) }).toString(),
    },
  );
  assert.equal(created.statusCode, 200);
  const token = /hosted-credential-secret-value">([^<]+)</.exec(
    created.body,
  )?.[1];
  assert.ok(token, "the raw credential token must be revealed once");
  const credentialId = /hosted-credential-id">([^<]+)</.exec(created.body)?.[1];
  assert.ok(credentialId);
  // The management page must never re-render the secret afterwards.
  const again = await requestWithCookies(
    app,
    `/organizers/${ctx.organizerId}?lang=en`,
    { cookie: jarCookie(ctx.owner) },
  );
  assert.ok(!again.body.includes(token), "the secret must not persist");
  return { token, credentialId };
}

/**
 * A raw machine request to the integration API (no cookies, JSON).
 *
 * @param {import("http").Server} app
 * @param {string} requestPath
 * @param {{method?: string, authorization?: string, jsonBody?: string, contentType?: string}} [options]
 * @returns {Promise<{statusCode: number, headers: import("http").IncomingHttpHeaders, body: string, setCookie: string[]}>}
 */
function api(app, requestPath, options = {}) {
  return requestWithCookies(app, requestPath, {
    method: options.method || "GET",
    headers: {
      ...(options.authorization
        ? { authorization: options.authorization }
        : {}),
      ...(options.jsonBody
        ? {
            "content-type":
              options.contentType || "application/json; charset=utf-8",
            "content-length": String(Buffer.byteLength(options.jsonBody)),
          }
        : {}),
    },
    body: options.jsonBody,
  });
}

/**
 * POSTs a grant redemption exactly like the event page's browser script.
 *
 * @param {import("http").Server} app
 * @param {{sessionCookie: string, csrfCookie: string}} participant
 * @param {string} publicId
 * @param {{token?: string, omitCsrf?: boolean}} [fields]
 */
function redeem(app, participant, publicId, fields = {}) {
  return requestWithCookies(app, `/events/${publicId}/entry-grant`, {
    method: "POST",
    cookie: jarCookie(participant),
    body: new URLSearchParams({
      ...(fields.omitCsrf ? {} : { _csrf: csrf(participant) }),
      entryGrant: fields.token ?? "",
    }).toString(),
  });
}

/**
 * The uniform deterministic failure every invalid redemption returns.
 *
 * @param {{statusCode: number, body: string}} response
 * @returns {void}
 */
function assertInvalidGrant(response) {
  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), { error: "entry_grant_invalid" });
}

test("only owners manage credentials, and the secret is revealed exactly once", async () => {
  const holder = { now: Date.now() };
  const { app, outboxDir } = await createClockServer(holder);
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    await approveEvent(app, ctx, holder.now);

    // An Owner creates a credential; the secret is shown once and never again.
    const credential = await createCredential(app, ctx);
    assert.match(
      credential.token,
      /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/,
      "the token is <uuid>.<secret>",
    );
    // The management page lists the credential metadata.
    const manage = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}?lang=en`,
      { cookie: jarCookie(ctx.owner) },
    );
    assert.match(manage.body, new RegExp(credential.credentialId));
    assert.match(manage.body, /API credentials/);

    // An invited Admin may not mint credentials.
    const adminEmail = `admin-${Date.now()}@example.com`;
    await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/invitations`,
      {
        method: "POST",
        cookie: jarCookie(ctx.owner),
        body: new URLSearchParams({
          _csrf: csrf(ctx.owner),
          email: adminEmail,
          role: "admin",
        }).toString(),
      },
    );
    const admin = await signUpAndLogin(
      app,
      outboxDir,
      adminEmail,
      STRONG_PASSWORD,
    );
    const invitations = await requestWithCookies(app, "/organizer?lang=en", {
      cookie: jarCookie(admin),
    });
    const acceptHref = /organizer\/invitations\/[^"]+\/accept/.exec(
      invitations.body,
    )?.[0];
    assert.ok(acceptHref);
    const accepted = await requestWithCookies(app, `/${acceptHref}`, {
      method: "POST",
      cookie: jarCookie(admin),
      body: new URLSearchParams({ _csrf: csrf(admin) }).toString(),
    });
    assert.equal(accepted.statusCode, 303);
    const adminDenied = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/credentials`,
      {
        method: "POST",
        cookie: jarCookie(admin),
        body: new URLSearchParams({ _csrf: csrf(admin) }).toString(),
      },
    );
    assert.equal(adminDenied.statusCode, 403);

    // A signed-in non-member is a 404, and a signed-out visitor is bounced.
    const outsider = await signUpAndLogin(
      app,
      outboxDir,
      `out-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    const outsiderDenied = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/credentials`,
      {
        method: "POST",
        cookie: jarCookie(outsider),
        body: new URLSearchParams({ _csrf: csrf(outsider) }).toString(),
      },
    );
    assert.equal(outsiderDenied.statusCode, 404);
    const bounced = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/credentials`,
      { method: "POST", body: new URLSearchParams({ _csrf: "x" }).toString() },
    );
    assert.equal(bounced.statusCode, 303);

    // Rotation replaces the secret; the old token dies instantly.
    const rotated = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/credentials/${credential.credentialId}/rotate`,
      {
        method: "POST",
        cookie: jarCookie(ctx.owner),
        body: new URLSearchParams({ _csrf: csrf(ctx.owner) }).toString(),
      },
    );
    assert.equal(rotated.statusCode, 200);
    const newToken = /hosted-credential-secret-value">([^<]+)</.exec(
      rotated.body,
    )?.[1];
    assert.ok(newToken && newToken !== credential.token);
    const event = await approveEvent(app, ctx, holder.now + 3 * DAY);
    const deadToken = await api(app, `/api/v1/events/${event.publicId}`, {
      authorization: `Bearer ${credential.token}`,
    });
    assert.equal(deadToken.statusCode, 401);
    const liveToken = await api(app, `/api/v1/events/${event.publicId}`, {
      authorization: `Bearer ${newToken}`,
    });
    assert.equal(liveToken.statusCode, 200);

    // Revocation is permanent; a revoked credential cannot rotate.
    const revoked = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/credentials/${credential.credentialId}/revoke`,
      {
        method: "POST",
        cookie: jarCookie(ctx.owner),
        body: new URLSearchParams({ _csrf: csrf(ctx.owner) }).toString(),
      },
    );
    assert.equal(revoked.statusCode, 303);
    const revokedAuth = await api(app, `/api/v1/events/${event.publicId}`, {
      authorization: `Bearer ${newToken}`,
    });
    assert.equal(revokedAuth.statusCode, 401);
    const rotateRevoked = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/credentials/${credential.credentialId}/rotate`,
      {
        method: "POST",
        cookie: jarCookie(ctx.owner),
        body: new URLSearchParams({ _csrf: csrf(ctx.owner) }).toString(),
      },
    );
    assert.equal(rotateRevoked.statusCode, 409);
    // An unknown credential id is a plain 404.
    const unknown = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/credentials/00000000-0000-4000-8000-000000000000/revoke`,
      {
        method: "POST",
        cookie: jarCookie(ctx.owner),
        body: new URLSearchParams({ _csrf: csrf(ctx.owner) }).toString(),
      },
    );
    assert.equal(unknown.statusCode, 404);
  } finally {
    await closeServer(app);
  }
});

test("the integration API authenticates credentials and never leaks other organizers' events", async () => {
  const holder = { now: Date.now() };
  const { app, outboxDir } = await createClockServer(holder);
  try {
    const first = await provisionOrganizer(app, outboxDir);
    const ownEvent = await approveEvent(app, first, holder.now);
    const second = await provisionOrganizer(app, outboxDir, {
      email: `owner2-${Date.now()}@example.com`,
      reuseOperator: first.operator,
    });
    const foreignEvent = await approveEvent(app, second, holder.now);
    const credential = await createCredential(app, first);

    // Missing, malformed, and wrong bearer values all fail identically.
    for (const authorization of [
      undefined,
      "",
      "Basic dXNlcjpwYXNz",
      "Bearer",
      "Bearer garbage",
      `Bearer ${credential.token.slice(0, -3)}`,
      `Bearer ${credential.credentialId}.${"A".repeat(43)}`,
    ]) {
      const response = await api(app, `/api/v1/events/${ownEvent.publicId}`, {
        authorization,
      });
      assert.equal(response.statusCode, 401);
      assert.deepEqual(JSON.parse(response.body), {
        error: "credential_required",
      });
    }

    // A scoped query reports the event's authoritative lifecycle state.
    const scheduled = await api(app, `/api/v1/events/${ownEvent.publicId}`, {
      authorization: `Bearer ${credential.token}`,
    });
    assert.equal(scheduled.statusCode, 200);
    assert.deepEqual(JSON.parse(scheduled.body), {
      event: {
        publicId: ownEvent.publicId,
        name: "Grant Jam",
        status: "scheduled",
        startsAtMs: minute(holder.now + DAY),
        endsAtMs: minute(holder.now + DAY) + HOUR,
      },
    });
    holder.now += DAY + MINUTE;
    const open = await api(app, `/api/v1/events/${ownEvent.publicId}`, {
      authorization: `Bearer ${credential.token}`,
    });
    assert.equal(JSON.parse(open.body).event.status, "open");

    // Foreign and unknown events are the same deterministic 404.
    for (const publicId of [foreignEvent.publicId, "c3RhcmVsaW5nGQ"]) {
      const denied = await api(app, `/api/v1/events/${publicId}`, {
        authorization: `Bearer ${credential.token}`,
      });
      assert.equal(denied.statusCode, 404);
      assert.deepEqual(JSON.parse(denied.body), { error: "event_not_found" });
    }

    // The interface is exactly GET-query and POST-grants.
    const wrongMethodQuery = await api(
      app,
      `/api/v1/events/${ownEvent.publicId}`,
      {
        method: "POST",
        authorization: `Bearer ${credential.token}`,
      },
    );
    assert.equal(wrongMethodQuery.statusCode, 405);
    const wrongMethodGrants = await api(
      app,
      `/api/v1/events/${ownEvent.publicId}/entry-grants`,
      { method: "GET", authorization: `Bearer ${credential.token}` },
    );
    assert.equal(wrongMethodGrants.statusCode, 405);
  } finally {
    await closeServer(app);
  }
});

test("grant creation issues a ten-minute grant whose token travels only in the fragment", async () => {
  const holder = { now: Date.now() };
  const { app, outboxDir } = await createClockServer(holder);
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, holder.now);
    const credential = await createCredential(app, ctx);

    const created = await api(
      app,
      `/api/v1/events/${event.publicId}/entry-grants`,
      {
        method: "POST",
        authorization: `Bearer ${credential.token}`,
        jsonBody: JSON.stringify({ externalReference: "customer-42" }),
      },
    );
    assert.equal(created.statusCode, 201);
    const body = JSON.parse(created.body);
    const grantPath = body.entryGrant.entryGrantPath;
    assert.ok(
      grantPath.startsWith(`/events/${event.publicId}#entryGrant=`),
      "the grant travels only in a URL fragment of the event page",
    );
    const grantToken = grantPath.split("#entryGrant=")[1];
    assert.match(grantToken, /^[A-Za-z0-9_-]{20,128}$/);
    assert.equal(grantToken, grantToken.trim());
    // The token appears exactly once in the whole response — in the fragment.
    assert.equal(JSON.stringify(body).split(grantToken).length - 1, 1);
    assert.equal(body.entryGrant.externalReference, "customer-42");
    assert.equal(
      Math.abs(body.entryGrant.expiresAtMs - (holder.now + 10 * MINUTE)) <
        5 * 1000,
      true,
    );

    // Hostile payloads are deterministic machine-readable failures.
    for (const [
      jsonBody,
      status,
      error,
    ] of /** @type {[string, number, string][]} */ ([
      [
        JSON.stringify({ externalReference: "" }),
        400,
        "invalid_external_reference",
      ],
      [
        JSON.stringify({ externalReference: "   \n  " }),
        400,
        "invalid_external_reference",
      ],
      [
        JSON.stringify({ externalReference: "x".repeat(257) }),
        400,
        "invalid_external_reference",
      ],
      [
        JSON.stringify({ externalReference: 42 }),
        400,
        "invalid_external_reference",
      ],
      ['{"externalReference":', 400, "invalid_json"],
      ["[1,2,3]", 400, "invalid_json"],
      [
        JSON.stringify({ ok: true }) + " ".repeat(17 * 1024),
        413,
        "request_too_large",
      ],
    ])) {
      const hostile = await api(
        app,
        `/api/v1/events/${event.publicId}/entry-grants`,
        {
          method: "POST",
          authorization: `Bearer ${credential.token}`,
          jsonBody,
        },
      );
      assert.equal(hostile.statusCode, status);
      assert.deepEqual(JSON.parse(hostile.body), { error });
    }
    const wrongType = await api(
      app,
      `/api/v1/events/${event.publicId}/entry-grants`,
      {
        method: "POST",
        authorization: `Bearer ${credential.token}`,
        jsonBody: JSON.stringify({ externalReference: "ok" }),
        contentType: "text/plain",
      },
    );
    assert.equal(wrongType.statusCode, 415);

    // A cancelled event issues no grants at all.
    await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/reservations/${event.reservationId}/cancel`,
      {
        method: "POST",
        cookie: jarCookie(ctx.owner),
        body: new URLSearchParams({ _csrf: csrf(ctx.owner) }).toString(),
      },
    );
    const cancelled = await api(
      app,
      `/api/v1/events/${event.publicId}/entry-grants`,
      {
        method: "POST",
        authorization: `Bearer ${credential.token}`,
        jsonBody: "{}",
      },
    );
    assert.equal(cancelled.statusCode, 409);
    assert.deepEqual(JSON.parse(cancelled.body), {
      error: "event_not_available",
    });
  } finally {
    await closeServer(app);
  }
});

test("grant creation is rate limited per credential", async () => {
  const holder = { now: Date.now() };
  const { app, outboxDir } = await createClockServer(holder, {
    HOSTED_API_ENTRY_GRANT_LIMIT: 2,
    HOSTED_API_ENTRY_GRANT_WINDOW_MS: MINUTE,
  });
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, holder.now);
    const credential = await createCredential(app, ctx);
    for (let index = 0; index < 2; index += 1) {
      const created = await api(
        app,
        `/api/v1/events/${event.publicId}/entry-grants`,
        {
          method: "POST",
          authorization: `Bearer ${credential.token}`,
          jsonBody: "{}",
        },
      );
      assert.equal(created.statusCode, 201);
    }
    const limited = await api(
      app,
      `/api/v1/events/${event.publicId}/entry-grants`,
      {
        method: "POST",
        authorization: `Bearer ${credential.token}`,
        jsonBody: "{}",
      },
    );
    assert.equal(limited.statusCode, 429);
    assert.deepEqual(JSON.parse(limited.body), { error: "rate_limited" });
  } finally {
    await closeServer(app);
  }
});

test("redemption admits the signed-in participant exactly once, then never again", async () => {
  const holder = { now: Date.now() };
  const { app, outboxDir } = await createClockServer(holder);
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, holder.now);
    const credential = await createCredential(app, ctx);
    const participant = await signUpAndLogin(
      app,
      outboxDir,
      `p-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    holder.now += DAY + MINUTE; // open the session

    // The grant is minted while the event runs, so its 10-minute TTL is
    // exercisable within the session.
    const grant = await api(
      app,
      `/api/v1/events/${event.publicId}/entry-grants`,
      {
        method: "POST",
        authorization: `Bearer ${credential.token}`,
        jsonBody: "{}",
      },
    );
    const grantToken = JSON.parse(grant.body).entryGrant.entryGrantPath.split(
      "#entryGrant=",
    )[1];

    // Signed-out browsers are told to authenticate, not rejected as invalid.
    const signedOut = await requestWithCookies(
      app,
      `/events/${event.publicId}/entry-grant`,
      {
        method: "POST",
        body: new URLSearchParams({ entryGrant: grantToken }).toString(),
      },
    );
    assert.equal(signedOut.statusCode, 401);
    assert.deepEqual(JSON.parse(signedOut.body), { error: "account_required" });

    // Missing CSRF fails before anything else.
    const noCsrf = await redeem(app, participant, event.publicId, {
      token: grantToken,
      omitCsrf: true,
    });
    assert.equal(noCsrf.statusCode, 403);

    // Malformed tokens are uniform, deterministic failures.
    for (const hostile of [
      "",
      "short",
      "../../etc/passwd",
      `${"a".repeat(500)}`,
      "入場リンクのトークン",
      `${grantToken}x`,
    ]) {
      assertInvalidGrant(
        await redeem(app, participant, event.publicId, { token: hostile }),
      );
    }

    // A failed attempt must not burn the grant.
    const admitted = await redeem(app, participant, event.publicId, {
      token: grantToken,
    });
    assert.equal(admitted.statusCode, 200);
    assert.deepEqual(JSON.parse(admitted.body), { ok: true });

    // The membership renders, and the page URL never carried the token.
    const page = await requestWithCookies(
      app,
      `/events/${event.publicId}?lang=en`,
      { cookie: jarCookie(participant) },
    );
    assert.match(page.body, /hosted-event-membership/);

    // The grant is single-use.
    assertInvalidGrant(
      await redeem(app, participant, event.publicId, { token: grantToken }),
    );

    // A different account cannot reuse the spent grant either.
    const secondParticipant = await signUpAndLogin(
      app,
      outboxDir,
      `p2-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    assertInvalidGrant(
      await redeem(app, secondParticipant, event.publicId, {
        token: grantToken,
      }),
    );
  } finally {
    await closeServer(app);
  }
});

test("a grant cannot outrun the lifecycle, the entry lock, or the event itself", async () => {
  const holder = { now: Date.now() };
  const { app, outboxDir } = await createClockServer(holder);
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    // A short opening offset keeps the 10-minute TTL exercisable: the grant
    // minted before the session opens must survive until just after it.
    const event = await approveEvent(app, ctx, holder.now, 5 * MINUTE);
    const credential = await createCredential(app, ctx);

    /**
     * @param {string} publicId
     * @param {string} [bearerToken]
     * @returns {Promise<string>}
     */
    async function mintGrant(publicId, bearerToken = credential.token) {
      const created = await api(
        app,
        `/api/v1/events/${publicId}/entry-grants`,
        {
          method: "POST",
          authorization: `Bearer ${bearerToken}`,
          jsonBody: "{}",
        },
      );
      assert.equal(created.statusCode, 201);
      return JSON.parse(created.body).entryGrant.entryGrantPath.split(
        "#entryGrant=",
      )[1];
    }

    const participant = await signUpAndLogin(
      app,
      outboxDir,
      `p-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );

    // Before the Board Session opens, redemption fails and stays unused.
    const beforeOpenToken = await mintGrant(event.publicId);
    assertInvalidGrant(
      await redeem(app, participant, event.publicId, {
        token: beforeOpenToken,
      }),
    );
    holder.now += 6 * MINUTE; // open the session, still inside the grant TTL
    assert.equal(
      (
        await redeem(app, participant, event.publicId, {
          token: beforeOpenToken,
        })
      ).statusCode,
      200,
      "the failed too-early attempt must not consume the grant",
    );

    // A grant minted for one event cannot be redeemed on another event's
    // page, even of the same organizer and even for an existing member.
    const laterEvent = await approveEvent(app, ctx, holder.now + 2 * DAY);
    const foreignGrant = await mintGrant(laterEvent.publicId);
    assertInvalidGrant(
      await redeem(app, participant, event.publicId, { token: foreignGrant }),
    );

    // The Entry Lock beats a valid grant for a non-member (an existing
    // member is not "new entry", so the lock does not apply to them).
    const lockParticipant = await signUpAndLogin(
      app,
      outboxDir,
      `lock-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    const lockedGrant = await mintGrant(event.publicId);
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
    assertInvalidGrant(
      await redeem(app, lockParticipant, event.publicId, {
        token: lockedGrant,
      }),
    );
    await requestWithCookies(
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
    assert.equal(
      (
        await redeem(app, lockParticipant, event.publicId, {
          token: lockedGrant,
        })
      ).statusCode,
      200,
      "unlocking restores the grant's usability",
    );

    // An expired grant fails deterministically even while the event runs.
    const expiring = await mintGrant(event.publicId);
    holder.now += 11 * MINUTE; // past the 10-minute TTL, still within the hour
    assertInvalidGrant(
      await redeem(app, participant, event.publicId, { token: expiring }),
    );

    // A revoked credential's outstanding grants die with it.
    const secondCredential = await createCredential(app, ctx);
    const orphaned = await mintGrant(event.publicId, secondCredential.token);
    await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/credentials/${secondCredential.credentialId}/revoke`,
      {
        method: "POST",
        cookie: jarCookie(ctx.owner),
        body: new URLSearchParams({ _csrf: csrf(ctx.owner) }).toString(),
      },
    );
    assertInvalidGrant(
      await redeem(app, participant, event.publicId, { token: orphaned }),
    );
  } finally {
    await closeServer(app);
  }
});

test("an existing member redeeming a grant keeps their membership and anonymity", async () => {
  const holder = { now: Date.now() };
  const { app, outboxDir } = await createClockServer(holder);
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, holder.now);
    const credential = await createCredential(app, ctx);

    const participant = await signUpAndLogin(
      app,
      outboxDir,
      `p-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    // Mint the shared Access Code and join as an anonymous member first.
    const minted = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/events/${event.eventId}/access-code`,
      {
        method: "POST",
        cookie: jarCookie(ctx.owner),
        body: new URLSearchParams({ _csrf: csrf(ctx.owner) }).toString(),
      },
    );
    const accessCode = /access-code-value">([^<]+)</.exec(minted.body)?.[1];
    assert.ok(accessCode);
    holder.now += DAY + MINUTE; // open the session
    const joined = await requestWithCookies(
      app,
      `/events/${event.publicId}/enter`,
      {
        method: "POST",
        cookie: jarCookie(participant),
        body: new URLSearchParams({
          _csrf: csrf(participant),
          accessCode,
          anonymity: "anonymous",
        }).toString(),
      },
    );
    assert.equal(joined.statusCode, 303);

    // Mint the grant only now, so the TTL stays valid within the session.
    const grant = await api(
      app,
      `/api/v1/events/${event.publicId}/entry-grants`,
      {
        method: "POST",
        authorization: `Bearer ${credential.token}`,
        jsonBody: "{}",
      },
    );
    const grantToken = JSON.parse(grant.body).entryGrant.entryGrantPath.split(
      "#entryGrant=",
    )[1];

    // Redeeming a grant as an existing member succeeds without touching the
    // membership: the anonymity choice still holds.
    const redeemed = await redeem(app, participant, event.publicId, {
      token: grantToken,
    });
    assert.equal(redeemed.statusCode, 200);
    const page = await requestWithCookies(
      app,
      `/events/${event.publicId}?lang=en`,
      { cookie: jarCookie(participant) },
    );
    assert.match(page.body, /hosted-event-membership/);
    assert.ok(
      !page.body.includes("/anonymity"),
      "an already-anonymous member sees no switch back to identified",
    );
  } finally {
    await closeServer(app);
  }
});

test("redemption is rate limited per account and per IP", async () => {
  const holder = { now: Date.now() };
  const { app, outboxDir } = await createClockServer(holder, {
    HOSTED_ENTRY_GRANT_ATTEMPTS_LIMIT: 2,
    HOSTED_ENTRY_GRANT_ATTEMPTS_WINDOW_MS: MINUTE,
  });
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, holder.now);
    const credential = await createCredential(app, ctx);
    const grant = await api(
      app,
      `/api/v1/events/${event.publicId}/entry-grants`,
      {
        method: "POST",
        authorization: `Bearer ${credential.token}`,
        jsonBody: "{}",
      },
    );
    const grantToken = JSON.parse(grant.body).entryGrant.entryGrantPath.split(
      "#entryGrant=",
    )[1];
    const participant = await signUpAndLogin(
      app,
      outboxDir,
      `p-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    holder.now += DAY + MINUTE;
    // Failed attempts consume the budget too.
    assertInvalidGrant(
      await redeem(app, participant, event.publicId, { token: "short" }),
    );
    assertInvalidGrant(
      await redeem(app, participant, event.publicId, { token: "nope" }),
    );
    const limited = await redeem(app, participant, event.publicId, {
      token: grantToken,
    });
    assert.equal(limited.statusCode, 429);
    assert.deepEqual(JSON.parse(limited.body), { error: "rate_limited" });
  } finally {
    await closeServer(app);
  }
});

test("a banned account cannot redeem a grant even while the event runs", async () => {
  const holder = { now: Date.now() };
  const dataDir = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "wbo-hosted-grants-")),
    "hosted-data",
  );
  const overrides = { HOSTED_DATA_DIR: dataDir };
  let { app } = await createClockServer(holder, overrides);
  let outboxDir = path.join(dataDir, "mail-outbox");
  let ctx;
  try {
    ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, holder.now);
    const credential = await createCredential(app, ctx);
    const participantEmail = `banned-${Date.now()}@example.com`;
    await signUpAndLogin(app, outboxDir, participantEmail, STRONG_PASSWORD);
    await closeServer(app);

    // Inject the Event Ban directly into the membership store's file: the
    // moderation routes arrive with issue 13, but the ban rule precedes the
    // grant today and must be provable now.
    const accounts = JSON.parse(
      await fs.readFile(path.join(dataDir, "accounts.json"), "utf8"),
    );
    const account = accounts.accounts.find(
      (/** @type {{email: string}} */ candidate) =>
        candidate.email === participantEmail,
    );
    assert.ok(account);
    const eventsFile = JSON.parse(
      await fs.readFile(path.join(dataDir, "events.json"), "utf8"),
    );
    const eventRecord = eventsFile.events.find(
      (/** @type {{publicId: string}} */ candidate) =>
        candidate.publicId === event.publicId,
    );
    assert.ok(eventRecord);
    await fs.writeFile(
      path.join(dataDir, "event_memberships.json"),
      JSON.stringify({
        version: 1,
        memberships: [],
        bans: [
          {
            eventId: eventRecord.eventId,
            accountId: account.accountId,
            createdAtMs: holder.now,
          },
        ],
      }),
    );

    // A second server over the same data directory sees the ban.
    holder.now += DAY + MINUTE;
    ({ app } = await createClockServer(holder, overrides));
    outboxDir = path.join(dataDir, "mail-outbox");
    const participant = await loginSession(
      app,
      participantEmail,
      STRONG_PASSWORD,
    );
    // Mint a fresh grant on the restarted server: the credential survived the
    // restart, so any failure below is the ban, not a lost credential.
    const grant = await api(
      app,
      `/api/v1/events/${event.publicId}/entry-grants`,
      {
        method: "POST",
        authorization: `Bearer ${credential.token}`,
        jsonBody: "{}",
      },
    );
    assert.equal(grant.statusCode, 201);
    const grantToken = JSON.parse(grant.body).entryGrant.entryGrantPath.split(
      "#entryGrant=",
    )[1];
    const response = await redeem(app, participant, event.publicId, {
      token: grantToken,
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(JSON.parse(response.body), {
      error: "entry_grant_invalid",
    });
    const page = await requestWithCookies(
      app,
      `/events/${event.publicId}?lang=en`,
      { cookie: jarCookie(participant) },
    );
    assert.doesNotMatch(page.body, /hosted-event-membership/);
  } finally {
    await closeServer(app);
  }
});
