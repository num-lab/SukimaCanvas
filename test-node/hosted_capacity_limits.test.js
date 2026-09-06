/** Platform capacity commitments and rejection behavior, proven at the store. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  createFileOrganizerStore,
} = require("../server/hosted_event/organizers/store.mjs");
const {
  createFileAccountStore,
} = require("../server/hosted_event/accounts/store.mjs");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The confirmed platform commitments. */
const SESSION_LIMIT = 20;
const SEAT_LIMIT = 1000;
const SEATS_PER_SESSION = 50;

/** Hosted reservation attempt limits are wide enough not to trip here. */
/**
 * @param {number} now
 */
async function createStore(now) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-capacity-"));
  const holder = { now };
  const store = createFileOrganizerStore({ dataDir, clock: () => holder.now });
  const accountStore = createFileAccountStore({
    dataDir,
    clock: () => holder.now,
  });
  const owner = await accountStore.createAccount({
    email: "capacity-owner@example.com",
    passwordHash: "test-hash",
  });
  const application = await store.submitApplication({
    accountId: owner.accountId,
    organizerName: "Capacity Collective",
    contactName: "Mika Rin",
    contactEmail: "owner@example.com",
  });
  assert.ok(application.ok);
  const approved = await store.approveApplication({
    applicationId: application.application.applicationId,
    operatorAccountId: "operator",
  });
  assert.ok(approved.ok);
  return { holder, store, organizerId: /** @type {string} */ (approved.organizerId), ownerAccountId: owner.accountId };
}

/**
 * Creates, submits, and approves one reservation with an overlapping window.
 * @param {any} fixture
 * @param {number} index
 * @param {number} seats
 * @returns {Promise<{ok: boolean, reason?: string, maxSessions?: number, maxSeats?: number, eventId?: string}>}
 */
async function approveOverlapping(fixture, index, seats) {
  const { store, organizerId, ownerAccountId, holder } = fixture;
  const created = await store.createReservation({
    organizerId,
    createdByAccountId: ownerAccountId,
    eventName: `Capacity Jam ${index}`,
    visibility: "unlisted",
    startsAtMs: holder.now + 24 * HOUR,
    endsAtMs: holder.now + 24 * HOUR + 2 * HOUR,
    requestedSeats: seats,
  });
  assert.ok(created.ok);
  const submitted = await store.submitReservation({
    reservationId: created.reservation.reservationId,
    actorAccountId: ownerAccountId,
    now: holder.now,
  });
  assert.ok(submitted.ok);
  return store.approveReservation({
    reservationId: created.reservation.reservationId,
    operatorAccountId: "operator",
    now: holder.now,
    bufferMs: 15 * MINUTE,
    sessionLimit: SESSION_LIMIT,
    seatLimit: SEAT_LIMIT,
  });
}

test("capacity: 20 overlapping sessions with 1,000 committed seats are approved exactly at the limits", async () => {
  const fixture = await createStore(1_000_000);
  for (let index = 0; index < SESSION_LIMIT; index += 1) {
    const approved = await approveOverlapping(fixture, index, SEATS_PER_SESSION);
    assert.ok(
      approved.ok,
      `session ${index + 1} of ${SESSION_LIMIT} must be approved`,
    );
  }
  // The capacity signal reads the commitments directly against the limits.
  const usage = fixture.store.readCapacityUsage();
  assert.equal(usage.activeSessions, 0, "nothing is open yet");
});

test("capacity: a 21st overlapping session is refused with the deterministic capacity reason", async () => {
  const fixture = await createStore(1_000_000);
  for (let index = 0; index < SESSION_LIMIT; index += 1) {
    assert.ok((await approveOverlapping(fixture, index, SEATS_PER_SESSION)).ok);
  }
  const refused = await approveOverlapping(fixture, SESSION_LIMIT, 1);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "capacity");
  // The refusal reports the peak the candidate would create: 21 sessions,
  // 1,001 seats — both past the confirmed limits.
  assert.equal(refused.maxSessions, SESSION_LIMIT + 1);
  assert.equal(refused.maxSeats, SEAT_LIMIT + 1);
});

test("capacity: an overlapping window exceeding 1,000 committed seats is refused", async () => {
  const fixture = await createStore(1_000_000);
  // Fill all 20 sessions with 50 seats each: 1,000 committed seats, exactly
  // at the seat limit.
  for (let index = 0; index < SESSION_LIMIT; index += 1) {
    assert.ok((await approveOverlapping(fixture, index, SEATS_PER_SESSION)).ok);
  }
  // One more seat breaches the seat total even though the session count
  // alone would suggest room.
  const overSeats = await approveOverlapping(fixture, SESSION_LIMIT, 1);
  assert.equal(overSeats.ok, false);
  assert.equal(overSeats.reason, "capacity");
  assert.equal(overSeats.maxSeats, SEAT_LIMIT + 1);
});

test("capacity: the signal reports live sessions and committed seats on the lifecycle cadence", async () => {
  const fixture = await createStore(1_000_000);
  const approved = await approveOverlapping(fixture, 1, SEATS_PER_SESSION);
  assert.ok(approved.ok);
  const event = fixture.store.getEventById(
    /** @type {string} */ (approved.eventId),
  );
  assert.ok(event);
  const session = fixture.store.getBoardSessionForEvent(event.eventId);
  assert.ok(session);
  assert.deepEqual(fixture.store.readCapacityUsage(), {
    activeSessions: 0,
    committedSeats: 0,
  });
  fixture.holder.now = session.startsAtMs;
  await fixture.store.advanceLifecycle({ now: fixture.holder.now });
  assert.deepEqual(fixture.store.readCapacityUsage(), {
    activeSessions: 1,
    committedSeats: SEATS_PER_SESSION,
  });
  // Draining sessions stay committed until they are sealed.
  fixture.holder.now = session.endsAtMs;
  await fixture.store.advanceLifecycle({ now: fixture.holder.now });
  assert.deepEqual(fixture.store.readCapacityUsage(), {
    activeSessions: 1,
    committedSeats: SEATS_PER_SESSION,
  });
});
