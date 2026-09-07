const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createFixture,
  createSocketScenario,
  connectSocket,
  cookieFor,
  provisionAccount,
  rectangleCreate,
  readLedgerFile,
} = require("./helpers/hosted_board_fixture.js");
const { TOOL_CODE_BY_ID } = require("../client-data/tools/manifest.js");
const { MutationType } = require("../client-data/js/mutation_type.js");
const { SocketEvents } = require("../client-data/js/socket_events.js");
const {
  moderationSocketEffects,
  registerModerationSocketEffects,
} = require("../server/hosted_event/moderation/socket_effects.mjs");

const MINUTE = 60 * 1000;

test.after(() => {
  // The moderation effects registry is process-global; restore the default
  // so unrelated test files never observe scenario registrations.
  registerModerationSocketEffects(null);
});

/**
 * Emits a hosted moderation action through the real socket handler and
 * captures the ack result.
 *
 * @param {any} scenario
 * @param {any} created
 * @param {{[key: string]: unknown}} payload
 */
async function emitModerationAction(scenario, created, payload) {
  /** @type {{ok: boolean, reason?: string} | undefined} */
  let ackResult;
  await scenario.invoke(
    created,
    SocketEvents.MODERATION_ACTION,
    payload,
    (/** @type {any} */ result) => {
      ackResult = result;
    },
  );
  return /** @type {{ok: boolean, reason?: string}} */ (ackResult);
}

/**
 * Requests the event's moderation state through the real socket handler.
 *
 * @param {any} scenario
 * @param {any} created
 */
async function requestModerationState(scenario, created) {
  /** @type {{banned?: {participantId: string, name: string}[]} | undefined} */
  let ackResult;
  await scenario.invoke(
    created,
    SocketEvents.MODERATION_STATE,
    (/** @type {any} */ result) => {
      ackResult = result;
    },
  );
  return /** @type {{banned: {participantId: string, name: string}[]}} */ (
    ackResult
  );
}

/**
 * @param {any[]} emitted
 * @param {string} event
 */
function emittedPayloads(emitted, event) {
  return emitted
    .filter((entry) => entry.event === event)
    .map((entry) => entry.payload);
}

/**
 * @template T
 * @param {T[]} list
 * @returns {T | undefined}
 */
function last(list) {
  return list[list.length - 1];
}

/**
 * Shared world builder used by every test: prepares stores and accounts and
 * hands the caller a ready scenario callback.
 *
 * @param {{moderatorIsMember?: boolean, prepWindow?: boolean}} options
 * @param {(context: any) => Promise<void>} run
 */
async function withModerationWorld(options, run) {
  const now = 1_700_000_000_000;
  const fixture = await createFixture(now, { seats: 4 });
  const moderator = await provisionAccount(
    fixture.accountStore,
    "moderator@example.com",
  );
  const grantedModerator = await fixture.organizerStore.grantEventModerator({
    organizerId: fixture.event.organizerId,
    eventId: fixture.event.eventId,
    targetAccountId: moderator.accountId,
    actorAccountId: fixture.owner.accountId,
  });
  assert.ok(grantedModerator.ok);
  const memberA = await fixture.addMember("member-a@example.com");
  const memberB = await fixture.addMember("member-b@example.com");
  if (options.moderatorIsMember) {
    await fixture.membershipStore.admit({
      eventId: fixture.event.eventId,
      accountId: moderator.accountId,
      anonymity: "identified",
    });
  }
  fixture.holder.now = options.prepWindow
    ? fixture.boardSession.startsAtMs - 5 * MINUTE
    : fixture.boardSession.startsAtMs + MINUTE;
  await fixture.organizerStore.advanceLifecycle({ now: fixture.holder.now });
  await run({ fixture, moderator, memberA, memberB });
}

/**
 * Connects one account through the real hosted admission gate and fails the
 * test on refusal, returning the created socket handle.
 *
 * @param {any} fixture
 * @param {any} account
 * @param {string} id
 */
async function connectAccount(fixture, account, id) {
  const result = await connectSocket(
    fixture.scenario,
    fixture.hostedModule,
    fixture.event.boardName,
    cookieFor(account.rawSessionId),
    id,
  );
  return /** @type {any} */ (result.created);
}

test("role matrix: event moderator moderates but cannot clear; owner clears; members do neither", async () => {
  await withModerationWorld({}, async ({ fixture, moderator, memberA }) => {
    await createSocketScenario({}, async (scenario) => {
      fixture.scenario = scenario;
      scenario.sockets.__test.registerModerationEffects(
        scenario.sockets.__config,
      );
      const ownerSocket = await connectAccount(
        fixture,
        fixture.owner,
        "sock-owner",
      );
      const modSocket = await connectAccount(fixture, moderator, "sock-mod");
      const memberSocket = await connectAccount(
        fixture,
        memberA,
        "sock-member",
      );

      const ownerState = last(
        emittedPayloads(ownerSocket.emitted, SocketEvents.BOARDSTATE),
      );
      const modState = last(
        emittedPayloads(modSocket.emitted, SocketEvents.BOARDSTATE),
      );
      const memberState = last(
        emittedPayloads(memberSocket.emitted, SocketEvents.BOARDSTATE),
      );
      assert.equal(ownerState.canClear, true);
      assert.equal(ownerState.canBan, true);
      assert.equal(ownerState.canEdit, true);
      assert.equal(modState.canClear, false, "event moderator must not clear");
      assert.equal(modState.canBan, true, "event moderator moderates");
      assert.equal(modState.canEdit, true);
      assert.equal(memberState.canClear, false);
      assert.equal(memberState.canBan, false);
      assert.equal(memberState.canEdit, true);
    });
  });
});

test("reports: a participant report reaches moderators, records the trail, and never disconnects", async () => {
  await withModerationWorld(
    {},
    async ({ fixture, moderator, memberA, memberB }) => {
      await createSocketScenario({}, async (scenario) => {
        fixture.scenario = scenario;
        scenario.sockets.__test.registerModerationEffects(
          scenario.sockets.__config,
        );
        const modSocket = await connectAccount(fixture, moderator, "sock-mod");
        const reporter = await connectAccount(
          fixture,
          memberA,
          "sock-reporter",
        );
        const target = await connectAccount(fixture, memberB, "sock-target");

        await scenario.invoke(reporter, "report_user", {
          socketId: target.socket.id,
        });

        const reported = emittedPayloads(
          modSocket.emitted,
          SocketEvents.USER_REPORTED,
        );
        assert.equal(reported.length, 1, "moderators are notified once");
        assert.ok(reported[0].reporterName && reported[0].reportedName);
        // Neither side is disconnected by a hosted report.
        assert.equal(reporter.socket.disconnected, undefined);
        assert.equal(target.socket.disconnected, undefined);
        // The report is recorded with the frozen identity of the target.
        const records = fixture.moderationStore.listForEvent(
          fixture.event.eventId,
        );
        assert.equal(records.length, 1);
        assert.equal(records[0].action, "report");
        assert.ok(
          typeof records[0].targetName === "string" &&
            records[0].targetName.length > 0,
          "the frozen display name is recorded",
        );
        assert.ok(records[0].targetParticipantId);
        assert.equal(records[0].operatorAccountId, memberA.accountId);
        // The report targets the participant, so the reported identity is the
        // event-scoped identifier, not an email or account id.
        assert.ok(!records[0].targetParticipantId.includes("@"));
      });
    },
  );
});

test("reports: self-reports, malformed ids, and cross-event targets are deterministically rejected", async () => {
  await withModerationWorld({}, async ({ fixture, memberA, memberB }) => {
    await createSocketScenario({}, async (scenario) => {
      fixture.scenario = scenario;
      scenario.sockets.__test.registerModerationEffects(
        scenario.sockets.__config,
      );
      const reporter = await connectAccount(fixture, memberA, "sock-reporter");
      // A second participant on the board; its socket id must not resolve
      // for the malformed/cross-board probes below.
      await connectAccount(fixture, memberB, "sock-other");

      await scenario.invoke(reporter, "report_user", {
        socketId: reporter.socket.id,
      });
      await scenario.invoke(reporter, "report_user", { socketId: "" });
      await scenario.invoke(reporter, "report_user", { socketId: 42 });
      await scenario.invoke(reporter, "report_user", {
        socketId: "sock-not-on-this-board",
      });

      assert.equal(
        fixture.moderationStore.listForEvent(fixture.event.eventId).length,
        0,
        "no rejected report reaches the moderation trail",
      );
      assert.equal(reporter.socket.disconnected, undefined);
    });
  });
});

test("reports: reports against governance roles are refused", async () => {
  await withModerationWorld({}, async ({ fixture, moderator, memberA }) => {
    await createSocketScenario({}, async (scenario) => {
      fixture.scenario = scenario;
      scenario.sockets.__test.registerModerationEffects(
        scenario.sockets.__config,
      );
      const modSocket = await connectAccount(fixture, moderator, "sock-mod");
      const reporter = await connectAccount(fixture, memberA, "sock-reporter");

      await scenario.invoke(reporter, "report_user", {
        socketId: modSocket.socket.id,
      });
      assert.equal(
        fixture.moderationStore.listForEvent(fixture.event.eventId).length,
        0,
      );
      assert.equal(modSocket.socket.disconnected, undefined);
    });
  });
});

test("warn: the target stays connected and receives the reason; the record names the operator", async () => {
  await withModerationWorld({}, async ({ fixture, moderator, memberB }) => {
    await createSocketScenario({}, async (scenario) => {
      fixture.scenario = scenario;
      scenario.sockets.__test.registerModerationEffects(
        scenario.sockets.__config,
      );
      const modSocket = await connectAccount(fixture, moderator, "sock-mod");
      const target = await connectAccount(fixture, memberB, "sock-target");

      const ack = await emitModerationAction(scenario, modSocket, {
        action: "warn",
        reason: "be kind",
        socketId: target.socket.id,
      });
      assert.deepEqual(ack, { ok: true });

      const notices = emittedPayloads(
        target.emitted,
        SocketEvents.MODERATION_NOTICE,
      );
      assert.equal(notices.length, 1);
      assert.equal(notices[0].reason, "be kind");
      assert.equal(target.socket.disconnected, undefined);

      const records = fixture.moderationStore.listForEvent(
        fixture.event.eventId,
      );
      assert.equal(records.length, 1);
      assert.equal(records[0].action, "warn");
      assert.equal(records[0].reason, "be kind");
      assert.equal(records[0].operatorAccountId, moderator.accountId);
      assert.equal(records[0].targetAccountId, memberB.accountId);
      assert.ok(records[0].targetParticipantId);
    });
  });
});

test("kick: every connection of the target is evicted without a ban", async () => {
  await withModerationWorld({}, async ({ fixture, moderator, memberB }) => {
    await createSocketScenario({}, async (scenario) => {
      fixture.scenario = scenario;
      scenario.sockets.__test.registerModerationEffects(
        scenario.sockets.__config,
      );
      const modSocket = await connectAccount(fixture, moderator, "sock-mod");
      const target = await connectAccount(fixture, memberB, "sock-target");
      const companion = await connectAccount(
        fixture,
        memberB,
        "sock-companion",
      );

      const ack = await emitModerationAction(scenario, modSocket, {
        action: "kick",
        reason: "spamming",
        socketId: target.socket.id,
      });
      assert.deepEqual(ack, { ok: true });

      for (const evicted of [target, companion]) {
        const notices = emittedPayloads(
          evicted.emitted,
          SocketEvents.MODERATION_DISCONNECT,
        );
        assert.equal(notices.length, 1);
        assert.equal(notices[0].source, "moderator");
        assert.equal(notices[0].banDurationMs, 0);
        assert.equal(evicted.socket.disconnected, true);
      }
      // A kick is not a ban: the membership survives and re-entry is honest.
      assert.ok(
        fixture.membershipStore.getMembership(
          fixture.event.eventId,
          memberB.accountId,
        ),
      );
      assert.equal(
        fixture.membershipStore.isEventBanned(
          fixture.event.eventId,
          memberB.accountId,
        ),
        false,
      );
    });
  });
});

test("ban: the target is evicted, membership revoked, and re-entry blocked everywhere", async () => {
  await withModerationWorld({}, async ({ fixture, moderator, memberB }) => {
    await createSocketScenario({}, async (scenario) => {
      fixture.scenario = scenario;
      scenario.sockets.__test.registerModerationEffects(
        scenario.sockets.__config,
      );
      const modSocket = await connectAccount(fixture, moderator, "sock-mod");
      const target = await connectAccount(fixture, memberB, "sock-target");

      const ack = await emitModerationAction(scenario, modSocket, {
        action: "ban",
        reason: "harassment",
        socketId: target.socket.id,
      });
      assert.deepEqual(ack, { ok: true });

      const notices = emittedPayloads(
        target.emitted,
        SocketEvents.MODERATION_DISCONNECT,
      );
      assert.equal(notices.length, 1);
      assert.equal(notices[0].source, "event_ban");
      assert.equal(target.socket.disconnected, true);

      // The ban revokes the membership and blocks every entry path.
      assert.ok(
        fixture.membershipStore.isEventBanned(
          fixture.event.eventId,
          memberB.accountId,
        ),
      );
      assert.equal(
        fixture.membershipStore.getMembership(
          fixture.event.eventId,
          memberB.accountId,
        ),
        null,
      );
      const refused = fixture.admission.admitEventBoardSocket({
        boardName: fixture.event.boardName,
        cookieHeader: cookieFor(memberB.rawSessionId),
      });
      assert.equal(refused.ok, false);
      assert.equal(refused.reason, "event_banned");
      // Even a direct admit call keeps the ban independent: a record exists
      // only as re-admissible state, and the ban gate still refuses.
      await fixture.membershipStore.admit({
        eventId: fixture.event.eventId,
        accountId: memberB.accountId,
        anonymity: "identified",
      });
      const stillRefused = fixture.admission.admitEventBoardSocket({
        boardName: fixture.event.boardName,
        cookieHeader: cookieFor(memberB.rawSessionId),
      });
      assert.equal(stillRefused.ok, false);
      assert.equal(stillRefused.reason, "event_banned");

      const records = fixture.moderationStore.listForEvent(
        fixture.event.eventId,
      );
      assert.equal(records[0].action, "ban");
      assert.equal(records[0].reason, "harassment");
      assert.equal(records[0].operatorAccountId, moderator.accountId);
    });
  });
});

test("unban: a moderator lifts the ban by participant identifier with a reason", async () => {
  await withModerationWorld({}, async ({ fixture, moderator, memberB }) => {
    await createSocketScenario({}, async (scenario) => {
      fixture.scenario = scenario;
      scenario.sockets.__test.registerModerationEffects(
        scenario.sockets.__config,
      );
      const modSocket = await connectAccount(fixture, moderator, "sock-mod");
      const target = await connectAccount(fixture, memberB, "sock-target");
      const banAck = await emitModerationAction(scenario, modSocket, {
        action: "ban",
        reason: "harassment",
        socketId: target.socket.id,
      });
      assert.deepEqual(banAck, { ok: true });

      const state = await requestModerationState(scenario, modSocket);
      const bannedEntry = state.banned[0];
      assert.ok(bannedEntry, "the banned participant is listed");
      assert.ok(bannedEntry.participantId.startsWith("p"));
      assert.ok(bannedEntry.name, "the frozen display name is listed");

      const unbanAck = await emitModerationAction(scenario, modSocket, {
        action: "unban",
        reason: "appeal accepted",
        participantId: bannedEntry.participantId,
      });
      assert.deepEqual(unbanAck, { ok: true });
      assert.equal(
        fixture.membershipStore.isEventBanned(
          fixture.event.eventId,
          memberB.accountId,
        ),
        false,
      );
      // Unbanning never resurrects the revoked membership: re-entry requires
      // the Access Code again.
      assert.equal(
        fixture.membershipStore.getMembership(
          fixture.event.eventId,
          memberB.accountId,
        ),
        null,
      );
      // An unknown identifier is rejected deterministically.
      const unknownAck = await emitModerationAction(scenario, modSocket, {
        action: "unban",
        reason: "typo",
        participantId: "pdeadbeefdeadbeef",
      });
      assert.equal(unknownAck.ok, false);
    });
  });
});

test("moderation actions require moderation capability and a reason", async () => {
  await withModerationWorld(
    {},
    async ({ fixture, moderator, memberA, memberB }) => {
      await createSocketScenario({}, async (scenario) => {
        fixture.scenario = scenario;
        scenario.sockets.__test.registerModerationEffects(
          scenario.sockets.__config,
        );
        const reporter = await connectAccount(
          fixture,
          memberA,
          "sock-reporter",
        );
        const target = await connectAccount(fixture, memberB, "sock-target");

        const notModerator = await emitModerationAction(scenario, reporter, {
          action: "warn",
          reason: "hostile",
          socketId: target.socket.id,
        });
        assert.equal(notModerator.ok, false);
        assert.equal(notModerator.reason, "not_allowed");

        const modSocket = await connectAccount(fixture, moderator, "sock-mod");
        const noReason = await emitModerationAction(scenario, modSocket, {
          action: "warn",
          reason: "   ",
          socketId: target.socket.id,
        });
        assert.equal(noReason.ok, false);
        assert.equal(noReason.reason, "missing_reason");
        const badAction = await emitModerationAction(scenario, modSocket, {
          action: "nuke",
          reason: "hostile",
          socketId: target.socket.id,
        });
        assert.equal(badAction.ok, false);
        assert.equal(
          fixture.moderationStore.listForEvent(fixture.event.eventId).length,
          0,
        );
      });
    },
  );
});

test("clear: event moderators are refused; Owner/Admin clears with the reason recorded", async () => {
  await withModerationWorld({}, async ({ fixture, moderator, memberA }) => {
    await createSocketScenario({}, async (scenario) => {
      fixture.scenario = scenario;
      scenario.sockets.__test.registerModerationEffects(
        scenario.sockets.__config,
      );
      const modSocket = await connectAccount(fixture, moderator, "sock-mod");
      const ownerSocket = await connectAccount(
        fixture,
        fixture.owner,
        "sock-owner",
      );
      const memberSocket = await connectAccount(
        fixture,
        memberA,
        "sock-member",
      );

      // Seed one item from the member so the clear visibly changes state.
      await scenario.invoke(
        memberSocket,
        "broadcast",
        rectangleCreate("r-seed-1", "cm-seed-1"),
      );
      assert.equal(
        emittedPayloads(memberSocket.emitted, SocketEvents.MUTATION_REJECTED)
          .length,
        0,
      );

      await scenario.invoke(modSocket, "broadcast", {
        tool: TOOL_CODE_BY_ID.clear,
        type: MutationType.CLEAR,
        id: "",
        clientMutationId: "cm-mod-clear",
      });
      assert.equal(
        emittedPayloads(modSocket.emitted, SocketEvents.MUTATION_REJECTED)
          .length,
        1,
      );

      // A hosted clear without a reason is deterministically rejected even
      // for Owner/Admin: the governance trail requires the reason.
      await scenario.invoke(ownerSocket, "broadcast", {
        tool: TOOL_CODE_BY_ID.clear,
        type: MutationType.CLEAR,
        id: "",
        clientMutationId: "cm-owner-clear-no-reason",
      });
      const ownerRejections = emittedPayloads(
        ownerSocket.emitted,
        SocketEvents.MUTATION_REJECTED,
      );
      assert.equal(ownerRejections.length, 1);
      assert.equal(ownerRejections[0].reason, "write_blocked");

      await scenario.invoke(ownerSocket, "broadcast", {
        tool: TOOL_CODE_BY_ID.clear,
        type: MutationType.CLEAR,
        id: "",
        clientMutationId: "cm-owner-clear",
        reason: "resetting for round two",
      });
      assert.equal(
        emittedPayloads(ownerSocket.emitted, SocketEvents.MUTATION_REJECTED)
          .length,
        1,
        "owner clears with the reason",
      );
      await fixture.moderationStore.flush();
      const entries = await readLedgerFile(
        fixture.ledgerDir,
        fixture.event.boardName,
      );
      const clearEntry = entries.find(
        (entry) => entry.mutation?.type === MutationType.CLEAR,
      );
      assert.ok(clearEntry, "the clear is durable in the ledger");
      assert.equal(clearEntry.mutation.reason, "resetting for round two");
      assert.equal(clearEntry.accountId, fixture.owner.accountId);
      const records = fixture.moderationStore.listForEvent(
        fixture.event.eventId,
      );
      const clearRecord = records.find(
        (/** @type {any} */ record) => record.action === "clear",
      );
      assert.ok(clearRecord, "the clear lands in the governance trail");
      assert.equal(clearRecord.reason, "resetting for round two");
      assert.equal(clearRecord.operatorAccountId, fixture.owner.accountId);
    });
  });
});

test("revocation: a revoked moderator's live connection is refreshed or dropped", async () => {
  await withModerationWorld(
    { moderatorIsMember: true },
    async ({ fixture, moderator }) => {
      await createSocketScenario({}, async (scenario) => {
        fixture.scenario = scenario;
        scenario.sockets.__test.registerModerationEffects(
          scenario.sockets.__config,
        );
        const modSocket = await connectAccount(fixture, moderator, "sock-mod");
        const modCreated = /** @type {any} */ (modSocket);
        let modState = last(
          emittedPayloads(modCreated.emitted, SocketEvents.BOARDSTATE),
        );
        assert.equal(modState.canBan, true);
        assert.equal(modState.canClear, false);

        const revokeResult = await fixture.organizerStore.revokeEventModerator({
          organizerId: fixture.event.organizerId,
          eventId: fixture.event.eventId,
          targetAccountId: moderator.accountId,
          actorAccountId: fixture.owner.accountId,
        });
        assert.ok(revokeResult.ok);
        // Production revocation applies the refresh through the effects
        // registry; drive the same seam the console route uses.
        const effects = /** @type {any} */ (moderationSocketEffects());
        await effects.refreshEventAccountAccess(
          fixture.event.eventId,
          moderator.accountId,
        );

        // The demoted moderator is also a member: still connected, now with
        // member capabilities (writer of the account's own seat).
        modState = last(
          emittedPayloads(modCreated.emitted, SocketEvents.BOARDSTATE),
        );
        assert.equal(modState.canBan, false);
        assert.equal(modState.canClear, false);
        assert.equal(modState.canEdit, true);
        assert.equal(modCreated.socket.disconnected, undefined);
      });
    },
  );
});

test("revocation: a revoked moderator without membership is disconnected", async () => {
  await withModerationWorld({}, async ({ fixture, moderator }) => {
    await createSocketScenario({}, async (scenario) => {
      fixture.scenario = scenario;
      scenario.sockets.__test.registerModerationEffects(
        scenario.sockets.__config,
      );
      const modSocket = await connectAccount(fixture, moderator, "sock-mod");

      const revokeResult = await fixture.organizerStore.revokeEventModerator({
        organizerId: fixture.event.organizerId,
        eventId: fixture.event.eventId,
        targetAccountId: moderator.accountId,
        actorAccountId: fixture.owner.accountId,
      });
      assert.ok(revokeResult.ok);
      const effects = moderationSocketEffects();
      await /** @type {any} */ (effects).refreshEventAccountAccess(
        fixture.event.eventId,
        moderator.accountId,
      );
      assert.equal(/** @type {any} */ (modSocket).socket.disconnected, true);
    });
  });
});

test("moderator grants are audited with the actual operator", async () => {
  await withModerationWorld({}, async ({ fixture, moderator }) => {
    const audit = fixture.organizerStore
      .listAuditForOrganizer(fixture.event.organizerId)
      .filter((/** @type {any} */ record) =>
        record.action.startsWith("event_moderator."),
      );
    assert.ok(
      audit.some(
        (/** @type {any} */ record) =>
          record.action === "event_moderator.granted",
      ),
    );
    assert.equal(
      audit.find(
        (/** @type {any} */ record) =>
          record.action === "event_moderator.granted",
      )?.actorAccountId,
      fixture.owner.accountId,
    );
    const revokeResult = await fixture.organizerStore.revokeEventModerator({
      organizerId: fixture.event.organizerId,
      eventId: fixture.event.eventId,
      targetAccountId: moderator.accountId,
      actorAccountId: fixture.owner.accountId,
    });
    assert.ok(revokeResult.ok);
    const auditAfter = fixture.organizerStore
      .listAuditForOrganizer(fixture.event.organizerId)
      .filter(
        (/** @type {any} */ record) =>
          record.action === "event_moderator.revoked",
      );
    assert.equal(auditAfter.length, 1);
  });
});

test("preparation window: event moderators enter while ordinary members cannot", async () => {
  await withModerationWorld(
    { prepWindow: true },
    async ({ fixture, moderator, memberA }) => {
      const modVerdict = fixture.admission.admitEventBoardPage({
        boardName: fixture.event.boardName,
        cookieHeader: cookieFor(moderator.rawSessionId),
      });
      assert.equal(modVerdict.ok, true);
      assert.equal(modVerdict.role, "event_moderator");
      const memberVerdict = fixture.admission.admitEventBoardPage({
        boardName: fixture.event.boardName,
        cookieHeader: cookieFor(memberA.rawSessionId),
      });
      assert.equal(memberVerdict.ok, false);
      assert.equal(memberVerdict.reason, "event_not_open");
    },
  );
});
