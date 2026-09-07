const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
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
  createFileEventMembershipStore,
} = require("../server/hosted_event/memberships/store.mjs");
const {
  createFileBoardArchiveStore,
} = require("../server/hosted_event/archive/store.mjs");
const {
  createParticipantIdentifierResolver,
} = require("../server/hosted_event/attribution.mjs");
const {
  createDefaultStoredSvgEnvelope,
  serializeStoredSvgEnvelope,
} = require("../server/persistence/svg_envelope.mjs");
const { closeServer } = require("./test_helpers.js");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const RETENTION_MS = 90 * DAY;
const DELETE_WINDOW_MS = 7 * DAY;

const participantIdentifierFor =
  createParticipantIdentifierResolver("hosted-test-secret");

/**
 * A stored canvas item carrying the server-stamped Participant Identifier,
 * like the close pipeline archives them.
 * @param {string} participantId
 */
const attributedItem = (participantId) =>
  `<rect id="r1" x="120" y="80" width="120" height="80" stroke="#1f2937" ` +
  `stroke-width="10" fill="none" opacity="0.85" ` +
  `data-wbo-created-by="${participantId}"></rect>`;

/**
 * Boots the hosted server with a controllable clock and the outcome-retention
 * windows the routes consume.
 * @param {{now: number}} holder
 */
async function createOutcomeServer(holder) {
  return createHostedServer({
    HOSTED_CLOCK: () => holder.now,
    HOSTED_OUTCOME_RETENTION_MS: RETENTION_MS,
    HOSTED_OUTCOME_DELETE_WINDOW_MS: DELETE_WINDOW_MS,
    // The tests jump the service clock across days; sessions must outlive
    // the jumps so the sign-in itself is not what is being tested.
    HOSTED_SESSION_MAX_AGE_MS: 400 * DAY,
    HOSTED_SESSION_IDLE_TIMEOUT_MS: 400 * DAY,
  });
}

/**
 * Seeds an organizer owned by a freshly registered account, plus an event
 * whose Board Session is sealed behind a real Private Board Archive with one
 * attributed item — exactly the state the close pipeline leaves behind.
 * @param {{app: any, root: string, outboxDir: string, hostedEventModule: any}} server
 * @param {{now: number}} holder
 * @param {{eventName: string, creatorAccountId?: string}} options
 */
async function seedArchivedOutcome(server, holder, options) {
  const clock = () => holder.now;
  const dataDir = path.join(server.root, "hosted-data");
  const ownerEmail = `${options.eventName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")}@example.com`;
  await registerAccount(server.app, ownerEmail, STRONG_PASSWORD);
  await verifyAccount(server.app, server.outboxDir, ownerEmail);
  const owner = await loginSession(server.app, ownerEmail, STRONG_PASSWORD);
  const accountStore = createFileAccountStore({
    dataDir,
    clock,
    sessionMaxAgeMs: DAY,
    sessionIdleMs: DAY,
  });
  const ownerAccount = accountStore.getAccountByEmail(ownerEmail);
  assert.ok(ownerAccount);
  const organizerStore = createFileOrganizerStore({ dataDir, clock });
  const application = await organizerStore.submitApplication({
    accountId: ownerAccount.accountId,
    organizerName: "Outcome Collective",
    contactName: "Mika Rin",
    contactEmail: ownerEmail,
  });
  assert.ok(application.ok);
  const approved = await organizerStore.approveApplication({
    applicationId: application.application.applicationId,
    operatorAccountId: "seed-operator",
  });
  assert.ok(approved.ok);
  const organizerId = /** @type {string} */ (approved.organizerId);
  const created = await organizerStore.createReservation({
    organizerId,
    createdByAccountId: ownerAccount.accountId,
    eventName: options.eventName,
    visibility: "unlisted",
    startsAtMs: holder.now + HOUR,
    endsAtMs: holder.now + 2 * HOUR,
    requestedSeats: 2,
  });
  assert.ok(created.ok);
  await organizerStore.submitReservation({
    reservationId: created.reservation.reservationId,
    actorAccountId: ownerAccount.accountId,
    now: holder.now,
  });
  const approvedReservation = await organizerStore.approveReservation({
    reservationId: created.reservation.reservationId,
    operatorAccountId: "seed-operator",
    now: holder.now,
    bufferMs: 15 * MINUTE,
    sessionLimit: 20,
    seatLimit: 1000,
  });
  assert.ok(approvedReservation.ok);
  const event = organizerStore.getEventById(
    /** @type {string} */ (approvedReservation.eventId),
  );
  assert.ok(event);
  const boardSession = organizerStore.getBoardSessionForEvent(event.eventId);
  assert.ok(boardSession);

  const creatorId = options.creatorAccountId || ownerAccount.accountId;
  const participantId = participantIdentifierFor(event.eventId, creatorId);
  await organizerStore.advanceLifecycle({ now: boardSession.startsAtMs });
  await organizerStore.advanceLifecycle({
    now: boardSession.endsAtMs + MINUTE,
  });
  const archiveStore = createFileBoardArchiveStore({ dataDir });
  const envelope = createDefaultStoredSvgEnvelope({ readonly: false }, 1);
  const canvas = serializeStoredSvgEnvelope(
    envelope.prefix,
    [attributedItem(participantId)],
    envelope.suffix,
  );
  const manifest = {
    format: "sukimacanvas-board-archive-v1",
    boardSessionId: boardSession.boardSessionId,
    eventId: event.eventId,
    organizerId,
    finalSeq: 1,
    itemCount: 1,
    acceptedMutationCount: 1,
    integrity: {
      "canvas.svg": crypto.createHash("sha256").update(canvas).digest("hex"),
      "ledger.jsonl": crypto.createHash("sha256").update("").digest("hex"),
    },
  };
  await archiveStore.putArchive(
    `board-archives/${boardSession.boardSessionId}/canvas.svg`,
    canvas,
  );
  await archiveStore.putArchive(
    `board-archives/${boardSession.boardSessionId}/manifest.json`,
    JSON.stringify(manifest),
  );
  const sealed = await organizerStore.markBoardSessionClosed({
    boardSessionId: boardSession.boardSessionId,
    archiveKey: `board-archives/${boardSession.boardSessionId}/manifest.json`,
    finalSeq: 1,
    archivedAtMs: holder.now,
  });
  assert.ok(sealed.ok);
  await organizerStore.flush();

  return {
    owner,
    ownerEmail,
    ownerAccountId: ownerAccount.accountId,
    participantId,
    organizerId,
    event,
    boardSession,
    dataDir,
    accountStore,
    organizerStore,
    archiveStore,
  };
}

/**
 * Requests the console page and returns its CSRF token and cookie pair.
 * @param {any} server
 * @param {{sessionCookie: string}} session
 * @param {string} organizerId
 * @param {string} eventId
 */
async function consoleSecurity(server, session, organizerId, eventId) {
  const page = await requestWithCookies(
    server.app,
    `/organizers/${organizerId}/events/${eventId}?lang=en`,
    { cookie: session.sessionCookie },
  );
  assert.equal(page.statusCode, 200);
  return {
    page,
    csrfToken: formValue(page.body, "_csrf"),
    cookies: `${session.sessionCookie}; ${cookiePair(page.setCookie, "hosted-csrf-v1")}`,
  };
}

test("early deletion immediately invalidates the published canvas and every export download link, and restore brings them back unchanged", async () => {
  const holder = { now: Date.now() };
  const server = await createOutcomeServer(holder);
  try {
    const seeded = await seedArchivedOutcome(server, holder, {
      eventName: "Restore Jam",
    });
    const { owner, organizerId, event, boardSession } = seeded;
    const consoleSecurityState = await consoleSecurity(
      server,
      owner,
      organizerId,
      event.eventId,
    );
    const { csrfToken, cookies } = consoleSecurityState;

    // Publish the canvas (organizer audience) and produce one export with a
    // live download link.
    const published = await requestWithCookies(
      server.app,
      `/organizers/${organizerId}/events/${event.eventId}/publication`,
      {
        method: "POST",
        cookie: cookies,
        body: new URLSearchParams({
          _csrf: csrfToken,
          audience: "organizer",
          showAttribution: "1",
        }).toString(),
      },
    );
    assert.equal(published.statusCode, 200);
    const canvasPath = `/events/${event.publicId}/canvas`;
    const canvasBefore = await requestWithCookies(server.app, canvasPath, {
      cookie: owner.sessionCookie,
    });
    assert.equal(canvasBefore.statusCode, 200);

    const requested = await requestWithCookies(
      server.app,
      `/organizers/${organizerId}/events/${event.eventId}/exports`,
      {
        method: "POST",
        cookie: cookies,
        body: `_csrf=${csrfToken}`,
      },
    );
    assert.equal(requested.statusCode, 303);
    let readyPage = null;
    for (let attempt = 0; attempt < 100 && readyPage === null; attempt += 1) {
      await server.hostedEventModule.refreshEventLifecycle();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const candidate = await requestWithCookies(
        server.app,
        `/organizers/${organizerId}/events/${event.eventId}?lang=en`,
        { cookie: owner.sessionCookie },
      );
      if (candidate.statusCode === 200 && candidate.body.includes("Ready")) {
        readyPage = candidate;
      }
    }
    assert.ok(readyPage, "the export job reached its success state");
    const linkMatch =
      /href="(organizers\/[^"]+\/exports\/[^"]+\/download\?[^"]+)"/.exec(
        readyPage.body,
      );
    assert.ok(linkMatch, "the console renders the download link");
    const downloadPath =
      `/${/** @type {RegExpExecArray} */ (linkMatch)[1] ?? ""}`
        .replace(/&#x3D;/g, "=")
        .replace(/&amp;/g, "&");
    const download = await requestWithCookies(server.app, downloadPath, {
      cookie: owner.sessionCookie,
      binary: true,
    });
    assert.equal(download.statusCode, 200);

    // --- the deletion request -------------------------------------------
    const requestedDeletion = await requestWithCookies(
      server.app,
      `/organizers/${organizerId}/events/${event.eventId}/outcomes/delete`,
      {
        method: "POST",
        cookie: cookies,
        body: `_csrf=${csrfToken}`,
      },
    );
    assert.equal(requestedDeletion.statusCode, 200);
    assert.ok(
      requestedDeletion.body.includes("Deletion requested."),
      "the console confirms the deletion request",
    );
    assert.ok(
      requestedDeletion.body.includes("Restore deletion"),
      "the console offers the restore action",
    );

    // The published canvas and the download link die immediately, although
    // nothing was physically deleted yet.
    const canvasWhilePending = await requestWithCookies(
      server.app,
      canvasPath,
      { cookie: owner.sessionCookie },
    );
    assert.equal(
      canvasWhilePending.statusCode,
      404,
      "the published canvas stops working immediately",
    );
    const downloadWhilePending = await requestWithCookies(
      server.app,
      downloadPath,
      { cookie: owner.sessionCookie, binary: true },
    );
    assert.equal(
      downloadWhilePending.statusCode,
      404,
      "the export download stops working immediately",
    );

    // New publications and new exports are refused while the window runs.
    const publishWhilePending = await requestWithCookies(
      server.app,
      `/organizers/${organizerId}/events/${event.eventId}/publication`,
      {
        method: "POST",
        cookie: cookies,
        body: new URLSearchParams({
          _csrf: csrfToken,
          audience: "organizer",
        }).toString(),
      },
    );
    assert.equal(publishWhilePending.statusCode, 409);
    const exportWhilePending = await requestWithCookies(
      server.app,
      `/organizers/${organizerId}/events/${event.eventId}/exports`,
      {
        method: "POST",
        cookie: cookies,
        body: `_csrf=${csrfToken}`,
      },
    );
    assert.equal(exportWhilePending.statusCode, 409);

    // --- restore ----------------------------------------------------------
    const restored = await requestWithCookies(
      server.app,
      `/organizers/${organizerId}/events/${event.eventId}/outcomes/restore`,
      {
        method: "POST",
        cookie: cookies,
        body: `_csrf=${csrfToken}`,
      },
    );
    assert.equal(restored.statusCode, 200);
    assert.ok(
      restored.body.includes("Deletion restored."),
      "the console confirms the restore",
    );
    const canvasAfter = await requestWithCookies(server.app, canvasPath, {
      cookie: owner.sessionCookie,
    });
    assert.equal(
      canvasAfter.statusCode,
      200,
      "the published canvas works again after restore",
    );
    const downloadAfter = await requestWithCookies(server.app, downloadPath, {
      cookie: owner.sessionCookie,
      binary: true,
    });
    assert.equal(
      downloadAfter.statusCode,
      200,
      "the export download works again after restore",
    );
    assert.equal(downloadAfter.body, download.body, "the bytes are unchanged");
    const archiveObjects = await seeded.archiveStore.listObjectKeys(
      `board-archives/${boardSession.boardSessionId}`,
    );
    assert.ok(
      archiveObjects.length > 0,
      "the archive objects were never deleted",
    );
  } finally {
    await closeServer(server.app);
  }
});

test("after the recoverable window the purge removes archive, attribution, audit, publication, and exports, idempotently", async () => {
  const holder = { now: Date.now() };
  const server = await createOutcomeServer(holder);
  try {
    const seeded = await seedArchivedOutcome(server, holder, {
      eventName: "Purge Jam",
    });
    const { owner, organizerId, event, boardSession } = seeded;
    const security = await consoleSecurity(
      server,
      owner,
      organizerId,
      event.eventId,
    );
    const { csrfToken, cookies } = security;

    const requested = await requestWithCookies(
      server.app,
      `/organizers/${organizerId}/events/${event.eventId}/outcomes/delete`,
      {
        method: "POST",
        cookie: cookies,
        body: `_csrf=${csrfToken}`,
      },
    );
    assert.equal(requested.statusCode, 200);

    // Inside the window the purge is not due: the console still shows the
    // pending state.
    holder.now += DAY;
    const pendingPage = await requestWithCookies(
      server.app,
      `/organizers/${organizerId}/events/${event.eventId}?lang=en`,
      { cookie: owner.sessionCookie },
    );
    assert.equal(pendingPage.statusCode, 200);
    assert.ok(pendingPage.body.includes("Restore deletion"));

    // After the window elapses the next lifecycle pass — triggered by the
    // console render itself — purges the outcomes.
    holder.now = holder.now + 6 * DAY + MINUTE;
    const purgedPage = await requestWithCookies(
      server.app,
      `/organizers/${organizerId}/events/${event.eventId}?lang=en`,
      { cookie: owner.sessionCookie },
    );
    assert.equal(purgedPage.statusCode, 200);
    assert.ok(
      purgedPage.body.includes("were purged"),
      "the console reports the purge",
    );
    assert.equal(
      await seeded.archiveStore.readArchive(
        `board-archives/${boardSession.boardSessionId}/canvas.svg`,
      ),
      null,
      "the archived canvas is gone",
    );
    assert.deepEqual(
      await seeded.archiveStore.listObjectKeys(
        `board-archives/${boardSession.boardSessionId}`,
      ),
      [],
    );
    // The purge mutated the server's in-memory store and persisted; verify
    // the durable state through a freshly loaded instance.
    const durableStore = createFileOrganizerStore({
      dataDir: seeded.dataDir,
      clock: () => holder.now,
    });
    const purgedSession = durableStore.getBoardSessionById(
      boardSession.boardSessionId,
    );
    assert.ok(purgedSession);
    assert.equal(purgedSession.archiveKey, null);
    assert.equal(purgedSession.outcomesPurgedAtMs, holder.now);
    const eventRecord = durableStore.getEventById(event.eventId);
    assert.ok(eventRecord && eventRecord.outcomeDeletion);
    assert.equal(eventRecord.outcomeDeletion.purgedAtMs, holder.now);
    await assert.rejects(() =>
      fs.access(
        path.join(
          seeded.dataDir,
          "mutation-ledger",
          `${event.boardName}.jsonl`,
        ),
      ),
    );

    // Repeated passes are idempotent: a second console render succeeds and
    // does nothing.
    const againPage = await requestWithCookies(
      server.app,
      `/organizers/${organizerId}/events/${event.eventId}?lang=en`,
      { cookie: owner.sessionCookie },
    );
    assert.equal(againPage.statusCode, 200);
    assert.ok(againPage.body.includes("were purged"));

    // Isolation: a second event's outcomes are untouched by the purge above.
    const other = await seedArchivedOutcome(server, holder, {
      eventName: "Purge Keeper",
    });
    const otherSession = other.boardSession;
    assert.ok(
      await other.archiveStore.readArchive(
        `board-archives/${otherSession.boardSessionId}/canvas.svg`,
      ),
      "another event's archive survives",
    );
    const otherSessionRecord = other.organizerStore.getBoardSessionById(
      otherSession.boardSessionId,
    ); // seeded fresh, holds its own live state
    assert.ok(otherSessionRecord);
    assert.equal(
      otherSessionRecord.archiveKey,
      `board-archives/${otherSession.boardSessionId}/manifest.json`,
    );
    assert.equal(otherSessionRecord.outcomesPurgedAtMs, null);
  } finally {
    await closeServer(server.app);
  }
});

test("the retention deadline purges automatically from server-authoritative time", async () => {
  const holder = { now: Date.now() };
  const server = await createOutcomeServer(holder);
  try {
    const seeded = await seedArchivedOutcome(server, holder, {
      eventName: "Expiry Jam",
    });
    const { owner, organizerId, event, boardSession } = seeded;
    await fs.mkdir(path.join(seeded.dataDir, "mutation-ledger"), {
      recursive: true,
    });
    const ledgerPath = path.join(
      seeded.dataDir,
      "mutation-ledger",
      `${event.boardName}.jsonl`,
    );
    await fs.writeFile(
      ledgerPath,
      `${JSON.stringify({
        seq: 1,
        acceptedAtMs: holder.now,
        eventId: event.eventId,
        boardSessionId: boardSession.boardSessionId,
        accountId: seeded.ownerAccountId,
        mutation: { tool: 3, type: 1, id: "r1", clientMutationId: "cm-x" },
      })}\n`,
      "utf8",
    );

    // The console shows the retention deadline computed from the server clock.
    const beforePage = await requestWithCookies(
      server.app,
      `/organizers/${organizerId}/events/${event.eventId}?lang=en`,
      { cookie: owner.sessionCookie },
    );
    assert.ok(beforePage.body.includes("days remaining"));

    // Jump past the 90-day retention: the next console render purges.
    holder.now += RETENTION_MS + MINUTE;
    const afterPage = await requestWithCookies(
      server.app,
      `/organizers/${organizerId}/events/${event.eventId}?lang=en`,
      { cookie: owner.sessionCookie },
    );
    assert.equal(afterPage.statusCode, 200);
    assert.ok(afterPage.body.includes("were purged"));
    const durableStore = createFileOrganizerStore({
      dataDir: seeded.dataDir,
      clock: () => holder.now,
    });
    const purgedSession = durableStore.getBoardSessionById(
      boardSession.boardSessionId,
    );
    assert.ok(purgedSession);
    assert.equal(purgedSession.archiveKey, null);
    assert.ok(purgedSession.outcomesPurgedAtMs !== null);
    await assert.rejects(() => fs.access(ledgerPath));
    const audit = durableStore.listAuditForEvent(event.eventId, {
      limit: 100,
    });
    assert.ok(audit.some((record) => record.action === "event_outcome.purged"));
  } finally {
    await closeServer(server.app);
  }
});

test("the audit page is an Owner/Admin-only view of attribution and change audit", async () => {
  const holder = { now: Date.now() };
  const server = await createOutcomeServer(holder);
  try {
    const seeded = await seedArchivedOutcome(server, holder, {
      eventName: "Audit Jam",
    });
    const { owner, organizerId, event, boardSession, organizerStore, dataDir } =
      seeded;
    const auditPath = `/organizers/${organizerId}/events/${event.eventId}/audit?lang=en`;

    // Seed the durable mutation ledger with one accepted creation by the
    // owner — the Change Audit the audit page must surface.
    await fs.mkdir(path.join(dataDir, "mutation-ledger"), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "mutation-ledger", `${event.boardName}.jsonl`),
      `${JSON.stringify({
        seq: 1,
        acceptedAtMs: holder.now,
        eventId: event.eventId,
        boardSessionId: boardSession.boardSessionId,
        accountId: seeded.ownerAccountId,
        mutation: { tool: 3, type: 1, id: "r1", clientMutationId: "cm-a" },
      })}\n`,
      "utf8",
    );

    // Signed-out visitors go to login.
    const anonymous = await requestWithCookies(server.app, auditPath);
    assert.equal(anonymous.statusCode, 303);

    const ownerPage = await requestWithCookies(server.app, auditPath, {
      cookie: owner.sessionCookie,
    });
    assert.equal(ownerPage.statusCode, 200);
    assert.ok(ownerPage.body.includes("Board Item Attribution"));
    assert.ok(
      ownerPage.body.includes(seeded.participantId),
      "the archived item's participant identifier is listed",
    );
    assert.ok(ownerPage.body.includes("Change Audit"));
    assert.ok(
      ownerPage.body.includes("Create"),
      "the accepted mutation type is labeled",
    );
    assert.ok(
      !ownerPage.body.includes(seeded.ownerAccountId),
      "internal Account ids never render",
    );
    // The board-write history (attribution + Change Audit) is pseudonymous —
    // only the Administrative activity section resolves Owner/Admin emails,
    // matching the member list's existing Owner/Admin-only visibility. (The
    // page header's account chip shows the signed-in user's own email; the
    // section-scoped checks below exclude it.)
    const changeSection =
      ownerPage.body
        .split("Change Audit")[1]
        ?.split("Administrative activity")[0] || "";
    assert.ok(
      !changeSection.includes("audit-jam@example.com"),
      "the Change Audit carries no account email",
    );
    assert.ok(
      changeSection.includes(seeded.participantId),
      "the Change Audit projects the creator to a participant identifier",
    );
    assert.ok(
      ownerPage.body.includes("Reservation created"),
      "the administrative activity lists the seeded actions",
    );
    assert.ok(ownerPage.body.includes("days remaining"), "retention shows");
    assert.ok(ownerPage.body.includes("Administrative activity"));

    // A signed-in non-member gets the uniform 404.
    const outsiderEmail = "audit-outsider@example.com";
    await registerAccount(server.app, outsiderEmail, STRONG_PASSWORD);
    await verifyAccount(server.app, server.outboxDir, outsiderEmail);
    const outsider = await loginSession(
      server.app,
      outsiderEmail,
      STRONG_PASSWORD,
    );
    const outsiderPage = await requestWithCookies(server.app, auditPath, {
      cookie: outsider.sessionCookie,
    });
    assert.equal(outsiderPage.statusCode, 404);

    // An Event Moderator — realtime governance only — also gets the 404.
    const moderatorAccountStore = createFileAccountStore({
      dataDir,
      clock: () => holder.now,
      sessionMaxAgeMs: DAY,
      sessionIdleMs: DAY,
    });
    const moderatorAccount = moderatorAccountStore.getAccountByEmail(
      "audit-outsider@example.com",
    );
    assert.ok(moderatorAccount);
    await organizerStore.grantEventModerator({
      eventId: event.eventId,
      organizerId,
      targetAccountId: moderatorAccount.accountId,
      actorAccountId: seeded.ownerAccountId,
    });
    const moderatorPage = await requestWithCookies(server.app, auditPath, {
      cookie: outsider.sessionCookie,
    });
    assert.equal(
      moderatorPage.statusCode,
      404,
      "an Event Moderator is not an organizer member",
    );

    // A plain event member sees no audit either.
    const membershipStore = createFileEventMembershipStore({
      dataDir,
      clock: () => holder.now,
    });
    const memberAccountStore = createFileAccountStore({
      dataDir,
      clock: () => holder.now,
    });
    const member = await memberAccountStore.createAccount({
      email: "audit-member@example.com",
      passwordHash: "x",
    });
    await membershipStore.admit({
      eventId: event.eventId,
      accountId: member.accountId,
      anonymity: "identified",
    });
    await registerAccount(
      server.app,
      "audit-member@example.com",
      STRONG_PASSWORD,
    );
    await verifyAccount(
      server.app,
      server.outboxDir,
      "audit-member@example.com",
    );
    const memberSession = await loginSession(
      server.app,
      "audit-member@example.com",
      STRONG_PASSWORD,
    );
    const memberPage = await requestWithCookies(server.app, auditPath, {
      cookie: memberSession.sessionCookie,
    });
    assert.equal(memberPage.statusCode, 404);

    // The deletion request route is equally member-gated.
    const memberDelete = await requestWithCookies(
      server.app,
      `/organizers/${organizerId}/events/${event.eventId}/outcomes/delete`,
      { method: "POST", cookie: memberSession.sessionCookie, body: "_csrf=x" },
    );
    assert.equal(memberDelete.statusCode, 404);
  } finally {
    await closeServer(server.app);
  }
});
