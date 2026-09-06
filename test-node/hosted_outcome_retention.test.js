const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const { createFixture } = require("./helpers/hosted_board_fixture.js");
const {
  createFilePublicationStore,
} = require("../server/hosted_event/publication/store.mjs");
const {
  createFileBoardExportStore,
} = require("../server/hosted_event/export/store.mjs");
const {
  createOutcomeRetentionPipeline,
} = require("../server/hosted_event/outcomes.mjs");
const {
  createBoardExportPipeline,
} = require("../server/hosted_event/export/pipeline.mjs");
const {
  createDefaultStoredSvgEnvelope,
  serializeStoredSvgEnvelope,
} = require("../server/persistence/svg_envelope.mjs");
const {
  createFileBoardArchiveStore,
} = require("../server/hosted_event/archive/store.mjs");
const {
  deleteBoardMutationLedgerFile,
} = require("../server/hosted_event/ledger/store.mjs");

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

const RETENTION_MS = 90 * DAY;
const DELETE_WINDOW_MS = 7 * DAY;
const PURGE_RETRY_MS = 15 * MINUTE;

/**
 * Composes the outcome-retention surface on top of the shared board fixture:
 * publication store, export store, and the retention pipeline, all against
 * the fixture's controllable clock.
 *
 * @param {number} now
 */
async function createOutcomeFixture(now) {
  const fixture = await createFixture(now);
  const publicationStore = createFilePublicationStore({
    dataDir: fixture.dataDir,
    clock: () => fixture.holder.now,
    archiveStore: fixture.archiveStore,
  });
  const exportStore = createFileBoardExportStore({
    dataDir: fixture.dataDir,
    clock: () => fixture.holder.now,
    linkTtlMs: DAY,
    hmacKey: "outcome-test-secret",
  });
  const outcomePipeline = createOutcomeRetentionPipeline({
    organizerStore: fixture.organizerStore,
    archiveStore: fixture.archiveStore,
    publicationStore,
    exportStore,
    config: {
      ...require("../server/configuration.mjs"),
      HOSTED_DATA_DIR: fixture.dataDir,
      HOSTED_OUTCOME_RETENTION_MS: RETENTION_MS,
      HOSTED_OUTCOME_PURGE_RETRY_MS: PURGE_RETRY_MS,
    },
    clock: () => fixture.holder.now,
  });
  return { ...fixture, publicationStore, exportStore, outcomePipeline };
}

/**
 * Drives the fixture's Board Session through the durable lifecycle to
 * `closing` and seals it with a real archive object, a stored publication,
 * and a succeeded export — the full outcome surface a purge must clear.
 */
/**
 * @param {any} fixture
 */
async function sealWithOutcomes(fixture) {
  const {
    organizerStore,
    holder,
    archiveStore,
    publicationStore,
    exportStore,
  } = fixture;
  // Advance into the open session, then past its end into the drain window.
  holder.now = fixture.event.startsAtMs + 1;
  await organizerStore.advanceLifecycle({ now: holder.now });
  holder.now = fixture.event.endsAtMs + 1;
  await organizerStore.advanceLifecycle({ now: holder.now });

  const session = organizerStore.getBoardSessionForEvent(fixture.event.eventId);
  const canvasEnvelope = createDefaultStoredSvgEnvelope({ readonly: false }, 1);
  const canvas = serializeStoredSvgEnvelope(
    canvasEnvelope.prefix,
    [],
    canvasEnvelope.suffix,
  );
  const keyPrefix = `board-archives/${session.boardSessionId}`;
  await archiveStore.putArchive(`${keyPrefix}/canvas.svg`, canvas);
  await archiveStore.putArchive(`${keyPrefix}/ledger.jsonl`, "");
  await archiveStore.putArchive(
    `${keyPrefix}/manifest.json`,
    JSON.stringify({ format: "sukimacanvas-board-archive-v1" }),
  );
  const sealed = await organizerStore.markBoardSessionClosed({
    boardSessionId: session.boardSessionId,
    archiveKey: `${keyPrefix}/manifest.json`,
    finalSeq: 1,
    archivedAtMs: holder.now,
  });
  assert.equal(sealed.ok, true);

  const published = await publicationStore.publish({
    boardSessionId: session.boardSessionId,
    eventId: fixture.event.eventId,
    organizerId: fixture.event.organizerId,
    audience: "link",
    showAttribution: true,
    canvasContent: canvas,
    archivedFinalSeq: 1,
    itemCount: 0,
    actorAccountId: fixture.owner.accountId,
  });
  assert.equal(published.ok, true);

  const created = await exportStore.createExport({
    boardSessionId: session.boardSessionId,
    eventId: fixture.event.eventId,
    organizerId: fixture.event.organizerId,
    requestedByAccountId: fixture.owner.accountId,
  });
  assert.equal(created.created, true);
  const claimed = await exportStore.markExportProcessing(
    created.export.exportId,
  );
  assert.equal(claimed.ok, true);
  const succeeded = await exportStore.markExportSucceeded({
    exportId: created.export.exportId,
    bytes: Buffer.from("png-bytes"),
    width: 10,
    height: 10,
    sha256: "a".repeat(64),
  });
  assert.equal(succeeded.ok, true);
  return {
    session,
    canvasKey: published.publication.canvasKey,
    exportId: created.export.exportId,
  };
}

test("retention expiry purges archive, attribution, change audit, publication, and exports together", async () => {
  const fixture = await createOutcomeFixture(1000);
  const {
    organizerStore,
    holder,
    outcomePipeline,
    publicationStore,
    exportStore,
  } = fixture;
  const { session, canvasKey, exportId } = await sealWithOutcomes(fixture);

  // Well inside the 90-day window nothing is due.
  holder.now = session.archivedAtMs + RETENTION_MS - MINUTE;
  await outcomePipeline.runDueOutcomePurges({ now: holder.now });
  assert.ok(await fixture.archiveStore.readArchive(canvasKey));
  assert.ok(exportStore.getExport(exportId));
  assert.ok(
    (await outcomePipeline.runDueOutcomePurges({ now: holder.now })).length ===
      0,
  );

  // At the deadline the purge runs and removes every outcome together.
  holder.now = session.archivedAtMs + RETENTION_MS;
  const purged = await outcomePipeline.runDueOutcomePurges({ now: holder.now });
  assert.deepEqual(purged, [fixture.event.eventId]);
  assert.equal(await fixture.archiveStore.readArchive(canvasKey), null);
  assert.equal(
    await fixture.archiveStore.readArchive(
      `board-archives/${session.boardSessionId}/manifest.json`,
    ),
    null,
  );
  assert.equal(
    publicationStore.getPublicationForBoardSession(session.boardSessionId),
    null,
  );
  assert.equal(exportStore.getExport(exportId), null);
  await assert.rejects(
    () =>
      fs.access(
        path.join(fixture.ledgerDir, `${fixture.event.boardName}.jsonl`),
      ),
    { code: "ENOENT" },
  );

  const purgedSession = organizerStore.getBoardSessionById(
    session.boardSessionId,
  );
  assert.ok(purgedSession);
  assert.equal(purgedSession.archiveKey, null);
  assert.equal(purgedSession.outcomesPurgedAtMs, holder.now);
  // The archival history itself is never rewritten by the purge.
  assert.equal(purgedSession.archivedAtMs, session.archivedAtMs);

  // The audit trail records the purge as a system action.
  const audit = organizerStore.listAuditForEvent(fixture.event.eventId, {
    limit: 100,
  });
  assert.ok(audit.some((record) => record.action === "event_outcome.purged"));

  // Repeated passes are idempotent: nothing is due, nothing crashes.
  assert.equal(
    (await outcomePipeline.runDueOutcomePurges({ now: holder.now })).length,
    0,
  );
  await outcomePipeline.purgeEventOutcomes({ eventId: fixture.event.eventId });
});

test("early deletion invalidates nothing physically, restore returns everything untouched, purge after the window clears all", async () => {
  const fixture = await createOutcomeFixture(1000);
  const {
    organizerStore,
    holder,
    outcomePipeline,
    publicationStore,
    exportStore,
  } = fixture;
  const { session, canvasKey, exportId } = await sealWithOutcomes(fixture);

  holder.now += 1;
  const requested = await organizerStore.requestEventOutcomeDeletion({
    eventId: fixture.event.eventId,
    actorAccountId: fixture.owner.accountId,
    deleteWindowMs: DELETE_WINDOW_MS,
  });
  assert.equal(requested.ok, true);
  assert.equal(requested.deletion.purgeAtMs, holder.now + DELETE_WINDOW_MS);

  // The pending deletion is not due until its window elapses; the objects are
  // all still physically present — invalidation is a read-path concern.
  holder.now = requested.deletion.purgeAtMs - 1;
  assert.equal(
    (await outcomePipeline.runDueOutcomePurges({ now: holder.now })).length,
    0,
  );
  assert.ok(await fixture.archiveStore.readArchive(canvasKey));
  assert.ok(exportStore.getExport(exportId));
  const pendingEvent = organizerStore.getEventById(fixture.event.eventId);
  assert.ok(pendingEvent && pendingEvent.outcomeDeletion);
  const stillPending = pendingEvent.outcomeDeletion;
  assert.equal(stillPending.purgedAtMs, null);

  // Restore inside the window removes the request entirely; the outcomes are
  // consistent by construction (they were never touched).
  const restored = await organizerStore.restoreEventOutcomeDeletion({
    eventId: fixture.event.eventId,
    actorAccountId: fixture.owner.accountId,
  });
  assert.equal(restored.ok, true);
  const restoredEvent = organizerStore.getEventById(fixture.event.eventId);
  assert.ok(restoredEvent);
  assert.equal(restoredEvent.outcomeDeletion, null);
  const restoredAudit = organizerStore.listAuditForEvent(
    fixture.event.eventId,
    { limit: 100 },
  );
  assert.ok(
    restoredAudit.some(
      (record) => record.action === "event_outcome.delete_restored",
    ),
  );

  // A second deletion runs out its window and purges through the shared
  // routine, finalizing the deletion record durably.
  holder.now = requested.deletion.purgeAtMs + 1;
  const second = await organizerStore.requestEventOutcomeDeletion({
    eventId: fixture.event.eventId,
    actorAccountId: fixture.owner.accountId,
    deleteWindowMs: DELETE_WINDOW_MS,
  });
  assert.equal(second.ok, true);
  holder.now = second.deletion.purgeAtMs + 1;
  assert.deepEqual(
    await outcomePipeline.runDueOutcomePurges({ now: holder.now }),
    [fixture.event.eventId],
  );
  assert.equal(await fixture.archiveStore.readArchive(canvasKey), null);
  assert.equal(
    publicationStore.getPublicationForBoardSession(session.boardSessionId),
    null,
  );
  assert.equal(exportStore.getExport(exportId), null);
  const event = organizerStore.getEventById(fixture.event.eventId);
  assert.ok(event && event.outcomeDeletion);
  assert.equal(event.outcomeDeletion.purgedAtMs, holder.now);
  assert.equal(event.outcomePurgeFailure, null);
});

test("deletion requests are refused deterministically outside the archived state", async () => {
  const fixture = await createOutcomeFixture(1000);
  const { organizerStore, holder } = fixture;

  // No archived outcomes yet: the session is scheduled.
  const refused = await organizerStore.requestEventOutcomeDeletion({
    eventId: fixture.event.eventId,
    actorAccountId: fixture.owner.accountId,
    deleteWindowMs: DELETE_WINDOW_MS,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "not_archived");

  await sealWithOutcomes(fixture);
  holder.now += 1;
  const first = await organizerStore.requestEventOutcomeDeletion({
    eventId: fixture.event.eventId,
    actorAccountId: fixture.owner.accountId,
    deleteWindowMs: DELETE_WINDOW_MS,
  });
  assert.equal(first.ok, true);
  const duplicate = await organizerStore.requestEventOutcomeDeletion({
    eventId: fixture.event.eventId,
    actorAccountId: fixture.owner.accountId,
    deleteWindowMs: DELETE_WINDOW_MS,
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, "already_pending");

  // A restore without a pending request is refused without side effects.
  const bogus = await organizerStore.restoreEventOutcomeDeletion({
    eventId: "missing-event",
    actorAccountId: fixture.owner.accountId,
  });
  assert.equal(bogus.ok, false);
});

test("purge is event-isolated: other events' archives, publications, exports, and ledgers survive", async () => {
  const fixture = await createOutcomeFixture(1000);
  const {
    organizerStore,
    holder,
    outcomePipeline,
    publicationStore,
    archiveStore,
  } = fixture;
  const first = await sealWithOutcomes(fixture);

  // A second event for the same organizer, sealed with its own outcomes.
  const created = await organizerStore.createReservation({
    organizerId: fixture.event.organizerId,
    createdByAccountId: fixture.owner.accountId,
    eventName: "Isolation Check",
    visibility: "public",
    startsAtMs: holder.now + 30 * DAY,
    endsAtMs: holder.now + 30 * DAY + 60 * MINUTE,
    requestedSeats: 2,
  });
  assert.equal(created.ok, true);
  await organizerStore.submitReservation({
    reservationId: created.reservation.reservationId,
    actorAccountId: fixture.owner.accountId,
    now: 0,
  });
  const approved = await organizerStore.approveReservation({
    reservationId: created.reservation.reservationId,
    operatorAccountId: "operator",
    now: 0,
    bufferMs: 15 * MINUTE,
    sessionLimit: 20,
    seatLimit: 1000,
  });
  assert.equal(approved.ok, true);
  const secondSession = organizerStore.getBoardSessionForEvent(
    approved.eventId,
  );
  assert.ok(secondSession);
  // Advance the second session through its own lifecycle boundaries.
  holder.now = secondSession.startsAtMs + 1;
  await organizerStore.advanceLifecycle({ now: holder.now });
  holder.now = secondSession.endsAtMs + 1;
  await organizerStore.advanceLifecycle({ now: holder.now });
  const envelope = createDefaultStoredSvgEnvelope({ readonly: false }, 1);
  const secondCanvas = serializeStoredSvgEnvelope(
    envelope.prefix,
    [],
    envelope.suffix,
  );
  const secondKeyPrefix = `board-archives/${secondSession.boardSessionId}`;
  await archiveStore.putArchive(`${secondKeyPrefix}/canvas.svg`, secondCanvas);
  await archiveStore.putArchive(`${secondKeyPrefix}/manifest.json`, "{}");
  const secondSealed = await organizerStore.markBoardSessionClosed({
    boardSessionId: secondSession.boardSessionId,
    archiveKey: `${secondKeyPrefix}/manifest.json`,
    finalSeq: 1,
    archivedAtMs: holder.now,
  });
  assert.equal(secondSealed.ok, true);
  const secondEvent = organizerStore.getEventById(approved.eventId);
  assert.ok(secondEvent);
  const secondPublished = await publicationStore.publish({
    boardSessionId: secondSession.boardSessionId,
    eventId: approved.eventId,
    organizerId: secondEvent.organizerId,
    audience: "organizer",
    showAttribution: false,
    canvasContent: secondCanvas,
    archivedFinalSeq: 1,
    itemCount: 0,
    actorAccountId: fixture.owner.accountId,
  });
  assert.equal(secondPublished.ok, true);
  const secondLedgerDir = path.join(fixture.dataDir, "mutation-ledger");
  await fs.mkdir(secondLedgerDir, { recursive: true });
  await fs.writeFile(
    path.join(secondLedgerDir, `${secondEvent.boardName}.jsonl`),
    "",
    "utf8",
  );

  // Only the first event is due: purge it and prove the second event's
  // outcomes are untouched.
  holder.now = first.session.archivedAtMs + RETENTION_MS + 1;
  assert.deepEqual(
    await outcomePipeline.runDueOutcomePurges({ now: holder.now }),
    [fixture.event.eventId],
  );
  assert.ok(await archiveStore.readArchive(`${secondKeyPrefix}/canvas.svg`));
  assert.ok(
    publicationStore.getPublicationForBoardSession(
      secondSession.boardSessionId,
    ),
  );
  await fs.access(path.join(secondLedgerDir, `${secondEvent.boardName}.jsonl`));
  const secondPurgedSession = organizerStore.getBoardSessionById(
    secondSession.boardSessionId,
  );
  assert.ok(secondPurgedSession);
  assert.equal(
    secondPurgedSession.archiveKey,
    `${secondKeyPrefix}/manifest.json`,
  );
  assert.equal(secondPurgedSession.outcomesPurgedAtMs, null);
});

test("a failed purge stays durable, visible, and retryable; the operator retry clears the backoff", async () => {
  const fixture = await createOutcomeFixture(1000);
  const { organizerStore, holder, outcomePipeline, archiveStore } = fixture;
  const { session } = await sealWithOutcomes(fixture);

  // Inject a storage fault into object deletion.
  const realDelete = archiveStore.deleteObject.bind(archiveStore);
  archiveStore.deleteObject = async () => {
    throw Object.assign(new Error("disk offline"), { code: "EACCES" });
  };
  holder.now = session.archivedAtMs + RETENTION_MS;
  await outcomePipeline.runDueOutcomePurges({ now: holder.now });
  const failedEvent = organizerStore.getEventById(fixture.event.eventId);
  assert.ok(failedEvent && failedEvent.outcomePurgeFailure);
  assert.equal(failedEvent.outcomePurgeFailure.code, "storage_write_failed");
  assert.equal(failedEvent.outcomePurgeFailure.attempts, 1);
  const failedAudit = organizerStore.listAuditForEvent(fixture.event.eventId, {
    limit: 100,
  });
  assert.ok(
    failedAudit.some(
      (record) => record.action === "event_outcome.purge_failed",
    ),
  );

  // Inside the backoff nothing is attempted; after it, the purge completes.
  holder.now += MINUTE;
  assert.equal(
    (await outcomePipeline.runDueOutcomePurges({ now: holder.now })).length,
    0,
  );
  holder.now += PURGE_RETRY_MS;
  archiveStore.deleteObject = realDelete;
  assert.deepEqual(
    await outcomePipeline.runDueOutcomePurges({ now: holder.now }),
    [fixture.event.eventId],
  );
  const healedEvent = organizerStore.getEventById(fixture.event.eventId);
  assert.ok(healedEvent);
  assert.equal(healedEvent.outcomePurgeFailure, null);
});

test("the operator purge retry clears the failure context for the next pass", async () => {
  const fixture = await createOutcomeFixture(1000);
  const { organizerStore, holder, outcomePipeline, archiveStore } = fixture;
  const { session } = await sealWithOutcomes(fixture);
  const realDelete = archiveStore.deleteObject.bind(archiveStore);
  archiveStore.deleteObject = async () => {
    throw Object.assign(new Error("disk offline"), { code: "EACCES" });
  };
  holder.now = session.archivedAtMs + RETENTION_MS;
  await outcomePipeline.runDueOutcomePurges({ now: holder.now });
  const failedEvent = organizerStore.getEventById(fixture.event.eventId);
  assert.ok(failedEvent && failedEvent.outcomePurgeFailure);

  const retry = await organizerStore.retryEventOutcomePurge({
    eventId: fixture.event.eventId,
    operatorAccountId: "operator",
  });
  assert.equal(retry.ok, true);
  const clearedEvent = organizerStore.getEventById(fixture.event.eventId);
  assert.ok(clearedEvent);
  assert.equal(clearedEvent.outcomePurgeFailure, null);
  const notFailed = await organizerStore.retryEventOutcomePurge({
    eventId: fixture.event.eventId,
    operatorAccountId: "operator",
  });
  assert.equal(notFailed.ok, false);
  assert.equal(notFailed.reason, "not_failed");

  // With the failure cleared, the very next pass purges immediately.
  archiveStore.deleteObject = realDelete;
  assert.deepEqual(
    await outcomePipeline.runDueOutcomePurges({ now: holder.now }),
    [fixture.event.eventId],
  );
});

test("the operator console work list surfaces pending deletions and failed purges", async () => {
  const fixture = await createOutcomeFixture(1000);
  const { organizerStore, holder, outcomePipeline, archiveStore } = fixture;
  const { session } = await sealWithOutcomes(fixture);
  assert.equal(organizerStore.listOutcomePurgeWork().length, 0);

  holder.now += 1;
  const deletion = await organizerStore.requestEventOutcomeDeletion({
    eventId: fixture.event.eventId,
    actorAccountId: fixture.owner.accountId,
    deleteWindowMs: DELETE_WINDOW_MS,
  });
  assert.equal(deletion.ok, true);
  let work = organizerStore.listOutcomePurgeWork();
  assert.equal(work.length, 1);
  assert.ok(work[0] && work[0].deletion);
  assert.equal(work[0].event.eventId, fixture.event.eventId);
  assert.equal(work[0].deletion.purgeAtMs, holder.now + DELETE_WINDOW_MS);

  // A purge failure keeps the event on the work list after restore.
  await organizerStore.restoreEventOutcomeDeletion({
    eventId: fixture.event.eventId,
    actorAccountId: fixture.owner.accountId,
  });
  assert.equal(organizerStore.listOutcomePurgeWork().length, 0);
  archiveStore.deleteObject = async () => {
    throw Object.assign(new Error("disk offline"), { code: "EACCES" });
  };
  holder.now = session.archivedAtMs + RETENTION_MS;
  await outcomePipeline.runDueOutcomePurges({ now: holder.now });
  work = organizerStore.listOutcomePurgeWork();
  assert.equal(work.length, 1);
  assert.ok(work[0] && work[0].event.outcomePurgeFailure);
  assert.equal(work[0].event.outcomePurgeFailure.code, "storage_write_failed");
});

test("deleting a board ledger file is safe for unknown boards and unsafe names", async () => {
  const dataDir = await fs.mkdtemp(
    path.join(require("node:os").tmpdir(), "wbo-ledger-"),
  );
  await deleteBoardMutationLedgerFile({
    boardName: "event-neverexisted",
    dataDir,
  });
  await assert.rejects(
    () => deleteBoardMutationLedgerFile({ boardName: "../escape", dataDir }),
    /unsafe board name/,
  );
});

test("the archive store lists and deletes a session's whole key namespace", async () => {
  const dataDir = await fs.mkdtemp(
    path.join(require("node:os").tmpdir(), "wbo-arch-"),
  );
  const archiveStore = createFileBoardArchiveStore({ dataDir });
  await archiveStore.putArchive("board-archives/s1/canvas.svg", "a");
  await archiveStore.putArchive("board-archives/s1/manifest.json", "b");
  await archiveStore.putArchive("board-archives/s2/canvas.svg", "c");
  await archiveStore.putArchive("published-canvases/s1/1.svg", "d");
  assert.deepEqual(await archiveStore.listObjectKeys("board-archives/s1"), [
    "board-archives/s1/canvas.svg",
    "board-archives/s1/manifest.json",
  ]);
  assert.deepEqual(
    await archiveStore.listObjectKeys("board-archives/missing"),
    [],
  );
  await archiveStore.deleteObject("board-archives/s1/canvas.svg");
  await archiveStore.deleteObject("board-archives/s1/canvas.svg");
  assert.deepEqual(await archiveStore.listObjectKeys("board-archives/s1"), [
    "board-archives/s1/manifest.json",
  ]);
  assert.ok(await archiveStore.readArchive("board-archives/s2/canvas.svg"));
});


test("the retention purge recovers from a restart: durable due-state drives a freshly composed pipeline", async () => {
  const fixture = await createOutcomeFixture(1000);
  const { holder } = fixture;
  const { session, canvasKey, exportId } = await sealWithOutcomes(fixture);

  // Advance past the retention deadline WITHOUT running a pass, then compose
  // every store and the pipeline fresh from the same data directory — the
  // restart simulation. Nothing in memory survives; the durable due-state is
  // the only thing the new pass can act on.
  holder.now = session.archivedAtMs + RETENTION_MS + 1;
  const dataDir = fixture.dataDir;
  const clock = () => holder.now;
  const freshOrganizerStore =
    require("../server/hosted_event/organizers/store.mjs").createFileOrganizerStore(
      { dataDir, clock },
    );
  const freshArchiveStore = createFileBoardArchiveStore({ dataDir });
  const freshPublicationStore = createFilePublicationStore({
    dataDir,
    clock,
    archiveStore: freshArchiveStore,
  });
  const freshExportStore = createFileBoardExportStore({
    dataDir,
    clock,
    linkTtlMs: DAY,
    hmacKey: "outcome-test-secret",
  });
  const freshPipeline = createOutcomeRetentionPipeline({
    organizerStore: freshOrganizerStore,
    archiveStore: freshArchiveStore,
    publicationStore: freshPublicationStore,
    exportStore: freshExportStore,
    config: {
      ...require("../server/configuration.mjs"),
      HOSTED_DATA_DIR: dataDir,
      HOSTED_OUTCOME_RETENTION_MS: RETENTION_MS,
      HOSTED_OUTCOME_PURGE_RETRY_MS: PURGE_RETRY_MS,
    },
    clock,
  });

  assert.deepEqual(
    await freshPipeline.runDueOutcomePurges({ now: holder.now }),
    [fixture.event.eventId],
  );
  assert.equal(await freshArchiveStore.readArchive(canvasKey), null);
  assert.equal(
    freshPublicationStore.getPublicationForBoardSession(
      session.boardSessionId,
    ),
    null,
  );
  assert.equal(freshExportStore.getExport(exportId), null);
  const purgedSession = freshOrganizerStore.getBoardSessionById(
    session.boardSessionId,
  );
  assert.ok(purgedSession);
  assert.equal(purgedSession.archiveKey, null);
  assert.equal(purgedSession.outcomesPurgedAtMs, holder.now);
});

test("the export pipeline retires jobs whose event outcomes are invalidated instead of rendering them", async () => {
  const fixture = await createOutcomeFixture(1000);
  const { organizerStore, holder, exportStore } = fixture;
  await sealWithOutcomes(fixture);
  // A fresh queued job: the settled one does not block a new request.
  const session = organizerStore.getBoardSessionForEvent(fixture.event.eventId);
  assert.ok(session);
  const queued = await exportStore.createExport({
    boardSessionId: session.boardSessionId,
    eventId: fixture.event.eventId,
    organizerId: fixture.event.organizerId,
    requestedByAccountId: fixture.owner.accountId,
  });
  assert.equal(queued.created, true);
  const exportPipeline = createBoardExportPipeline({
    exportStore,
    archiveStore: fixture.archiveStore,
    organizerStore,
    config: {
      ...require("../server/configuration.mjs"),
      HOSTED_BOARD_EXPORT_RETRY_MS: 0,
    },
    clock: () => holder.now,
  });

  holder.now += 1;
  const deletion = await organizerStore.requestEventOutcomeDeletion({
    eventId: fixture.event.eventId,
    actorAccountId: fixture.owner.accountId,
    deleteWindowMs: DELETE_WINDOW_MS,
  });
  assert.equal(deletion.ok, true);

  // The queued job survives until its event's window elapses; the runner
  // pass retires it instead of rendering a canvas that is on its way out.
  holder.now = deletion.deletion.purgeAtMs + 1;
  const pass = await exportPipeline.runDueExports({ now: holder.now });
  assert.deepEqual(pass, { succeeded: [], failed: [] });
  assert.equal(exportStore.getExport(queued.export.exportId), null);
});
