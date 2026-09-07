const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  createFileOrganizerStore,
  computeCapacityPeak,
  eventLifecycleState,
} = require("../server/hosted_event/organizers/store.mjs");

const HOUR = 60 * 60 * 1000;
const BUFFER = 15 * 60 * 1000;

/**
 * @returns {Promise<string>}
 */
async function createDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "wbo-hosted-reservations-"));
}

/**
 * @param {string} dataDir
 * @param {{clock?: () => number}} [options]
 */
function makeStore(dataDir, options = {}) {
  return createFileOrganizerStore({ dataDir, ...options });
}

/**
 * Creates an approved organizer owned by "owner-1".
 *
 * @param {ReturnType<typeof createFileOrganizerStore>} store
 * @returns {Promise<string>}
 */
async function setupOrganizer(store) {
  const submitted = await store.submitApplication({
    accountId: "owner-1",
    organizerName: "Aurora Collective",
    contactName: "Mika Rin",
    contactEmail: "owner@example.com",
    description: "Jams.",
  });
  assert.ok(submitted.ok);
  const approved = await store.approveApplication({
    applicationId: submitted.application.applicationId,
    operatorAccountId: "operator-1",
  });
  assert.ok(approved.ok);
  return approved.organizerId;
}

test("computeCapacityPeak sums only overlapping allocations", () => {
  // Disjoint window: only the candidate counts.
  assert.deepEqual(
    computeCapacityPeak(0, 100, 10, [
      { windowStartMs: 200, windowEndMs: 300, seats: 50 },
    ]),
    {
      maxSessions: 1,
      maxSeats: 10,
    },
  );
  // Overlapping: sessions and seats add up.
  assert.deepEqual(
    computeCapacityPeak(0, 100, 10, [
      { windowStartMs: 50, windowEndMs: 150, seats: 40 },
      { windowStartMs: 60, windowEndMs: 80, seats: 5 },
    ]),
    { maxSessions: 3, maxSeats: 55 },
  );
  // Touching at the boundary is not an overlap (half-open windows).
  assert.deepEqual(
    computeCapacityPeak(0, 100, 10, [
      { windowStartMs: 100, windowEndMs: 200, seats: 40 },
    ]),
    {
      maxSessions: 1,
      maxSeats: 10,
    },
  );
});

test("a reservation draft is created, edited, and frozen after submit", async () => {
  const now = 1_000_000;
  const store = makeStore(await createDataDir(), { clock: () => now });
  const organizerId = await setupOrganizer(store);
  const created = await store.createReservation({
    organizerId,
    createdByAccountId: "owner-1",
    eventName: "Launch Party",
    description: "Come draw.",
    visibility: "public",
    startsAtMs: now + HOUR,
    endsAtMs: now + 2 * HOUR,
    requestedSeats: 30,
  });
  assert.ok(created.ok);
  const id = created.reservation.reservationId;
  assert.equal(created.reservation.status, "draft");

  const edited = await store.updateReservation({
    reservationId: id,
    eventName: "Launch Party v2",
    visibility: "unlisted",
    startsAtMs: now + HOUR,
    endsAtMs: now + 2 * HOUR,
    requestedSeats: 40,
  });
  assert.deepEqual(edited, { ok: true });
  assert.equal(store.getReservationById(id)?.requestedSeats, 40);

  const submitted = await store.submitReservation({
    reservationId: id,
    actorAccountId: "owner-1",
    now,
  });
  assert.deepEqual(submitted, { ok: true });

  // A submitted reservation can no longer be edited directly.
  assert.deepEqual(
    await store.updateReservation({
      reservationId: id,
      eventName: "Sneaky change",
      visibility: "public",
      startsAtMs: now + HOUR,
      endsAtMs: now + 2 * HOUR,
      requestedSeats: 50,
    }),
    { ok: false, reason: "not_draft" },
  );
  assert.deepEqual(
    await store.submitReservation({
      reservationId: id,
      actorAccountId: "owner-1",
      now,
    }),
    { ok: false, reason: "not_draft" },
  );
});

test("submitting rejects a start that is not in the future", async () => {
  const now = 1_000_000;
  const store = makeStore(await createDataDir(), { clock: () => now });
  const organizerId = await setupOrganizer(store);
  const created = await store.createReservation({
    organizerId,
    createdByAccountId: "owner-1",
    eventName: "Past event",
    visibility: "public",
    startsAtMs: now - HOUR,
    endsAtMs: now + HOUR,
    requestedSeats: 10,
  });
  assert.ok(created.ok);
  assert.deepEqual(
    await store.submitReservation({
      reservationId: created.reservation.reservationId,
      actorAccountId: "owner-1",
      now,
    }),
    { ok: false, reason: "past_start" },
  );
});

/**
 * @param {ReturnType<typeof createFileOrganizerStore>} store
 * @param {string} organizerId
 * @param {number} now
 * @param {{startsAtMs: number, endsAtMs: number, requestedSeats: number}} fields
 */
async function submittedReservation(store, organizerId, now, fields) {
  const created = await store.createReservation({
    organizerId,
    createdByAccountId: "owner-1",
    eventName: "Event",
    visibility: "public",
    ...fields,
  });
  assert.ok(created.ok);
  const submitted = await store.submitReservation({
    reservationId: created.reservation.reservationId,
    actorAccountId: "owner-1",
    now,
  });
  assert.ok(submitted.ok);
  return created.reservation.reservationId;
}

test("approval mints an unguessable public id and a scheduled board session", async () => {
  const now = 1_000_000;
  const store = makeStore(await createDataDir(), { clock: () => now });
  const organizerId = await setupOrganizer(store);
  const id = await submittedReservation(store, organizerId, now, {
    startsAtMs: now + HOUR,
    endsAtMs: now + 2 * HOUR,
    requestedSeats: 30,
  });
  const approved = await store.approveReservation({
    reservationId: id,
    operatorAccountId: "operator-1",
    now,
    bufferMs: BUFFER,
    sessionLimit: 20,
    seatLimit: 1000,
  });
  assert.ok(approved.ok);
  assert.match(approved.publicId, /^[A-Za-z0-9_-]{16,}$/);
  const event = store.getEventByPublicId(approved.publicId);
  assert.ok(event);
  assert.equal(event.name, "Event");
  // The internal reservation id is not the public id.
  assert.notEqual(approved.publicId, id);
  assert.equal(store.getReservationById(id)?.status, "approved");

  // A second approval mints a distinct public id.
  const id2 = await submittedReservation(store, organizerId, now, {
    startsAtMs: now + 10 * HOUR,
    endsAtMs: now + 11 * HOUR,
    requestedSeats: 10,
  });
  const approved2 = await store.approveReservation({
    reservationId: id2,
    operatorAccountId: "operator-1",
    now,
    bufferMs: BUFFER,
    sessionLimit: 20,
    seatLimit: 1000,
  });
  assert.ok(approved2.ok);
  assert.notEqual(approved.publicId, approved2.publicId);
});

test("approval refuses a reservation whose start has already passed", async () => {
  const submitNow = 1_000_000;
  const store = makeStore(await createDataDir(), { clock: () => submitNow });
  const organizerId = await setupOrganizer(store);
  const id = await submittedReservation(store, organizerId, submitNow, {
    startsAtMs: submitNow + HOUR,
    endsAtMs: submitNow + 2 * HOUR,
    requestedSeats: 10,
  });
  // The operator approves after the start time has passed.
  const result = await store.approveReservation({
    reservationId: id,
    operatorAccountId: "operator-1",
    now: submitNow + 3 * HOUR,
    bufferMs: BUFFER,
    sessionLimit: 20,
    seatLimit: 1000,
  });
  assert.deepEqual(result, { ok: false, reason: "past_start" });
  assert.equal(store.getReservationById(id)?.status, "submitted");
});

test("approval enforces the concurrent seat limit at the window peak", async () => {
  const now = 1_000_000;
  const store = makeStore(await createDataDir(), { clock: () => now });
  const organizerId = await setupOrganizer(store);
  // Two overlapping reservations of 30 seats each; limit is 50.
  const a = await submittedReservation(store, organizerId, now, {
    startsAtMs: now + HOUR,
    endsAtMs: now + 2 * HOUR,
    requestedSeats: 30,
  });
  const b = await submittedReservation(store, organizerId, now, {
    startsAtMs: now + HOUR,
    endsAtMs: now + 2 * HOUR,
    requestedSeats: 30,
  });
  const limits = { now, bufferMs: BUFFER, sessionLimit: 20, seatLimit: 50 };
  const approvedA = await store.approveReservation({
    reservationId: a,
    operatorAccountId: "operator-1",
    ...limits,
  });
  assert.ok(approvedA.ok);
  // B alone fits, but A+B = 60 > 50 in the overlapping window.
  const approvedB = await store.approveReservation({
    reservationId: b,
    operatorAccountId: "operator-1",
    ...limits,
  });
  assert.equal(approvedB.ok, false);
  assert.ok(approvedB.ok === false && approvedB.reason === "capacity");
  assert.equal(store.getReservationById(b)?.status, "submitted");
});

test("approval allows capacity exactly at the limit", async () => {
  const now = 1_000_000;
  const store = makeStore(await createDataDir(), { clock: () => now });
  const organizerId = await setupOrganizer(store);
  const a = await submittedReservation(store, organizerId, now, {
    startsAtMs: now + HOUR,
    endsAtMs: now + 2 * HOUR,
    requestedSeats: 25,
  });
  const b = await submittedReservation(store, organizerId, now, {
    startsAtMs: now + HOUR,
    endsAtMs: now + 2 * HOUR,
    requestedSeats: 25,
  });
  const limits = { now, bufferMs: BUFFER, sessionLimit: 20, seatLimit: 50 };
  assert.ok(
    (
      await store.approveReservation({
        reservationId: a,
        operatorAccountId: "operator-1",
        ...limits,
      })
    ).ok,
  );
  // A+B = 50 == limit, exactly allowed.
  assert.ok(
    (
      await store.approveReservation({
        reservationId: b,
        operatorAccountId: "operator-1",
        ...limits,
      })
    ).ok,
  );
});

test("concurrent approvals never oversell capacity", async () => {
  const now = 1_000_000;
  const store = makeStore(await createDataDir(), { clock: () => now });
  const organizerId = await setupOrganizer(store);
  // Two overlapping 30-seat reservations, seat limit 50: only one can win.
  const a = await submittedReservation(store, organizerId, now, {
    startsAtMs: now + HOUR,
    endsAtMs: now + 2 * HOUR,
    requestedSeats: 30,
  });
  const b = await submittedReservation(store, organizerId, now, {
    startsAtMs: now + HOUR,
    endsAtMs: now + 2 * HOUR,
    requestedSeats: 30,
  });
  const limits = { now, bufferMs: BUFFER, sessionLimit: 20, seatLimit: 50 };
  const [ra, rb] = await Promise.all([
    store.approveReservation({
      reservationId: a,
      operatorAccountId: "operator-1",
      ...limits,
    }),
    store.approveReservation({
      reservationId: b,
      operatorAccountId: "operator-1",
      ...limits,
    }),
  ]);
  assert.equal([ra, rb].filter((r) => r.ok).length, 1);
  assert.equal([ra, rb].filter((r) => !r.ok).length, 1);
  await store.flush();
  // Exactly one board session (allocation) exists for the organizer.
  const approvedCount = store
    .listReservationsForOrganizer(organizerId)
    .filter((r) => r.status === "approved").length;
  assert.equal(approvedCount, 1);
});

test("the concurrent board-session count is capped independently of seats", async () => {
  const now = 1_000_000;
  const store = makeStore(await createDataDir(), { clock: () => now });
  const organizerId = await setupOrganizer(store);
  const limits = { now, bufferMs: BUFFER, sessionLimit: 2, seatLimit: 1000 };
  const windows = { startsAtMs: now + HOUR, endsAtMs: now + 2 * HOUR };
  const first = await submittedReservation(store, organizerId, now, {
    ...windows,
    requestedSeats: 5,
  });
  const second = await submittedReservation(store, organizerId, now, {
    ...windows,
    requestedSeats: 5,
  });
  const thirdId = await submittedReservation(store, organizerId, now, {
    ...windows,
    requestedSeats: 5,
  });
  assert.ok(
    (
      await store.approveReservation({
        reservationId: first,
        operatorAccountId: "op",
        ...limits,
      })
    ).ok,
  );
  assert.ok(
    (
      await store.approveReservation({
        reservationId: second,
        operatorAccountId: "op",
        ...limits,
      })
    ).ok,
  );
  // Third overlapping session exceeds the 2-session cap.
  const third = await store.approveReservation({
    reservationId: thirdId,
    operatorAccountId: "op",
    ...limits,
  });
  assert.ok(third.ok === false && third.reason === "capacity");
});

test("non-overlapping windows do not consume each other's capacity", async () => {
  const now = 1_000_000;
  const store = makeStore(await createDataDir(), { clock: () => now });
  const organizerId = await setupOrganizer(store);
  const limits = { now, bufferMs: BUFFER, sessionLimit: 1, seatLimit: 40 };
  const a = await submittedReservation(store, organizerId, now, {
    startsAtMs: now + HOUR,
    endsAtMs: now + 2 * HOUR,
    requestedSeats: 40,
  });
  // Starts well after A's window (plus buffers) ends.
  const b = await submittedReservation(store, organizerId, now, {
    startsAtMs: now + 5 * HOUR,
    endsAtMs: now + 6 * HOUR,
    requestedSeats: 40,
  });
  assert.ok(
    (
      await store.approveReservation({
        reservationId: a,
        operatorAccountId: "op",
        ...limits,
      })
    ).ok,
  );
  assert.ok(
    (
      await store.approveReservation({
        reservationId: b,
        operatorAccountId: "op",
        ...limits,
      })
    ).ok,
  );
});

test("reject and cancel move reservations to terminal states", async () => {
  const now = 1_000_000;
  const store = makeStore(await createDataDir(), { clock: () => now });
  const organizerId = await setupOrganizer(store);
  const id = await submittedReservation(store, organizerId, now, {
    startsAtMs: now + HOUR,
    endsAtMs: now + 2 * HOUR,
    requestedSeats: 10,
  });
  const rejected = await store.rejectReservation({
    reservationId: id,
    operatorAccountId: "operator-1",
    note: "OPERATOR-ONLY: timing conflict",
  });
  assert.deepEqual(rejected, { ok: true });
  const reservation = store.getReservationById(id);
  assert.equal(reservation?.status, "rejected");
  assert.equal(reservation?.operatorNote, "OPERATOR-ONLY: timing conflict");
  // Approving a rejected reservation is refused.
  assert.deepEqual(
    await store.approveReservation({
      reservationId: id,
      operatorAccountId: "operator-1",
      now,
      bufferMs: BUFFER,
      sessionLimit: 20,
      seatLimit: 1000,
    }),
    { ok: false, reason: "not_submitted" },
  );

  // Cancel a draft; an approved reservation is not cancellable here.
  const draft = await store.createReservation({
    organizerId,
    createdByAccountId: "owner-1",
    eventName: "Draft",
    visibility: "public",
    startsAtMs: now + HOUR,
    endsAtMs: now + 2 * HOUR,
    requestedSeats: 5,
  });
  assert.ok(draft.ok);
  assert.deepEqual(
    await store.cancelReservation({
      reservationId: draft.reservation.reservationId,
      actorAccountId: "owner-1",
    }),
    { ok: true },
  );
});

test("reservation state survives a store reload", async () => {
  const now = 1_000_000;
  const dataDir = await createDataDir();
  const store = makeStore(dataDir, { clock: () => now });
  const organizerId = await setupOrganizer(store);
  const id = await submittedReservation(store, organizerId, now, {
    startsAtMs: now + HOUR,
    endsAtMs: now + 2 * HOUR,
    requestedSeats: 20,
  });
  const approved = await store.approveReservation({
    reservationId: id,
    operatorAccountId: "operator-1",
    now,
    bufferMs: BUFFER,
    sessionLimit: 20,
    seatLimit: 1000,
  });
  assert.ok(approved.ok);
  await store.flush();

  const reloaded = makeStore(dataDir, { clock: () => now });
  assert.equal(reloaded.getReservationById(id)?.status, "approved");
  assert.ok(reloaded.getEventByPublicId(approved.publicId));
  // The reloaded allocation still blocks an oversized overlapping approval.
  const clash = await submittedReservation(reloaded, organizerId, now, {
    startsAtMs: now + HOUR,
    endsAtMs: now + 2 * HOUR,
    requestedSeats: 1000,
  });
  const clashResult = await reloaded.approveReservation({
    reservationId: clash,
    operatorAccountId: "operator-1",
    now,
    bufferMs: BUFFER,
    sessionLimit: 20,
    seatLimit: 1000,
  });
  assert.ok(clashResult.ok === false && clashResult.reason === "capacity");
});

/**
 * Approves a reservation and returns its minted event.
 *
 * @param {ReturnType<typeof createFileOrganizerStore>} store
 * @param {string} organizerId
 * @param {number} now
 * @param {{visibility: "public" | "unlisted", eventName?: string, startsAtMs?: number, endsAtMs?: number}} fields
 */
async function approvedEvent(store, organizerId, now, fields) {
  const created = await store.createReservation({
    organizerId,
    createdByAccountId: "owner-1",
    eventName: fields.eventName || "Event",
    visibility: fields.visibility,
    startsAtMs: fields.startsAtMs ?? now + HOUR,
    endsAtMs: fields.endsAtMs ?? now + 2 * HOUR,
    requestedSeats: 10,
  });
  assert.ok(created.ok);
  await store.submitReservation({
    reservationId: created.reservation.reservationId,
    actorAccountId: "owner-1",
    now,
  });
  const approved = await store.approveReservation({
    reservationId: created.reservation.reservationId,
    operatorAccountId: "operator-1",
    now,
    bufferMs: BUFFER,
    sessionLimit: 20,
    seatLimit: 1000,
  });
  assert.ok(approved.ok);
  const event = store.getEventByPublicId(approved.publicId);
  assert.ok(event);
  return event;
}

test("eventLifecycleState classifies by the service clock", () => {
  const event = { startsAtMs: 100, endsAtMs: 200 };
  assert.equal(eventLifecycleState(event, 50), "scheduled");
  assert.equal(eventLifecycleState(event, 100), "open");
  assert.equal(eventLifecycleState(event, 150), "open");
  assert.equal(eventLifecycleState(event, 200), "ended");
  assert.equal(eventLifecycleState(event, 999), "ended");
});

test("discovery lists only public, not-yet-ended events", async () => {
  const now = 1_000_000;
  const store = makeStore(await createDataDir(), { clock: () => now });
  const organizerId = await setupOrganizer(store);
  const publicEvent = await approvedEvent(store, organizerId, now, {
    visibility: "public",
    eventName: "Public One",
    startsAtMs: now + HOUR,
    endsAtMs: now + 2 * HOUR,
  });
  await approvedEvent(store, organizerId, now, {
    visibility: "unlisted",
    eventName: "Unlisted One",
    startsAtMs: now + HOUR,
    endsAtMs: now + 2 * HOUR,
  });

  const discoverable = store.listPublicDiscoverableEvents(now);
  assert.deepEqual(
    discoverable.map((event) => event.eventId),
    [publicEvent.eventId],
  );

  // Once the public event's window has passed, it is no longer discoverable.
  const afterEnd = store.listPublicDiscoverableEvents(now + 5 * HOUR);
  assert.deepEqual(afterEnd, []);
});

test("event display and cover updates are authorized to the owning organizer", async () => {
  const now = 1_000_000;
  const dataDir = await createDataDir();
  const store = makeStore(dataDir, { clock: () => now });
  const organizerId = await setupOrganizer(store);
  const event = await approvedEvent(store, organizerId, now, {
    visibility: "unlisted",
    eventName: "Togglable",
  });

  // A different organizer id cannot touch this event.
  const foreign = await store.updateEventDisplay({
    organizerId: "some-other-organizer",
    eventId: event.eventId,
    visibility: "public",
    actorAccountId: "owner-1",
  });
  assert.deepEqual(foreign, { ok: false, reason: "not_found" });

  const updated = await store.updateEventDisplay({
    organizerId,
    eventId: event.eventId,
    visibility: "public",
    tagline: "Open now",
    actorAccountId: "owner-1",
  });
  assert.ok(updated.ok);
  await store.setEventCover({
    organizerId,
    eventId: event.eventId,
    assetId: "asset-xyz",
    actorAccountId: "owner-1",
  });
  await store.flush();

  const reloaded = makeStore(dataDir, { clock: () => now });
  const persisted = reloaded.getEventForOrganizer(organizerId, event.eventId);
  assert.ok(persisted);
  assert.equal(persisted.visibility, "public");
  assert.equal(persisted.tagline, "Open now");
  assert.equal(persisted.coverAssetId, "asset-xyz");
  assert.equal(reloaded.listPublicDiscoverableEvents(now).length, 1);

  // Removing the cover clears only the cover reference.
  const removed = await reloaded.updateEventDisplay({
    organizerId,
    eventId: event.eventId,
    visibility: "public",
    tagline: "Open now",
    removeCover: true,
    actorAccountId: "owner-1",
  });
  assert.ok(removed.ok);
  assert.equal(
    reloaded.getEventForOrganizer(organizerId, event.eventId)?.coverAssetId,
    null,
  );
});
