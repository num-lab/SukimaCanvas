const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  createFixture,
  connectSocket,
  cookieFor,
  rectangleCreate,
  ownAcceptance,
  createSocketScenario,
  participantIdentifierFor,
} = require("./helpers/hosted_board_fixture.js");
const {
  createFileBoardArchiveStore,
} = require("../server/hosted_event/archive/store.mjs");
const { getBoardSession } = require("../server/board/session.mjs");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** @param {string} content */
const sha256 = (content) =>
  crypto.createHash("sha256").update(content).digest("hex");

/**
 * Opens the Board Session for drawing and connects a member socket through
 * the real hosted admission gate.
 *
 * @param {any} scenario
 * @param {any} fixture
 * @param {string | undefined} email
 * @param {string} socketId
 */
async function openAndConnect(scenario, fixture, email, socketId) {
  fixture.holder.now = fixture.boardSession.startsAtMs;
  await fixture.organizerStore.advanceLifecycle({ now: fixture.holder.now });
  const member = email ? await fixture.addMember(email) : fixture.owner;
  const connected = await connectSocket(
    scenario,
    fixture.hostedModule,
    fixture.event.boardName,
    cookieFor(member.rawSessionId),
    socketId,
  );
  if (connected.ok === false || !connected.created) {
    throw new Error(
      `socket connection was refused: ${connected.ok === false ? connected.reason : "no socket"}`,
    );
  }
  return { member, created: connected.created };
}

/**
 * Reads the Private Board Archive of a closed session through the archive
 * store.
 *
 * @param {any} fixture
 * @param {string} boardSessionId
 */
async function readArchive(fixture, boardSessionId) {
  const prefix = `board-archives/${boardSessionId}`;
  const manifestKey = `${prefix}/manifest.json`;
  const manifestBytes = await fixture.archiveStore.readArchive(manifestKey);
  assert.ok(manifestBytes, "archive manifest exists");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const canvas = (
    await fixture.archiveStore.readArchive(`${prefix}/canvas.svg`)
  )?.toString("utf8");
  const ledger = (
    await fixture.archiveStore.readArchive(`${prefix}/ledger.jsonl`)
  )?.toString("utf8");
  assert.ok(canvas !== undefined, "archive canvas exists");
  assert.ok(ledger !== undefined, "archive ledger exists");
  return { manifestKey, manifest, canvas, ledger };
}

test("closing seals accepted writes into the archive and refuses later writes deterministically", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-archive-close-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now(), {
        config: scenario.sockets.__config,
      });
      // Wire the real read-only completion notification for live sockets.
      scenario.sockets.__test.registerCloseEffects(
        scenario.sockets.__config,
        fixture.hostedModule,
      );
      const alice = await openAndConnect(
        scenario,
        fixture,
        "alice@example.com",
        "socket-alice",
      );

      // A persistent write while the session is open: accepted and sequenced.
      await scenario.invoke(
        alice.created,
        "broadcast",
        rectangleCreate("rect-1", "cm-1"),
      );
      const acceptance = ownAcceptance(alice.created, "cm-1");
      assert.equal(acceptance.seq, 1);

      // The planned end passes: the session drains, and the write boundary
      // refuses new persistent writes deterministically.
      fixture.holder.now = fixture.boardSession.endsAtMs;
      await fixture.organizerStore.advanceLifecycle({
        now: fixture.holder.now,
      });
      await scenario.invoke(
        alice.created,
        "broadcast",
        rectangleCreate("rect-2", "cm-2"),
      );
      const rejected = alice.created.emitted.find(
        /** @param {{event: string, payload: any}} emitted */
        (emitted) => emitted.event === "mutation_rejected",
      );
      assert.ok(rejected, "a write during closing is rejected");
      assert.equal(rejected.payload.reason, "write_blocked");
      assert.equal(
        alice.created.emitted.some(
          /** @param {{event: string, payload: any}} emitted */
          (emitted) =>
            emitted.event === "broadcast" &&
            emitted.payload?.mutation?.clientMutationId === "cm-2",
        ),
        false,
        "no late write is sequenced",
      );

      // The close pass drains, validates, archives, and seals the session.
      fixture.holder.now = fixture.boardSession.endsAtMs + MINUTE;
      const closed = await fixture.boardArchivePipeline.runDueCloses({
        now: fixture.holder.now,
      });
      assert.equal(closed.length, 1);
      assert.equal(closed[0]?.finalSeq, 1);
      const session = fixture.organizerStore.getBoardSessionForEvent(
        fixture.event.eventId,
      );
      assert.equal(session?.status, "closed");
      assert.equal(session?.archivedFinalSeq, 1);
      assert.ok(session?.archiveKey?.startsWith("board-archives/"));
      assert.ok(
        !session?.archiveKey?.includes(fixture.event.publicId),
        "the internal archive key never embeds the public id",
      );

      // The archive carries the canvas, its item attribution, and the ledger.
      const { manifest, canvas, ledger } = await readArchive(
        fixture,
        /** @type {string} */ (session?.boardSessionId),
      );
      assert.equal(manifest.format, "sukimacanvas-board-archive-v1");
      assert.equal(manifest.finalSeq, 1);
      assert.equal(manifest.itemCount, 1);
      assert.equal(manifest.acceptedMutationCount, 1);
      assert.equal(
        manifest.closedAtMs,
        undefined,
        "the manifest is deterministic: no wall-clock fields",
      );
      assert.equal(
        manifest.integrity["canvas.svg"],
        sha256(canvas ?? ""),
        "the manifest binds the canvas content",
      );
      assert.equal(
        manifest.integrity["ledger.jsonl"],
        sha256(ledger ?? ""),
        "the manifest binds the ledger content",
      );
      assert.ok(canvas?.includes('id="rect-1"'));
      assert.ok(
        canvas?.includes(
          `data-wbo-created-by="${participantIdentifierFor(
            fixture.event.eventId,
            alice.member.accountId,
          )}"`,
        ),
        "item attribution is archived with the canvas",
      );
      assert.ok(!canvas?.includes('id="rect-2"'), "refused writes are absent");
      const ledgerEntries = (ledger ?? "")
        .split("\n")
        .filter(
          /** @param {string} line */
          (line) => line !== "",
        )
        .map(
          /** @param {string} line */
          (line) => JSON.parse(line),
        );
      assert.equal(ledgerEntries.length, 1);
      assert.equal(ledgerEntries[0]?.seq, 1);
      assert.equal(ledgerEntries[0]?.accountId, alice.member.accountId);

      // Connected participants ended on the read-only completion state and
      // cannot regain write access through the old socket.
      const completion = alice.created.emitted.find(
        /** @param {{event: string, payload: any}} emitted */
        (emitted) =>
          emitted.event === "boardstate" &&
          emitted.payload?.eventClosed === true,
      );
      assert.ok(completion, "the completion state is emitted");
      assert.equal(completion.payload.canEdit, false);
      await scenario.invoke(
        alice.created,
        "broadcast",
        rectangleCreate("rect-3", "cm-3"),
      );
      assert.equal(
        alice.created.emitted.some(
          /** @param {{event: string, payload: any}} emitted */
          (emitted) =>
            emitted.event === "broadcast" &&
            emitted.payload?.mutation?.clientMutationId === "cm-3",
        ),
        false,
        "a closed session never accepts writes again",
      );

      // Reconnecting is refused: old pages and sockets only see the event.
      const reconnect = await connectSocket(
        scenario,
        fixture.hostedModule,
        fixture.event.boardName,
        cookieFor(alice.member.rawSessionId),
        "socket-alice-2",
      );
      assert.ok(reconnect.ok === false);
      assert.equal(reconnect.reason, "event_not_open");
      const pageVerdict = fixture.admission.admitEventBoardPage({
        boardName: fixture.event.boardName,
        cookieHeader: cookieFor(alice.member.rawSessionId),
      });
      assert.ok(pageVerdict.ok === false);
      assert.equal(
        pageVerdict.ok === false ? pageVerdict.reason : "",
        "event_not_open",
      );
      assert.equal(
        pageVerdict.ok === false ? pageVerdict.publicId : "",
        fixture.event.publicId,
      );

      // A second close pass changes nothing: the session is terminal.
      const again = await fixture.boardArchivePipeline.runDueCloses({
        now: fixture.holder.now + HOUR,
      });
      assert.deepEqual(again, []);
    },
  );
});

test("an empty Board Session archives a valid empty canvas and closes", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-archive-empty-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now(), {
        config: scenario.sockets.__config,
      });
      fixture.holder.now = fixture.boardSession.endsAtMs + MINUTE;
      await fixture.hostedModule.refreshEventLifecycle();
      const session = fixture.organizerStore.getBoardSessionForEvent(
        fixture.event.eventId,
      );
      assert.equal(session?.status, "closed");

      const { manifest, canvas, ledger } = await readArchive(
        fixture,
        /** @type {string} */ (session?.boardSessionId),
      );
      assert.equal(manifest.finalSeq, 0);
      assert.equal(manifest.itemCount, 0);
      assert.equal(manifest.acceptedMutationCount, 0);
      assert.ok(canvas?.includes('data-wbo-seq="0"'));
      assert.ok(canvas?.includes('<g id="drawingArea"></g>'));
      assert.equal(ledger, "");
      assert.equal(manifest.integrity["canvas.svg"], sha256(canvas ?? ""));
      assert.equal(manifest.integrity["ledger.jsonl"], sha256(""));

      const audit = fixture.organizerStore
        .listAuditForOrganizer(fixture.event.organizerId)
        .filter((record) => record.subjectId === session?.boardSessionId);
      assert.ok(
        audit.some((record) => record.action === "board_session.closed"),
        "the lifecycle record notes the archive",
      );
    },
  );
});

test("a validation failure keeps the session draining and a retry can still seal it", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-archive-invalid-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now(), {
        config: scenario.sockets.__config,
      });
      const alice = await openAndConnect(
        scenario,
        fixture,
        "alice@example.com",
        "socket-alice",
      );
      await scenario.invoke(
        alice.created,
        "broadcast",
        rectangleCreate("rect-1", "cm-1"),
      );

      // Corrupt the audit boundary: the ledger loses its confirmed entry, so
      // snapshot and ledger can no longer agree on the final sequence. The
      // original content is kept so the retry below can restore it.
      const ledgerPath = path.join(
        fixture.ledgerDir,
        `${fixture.event.boardName}.jsonl`,
      );
      const originalLedger = await fs.readFile(ledgerPath, "utf8");
      fixture.holder.now = fixture.boardSession.endsAtMs + MINUTE;
      await fixture.organizerStore.advanceLifecycle({
        now: fixture.holder.now,
      });
      await fs.writeFile(ledgerPath, "");
      const closed = await fixture.boardArchivePipeline.runDueCloses({
        now: fixture.holder.now,
      });
      assert.deepEqual(closed, [], "a failed validation seals nothing");
      const session = fixture.organizerStore.getBoardSessionForEvent(
        fixture.event.eventId,
      );
      assert.equal(session?.status, "closing");
      assert.equal(session?.archiveKey, null);
      assert.equal(
        await fixture.archiveStore.readArchive(
          `board-archives/${session?.boardSessionId}/manifest.json`,
        ),
        null,
        "no archive is produced for a failed close",
      );
      const failures = fixture.organizerStore
        .listAuditForOrganizer(fixture.event.organizerId)
        .filter(
          (record) =>
            record.action === "board_session.archive_failed" &&
            record.subjectId === session?.boardSessionId,
        );
      assert.equal(failures.length, 1, "the failure is observable");

      // Once the ledger agrees again, the next close pass seals the session.
      await fs.writeFile(ledgerPath, originalLedger);
      const retry = await fixture.boardArchivePipeline.runDueCloses({
        now: fixture.holder.now,
      });
      assert.equal(retry.length, 1);
      assert.equal(
        fixture.organizerStore.getBoardSessionForEvent(fixture.event.eventId)
          ?.status,
        "closed",
      );
      const stored = await fixture.archiveStore.readArchive(
        `board-archives/${session?.boardSessionId}/manifest.json`,
      );
      assert.ok(stored, "the retry archives the board");
    },
  );
});

test("already-admitted writes complete across the barrier; later ones are refused", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-archive-barrier-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now(), {
        config: scenario.sockets.__config,
      });
      await openAndConnect(
        scenario,
        fixture,
        "alice@example.com",
        "socket-alice",
      );
      const board = await scenario.getLoadedBoard(fixture.event.boardName);
      const session = getBoardSession(board);
      const operator = {
        eventId: fixture.event.eventId,
        boardSessionId: fixture.boardSession.boardSessionId,
        accountId: fixture.owner.accountId,
        participantId: fixture.owner.participantId,
      };

      // A mutation already inside the acceptance queue when the close
      // barrier lands completes and keeps its deterministic result.
      const admitted = session.acceptPersistentMutation(
        /** @type {any} */ (rectangleCreate("rect-1", "cm-1")),
        Date.now(),
        operator,
      );
      await session.sealWrites();
      const result = await admitted;
      assert.ok(result.ok, "an admitted write completes across the barrier");

      // A mutation enqueued after the barrier is refused deterministically.
      const late = await session.acceptPersistentMutation(
        /** @type {any} */ (rectangleCreate("rect-2", "cm-2")),
        Date.now(),
        operator,
      );
      assert.deepEqual(late, { ok: false, reason: "writes_sealed" });

      // The retry of the accepted mutation still confirms the original entry.
      const retry = await session.acceptPersistentMutation(
        /** @type {any} */ (rectangleCreate("rect-1", "cm-1")),
        Date.now(),
        operator,
      );
      assert.ok(retry.ok);
      assert.equal(
        retry.ok === true ? retry.entry.seq : -1,
        result.ok === true ? result.entry.seq : -1,
      );

      // The close archives exactly the admitted history.
      fixture.holder.now = fixture.boardSession.endsAtMs + MINUTE;
      await fixture.organizerStore.advanceLifecycle({
        now: fixture.holder.now,
      });
      const closed = await fixture.boardArchivePipeline.runDueCloses({
        now: fixture.holder.now,
      });
      assert.equal(closed.length, 1);
      const { manifest, canvas } = await readArchive(
        fixture,
        fixture.boardSession.boardSessionId,
      );
      assert.equal(manifest.finalSeq, 1);
      assert.ok(canvas?.includes('id="rect-1"'));
      assert.ok(!canvas?.includes('id="rect-2"'));
    },
  );
});

test("a close that crashed between archiving and sealing retries over the identical archive", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-archive-crash-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now(), {
        config: scenario.sockets.__config,
      });
      const alice = await openAndConnect(
        scenario,
        fixture,
        "alice@example.com",
        "socket-alice",
      );
      await scenario.invoke(
        alice.created,
        "broadcast",
        rectangleCreate("rect-1", "cm-1"),
      );
      fixture.holder.now = fixture.boardSession.endsAtMs + MINUTE;
      await fixture.organizerStore.advanceLifecycle({
        now: fixture.holder.now,
      });

      // The archive lands, but the process dies before the lifecycle seal.
      const realSeal = fixture.organizerStore.markBoardSessionClosed;
      fixture.organizerStore.markBoardSessionClosed = async () => ({
        ok: false,
        reason: "not_closing",
      });
      await fixture.boardArchivePipeline.runDueCloses({
        now: fixture.holder.now,
      });
      assert.equal(
        fixture.organizerStore.getBoardSessionForEvent(fixture.event.eventId)
          ?.status,
        "closing",
      );
      fixture.organizerStore.markBoardSessionClosed = realSeal;

      // The retry regenerates byte-identical archive objects, so the
      // immutable put accepts them and the session finally seals.
      const retry = await fixture.boardArchivePipeline.runDueCloses({
        now: fixture.holder.now,
      });
      assert.equal(retry.length, 1);
      assert.equal(
        fixture.organizerStore.getBoardSessionForEvent(fixture.event.eventId)
          ?.status,
        "closed",
      );
      const { manifest } = await readArchive(
        fixture,
        fixture.boardSession.boardSessionId,
      );
      assert.equal(manifest.finalSeq, 1);
    },
  );
});

test("archive objects are immutable and refuse unsafe keys", async () => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "wbo-archive-store-"),
  );
  const store = createFileBoardArchiveStore({ dataDir });
  await store.putArchive("board-archives/abc/canvas.svg", "first");
  // Byte-identical re-put is the success of an idempotent retry.
  await store.putArchive("board-archives/abc/canvas.svg", "first");
  await assert.rejects(
    () => store.putArchive("board-archives/abc/canvas.svg", "changed"),
    { code: "WBO_ARCHIVE_OBJECT_EXISTS" },
  );
  assert.equal(
    (await store.readArchive("board-archives/abc/canvas.svg"))?.toString(),
    "first",
    "content under a key can never change",
  );
  assert.equal(await store.readArchive("board-archives/abc/missing"), null);
  for (const unsafe of ["../escape", "/absolute", "has spaces", ".."]) {
    await assert.rejects(() => store.putArchive(unsafe, "x"));
  }
});
