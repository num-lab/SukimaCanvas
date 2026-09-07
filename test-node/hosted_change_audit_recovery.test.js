const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const {
  MutationType,
  participantIdentifierFor,
  createFixture,
  connectSocket,
  cookieFor,
  rectangleCreate,
  textCreate,
  pencilCreate,
  handCopyBatch,
  ownAcceptance,
  readLedgerFile,
  createSocketScenario,
  resetSocketTestState,
} = require("./helpers/hosted_board_fixture.js");
const {
  getMutationType,
} = require("../client-data/js/message_tool_metadata.js");

const FORGED_PARTICIPANT_ID = "pffffffffffffffff";

/**
 * @param {number} dx
 * @param {number} dy
 * @returns {{a: number, b: number, c: number, d: number, e: number, f: number}}
 */
const moveTransform = (dx, dy) => ({
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: dx,
  f: dy,
});

/**
 * @param {string} id
 * @param {number} dx
 * @param {number} dy
 * @param {string} clientMutationId
 */
const handMoveBatch = (id, dx, dy, clientMutationId) => ({
  tool: 7,
  clientMutationId,
  _children: [
    {
      type: MutationType.UPDATE,
      id,
      transform: moveTransform(dx, dy),
    },
  ],
});

/**
 * Connects an already-provisioned account's socket and makes sure the Board
 * Session is open.
 *
 * @param {any} scenario
 * @param {any} fixture
 * @param {{rawSessionId: string, accountId: string}} member
 * @param {string} socketId
 * @param {string} [baselineSeq]
 */
async function connectAccount(
  scenario,
  fixture,
  member,
  socketId,
  baselineSeq,
) {
  fixture.holder.now = fixture.boardSession.startsAtMs;
  await fixture.organizerStore.advanceLifecycle({ now: fixture.holder.now });
  const connected = await connectSocket(
    scenario,
    fixture.hostedModule,
    fixture.event.boardName,
    cookieFor(member.rawSessionId),
    socketId,
    baselineSeq,
  );
  assert.equal(connected.ok, true);
  const created = connected.ok === true ? connected.created : null;
  assert.ok(created);
  return { member, socket: created, rawSocket: created.socket };
}

/**
 * Admits a new member by email, opens the Board Session, and connects their
 * socket. Passing `undefined` connects the event Owner (moderator role).
 *
 * @param {any} scenario
 * @param {any} fixture
 * @param {string | undefined} email
 * @param {string} socketId
 * @param {string} [baselineSeq]
 */
async function connectMember(scenario, fixture, email, socketId, baselineSeq) {
  const member = email ? await fixture.addMember(email) : fixture.owner;
  return connectAccount(scenario, fixture, member, socketId, baselineSeq);
}

test("moves, edits, and appends by another participant preserve the original creator and record the operator", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-audit-update-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now());
      const { event } = fixture;
      const alice = await connectMember(
        scenario,
        fixture,
        "alice@example.com",
        "socket-alice",
      );
      const bob = await connectMember(
        scenario,
        fixture,
        "bob@example.com",
        "socket-bob",
      );

      await scenario.invoke(
        alice.socket,
        "broadcast",
        rectangleCreate("rect-1", "cm-rect"),
      );
      await scenario.invoke(alice.socket, "broadcast", textCreate("text-1"));
      await scenario.invoke(
        alice.socket,
        "broadcast",
        pencilCreate("pencil-1"),
      );

      // Bob moves, edits, and appends to Alice's items. Forged attribution
      // fields ride along and must be dropped by normalization.
      await scenario.invoke(
        bob.socket,
        "broadcast",
        handMoveBatch("rect-1", 30, 15, "cm-move"),
      );
      await scenario.invoke(bob.socket, "broadcast", {
        ...textUpdateOf("text-1"),
        createdBy: FORGED_PARTICIPANT_ID,
      });
      await scenario.invoke(bob.socket, "broadcast", {
        tool: 1,
        type: MutationType.APPEND,
        parent: "pencil-1",
        x: 40,
        y: 42,
        createdBy: FORGED_PARTICIPANT_ID,
      });

      const board = await scenario.getLoadedBoard(event.boardName);
      const aliceParticipantId = participantIdentifierFor(
        event.eventId,
        alice.member.accountId,
      );
      assert.equal(board.get("rect-1").createdBy, aliceParticipantId);
      assert.equal(board.get("text-1").createdBy, aliceParticipantId);
      assert.equal(board.get("pencil-1").createdBy, aliceParticipantId);
      // Bob's move actually applied.
      assert.deepEqual(board.get("rect-1").transform, moveTransform(30, 15));

      // The change audit records the actual operator, operation type, time,
      // and target for every accepted mutation, in one contiguous sequence.
      const entries = await readLedgerFile(fixture.ledgerDir, event.boardName);
      assert.deepEqual(
        entries.map((entry) => entry.seq),
        [1, 2, 3, 4, 5, 6],
      );
      assert.deepEqual(
        entries.map((entry) => getMutationType(entry.mutation)),
        [
          MutationType.CREATE,
          MutationType.CREATE,
          MutationType.CREATE,
          MutationType.BATCH,
          MutationType.UPDATE,
          MutationType.APPEND,
        ],
      );
      const [moveEntry, editTextEntry, appendEntry] = entries.slice(3);
      assert.equal(moveEntry.accountId, bob.member.accountId);
      assert.equal(moveEntry.eventId, event.eventId);
      assert.equal(typeof moveEntry.acceptedAtMs, "number");
      assert.equal(moveEntry.mutation._children[0].id, "rect-1");
      assert.equal(editTextEntry.accountId, bob.member.accountId);
      assert.equal(editTextEntry.mutation.id, "text-1");
      assert.equal(appendEntry.accountId, bob.member.accountId);
      assert.equal(appendEntry.mutation.parent, "pencil-1");
      // The forged creator never reached the ledger.
      assert.equal(editTextEntry.mutation.createdBy, undefined);
      assert.equal(appendEntry.mutation.createdBy, undefined);
    },
  );
});

test("copies keep an auditable source relation that clients cannot forge", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-audit-copy-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now());
      const { event } = fixture;
      const alice = await connectMember(
        scenario,
        fixture,
        "alice@example.com",
        "socket-alice",
      );
      const bob = await connectMember(
        scenario,
        fixture,
        "bob@example.com",
        "socket-bob",
      );

      await scenario.invoke(
        alice.socket,
        "broadcast",
        rectangleCreate("rect-src", "cm-src"),
      );
      await scenario.invoke(
        alice.socket,
        "broadcast",
        pencilCreate("pencil-src"),
      );

      await scenario.invoke(
        bob.socket,
        "broadcast",
        handCopyBatch("rect-src", "rect-bob", "cm-copy-rect", {
          createdBy: FORGED_PARTICIPANT_ID,
        }),
      );
      await scenario.invoke(
        bob.socket,
        "broadcast",
        handCopyBatch("pencil-src", "pencil-bob", "cm-copy-pencil"),
      );

      const board = await scenario.getLoadedBoard(event.boardName);
      const aliceParticipantId = participantIdentifierFor(
        event.eventId,
        alice.member.accountId,
      );
      const bobParticipantId = participantIdentifierFor(
        event.eventId,
        bob.member.accountId,
      );
      // Copies belong to the copier; the sources keep their creator.
      assert.equal(board.get("rect-src").createdBy, aliceParticipantId);
      assert.equal(board.get("pencil-src").createdBy, aliceParticipantId);
      assert.equal(board.get("rect-bob").createdBy, bobParticipantId);
      assert.equal(board.get("pencil-bob").createdBy, bobParticipantId);

      // The durable audit ties every copy to its source, its copier, and the
      // event — none of which the client supplied.
      const entries = await readLedgerFile(fixture.ledgerDir, event.boardName);
      const copyRect = entries.find(
        (entry) => entry.mutation.clientMutationId === "cm-copy-rect",
      );
      const copyPencil = entries.find(
        (entry) => entry.mutation.clientMutationId === "cm-copy-pencil",
      );
      assert.ok(copyRect && copyPencil);
      assert.equal(copyRect.eventId, event.eventId);
      assert.equal(copyRect.accountId, bob.member.accountId);
      assert.equal(copyRect.mutation._children[0].id, "rect-src");
      assert.equal(copyRect.mutation._children[0].newid, "rect-bob");
      assert.equal(copyRect.mutation._children[0].createdBy, bobParticipantId);
      assert.equal(copyPencil.mutation._children[0].id, "pencil-src");
      assert.equal(copyPencil.mutation._children[0].newid, "pencil-bob");
      assert.ok(!JSON.stringify(entries).includes(FORGED_PARTICIPANT_ID));
    },
  );
});

test("deletes and clears keep the change audit after the items leave the stored SVG", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-audit-clear-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now());
      const { event } = fixture;
      const alice = await connectMember(
        scenario,
        fixture,
        "alice@example.com",
        "socket-alice",
      );
      const bob = await connectMember(
        scenario,
        fixture,
        "bob@example.com",
        "socket-bob",
      );

      await scenario.invoke(
        alice.socket,
        "broadcast",
        rectangleCreate("rect-1", "cm-rect"),
      );
      await scenario.invoke(alice.socket, "broadcast", textCreate("text-1"));
      await scenario.invoke(bob.socket, "broadcast", {
        tool: 6,
        type: MutationType.DELETE,
        id: "rect-1",
      });
      // Only Owner/Admin moderators hold the Clear capability in hosted mode.
      const owner = await connectMember(
        scenario,
        fixture,
        undefined,
        "socket-owner",
      );
      // Hosted clears record a reason with the operator.
      await scenario.invoke(owner.socket, "broadcast", {
        tool: 11,
        type: MutationType.CLEAR,
        reason: "audit clear",
      });
      const board = await scenario.getLoadedBoard(event.boardName);
      assert.equal(board.get("rect-1"), undefined);
      assert.equal(board.get("text-1"), undefined);
      await board.save();
      const svgPath = path.join(
        /** @type {string} */ (scenario.historyDir),
        `board-${event.boardName}.svg`,
      );
      // Cleared boards persist as no file at all; the audit lives in the
      // ledger, never in the current SVG.
      await assert.rejects(() => fs.access(svgPath), { code: "ENOENT" });

      // A reload replays the whole audit: the board converges to the same
      // confirmed empty state and keeps drawing at the authoritative sequence.
      // The reconnected tab stays a reader (the original socket holds the
      // account's writer slot), so the follow-up write goes through the
      // original socket, which survives the instance reload.
      await resetSocketTestState(scenario.sockets);
      await connectAccount(scenario, fixture, alice.member, "socket-alice-2");
      const reloaded = await scenario.getLoadedBoard(event.boardName);
      assert.equal(reloaded.get("rect-1"), undefined);
      assert.equal(reloaded.get("text-1"), undefined);
      assert.equal(reloaded.getSeq(), 4);
      await scenario.invoke(
        alice.socket,
        "broadcast",
        rectangleCreate("rect-after", "cm-after"),
      );
      assert.equal(
        reloaded.get("rect-after").createdBy,
        participantIdentifierFor(event.eventId, alice.member.accountId),
      );

      const entries = await readLedgerFile(fixture.ledgerDir, event.boardName);
      assert.deepEqual(
        entries.map((entry) => entry.seq),
        [1, 2, 3, 4, 5],
      );
      assert.deepEqual(
        entries.map((entry) => entry.mutation.type),
        [
          MutationType.CREATE,
          MutationType.CREATE,
          MutationType.DELETE,
          MutationType.CLEAR,
          MutationType.CREATE,
        ],
      );
      assert.equal(entries[2].accountId, bob.member.accountId);
      assert.equal(entries[2].mutation.id, "rect-1");
      // The clear was performed by the Owner (the only moderator).
      assert.equal(entries[3].accountId, owner.member.accountId);
      assert.equal(entries[4].accountId, alice.member.accountId);
    },
  );
});

test("a batch mutation is accepted atomically with one sequence or rejected deterministically", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-audit-batch-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now());
      const { event } = fixture;
      const alice = await connectMember(
        scenario,
        fixture,
        "alice@example.com",
        "socket-alice",
      );
      const bob = await connectMember(
        scenario,
        fixture,
        "bob@example.com",
        "socket-bob",
      );

      await scenario.invoke(
        alice.socket,
        "broadcast",
        rectangleCreate("rect-1", "cm-rect"),
      );

      // An accepted tool-owned batch lands as one sequenced audit entry.
      await scenario.invoke(bob.socket, "broadcast", {
        tool: 7,
        clientMutationId: "cm-batch-ok",
        _children: [
          {
            type: MutationType.UPDATE,
            id: "rect-1",
            transform: moveTransform(5, 6),
          },
          { type: MutationType.COPY, id: "rect-1", newid: "rect-bob" },
        ],
      });
      const board = await scenario.getLoadedBoard(event.boardName);
      assert.deepEqual(board.get("rect-1").transform, moveTransform(5, 6));
      const bobParticipantId = participantIdentifierFor(
        event.eventId,
        bob.member.accountId,
      );
      const aliceParticipantId = participantIdentifierFor(
        event.eventId,
        alice.member.accountId,
      );
      assert.equal(board.get("rect-1").createdBy, aliceParticipantId);
      assert.equal(board.get("rect-bob").createdBy, bobParticipantId);
      const acceptance = ownAcceptance(bob.socket, "cm-batch-ok");
      let entries = await readLedgerFile(fixture.ledgerDir, event.boardName);
      assert.equal(entries.length, 2);
      assert.equal(entries[1].seq, acceptance.seq);
      assert.equal(entries[1].mutation._children.length, 2);
      assert.equal(entries[1].accountId, bob.member.accountId);

      // One inadmissible child rejects the whole batch deterministically:
      // no partial application, no sequence, no audit entry.
      await scenario.invoke(bob.socket, "broadcast", {
        tool: 7,
        clientMutationId: "cm-batch-bad",
        _children: [
          {
            type: MutationType.UPDATE,
            id: "rect-1",
            transform: moveTransform(99, 99),
          },
          { type: MutationType.COPY, id: "missing-item", newid: "rect-ghost" },
        ],
      });
      const rejected = bob.socket.emitted.find(
        /** @param {{event: string, payload: any}} emitted */
        (emitted) => emitted.event === "mutation_rejected",
      );
      assert.ok(rejected);
      assert.equal(rejected.payload.reason, "copied object does not exist");
      assert.equal(rejected.payload.clientMutationId, "cm-batch-bad");
      assert.deepEqual(board.get("rect-1").transform, moveTransform(5, 6));
      assert.equal(board.get("rect-ghost"), undefined);
      assert.equal(board.getSeq(), 2);
      entries = await readLedgerFile(fixture.ledgerDir, event.boardName);
      assert.equal(entries.length, 2);
    },
  );
});

test("a corrupt snapshot is quarantined and the board rebuilds exactly from the ledger", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-audit-corrupt-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now());
      const { event } = fixture;
      const alice = await connectMember(
        scenario,
        fixture,
        "alice@example.com",
        "socket-alice",
      );
      const bob = await connectMember(
        scenario,
        fixture,
        "bob@example.com",
        "socket-bob",
      );

      await scenario.invoke(
        alice.socket,
        "broadcast",
        rectangleCreate("rect-1", "cm-rect"),
      );
      await scenario.invoke(
        alice.socket,
        "broadcast",
        pencilCreate("pencil-1"),
      );
      await scenario.invoke(
        bob.socket,
        "broadcast",
        handMoveBatch("rect-1", 12, 24, "cm-move"),
      );
      const board = await scenario.getLoadedBoard(event.boardName);
      await board.save();
      const snapshotSeq = board.getSeq();

      // Accepted writes that only the ledger holds after the snapshot.
      await scenario.invoke(
        bob.socket,
        "broadcast",
        handCopyBatch("rect-1", "rect-bob", "cm-copy"),
      );
      await scenario.invoke(alice.socket, "broadcast", {
        tool: 1,
        type: MutationType.APPEND,
        parent: "pencil-1",
        x: 8,
        y: 9,
      });
      const latestSeq = board.getSeq();

      // Crash with an unreadable snapshot: garbage replaces the primary SVG.
      const svgPath = path.join(
        /** @type {string} */ (scenario.historyDir),
        `board-${event.boardName}.svg`,
      );
      const ledgerBefore = await readLedgerFile(
        fixture.ledgerDir,
        event.boardName,
      );
      await fs.writeFile(svgPath, '<svg id="canvas"><g id="drawingArea">trunc');

      await resetSocketTestState(scenario.sockets);
      await connectAccount(scenario, fixture, alice.member, "socket-alice-2");
      const reloaded = await scenario.getLoadedBoard(event.boardName);
      const aliceParticipantId = participantIdentifierFor(
        event.eventId,
        alice.member.accountId,
      );
      const bobParticipantId = participantIdentifierFor(
        event.eventId,
        bob.member.accountId,
      );
      // The recovery result equals the final state confirmed to clients.
      assert.equal(reloaded.getSeq(), latestSeq);
      assert.deepEqual(reloaded.get("rect-1").transform, moveTransform(12, 24));
      assert.equal(reloaded.get("rect-1").createdBy, aliceParticipantId);
      assert.equal(reloaded.get("pencil-1").createdBy, aliceParticipantId);
      assert.equal(reloaded.get("rect-bob").createdBy, bobParticipantId);

      // The unreadable snapshot was preserved as an explicit quarantine, and
      // the audit boundary (the ledger) is untouched.
      const historyEntries = await fs.readdir(
        /** @type {string} */ (scenario.historyDir),
      );
      const quarantined = historyEntries.filter((name) =>
        name.endsWith(".quarantine"),
      );
      assert.equal(quarantined.length, 1);
      const quarantinedFile = /** @type {string} */ (quarantined[0]);
      const quarantinedContent = await fs.readFile(
        path.join(/** @type {string} */ (scenario.historyDir), quarantinedFile),
        "utf8",
      );
      assert.ok(quarantinedContent.includes("trunc"));
      const ledgerAfter = await readLedgerFile(
        fixture.ledgerDir,
        event.boardName,
      );
      assert.deepEqual(ledgerAfter, ledgerBefore);
      assert.ok(snapshotSeq < latestSeq);
    },
  );
});

test("a save interrupted between the backup and primary rename recovers the newest confirmed state", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-audit-savecrash-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now());
      const { event } = fixture;
      const alice = await connectMember(
        scenario,
        fixture,
        "alice@example.com",
        "socket-alice",
      );
      const bob = await connectMember(
        scenario,
        fixture,
        "bob@example.com",
        "socket-bob",
      );

      await scenario.invoke(
        alice.socket,
        "broadcast",
        rectangleCreate("rect-1", "cm-rect"),
      );
      const board = await scenario.getLoadedBoard(event.boardName);
      await board.save();
      const svgPath = path.join(
        /** @type {string} */ (scenario.historyDir),
        `board-${event.boardName}.svg`,
      );
      const bakPath = `${svgPath}.bak`;
      const stalePrimary = await fs.readFile(svgPath, "utf8");

      await scenario.invoke(
        bob.socket,
        "broadcast",
        handMoveBatch("rect-1", 7, 8, "cm-move"),
      );
      await scenario.invoke(
        bob.socket,
        "broadcast",
        handCopyBatch("rect-1", "rect-bob", "cm-copy"),
      );
      await board.save();
      // A crash between the save's two renames leaves the old primary in
      // place while the tmp→backup rename already replaced the backup with
      // the newer snapshot.
      const newestPrimary = await fs.readFile(svgPath, "utf8");
      assert.notEqual(newestPrimary, stalePrimary);
      await fs.writeFile(svgPath, stalePrimary);
      await fs.writeFile(bakPath, newestPrimary);

      await resetSocketTestState(scenario.sockets);
      await connectAccount(scenario, fixture, alice.member, "socket-alice-2");
      const reloaded = await scenario.getLoadedBoard(event.boardName);
      // Recovery catches the stale primary up to the confirmed state.
      assert.equal(reloaded.getSeq(), 3);
      assert.deepEqual(reloaded.get("rect-1").transform, moveTransform(7, 8));
      assert.ok(reloaded.get("rect-bob"));
      const bobParticipantId = participantIdentifierFor(
        event.eventId,
        bob.member.accountId,
      );
      assert.equal(reloaded.get("rect-bob").createdBy, bobParticipantId);
    },
  );
});

test("a torn ledger tail keeps every confirmed write and accepts new ones after recovery", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-audit-torn-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now());
      const { event } = fixture;
      const alice = await connectMember(
        scenario,
        fixture,
        "alice@example.com",
        "socket-alice",
      );

      await scenario.invoke(
        alice.socket,
        "broadcast",
        rectangleCreate("rect-kept", "cm-kept"),
      );

      // Simulate a crash mid-append: bytes of the in-flight second entry
      // reached the file, but its fsync never completed.
      const ledgerPath = path.join(
        fixture.ledgerDir,
        `${event.boardName}.jsonl`,
      );
      const tornTail = JSON.stringify({
        seq: 2,
        acceptedAtMs: Date.now(),
        eventId: event.eventId,
        boardSessionId: fixture.boardSession.boardSessionId,
        accountId: "acct",
        mutation: rectangleCreate("rect-inflight", "cm-inflight"),
      }).slice(0, 60);
      await fs.appendFile(ledgerPath, tornTail);

      await resetSocketTestState(scenario.sockets);
      const reconnected = await connectAccount(
        scenario,
        fixture,
        alice.member,
        "socket-alice-2",
      );
      const reloaded = await scenario.getLoadedBoard(event.boardName);
      // The confirmed write survives; the unconfirmed one never happened.
      assert.ok(reloaded.get("rect-kept"));
      assert.equal(reloaded.get("rect-inflight"), undefined);
      assert.equal(reloaded.getSeq(), 1);

      // The next accepted write must land on a clean boundary and stay
      // readable — a torn tail left in place would corrupt the file here.
      // It goes through the original socket, which holds the writer slot.
      await scenario.invoke(
        alice.socket,
        "broadcast",
        rectangleCreate("rect-next", "cm-next"),
      );
      assert.ok(reloaded.get("rect-next"));
      assert.ok(reconnected.rawSocket);

      await resetSocketTestState(scenario.sockets);
      await connectAccount(scenario, fixture, alice.member, "socket-alice-3");
      const finalBoard = await scenario.getLoadedBoard(event.boardName);
      assert.ok(finalBoard.get("rect-kept"));
      assert.ok(finalBoard.get("rect-next"));
      assert.equal(finalBoard.getSeq(), 2);
      const entries = await readLedgerFile(fixture.ledgerDir, event.boardName);
      assert.deepEqual(
        entries.map((entry) => entry.seq),
        [1, 2],
      );
    },
  );
});

test("a ledger gap or corruption fails the load loudly instead of serving a diverging board", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-audit-gap-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now());
      const { event } = fixture;
      const alice = await connectMember(
        scenario,
        fixture,
        "alice@example.com",
        "socket-alice",
      );

      await scenario.invoke(
        alice.socket,
        "broadcast",
        rectangleCreate("rect-1", "cm-1"),
      );
      await scenario.invoke(
        alice.socket,
        "broadcast",
        rectangleCreate("rect-2", "cm-2"),
      );
      const ledgerPath = path.join(
        fixture.ledgerDir,
        `${event.boardName}.jsonl`,
      );
      const lines = (await fs.readFile(ledgerPath, "utf8"))
        .split("\n")
        .filter((line) => line !== "");

      // A lost first entry leaves a sequence gap: the load refuses and the
      // connection is closed instead of serving a diverging board.
      await fs.writeFile(ledgerPath, `${lines[1]}\n`);
      await resetSocketTestState(scenario.sockets);
      const gapConnect = await connectAccount(
        scenario,
        fixture,
        alice.member,
        "socket-alice-2",
      );
      assert.equal(gapConnect.rawSocket.disconnected, true);

      // Mid-file corruption fails the read the same way.
      await fs.writeFile(
        ledgerPath,
        `${["{not json}", ...lines.slice(1)].join("\n")}\n`,
      );
      await resetSocketTestState(scenario.sockets);
      const corruptConnect = await connectAccount(
        scenario,
        fixture,
        alice.member,
        "socket-alice-3",
      );
      assert.equal(corruptConnect.rawSocket.disconnected, true);

      // After the fault is repaired, the board loads again with every
      // confirmed write.
      await fs.writeFile(ledgerPath, `${lines.join("\n")}\n`);
      await resetSocketTestState(scenario.sockets);
      await connectAccount(scenario, fixture, alice.member, "socket-alice-4");
      const repaired = await scenario.getLoadedBoard(event.boardName);
      assert.ok(repaired.get("rect-1"));
      assert.ok(repaired.get("rect-2"));
      assert.equal(repaired.getSeq(), 2);
      assert.equal(
        repaired.get("rect-1").createdBy,
        participantIdentifierFor(event.eventId, alice.member.accountId),
      );
    },
  );
});

/** @param {string} id */
function textUpdateOf(id) {
  return { tool: 5, type: MutationType.UPDATE, id, txt: "edited by bob" };
}
