/** Shared hosted-event composition for board attribution and audit tests. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  createSocket,
  createSocketScenario,
  resetSocketTestState,
} = require("../test_helpers.js");
const {
  createFileAccountStore,
} = require("../../server/hosted_event/accounts/store.mjs");
const {
  createEventAdmission,
} = require("../../server/hosted_event/admission/index.mjs");
const {
  createParticipantIdentifierResolver,
} = require("../../server/hosted_event/attribution.mjs");
const {
  createFileBoardArchiveStore,
} = require("../../server/hosted_event/archive/store.mjs");
const {
  createBoardArchivePipeline,
} = require("../../server/hosted_event/archive/close.mjs");
const {
  createFileBoardMutationLedger,
} = require("../../server/hosted_event/ledger/store.mjs");
const {
  registerBoardMutationLedgerFactory,
} = require("../../server/board/ledger_registry.mjs");
const {
  createFileOrganizerStore,
} = require("../../server/hosted_event/organizers/store.mjs");
const {
  createFileEventMembershipStore,
} = require("../../server/hosted_event/memberships/store.mjs");
const {
  createFileModerationStore,
} = require("../../server/hosted_event/moderation/store.mjs");
const {
  createEventModeration,
} = require("../../server/hosted_event/moderation/index.mjs");
const { MutationType } = require("../../client-data/js/mutation_type.js");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ATTRIBUTION_SECRET = "attribution-test-secret";
const participantIdentifierFor =
  createParticipantIdentifierResolver(ATTRIBUTION_SECRET);

/**
 * Composes the hosted stores, admission module, close pipeline, and the
 * durable mutation ledger exactly like the hosted module composition does,
 * against one shared controllable clock in a temporary data directory, and
 * registers the ledger factory for the socket scenario.
 *
 * @param {number} now
 * @param {{seats?: number, config?: any}} [options]
 */
async function createFixture(now, { seats = 2, config } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-attr-"));
  const holder = { now };
  const clock = () => holder.now;
  // The close pipeline loads boards through the same config the socket
  // scenario uses, so snapshot saves land in the scenario's history dir.
  const resolvedConfig = config || require("../../server/configuration.mjs");
  const accountStore = createFileAccountStore({
    dataDir,
    clock,
    sessionMaxAgeMs: 1000 * DAY,
    sessionIdleMs: 1000 * DAY,
  });
  const organizerStore = createFileOrganizerStore({ dataDir, clock });
  const membershipStore = createFileEventMembershipStore({ dataDir, clock });
  const moderationStore = createFileModerationStore({ dataDir, clock });
  const eventModeration = createEventModeration({
    organizerStore,
    membershipStore,
    moderationStore,
    participantIdentifierFor,
  });
  const admission = createEventAdmission({
    seatGraceMs: 10 * MINUTE,
    accountStore,
    organizerStore,
    membershipStore,
    participantIdentifierFor,
    clock,
  });
  registerBoardMutationLedgerFactory((boardName) =>
    createFileBoardMutationLedger({ boardName, dataDir }),
  );
  const archiveStore = createFileBoardArchiveStore({ dataDir });
  const boardArchivePipeline = createBoardArchivePipeline({
    organizerStore,
    archiveStore,
    config: resolvedConfig,
    clock,
  });
  const hostedModule = {
    enabled: true,
    ...admission,
    ...eventModeration,
    moderationStore,
    registerBoardCloseEffects: boardArchivePipeline.registerCloseEffects,
    // Mirrors the composed hosted module: admission advances the durable
    // lifecycle and seals drained sessions against the fixture clock before
    // every decision.
    refreshEventLifecycle: async () => {
      const now = holder.now;
      await organizerStore.advanceLifecycle({ now });
      await boardArchivePipeline.runDueCloses({ now });
    },
  };

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
    eventName: "Attribution Jam",
    visibility: "public",
    startsAtMs: now + DAY,
    endsAtMs: now + DAY + HOUR,
    requestedSeats: seats,
  });
  assert.ok(created.ok);
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
  const event = organizerStore.getEventById(operatorApproved.eventId);
  assert.ok(event);
  const boardSession = organizerStore.getBoardSessionForEvent(event.eventId);
  assert.ok(boardSession);

  /**
   * @param {string} email
   */
  const addMember = async (email) => {
    const member = await provisionAccount(accountStore, email);
    await membershipStore.admit({
      eventId: event.eventId,
      accountId: member.accountId,
      anonymity: "identified",
    });
    return member;
  };

  return {
    holder,
    dataDir,
    ledgerDir: path.join(dataDir, "mutation-ledger"),
    archiveDir: path.join(dataDir, "board-archives"),
    archiveStore,
    boardArchivePipeline,
    accountStore,
    organizerStore,
    membershipStore,
    admission,
    hostedModule,
    eventModeration,
    moderationStore,
    event,
    boardSession,
    owner: {
      ...owner,
      participantId: participantIdentifierFor(event.eventId, owner.accountId),
    },
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
 * Connects a socket through the real hosted admission gate and connection
 * handler, exactly like the production middleware composes them.
 *
 * @param {any} scenario
 * @param {{enabled: boolean}} hostedModule
 * @param {string} boardName
 * @param {string | undefined} cookie
 * @param {string} id
 * @param {string} [baselineSeq]
 */
async function connectSocket(
  scenario,
  hostedModule,
  boardName,
  cookie,
  id,
  baselineSeq = "0",
) {
  const created = createSocket({
    id,
    remoteAddress: "203.0.113.70",
    query: { board: boardName, baselineSeq },
    handshakeHeaders: cookie ? { cookie } : {},
  });
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

/** @param {string} rawSessionId */
const cookieFor = (rawSessionId) => `hosted-session-v1=${rawSessionId}`;

/**
 * @param {string} id
 * @param {string} clientMutationId
 * @param {{[key: string]: unknown}} [overrides]
 */
const rectangleCreate = (id, clientMutationId, overrides = {}) => ({
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
  ...overrides,
});

/** @param {string} id */
const ellipseCreate = (id) => ({
  tool: 4,
  type: MutationType.CREATE,
  id,
  color: "#222222",
  size: 10,
  x: 0,
  y: 0,
  x2: 30,
  y2: 30,
  clientMutationId: `cm-${id}`,
});

/** @param {string} id */
const lineCreate = (id) => ({
  tool: 2,
  type: MutationType.CREATE,
  id,
  color: "#333333",
  size: 10,
  x: 5,
  y: 5,
  x2: 95,
  y2: 55,
  clientMutationId: `cm-${id}`,
});

/** @param {string} id */
const textCreate = (id) => ({
  tool: 5,
  type: MutationType.CREATE,
  id,
  color: "#444444",
  size: 24,
  x: 20,
  y: 40,
  clientMutationId: `cm-${id}`,
});

/** @param {string} id */
const textUpdate = (id) => ({
  tool: 5,
  type: MutationType.UPDATE,
  id,
  txt: "attributed",
});

/** @param {string} id */
const pencilCreate = (id) => ({
  tool: 1,
  type: MutationType.CREATE,
  id,
  color: "#555555",
  size: 10,
  clientMutationId: `cm-${id}`,
});

/**
 * @param {string} id
 * @param {string} newid
 * @param {string} clientMutationId
 * @param {{[key: string]: unknown}} [overrides]
 */
const handCopyBatch = (id, newid, clientMutationId, overrides = {}) => ({
  tool: 7,
  clientMutationId,
  _children: [
    {
      type: MutationType.COPY,
      id,
      newid,
      ...overrides,
    },
  ],
});

/**
 * The sender's own sequenced acceptance broadcast for a mutation id.
 *
 * @param {{emitted: {event: string, payload: any}[]}} created
 * @param {string} clientMutationId
 */
function ownAcceptance(created, clientMutationId) {
  const found = created.emitted.find(
    /** @param {{event: string, payload: any}} emitted */
    (emitted) =>
      emitted.event === "broadcast" &&
      emitted.payload?.mutation?.clientMutationId === clientMutationId,
  );
  assert.ok(found, `no sequenced acceptance for ${clientMutationId}`);
  return found.payload;
}

/**
 * Reads the board's durable ledger entries straight from disk.
 *
 * @param {string} ledgerDir
 * @param {string} boardName
 */
async function readLedgerFile(ledgerDir, boardName) {
  try {
    const content = await fs.readFile(
      path.join(ledgerDir, `${boardName}.jsonl`),
      "utf8",
    );
    return content
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (/** @type {any} */ (error)?.code === "ENOENT") return [];
    throw error;
  }
}

module.exports = {
  ATTRIBUTION_SECRET,
  MutationType,
  participantIdentifierFor,
  createFixture,
  provisionAccount,
  connectSocket,
  cookieFor,
  rectangleCreate,
  ellipseCreate,
  lineCreate,
  textCreate,
  textUpdate,
  pencilCreate,
  handCopyBatch,
  ownAcceptance,
  readLedgerFile,
  createSocketScenario,
  resetSocketTestState,
};
