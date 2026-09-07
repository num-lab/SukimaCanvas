const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  createFileAccountStore,
} = require("../server/hosted_event/accounts/store.mjs");
const {
  createEventAdmission,
} = require("../server/hosted_event/admission/index.mjs");
const {
  createParticipantIdentifierResolver,
} = require("../server/hosted_event/attribution.mjs");
const {
  createFileOrganizerStore,
} = require("../server/hosted_event/organizers/store.mjs");
const {
  createFileEventMembershipStore,
} = require("../server/hosted_event/memberships/store.mjs");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Asserts an admission verdict was refused and returns its coarse reason.
 *
 * @param {{ok: boolean, reason?: string}} verdict
 * @returns {string}
 */
function refusedReason(verdict) {
  assert.equal(verdict.ok, false);
  return /** @type {string} */ (verdict.reason);
}

/**
 * Asserts a write revalidation was refused and returns its reason.
 *
 * @param {{ok: boolean, reason?: string}} result
 * @returns {string}
 */
function refusedWriteReason(result) {
  assert.equal(result.ok, false);
  return /** @type {string} */ (result.reason);
}

/**
 * Asserts an admission verdict was granted and returns the narrowed verdict.
 *
 * @param {{ok: boolean, role?: string, eventId?: string, accountId?: string, boardName?: string}} verdict
 * @returns {{ok: true, role: "editor" | "moderator" | "reader", eventId: string, accountId: string, boardName: string}}
 */
function admitted(verdict) {
  assert.equal(verdict.ok, true);
  return /** @type {{ok: true, role: "editor" | "moderator" | "reader", eventId: string, accountId: string, boardName: string}} */ (
    verdict
  );
}

/**
 * Composes the real hosted stores and the admission module against one shared,
 * controllable clock in a temporary data directory.
 */
async function createHarness() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-seats-"));
  const holder = { now: 1_700_000_000_000 };
  const clock = () => holder.now;
  // Sessions must survive the large clock jumps the tests drive.
  const accountStore = createFileAccountStore({
    dataDir,
    clock,
    sessionMaxAgeMs: 1000 * DAY,
    sessionIdleMs: 1000 * DAY,
  });
  const organizerStore = createFileOrganizerStore({ dataDir, clock });
  const membershipStore = createFileEventMembershipStore({ dataDir, clock });
  const admission = createEventAdmission({
    seatGraceMs: 10 * MINUTE,
    accountStore,
    organizerStore,
    membershipStore,
    participantIdentifierFor:
      createParticipantIdentifierResolver("seat-test-secret"),
    clock,
  });
  return { holder, accountStore, organizerStore, membershipStore, admission };
}

/**
 * Provisions one approved event through the real store state machine and
 * returns its identifiers plus the Owner's account id. The event starts one
 * day after the current harness clock, so lifecycle jumps stay small enough
 * for sessions to survive.
 */
/**
 * @param {ReturnType<typeof createFileOrganizerStore>} organizerStore
 * @param {string} ownerAccountId
 * @param {number} now
 */
async function provisionEvent(organizerStore, ownerAccountId, now) {
  const startsAtMs = now + DAY;
  const application = await organizerStore.submitApplication({
    accountId: ownerAccountId,
    organizerName: "Aurora Collective",
    contactName: "Mika Rin",
    contactEmail: "contact@example.com",
  });
  assert.ok(application.ok);
  const approved = await organizerStore.approveApplication({
    applicationId: application.application.applicationId,
    operatorAccountId: "operator",
  });
  assert.ok(approved.ok);
  const organizerId = approved.organizerId;

  const created = await organizerStore.createReservation({
    organizerId,
    createdByAccountId: ownerAccountId,
    eventName: "Seat Jam",
    visibility: "public",
    startsAtMs,
    endsAtMs: startsAtMs + HOUR,
    requestedSeats: 1,
  });
  assert.ok(created.ok);
  const reservation = created.reservation;
  await organizerStore.submitReservation({
    reservationId: reservation.reservationId,
    actorAccountId: ownerAccountId,
    now: 0,
  });
  const operatorApproved = await organizerStore.approveReservation({
    reservationId: reservation.reservationId,
    operatorAccountId: "operator",
    now: 0,
    bufferMs: 15 * MINUTE,
    sessionLimit: 20,
    seatLimit: 1000,
  });
  assert.ok(operatorApproved.ok);
  const event = organizerStore.getEventById(operatorApproved.eventId);
  assert.ok(event);
  assert.match(event.boardName, /^event-[0-9a-f]{24}$/);
  const session = organizerStore.getBoardSessionForReservation(
    reservation.reservationId,
  );
  assert.ok(session);
  return {
    organizerId,
    ownerAccountId,
    reservationId: reservation.reservationId,
    eventId: event.eventId,
    publicId: event.publicId,
    boardName: event.boardName,
    session,
  };
}

/**
 * Creates a verified account and returns its id plus a raw hosted session id.
 */
/**
 * @param {ReturnType<typeof createFileAccountStore>} accountStore
 * @param {string} email
 */
async function provisionAccount(accountStore, email) {
  const account = await accountStore.createAccount({
    email,
    passwordHash: "test-hash",
  });
  await accountStore.markAccountVerified(account.accountId, 0);
  const rawSessionId = await accountStore.createSession(account.accountId);
  return { accountId: account.accountId, rawSessionId };
}

test("admission rejects non-hosted boards, unknown events, and missing identity", async () => {
  const { accountStore, organizerStore, admission, holder } =
    await createHarness();
  const owner = await provisionAccount(accountStore, "owner@example.com");
  const event = await provisionEvent(
    organizerStore,
    owner.accountId,
    holder.now,
  );

  // Legacy and arbitrary board names never pass the hosted gate.
  assert.equal(
    refusedReason(
      admission.admitEventBoardSocket({
        boardName: "anonymous",
        cookieHeader: "",
      }),
    ),
    "hosted_board_required",
  );
  assert.equal(
    refusedReason(
      admission.admitEventBoardSocket({
        boardName: "some-legacy-board",
        cookieHeader: "",
      }),
    ),
    "hosted_board_required",
  );
  assert.equal(
    refusedReason(
      admission.admitEventBoardSocket({
        boardName: `event-${"0".repeat(24)}`,
        cookieHeader: "",
      }),
    ),
    "event_not_found",
  );

  // Without a hosted session cookie there is no identity to admit.
  const noIdentity = admission.admitEventBoardSocket({
    boardName: event.boardName,
    cookieHeader: undefined,
  });
  assert.equal(refusedReason(noIdentity), "account_required");

  // A member of a different event gains nothing on this board.
  const stranger = await provisionAccount(accountStore, "stranger@example.com");
  assert.equal(
    refusedReason(
      admission.admitEventBoardSocket({
        boardName: event.boardName,
        cookieHeader: `hosted-session-v1=${stranger.rawSessionId}`,
      }),
    ),
    "membership_required",
  );
});

test("only Owner/Admin may enter during the Preparation Window; members need OPEN", async () => {
  const { accountStore, organizerStore, membershipStore, admission, holder } =
    await createHarness();
  const owner = await provisionAccount(accountStore, "owner@example.com");
  const participant = await provisionAccount(accountStore, "p@example.com");
  const event = await provisionEvent(
    organizerStore,
    owner.accountId,
    holder.now,
  );
  await membershipStore.admit({
    eventId: event.eventId,
    accountId: participant.accountId,
    anonymity: "identified",
  });

  // Scheduled but outside the Preparation Window: even the owner is refused.
  assert.equal(
    refusedReason(
      admission.admitEventBoardSocket({
        boardName: event.boardName,
        cookieHeader: `hosted-session-v1=${owner.rawSessionId}`,
      }),
    ),
    "event_not_open",
  );

  // Inside the 15-minute Preparation Window: the owner enters as moderator,
  // the member is still refused.
  holder.now = event.session.startsAtMs - 10 * MINUTE;
  const ownerPrep = admission.admitEventBoardSocket({
    boardName: event.boardName,
    cookieHeader: `hosted-session-v1=${owner.rawSessionId}`,
  });
  assert.ok(admitted(ownerPrep).role === "moderator");
  assert.equal(
    refusedReason(
      admission.admitEventBoardSocket({
        boardName: event.boardName,
        cookieHeader: `hosted-session-v1=${participant.rawSessionId}`,
      }),
    ),
    "event_not_open",
  );

  // Open: the member becomes an editor.
  holder.now = event.session.startsAtMs;
  await organizerStore.advanceLifecycle({ now: holder.now });
  const memberOpen = admission.admitEventBoardSocket({
    boardName: event.boardName,
    cookieHeader: `hosted-session-v1=${participant.rawSessionId}`,
  });
  assert.ok(admitted(memberOpen).role === "editor");
});

test("seats count distinct accounts; extra tabs are read-only; full events refuse new accounts", async () => {
  const { accountStore, organizerStore, membershipStore, admission, holder } =
    await createHarness();
  const owner = await provisionAccount(accountStore, "owner@example.com");
  const alice = await provisionAccount(accountStore, "alice@example.com");
  const bob = await provisionAccount(accountStore, "bob@example.com");
  const event = await provisionEvent(
    organizerStore,
    owner.accountId,
    holder.now,
  );
  await membershipStore.admit({
    eventId: event.eventId,
    accountId: alice.accountId,
    anonymity: "identified",
  });
  await membershipStore.admit({
    eventId: event.eventId,
    accountId: bob.accountId,
    anonymity: "identified",
  });
  holder.now = event.session.startsAtMs;
  await organizerStore.advanceLifecycle({ now: holder.now });

  /**
   * @param {string} rawSessionId
   */
  const cookieFor = (rawSessionId) => `hosted-session-v1=${rawSessionId}`;
  // Alice's first connection is the account's writer.
  const aliceFirst = admission.admitEventBoardSocket({
    boardName: event.boardName,
    cookieHeader: cookieFor(alice.rawSessionId),
  });
  const aliceAdmitted = admitted(aliceFirst);
  assert.equal(aliceAdmitted.role, "editor");
  assert.equal(
    admission.noteEventSocketConnected(aliceAdmitted, "socket-a1").writable,
    true,
  );

  // A second tab of the same account is read-only and needs no new seat.
  const aliceSecond = admission.admitEventBoardSocket({
    boardName: event.boardName,
    cookieHeader: cookieFor(alice.rawSessionId),
  });
  const secondAdmitted = admitted(aliceSecond);
  assert.equal(secondAdmitted.role, "reader");
  assert.equal(
    admission.noteEventSocketConnected(secondAdmitted, "socket-a2").writable,
    false,
  );

  // The one-seat event is now full for a different account.
  assert.equal(
    refusedReason(
      admission.admitEventBoardSocket({
        boardName: event.boardName,
        cookieHeader: cookieFor(bob.rawSessionId),
      }),
    ),
    "event_full",
  );

  // When the writer drops, the companion is promoted so the account keeps
  // exactly one writable connection.
  const released = admission.releaseEventSocket("socket-a1");
  assert.equal(released.promotedSocketId, "socket-a2");

  // Bob is still refused while Alice's tab holds the seat.
  assert.equal(
    refusedReason(
      admission.admitEventBoardSocket({
        boardName: event.boardName,
        cookieHeader: cookieFor(bob.rawSessionId),
      }),
    ),
    "event_full",
  );
});

test("the Entry Lock refuses seats to unseated members but never to seated ones", async () => {
  const { accountStore, organizerStore, membershipStore, admission, holder } =
    await createHarness();
  const owner = await provisionAccount(accountStore, "owner@example.com");
  const seated = await provisionAccount(accountStore, "seated@example.com");
  const unseated = await provisionAccount(accountStore, "unseated@example.com");
  const event = await provisionEvent(
    organizerStore,
    owner.accountId,
    holder.now,
  );
  for (const participant of [seated, unseated]) {
    await membershipStore.admit({
      eventId: event.eventId,
      accountId: participant.accountId,
      anonymity: "identified",
    });
  }
  holder.now = event.session.startsAtMs;
  await organizerStore.advanceLifecycle({ now: holder.now });

  /**
   * @param {string} rawSessionId
   */
  const cookieFor = (rawSessionId) => `hosted-session-v1=${rawSessionId}`;
  // The seat is acquired before the lock closes.
  const seatedVerdict = admitted(
    admission.admitEventBoardSocket({
      boardName: event.boardName,
      cookieHeader: cookieFor(seated.rawSessionId),
    }),
  );
  assert.equal(seatedVerdict.role, "editor");
  assert.equal(
    admission.noteEventSocketConnected(seatedVerdict, "socket-seated").admitted,
    true,
  );

  await organizerStore.setEventEntryLock({
    organizerId: event.organizerId ?? event.organizerId,
    eventId: event.eventId,
    locked: true,
    actorAccountId: owner.accountId,
  });

  // A member without a seat cannot acquire one while locked...
  assert.equal(
    refusedReason(
      admission.admitEventBoardSocket({
        boardName: event.boardName,
        cookieHeader: cookieFor(unseated.rawSessionId),
      }),
    ),
    "event_locked",
  );

  // ...but the seated member's connection survives, and even their extra
  // tab joins read-only without needing a new seat.
  const companion = admission.admitEventBoardSocket({
    boardName: event.boardName,
    cookieHeader: cookieFor(seated.rawSessionId),
  });
  assert.ok(admitted(companion).role === "reader");

  // A grace reconnect after all connections drop is a restore, not new entry.
  admission.releaseEventSocket("socket-seated");
  const rejoin = admission.admitEventBoardSocket({
    boardName: event.boardName,
    cookieHeader: cookieFor(seated.rawSessionId),
  });
  assert.ok(admitted(rejoin).role === "editor");
});

test("a raced preview cannot oversubscribe: connect re-checks capacity", async () => {
  const { accountStore, organizerStore, membershipStore, admission, holder } =
    await createHarness();
  const owner = await provisionAccount(accountStore, "owner@example.com");
  const alice = await provisionAccount(accountStore, "alice@example.com");
  const bob = await provisionAccount(accountStore, "bob@example.com");
  const event = await provisionEvent(
    organizerStore,
    owner.accountId,
    holder.now,
  );
  for (const participant of [alice, bob]) {
    await membershipStore.admit({
      eventId: event.eventId,
      accountId: participant.accountId,
      anonymity: "identified",
    });
  }
  holder.now = event.session.startsAtMs;
  await organizerStore.advanceLifecycle({ now: holder.now });

  /**
   * @param {string} rawSessionId
   */
  const cookieFor = (rawSessionId) => `hosted-session-v1=${rawSessionId}`;
  // Both handshakes preview before either connection registers: each sees a
  // free seat on the one-seat event.
  const aliceVerdict = admitted(
    admission.admitEventBoardSocket({
      boardName: event.boardName,
      cookieHeader: cookieFor(alice.rawSessionId),
    }),
  );
  const bobVerdict = admitted(
    admission.admitEventBoardSocket({
      boardName: event.boardName,
      cookieHeader: cookieFor(bob.rawSessionId),
    }),
  );
  assert.equal(aliceVerdict.role, "editor");
  assert.equal(bobVerdict.role, "editor");

  // Alice registers first and takes the seat; Bob's registration is refused
  // and the socket layer drops his connection.
  assert.equal(
    admission.noteEventSocketConnected(aliceVerdict, "socket-alice").admitted,
    true,
  );
  assert.equal(
    admission.noteEventSocketConnected(bobVerdict, "socket-bob").admitted,
    false,
  );
});

test("a dropped seat is retained through the grace window and freed afterwards", async () => {
  const { accountStore, organizerStore, membershipStore, admission, holder } =
    await createHarness();
  const owner = await provisionAccount(accountStore, "owner@example.com");
  const alice = await provisionAccount(accountStore, "alice@example.com");
  const bob = await provisionAccount(accountStore, "bob@example.com");
  const event = await provisionEvent(
    organizerStore,
    owner.accountId,
    holder.now,
  );
  await membershipStore.admit({
    eventId: event.eventId,
    accountId: alice.accountId,
    anonymity: "identified",
  });
  await membershipStore.admit({
    eventId: event.eventId,
    accountId: bob.accountId,
    anonymity: "identified",
  });
  holder.now = event.session.startsAtMs;
  await organizerStore.advanceLifecycle({ now: holder.now });

  /**
   * @param {string} rawSessionId
   */
  const cookieFor = (rawSessionId) => `hosted-session-v1=${rawSessionId}`;
  const aliceFirst = admission.admitEventBoardSocket({
    boardName: event.boardName,
    cookieHeader: cookieFor(alice.rawSessionId),
  });
  assert.ok(aliceFirst.ok);
  admission.noteEventSocketConnected(aliceFirst, "socket-a1");
  admission.releaseEventSocket("socket-a1");

  // Inside the grace window the seat is Alice's to reclaim, and Bob cannot
  // take it even though no connection is live.
  const rejoin = admission.admitEventBoardSocket({
    boardName: event.boardName,
    cookieHeader: cookieFor(alice.rawSessionId),
  });
  assert.ok(admitted(rejoin).role === "editor");
  assert.equal(
    refusedReason(
      admission.admitEventBoardSocket({
        boardName: event.boardName,
        cookieHeader: cookieFor(bob.rawSessionId),
      }),
    ),
    "event_full",
  );

  // After the grace window the seat is released and Bob competes in.
  holder.now += 11 * MINUTE;
  const bobAfterGrace = admission.admitEventBoardSocket({
    boardName: event.boardName,
    cookieHeader: cookieFor(bob.rawSessionId),
  });
  assert.ok(admitted(bobAfterGrace).role === "editor");
});

test("an Event Ban refuses handshake and writes even with a stale verdict", async () => {
  const { accountStore, organizerStore, membershipStore, admission, holder } =
    await createHarness();
  const owner = await provisionAccount(accountStore, "owner@example.com");
  const alice = await provisionAccount(accountStore, "alice@example.com");
  const event = await provisionEvent(
    organizerStore,
    owner.accountId,
    holder.now,
  );
  await membershipStore.admit({
    eventId: event.eventId,
    accountId: alice.accountId,
    anonymity: "identified",
  });
  holder.now = event.session.startsAtMs;
  await organizerStore.advanceLifecycle({ now: holder.now });

  /**
   * @param {string} rawSessionId
   */
  const cookieFor = (rawSessionId) => `hosted-session-v1=${rawSessionId}`;
  const verdict = admission.admitEventBoardSocket({
    boardName: event.boardName,
    cookieHeader: cookieFor(alice.rawSessionId),
  });
  const admissionBeforeBan = admitted(verdict);

  // A ban issued mid-session invalidates an already-admitted connection.
  await membershipStore.banEvent({
    eventId: event.eventId,
    accountId: alice.accountId,
  });
  assert.equal(
    refusedWriteReason(admission.revalidateSocketWrite(admissionBeforeBan)),
    "event_banned",
  );
  assert.equal(
    refusedReason(
      admission.admitEventBoardSocket({
        boardName: event.boardName,
        cookieHeader: cookieFor(alice.rawSessionId),
      }),
    ),
    "event_banned",
  );

  // Lifting the ban restores eligibility but not the revoked membership.
  await membershipStore.unbanEvent({
    eventId: event.eventId,
    accountId: alice.accountId,
  });
  assert.equal(
    refusedReason(
      admission.admitEventBoardSocket({
        boardName: event.boardName,
        cookieHeader: cookieFor(alice.rawSessionId),
      }),
    ),
    "membership_required",
  );
});

test("writes are refused once the session leaves its open window", async () => {
  const { accountStore, organizerStore, membershipStore, admission, holder } =
    await createHarness();
  const owner = await provisionAccount(accountStore, "owner@example.com");
  const alice = await provisionAccount(accountStore, "alice@example.com");
  const event = await provisionEvent(
    organizerStore,
    owner.accountId,
    holder.now,
  );
  await membershipStore.admit({
    eventId: event.eventId,
    accountId: alice.accountId,
    anonymity: "identified",
  });
  holder.now = event.session.startsAtMs;
  await organizerStore.advanceLifecycle({ now: holder.now });

  /**
   * @param {string} rawSessionId
   */
  const cookieFor = (rawSessionId) => `hosted-session-v1=${rawSessionId}`;
  const verdict = admission.admitEventBoardSocket({
    boardName: event.boardName,
    cookieHeader: cookieFor(alice.rawSessionId),
  });
  const openAdmission = admitted(verdict);
  assert.equal(openAdmission.role, "editor");

  // While open, persistent writes validate.
  assert.deepEqual(admission.revalidateSocketWrite(openAdmission), {
    ok: true,
  });

  // After the end time the session drains and writes must stop.
  holder.now = event.session.endsAtMs + 1;
  await organizerStore.advanceLifecycle({
    now: holder.now,
    closeDrainMs: MINUTE,
  });
  assert.equal(
    refusedWriteReason(admission.revalidateSocketWrite(openAdmission)),
    "event_not_open",
  );
});
