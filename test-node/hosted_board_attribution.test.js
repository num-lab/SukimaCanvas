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
} = require("./helpers/hosted_board_fixture.js");
const {
  createFileBoardMutationLedger,
} = require("../server/hosted_event/ledger/store.mjs");
const {
  registerBoardMutationLedgerFactory,
  resetBoardMutationLedgerFactory,
} = require("../server/board/ledger_registry.mjs");

test("every creation tool receives durable server-side attribution", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-attr-tools-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now());
      const { event, hostedModule, boardSession } = fixture;
      const alice = await fixture.addMember("alice@example.com");
      fixture.holder.now = boardSession.startsAtMs;
      await fixture.organizerStore.advanceLifecycle({
        now: fixture.holder.now,
      });
      const connected = await connectSocket(
        scenario,
        hostedModule,
        event.boardName,
        cookieFor(alice.rawSessionId),
        "socket-alice",
      );
      assert.equal(connected.ok, true);
      const aliceSocket = connected.ok === true ? connected.created : null;
      assert.ok(aliceSocket);
      const aliceParticipantId = participantIdentifierFor(
        event.eventId,
        alice.accountId,
      );

      // CREATE for every creation tool shape.
      await scenario.invoke(
        aliceSocket,
        "broadcast",
        rectangleCreate("rect-1", "cm-rect"),
      );
      await scenario.invoke(
        aliceSocket,
        "broadcast",
        ellipseCreate("ellipse-1"),
      );
      await scenario.invoke(aliceSocket, "broadcast", lineCreate("line-1"));
      await scenario.invoke(aliceSocket, "broadcast", textCreate("text-1"));
      await scenario.invoke(aliceSocket, "broadcast", textUpdate("text-1"));
      await scenario.invoke(aliceSocket, "broadcast", pencilCreate("pencil-1"));
      // Pencil live points append to the created stroke.
      await scenario.invoke(aliceSocket, "broadcast", {
        tool: 1,
        type: MutationType.APPEND,
        parent: "pencil-1",
        x: 12,
        y: 14,
      });
      await scenario.invoke(
        aliceSocket,
        "broadcast",
        handCopyBatch("rect-1", "rect-1-copy", "cm-copy"),
      );

      const board = await scenario.getLoadedBoard(event.boardName);
      const debugRejections = aliceSocket.emitted.filter(
        /** @param {{event: string, payload: any}} emitted */
        (emitted) => emitted.event === "mutation_rejected",
      );
      assert.deepEqual(debugRejections, []);
      for (const itemId of [
        "rect-1",
        "ellipse-1",
        "line-1",
        "text-1",
        "pencil-1",
        "rect-1-copy",
      ]) {
        const item = board.get(itemId);
        assert.ok(item, `missing item ${itemId}`);
        assert.equal(
          item.createdBy,
          aliceParticipantId,
          `${itemId} has the wrong creator`,
        );
      }
      // An APPEND extends the creator's stroke without changing attribution.
      assert.equal(board.get("pencil-1").createdBy, aliceParticipantId);

      // The acceptance broadcast carries the opaque identifier, too.
      const acceptance = ownAcceptance(aliceSocket, "cm-rect");
      assert.equal(acceptance.mutation.createdBy, aliceParticipantId);
      assert.equal(typeof acceptance.seq, "number");
      assert.equal(typeof acceptance.acceptedAtMs, "number");

      // The durable ledger records event, board session, account, time,
      // sequence, and the full attributed mutation content.
      const entries = await readLedgerFile(fixture.ledgerDir, event.boardName);
      assert.equal(entries.length, 8);
      const rectEntry = entries.find(
        (entry) => entry.mutation.clientMutationId === "cm-rect",
      );
      assert.ok(rectEntry);
      assert.equal(rectEntry.eventId, event.eventId);
      assert.equal(rectEntry.boardSessionId, boardSession.boardSessionId);
      assert.equal(rectEntry.accountId, alice.accountId);
      assert.equal(rectEntry.seq, acceptance.seq);
      assert.equal(rectEntry.acceptedAtMs, acceptance.acceptedAtMs);
      assert.equal(rectEntry.mutation.createdBy, aliceParticipantId);
      assert.deepEqual(
        entries.map((entry) => entry.seq),
        [1, 2, 3, 4, 5, 6, 7, 8],
      );

      // Payloads never leak the internal account id or the email.
      const payloadText = JSON.stringify(aliceSocket.emitted);
      assert.ok(!payloadText.includes(alice.accountId));
      assert.ok(!payloadText.includes("alice@example.com"));
      const svgPath = path.join(
        /** @type {string} */ (scenario.historyDir),
        `board-${event.boardName}.svg`,
      );
      await board.save();
      const storedSvg = await fs.readFile(svgPath, "utf8");
      assert.ok(
        storedSvg.includes(`data-wbo-created-by="${aliceParticipantId}"`),
      );
      assert.ok(!storedSvg.includes(alice.accountId));
    },
  );
});

test("client-supplied attribution fields are ignored by the server", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-attr-forge-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now());
      const { event, hostedModule, boardSession } = fixture;
      const alice = await fixture.addMember("alice@example.com");
      fixture.holder.now = boardSession.startsAtMs;
      await fixture.organizerStore.advanceLifecycle({
        now: fixture.holder.now,
      });
      const connected = await connectSocket(
        scenario,
        hostedModule,
        event.boardName,
        cookieFor(alice.rawSessionId),
        "socket-alice",
      );
      assert.equal(connected.ok, true);
      const aliceSocket = connected.ok === true ? connected.created : null;
      assert.ok(aliceSocket);

      await scenario.invoke(
        aliceSocket,
        "broadcast",
        rectangleCreate("rect-forge", "cm-forge", {
          createdBy: "pffffffffffffffff",
          accountId: "acct-hax",
        }),
      );

      const board = await scenario.getLoadedBoard(event.boardName);
      const item = board.get("rect-forge");
      assert.ok(item);
      assert.equal(
        item.createdBy,
        participantIdentifierFor(event.eventId, alice.accountId),
      );
      // The forged fields are not stored anywhere on the item.
      assert.equal(item.accountId, undefined);
    },
  );
});

test("a copy is attributed to the copier while the source keeps its creator", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-attr-copy-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now());
      const { event, hostedModule, boardSession } = fixture;
      const alice = await fixture.addMember("alice@example.com");
      const bob = await fixture.addMember("bob@example.com");
      fixture.holder.now = boardSession.startsAtMs;
      await fixture.organizerStore.advanceLifecycle({
        now: fixture.holder.now,
      });
      const aliceConnect = await connectSocket(
        scenario,
        hostedModule,
        event.boardName,
        cookieFor(alice.rawSessionId),
        "socket-alice",
      );
      const bobConnect = await connectSocket(
        scenario,
        hostedModule,
        event.boardName,
        cookieFor(bob.rawSessionId),
        "socket-bob",
      );
      assert.equal(aliceConnect.ok, true);
      assert.equal(bobConnect.ok, true);
      const aliceSocket =
        aliceConnect.ok === true ? aliceConnect.created : null;
      const bobSocket = bobConnect.ok === true ? bobConnect.created : null;
      assert.ok(aliceSocket && bobSocket);

      await scenario.invoke(
        aliceSocket,
        "broadcast",
        rectangleCreate("rect-src", "cm-src"),
      );
      await scenario.invoke(
        bobSocket,
        "broadcast",
        handCopyBatch("rect-src", "rect-copy-bob", "cm-bob-copy"),
      );

      const board = await scenario.getLoadedBoard(event.boardName);
      const aliceParticipantId = participantIdentifierFor(
        event.eventId,
        alice.accountId,
      );
      const bobParticipantId = participantIdentifierFor(
        event.eventId,
        bob.accountId,
      );
      assert.notEqual(aliceParticipantId, bobParticipantId);
      assert.equal(board.get("rect-src").createdBy, aliceParticipantId);
      assert.equal(board.get("rect-copy-bob").createdBy, bobParticipantId);

      const entries = await readLedgerFile(fixture.ledgerDir, event.boardName);
      const copyEntry = entries.find(
        (entry) => entry.mutation.clientMutationId === "cm-bob-copy",
      );
      assert.ok(copyEntry);
      assert.equal(copyEntry.accountId, bob.accountId);
    },
  );
});

test("a duplicate client mutation id never creates a second durable item", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-attr-dup-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now());
      const { event, hostedModule, boardSession } = fixture;
      const alice = await fixture.addMember("alice@example.com");
      fixture.holder.now = boardSession.startsAtMs;
      await fixture.organizerStore.advanceLifecycle({
        now: fixture.holder.now,
      });
      const connected = await connectSocket(
        scenario,
        hostedModule,
        event.boardName,
        cookieFor(alice.rawSessionId),
        "socket-alice",
      );
      assert.equal(connected.ok, true);
      const aliceSocket = connected.ok === true ? connected.created : null;
      assert.ok(aliceSocket);

      const retry = rectangleCreate("rect-dup", "cm-dup");
      await scenario.invoke(aliceSocket, "broadcast", retry);
      await scenario.invoke(aliceSocket, "broadcast", retry);

      const first = ownAcceptance(aliceSocket, "cm-dup");
      const repeated = aliceSocket.emitted.filter(
        /** @param {{event: string, payload: any}} emitted */
        (emitted) =>
          emitted.event === "broadcast" &&
          emitted.payload?.mutation?.clientMutationId === "cm-dup",
      );
      // The retry is re-confirmed with the original sequence, not a new one.
      assert.ok(repeated.length >= 2);
      assert.equal(repeated[1]?.payload.seq, first.seq);

      const entries = await readLedgerFile(fixture.ledgerDir, event.boardName);
      assert.equal(entries.length, 1);
      const board = await scenario.getLoadedBoard(event.boardName);
      assert.ok(board.get("rect-dup"));
      assert.equal(board.getSeq(), 1);
    },
  );
});

test("a failed ledger append rejects the write and drops the mutated board instance", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-attr-fail-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now());
      const { event, hostedModule, boardSession } = fixture;
      const alice = await fixture.addMember("alice@example.com");
      fixture.holder.now = boardSession.startsAtMs;
      await fixture.organizerStore.advanceLifecycle({
        now: fixture.holder.now,
      });

      registerBoardMutationLedgerFactory(() => ({
        async appendEntries() {
          throw new Error("database unavailable");
        },
        async readEntriesAfter() {
          return [];
        },
      }));

      const connected = await connectSocket(
        scenario,
        hostedModule,
        event.boardName,
        cookieFor(alice.rawSessionId),
        "socket-alice",
      );
      assert.equal(connected.ok, true);
      const aliceSocket = connected.ok === true ? connected.created : null;
      assert.ok(aliceSocket);

      await scenario.invoke(
        aliceSocket,
        "broadcast",
        rectangleCreate("rect-lost", "cm-lost"),
      );

      const rejected = aliceSocket.emitted.find(
        /** @param {{event: string, payload: any}} emitted */
        (emitted) => emitted.event === "mutation_rejected",
      );
      assert.ok(rejected);
      assert.equal(rejected.payload.reason, "ledger_unavailable");
      assert.equal(rejected.payload.clientMutationId, "cm-lost");
      // The stale instance is dropped: the connection cannot keep serving
      // state that the durable ledger never confirmed.
      assert.equal(aliceSocket.socket.disconnected, true);

      // Nothing durable was recorded anywhere.
      const entries = await readLedgerFile(fixture.ledgerDir, event.boardName);
      assert.equal(entries.length, 0);

      // A fresh load with a healthy ledger has no trace of the mutation.
      registerBoardMutationLedgerFactory((boardName) =>
        createFileBoardMutationLedger({
          boardName,
          dataDir: fixture.dataDir,
        }),
      );
      const reconnected = await connectSocket(
        scenario,
        hostedModule,
        event.boardName,
        cookieFor(alice.rawSessionId),
        "socket-alice-2",
      );
      assert.equal(reconnected.ok, true);
      const board = await scenario.getLoadedBoard(event.boardName);
      assert.equal(board.get("rect-lost"), undefined);
      assert.equal(board.getSeq(), 0);
      const reSocket = reconnected.ok === true ? reconnected.created : null;
      assert.ok(reSocket);
      const replayBatch = reSocket.emitted.find(
        /** @param {{event: string, payload: any}} emitted */
        (emitted) =>
          emitted.event === "broadcast" &&
          emitted.payload?.type === MutationType.BATCH,
      );
      assert.ok(replayBatch);
      assert.equal(replayBatch.payload.seq, 0);
      assert.deepEqual(replayBatch.payload._children, []);
    },
  );
});

test("a board reload catches up from the ledger past the stored SVG snapshot", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-attr-reload-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now());
      const { event, hostedModule, boardSession } = fixture;
      const alice = await fixture.addMember("alice@example.com");
      fixture.holder.now = boardSession.startsAtMs;
      await fixture.organizerStore.advanceLifecycle({
        now: fixture.holder.now,
      });
      const connected = await connectSocket(
        scenario,
        hostedModule,
        event.boardName,
        cookieFor(alice.rawSessionId),
        "socket-alice",
      );
      assert.equal(connected.ok, true);
      const aliceSocket = connected.ok === true ? connected.created : null;
      assert.ok(aliceSocket);

      await scenario.invoke(
        aliceSocket,
        "broadcast",
        rectangleCreate("rect-snap", "cm-snap"),
      );
      const board = await scenario.getLoadedBoard(event.boardName);
      await board.save();
      const snapshotSeq = board.getSeq();

      // Accepted writes after the snapshot exist only in the ledger.
      await scenario.invoke(
        aliceSocket,
        "broadcast",
        rectangleCreate("rect-lag", "cm-lag"),
      );
      await scenario.invoke(
        aliceSocket,
        "broadcast",
        handCopyBatch("rect-lag", "rect-lag-copy", "cm-lag-copy"),
      );
      const lagSeq = board.getSeq();
      assert.equal(lagSeq, snapshotSeq + 2);

      // Reload from disk: snapshot plus ledger replay. A client whose
      // baseline is the snapshot seq replays the lagging mutations from the
      // hydrated log; anything older refreshes its baseline, exactly like
      // the legacy unload behavior.
      await resetSocketTestState(scenario.sockets);
      const reconnected = await connectSocket(
        scenario,
        hostedModule,
        event.boardName,
        cookieFor(alice.rawSessionId),
        "socket-alice-2",
        String(snapshotSeq),
      );
      assert.equal(reconnected.ok, true);
      const reloaded = await scenario.getLoadedBoard(event.boardName);
      const aliceParticipantId = participantIdentifierFor(
        event.eventId,
        alice.accountId,
      );
      assert.equal(reloaded.get("rect-snap").createdBy, aliceParticipantId);
      assert.equal(reloaded.get("rect-lag").createdBy, aliceParticipantId);
      assert.equal(reloaded.get("rect-lag-copy").createdBy, aliceParticipantId);
      assert.equal(reloaded.getSeq(), lagSeq);

      // The reconnecting socket replays the post-snapshot mutations from the
      // hydrated log, so late joiners see continuous history.
      const reSocket = reconnected.ok === true ? reconnected.created : null;
      assert.ok(reSocket);
      const replayBatch = reSocket.emitted.find(
        /** @param {{event: string, payload: any}} emitted */
        (emitted) =>
          emitted.event === "broadcast" &&
          emitted.payload?.type === MutationType.BATCH,
      );
      assert.ok(replayBatch);
      assert.equal(replayBatch.payload.fromSeq, snapshotSeq);
      assert.equal(replayBatch.payload.seq, lagSeq);
      assert.equal(replayBatch.payload._children.length, lagSeq - snapshotSeq);
      const replayedCreate = replayBatch.payload._children.find(
        /** @param {any} child */
        (child) => child.clientMutationId === "cm-lag",
      );
      assert.ok(replayedCreate);
      assert.equal(replayedCreate.createdBy, aliceParticipantId);
    },
  );
});

test("legacy boards keep their in-memory-only behavior", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-attr-legacy-" },
    async (scenario) => {
      const connected = await scenario.connect({
        id: "legacy-writer",
        query: { board: "legacy-board" },
      });
      await scenario.invoke(
        connected,
        "broadcast",
        rectangleCreate("legacy-rect", "cm-legacy"),
      );
      const board = await scenario.getLoadedBoard("legacy-board");
      const item = board.get("legacy-rect");
      assert.ok(item);
      // No hosted admission on a legacy socket: no operator, no attribution.
      assert.equal(item.createdBy, undefined);
      const acceptance = ownAcceptance(connected, "cm-legacy");
      assert.equal(acceptance.mutation.createdBy, undefined);
    },
  );
  resetBoardMutationLedgerFactory();
});
