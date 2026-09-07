const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { createSocket, createSocketScenario } = require("./test_helpers.js");
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
  createFileBoardMutationLedger,
} = require("../server/hosted_event/ledger/store.mjs");
const {
  createFileOrganizerStore,
} = require("../server/hosted_event/organizers/store.mjs");
const {
  createFileEventMembershipStore,
} = require("../server/hosted_event/memberships/store.mjs");
const {
  registerBoardMutationLedgerFactory,
  resetBoardMutationLedgerFactory,
} = require("../server/board/ledger_registry.mjs");
const { MutationType } = require("../client-data/js/mutation_type.js");

// The ledger factory is process-global; restore the no-ledger default once
// this file's tests are done.
test.after(() => {
  resetBoardMutationLedgerFactory();
});

/**
 * @param {Array<{event: string, payload: any}>} emitted
 * @param {string} eventName
 */
function getRequired(emitted, eventName) {
  const found = emitted.find((event) => event.event === eventName);
  assert.notEqual(found, undefined);
  return /** @type {{event: string, payload: any}} */ (found);
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Composes the hosted stores, admission module, and a board-name map so
 * socket scenarios can pin admission verdicts exactly like the real
 * middleware does.
 */
/**
 * @param {number} now
 */
async function createAdmissionFixture(now) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-socket-seats-"));
  const holder = { now };
  const clock = () => holder.now;
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
    participantIdentifierFor: createParticipantIdentifierResolver(
      "test-attribution-secret",
    ),
    clock,
  });
  // Hosted composition registers the durable mutation ledger factory; the
  // socket scenario replicates it so accepted writes pass the same gate.
  registerBoardMutationLedgerFactory((boardName) =>
    createFileBoardMutationLedger({ boardName, dataDir }),
  );
  // The exact surface the socket layer consumes through
  // socket.hostedEventModule in hosted mode.
  const hostedModule = { enabled: true, ...admission };

  const owner = await provisionAccount(accountStore, "owner@example.com");
  const app = await organizerStore.submitApplication({
    accountId: owner.accountId,
    organizerName: "Aurora Collective",
    contactName: "Mika Rin",
    contactEmail: "contact@example.com",
  });
  assert.ok(app.ok);
  const approved = await organizerStore.approveApplication({
    applicationId: app.application.applicationId,
    operatorAccountId: "operator",
  });
  assert.ok(approved.ok);
  const created = await organizerStore.createReservation({
    organizerId: approved.organizerId,
    createdByAccountId: owner.accountId,
    eventName: "Socket Seat Jam",
    visibility: "public",
    startsAtMs: now + DAY,
    endsAtMs: now + DAY + HOUR,
    requestedSeats: 1,
  });
  await organizerStore.submitReservation({
    reservationId: created.reservation.reservationId,
    actorAccountId: owner.accountId,
    now: 0,
  });
  const operatorApproved = await organizerStore.approveReservation({
    reservationId: created.reservation.reservationId,
    operatorAccountId: "operator",
    now: 0,
    bufferMs: 15 * MINUTE,
    sessionLimit: 20,
    seatLimit: 1000,
  });
  assert.ok(operatorApproved.ok);
  const fixtureEvent = organizerStore.getEventById(operatorApproved.eventId);
  assert.ok(fixtureEvent);
  const event = fixtureEvent;
  const ownerCookie = `hosted-session-v1=${owner.rawSessionId}`;

  /**
   * Admits a member account and returns the verdict the middleware would
   * have pinned on the socket.
   *
   * @param {{email?: string, seats?: number}} [options]
   */
  const addMember = async (options = {}) => {
    const member = await provisionAccount(
      accountStore,
      options.email ||
        `member-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    );
    await membershipStore.admit({
      eventId: event.eventId,
      accountId: member.accountId,
      anonymity: "identified",
    });
    return member;
  };

  return {
    holder,
    organizerStore,
    membershipStore,
    admission,
    hostedModule,
    event,
    owner: { ...owner, cookie: ownerCookie },
    addMember,
  };
}

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

/**
 * Connects a socket through the REAL hosted admission gate (the same
 * `admitHostedSocket` the production middleware runs, including the durable
 * lifecycle refresh) and then the real connection handler. Sockets present
 * their identity exactly like a browser: a hosted session cookie in the
 * handshake headers and the board name in the handshake query.
 *
 * @param {{sockets: any}} scenario
 * @param {{enabled: boolean}} hostedModule
 * @param {string} boardName
 * @param {string | undefined} cookieHeader
 * @param {string} socketId
 * @returns {Promise<{ok: true, created: any} | {ok: false, reason: string}>}
 */
async function connectSocket(
  scenario,
  hostedModule,
  boardName,
  cookieHeader,
  socketId,
) {
  const created = createSocket({
    id: socketId,
    remoteAddress: "203.0.113.70",
    query: { board: boardName, baselineSeq: "0" },
    handshakeHeaders: cookieHeader ? { cookie: cookieHeader } : {},
  });
  // The test fake predates the hosted fields; the middleware would set this.
  /** @type {any} */ (created.socket).hostedEventModule = hostedModule;
  const admission = await scenario.sockets.__test.admitHostedSocket(
    created.socket,
  );
  if (admission.ok === false) return { ok: false, reason: admission.reason };
  await scenario.sockets.__test.handleSocketConnection(
    created.socket,
    scenario.sockets.__config,
  );
  return { ok: true, created };
}

/**
 * @param {string} id
 * @param {string} clientMutationId
 */
const rectangleCreate = (id, clientMutationId) => ({
  tool: 3,
  type: MutationType.CREATE,
  id,
  color: "#1f2937",
  size: 10,
  x: 10,
  y: 10,
  x2: 60,
  y2: 40,
  clientMutationId,
});

test("the hosted socket gate enforces the admission matrix end to end", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-hosted-seats-" },
    async (scenario) => {
      const fixture = await createAdmissionFixture(Date.now());
      const {
        hostedModule,
        event: fixtureEvent,
        organizerStore,
        membershipStore,
        admission,
        addMember,
        holder,
      } = fixture;
      assert.ok(fixtureEvent);
      const event = fixtureEvent;
      /**
       * @param {string} rawSessionId
       */
      const cookieFor = (rawSessionId) => `hosted-session-v1=${rawSessionId}`;

      // A legacy or arbitrary board name is refused outright.
      const legacy = await connectSocket(
        scenario,
        hostedModule,
        "some-legacy-board",
        undefined,
        "socket-legacy",
      );
      assert.equal(legacy.ok, false);
      assert.ok(
        legacy.ok === false && legacy.reason === "hosted_board_required",
      );

      const alice = await addMember({ email: "alice@example.com" });
      const bob = await addMember({ email: "bob@example.com" });

      // Scheduled, outside the Preparation Window: members are refused.
      const tooEarly = await connectSocket(
        scenario,
        hostedModule,
        event.boardName,
        cookieFor(alice.rawSessionId),
        "socket-alice-early",
      );
      assert.equal(tooEarly.ok, false);
      assert.ok(tooEarly.ok === false && tooEarly.reason === "event_not_open");

      // Open the session.
      const session = organizerStore.getBoardSessionForEvent(event.eventId);
      assert.ok(session);
      holder.now = session.startsAtMs;
      await organizerStore.advanceLifecycle({ now: holder.now });

      // A member without a hosted session has no identity to admit.
      const anonymous = await connectSocket(
        scenario,
        hostedModule,
        event.boardName,
        undefined,
        "socket-anonymous",
      );
      assert.equal(anonymous.ok, false);
      assert.ok(
        anonymous.ok === false && anonymous.reason === "account_required",
      );

      // Tab 1 holds the writable connection.
      const tab1Connect = await connectSocket(
        scenario,
        hostedModule,
        event.boardName,
        cookieFor(alice.rawSessionId),
        "socket-alice-1",
      );
      assert.equal(tab1Connect.ok, true);
      const tab1 = tab1Connect.ok === true ? tab1Connect.created : null;
      assert.ok(tab1);
      const tab1State = getRequired(tab1.emitted, "boardstate");
      assert.equal(tab1State.payload.canEdit, true);

      // A second account on a one-seat event is refused at the gate.
      const full = await connectSocket(
        scenario,
        hostedModule,
        event.boardName,
        cookieFor(bob.rawSessionId),
        "socket-bob",
      );
      assert.equal(full.ok, false);
      assert.ok(full.ok === false && full.reason === "event_full");

      // Tab 2 of the same account is explicitly read-only.
      const tab2Connect = await connectSocket(
        scenario,
        hostedModule,
        event.boardName,
        cookieFor(alice.rawSessionId),
        "socket-alice-2",
      );
      assert.equal(tab2Connect.ok, true);
      const tab2 = tab2Connect.ok === true ? tab2Connect.created : null;
      assert.ok(tab2);
      const tab2State = getRequired(tab2.emitted, "boardstate");
      assert.equal(tab2State.payload.canEdit, false);

      // Tab 2's persistent write is rejected as write_blocked.
      await scenario.invoke(
        tab2,
        "broadcast",
        rectangleCreate("rect-alice-tab2", "cm-tab2-1"),
      );
      assert.ok(
        tab2.emitted.some(
          /** @param {{event: string, payload: any}} emitted */
          (emitted) =>
            emitted.event === "mutation_rejected" &&
            emitted.payload.reason === "write_blocked",
        ),
      );

      // An Event Ban issued mid-session invalidates the live connection's
      // writes even though the handshake was admitted.
      await membershipStore.banEvent({
        eventId: event.eventId,
        accountId: alice.accountId,
      });
      await scenario.invoke(
        tab1,
        "broadcast",
        rectangleCreate("rect-banned", "cm-banned-1"),
      );
      assert.ok(
        tab1.emitted.some(
          /** @param {{event: string, payload: any}} emitted */
          (emitted) =>
            emitted.event === "mutation_rejected" &&
            emitted.payload.reason === "write_blocked",
        ),
      );
      await membershipStore.unbanEvent({
        eventId: event.eventId,
        accountId: alice.accountId,
      });
      // The ban revoked the membership; re-admission needs the Access Code
      // again, but the pre-ban connections keep their registry entries until
      // they disconnect.
      const afterBan = admission.admitEventBoardSocket({
        boardName: event.boardName,
        cookieHeader: cookieFor(alice.rawSessionId),
      });
      assert.equal(afterBan.ok, false);
      assert.ok(
        afterBan.ok === false && afterBan.reason === "membership_required",
      );

      // Tab 1 disconnects; tab 2 is promoted and told it may edit again.
      await scenario.invoke(tab1, "disconnecting", "transport close");
      const refresh = tab2.emitted.filter(
        /** @param {{event: string, payload: any}} emitted */
        (emitted) => emitted.event === "boardstate",
      );
      assert.equal(refresh.length >= 2, true);
      assert.equal(refresh[refresh.length - 1]?.payload.canEdit, true);

      // Now tab 2's write goes through and is broadcast.
      await scenario.invoke(
        tab2,
        "broadcast",
        rectangleCreate("rect-alice-2", "cm-tab2-2"),
      );
      assert.ok(
        tab2.emitted.some(
          /** @param {{event: string, payload: any}} emitted */
          (emitted) =>
            emitted.event === "broadcast" &&
            !(
              emitted.payload.type === MutationType.BATCH &&
              Array.isArray(emitted.payload._children)
            ),
        ),
      );
    },
  );
});
