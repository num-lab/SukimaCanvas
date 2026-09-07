const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");

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

/** A real, CRC-correct 1x1 PNG (exercises the decoder, not just the magic). */
function makeValidPng() {
  /**
   * @param {string} type
   * @param {Buffer} data
   * @returns {Buffer}
   */
  const chunk = (type, data) => {
    const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
    let crc = 0xffffffff;
    for (const byte of typeAndData) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) {
        crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }
    }
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([length, typeAndData, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Builds a multipart/form-data body with one file part and any text fields.
 *
 * @param {string} boundary
 * @param {{[name: string]: string}} fields
 * @param {{name: string, filename: string, contentType: string, bytes: Buffer}} file
 * @returns {Buffer}
 */
function multipartBody(boundary, fields, file) {
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
  );
  parts.push(file.bytes);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

/**
 * @param {import("http").Server} app
 * @param {{sessionCookie: string, csrfCookie: string}} jar
 * @param {string} pathname
 * @param {{[name: string]: string}} fields
 * @param {{name: string, filename: string, contentType: string, bytes: Buffer}} file
 */
function uploadCover(app, jar, pathname, fields, file) {
  const boundary = "----wbotestboundaryXYZ";
  const body = multipartBody(boundary, { _csrf: csrf(jar), ...fields }, file);
  return requestWithCookies(app, pathname, {
    method: "POST",
    cookie: jarCookie(jar),
    body,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
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
 * Drafts, submits, and approves one reservation, returning the reservation id,
 * event id, and unguessable public id of the minted event.
 *
 * @param {import("http").Server} app
 * @param {{operator: any, owner: any, organizerId: string}} ctx
 * @param {{eventName: string, visibility: "public" | "unlisted", seats?: number, startOffset?: number}} fields
 */
async function approveEvent(app, ctx, fields) {
  const { operator, owner, organizerId } = ctx;
  const start = Date.now() + (fields.startOffset ?? DAY);
  const created = await requestWithCookies(
    app,
    `/organizers/${organizerId}/reservations?lang=en`,
    {
      method: "POST",
      cookie: jarCookie(owner),
      body: new URLSearchParams({
        _csrf: csrf(owner),
        eventName: fields.eventName,
        startsAt: dtLocal(start),
        endsAt: dtLocal(start + HOUR),
        requestedSeats: String(fields.seats ?? 30),
        visibility: fields.visibility,
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

test("the home page lists public events and hides unlisted ones", async () => {
  const { app, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
  });
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const shown = await approveEvent(app, ctx, {
      eventName: "Public Launch Jam",
      visibility: "public",
    });
    const hidden = await approveEvent(app, ctx, {
      eventName: "Private Rehearsal",
      visibility: "unlisted",
    });

    const home = await requestWithCookies(app, "/?lang=en");
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /Public Launch Jam/);
    assert.doesNotMatch(home.body, /Private Rehearsal/);
    // The public event links to its Public ID, never an internal id.
    assert.match(home.body, new RegExp(`events/${shown.publicId}`));
    assert.doesNotMatch(home.body, new RegExp(`events/${hidden.publicId}`));

    // The unlisted event is still reachable directly by its Public ID.
    const direct = await requestWithCookies(
      app,
      `/events/${hidden.publicId}?lang=en`,
    );
    assert.equal(direct.statusCode, 200);
    assert.match(direct.body, /Private Rehearsal/);

    // An unknown Public ID is a plain 404 and confirms nothing.
    const unknown = await requestWithCookies(app, "/events/deadbeefdeadbeef");
    assert.equal(unknown.statusCode, 404);
  } finally {
    await closeServer(app);
  }
});

test("the event page hides capacity, participant, and admin data", async () => {
  const { app, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
  });
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, {
      eventName: "Careful Event",
      visibility: "public",
      seats: 37,
    });
    const page = await requestWithCookies(
      app,
      `/events/${event.publicId}?lang=en`,
    );
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Careful Event/);
    assert.match(page.body, /Aurora Collective/); // organizer display name
    // No capacity, seat counts, participant lists, or admin emails leak here.
    // The seat count is checked after masking the displayed timestamps, whose
    // minute field would otherwise collide with a two-digit seat number.
    const withoutTimes = page.body.replace(
      /\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC[^)]*\)/g,
      "",
    );
    assert.doesNotMatch(withoutTimes, /\b37\b/);
    assert.doesNotMatch(page.body, /seat/i);
    assert.doesNotMatch(page.body, /capacity/i);
    assert.doesNotMatch(page.body, /owner-/);
    assert.doesNotMatch(page.body, /operator@example\.com/);
  } finally {
    await closeServer(app);
  }
});

test("owners toggle visibility; non-members and signed-out visitors cannot", async () => {
  const { app, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
  });
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, {
      eventName: "Rehearsal To Publish",
      visibility: "unlisted",
    });
    const managePath = `/organizers/${ctx.organizerId}/events/${event.eventId}`;

    // A non-member cannot even see the management page.
    const stranger = await signUpAndLogin(
      app,
      outboxDir,
      `stranger-${Date.now()}@example.com`,
      STRONG_PASSWORD,
    );
    const strangerView = await requestWithCookies(app, managePath, {
      cookie: jarCookie(stranger),
    });
    assert.equal(strangerView.statusCode, 404);

    // A signed-out visitor is redirected to login.
    const signedOut = await requestWithCookies(app, managePath);
    assert.equal(signedOut.statusCode, 303);
    assert.equal(signedOut.headers.location, "/login");

    // The owner flips the event to public with a tagline.
    const updated = await requestWithCookies(app, managePath, {
      method: "POST",
      cookie: jarCookie(ctx.owner),
      body: new URLSearchParams({
        _csrf: csrf(ctx.owner),
        visibility: "public",
        tagline: "Now open to everyone.",
      }).toString(),
    });
    assert.equal(updated.statusCode, 303);

    const home = await requestWithCookies(app, "/?lang=en");
    assert.match(home.body, /Rehearsal To Publish/);
    assert.match(home.body, /Now open to everyone\./);
  } finally {
    await closeServer(app);
  }
});

test("a hostile cover upload is rejected but a real image is stored and served", async () => {
  const { app, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
  });
  try {
    const ctx = await provisionOrganizer(app, outboxDir);
    const event = await approveEvent(app, ctx, {
      eventName: "Branded Event",
      visibility: "public",
    });
    const coverPath = `/organizers/${ctx.organizerId}/events/${event.eventId}/cover`;

    // An SVG that lies about its content type is rejected on decode.
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      "utf8",
    );
    const svgUpload = await uploadCover(
      app,
      ctx.owner,
      coverPath,
      {},
      {
        name: "cover",
        filename: "logo.png",
        contentType: "image/png",
        bytes: svg,
      },
    );
    assert.equal(svgUpload.statusCode, 400);

    // An oversized-but-well-formed-looking file is rejected too.
    const oversize = Buffer.alloc(5 * 1024 * 1024 + 1);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(
      oversize,
    );
    const bigUpload = await uploadCover(
      app,
      ctx.owner,
      coverPath,
      {},
      {
        name: "cover",
        filename: "huge.png",
        contentType: "image/png",
        bytes: oversize,
      },
    );
    assert.ok(
      bigUpload.statusCode === 400 || bigUpload.statusCode === 413,
      "an oversized upload is rejected",
    );

    // A genuine PNG is accepted.
    const goodUpload = await uploadCover(
      app,
      ctx.owner,
      coverPath,
      {},
      {
        name: "cover",
        filename: "logo.png",
        contentType: "image/png",
        bytes: makeValidPng(),
      },
    );
    assert.equal(goodUpload.statusCode, 303);

    // The management page now references the stored cover via /assets/<id>.
    const manage = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/events/${event.eventId}?lang=en`,
      { cookie: jarCookie(ctx.owner) },
    );
    const assetId = /assets\/([A-Za-z0-9_-]+)/.exec(manage.body)?.[1];
    assert.ok(assetId, "a stored cover asset id must be shown");

    // The controlled read path serves the bytes as an image, never as a page.
    const asset = await requestWithCookies(app, `/assets/${assetId}`);
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.headers["content-type"], "image/png");
    assert.equal(asset.headers["x-content-type-options"], "nosniff");
    assert.match(
      String(asset.headers["content-security-policy"]),
      /default-src 'none'/,
    );

    // The public event page and home card show the cover.
    const page = await requestWithCookies(
      app,
      `/events/${event.publicId}?lang=en`,
    );
    assert.match(page.body, new RegExp(`assets/${assetId}`));

    // An unknown asset id is a plain 404.
    const missing = await requestWithCookies(app, "/assets/nope-nope-nope");
    assert.equal(missing.statusCode, 404);

    // Replacing the cover retires the old asset: the superseded id stops
    // serving, while the new one is served.
    const replaceUpload = await uploadCover(
      app,
      ctx.owner,
      coverPath,
      {},
      {
        name: "cover",
        filename: "logo2.png",
        contentType: "image/png",
        bytes: makeValidPng(),
      },
    );
    assert.equal(replaceUpload.statusCode, 303);
    const manage2 = await requestWithCookies(
      app,
      `/organizers/${ctx.organizerId}/events/${event.eventId}?lang=en`,
      { cookie: jarCookie(ctx.owner) },
    );
    const newAssetId = /assets\/([A-Za-z0-9_-]+)/.exec(manage2.body)?.[1];
    assert.ok(newAssetId && newAssetId !== assetId);
    assert.equal(
      (await requestWithCookies(app, `/assets/${assetId}`)).statusCode,
      404,
    );
    assert.equal(
      (await requestWithCookies(app, `/assets/${newAssetId}`)).statusCode,
      200,
    );
  } finally {
    await closeServer(app);
  }
});
