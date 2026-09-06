const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const {
  createFixture,
  connectSocket,
  cookieFor,
  rectangleCreate,
  createSocketScenario,
} = require("./helpers/hosted_board_fixture.js");
const {
  createFileBoardArchiveStore,
} = require("../server/hosted_event/archive/store.mjs");
const {
  createBoardArchivePipeline,
} = require("../server/hosted_event/archive/close.mjs");
const {
  createFileOrganizerStore,
} = require("../server/hosted_event/organizers/store.mjs");
const { deleteLoadedBoard } = require("../server/board/registry.mjs");
const PRODUCTION_CONFIG = require("../server/configuration.mjs");
const { closeServer } = require("./test_helpers.js");
const {
  STRONG_PASSWORD,
  createHostedServer,
  requestWithCookies,
  signUpAndLogin,
} = require("./helpers/hosted_http.js");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const OPERATOR_EMAIL = "operator@example.com";

/**
 * A storage fault that fails only the manifest (the archive's commit marker),
 * leaving the canvas and ledger objects in place — the exact interruption a
 * crash mid-close produces.
 *
 * @param {any} fixture
 * @returns {() => void} restores the real store
 */
function failManifestWrites(fixture) {
  const realPut = fixture.archiveStore.putArchive.bind(fixture.archiveStore);
  fixture.archiveStore.putArchive = async (
    /** @type {string} */ key,
    /** @type {string | Uint8Array} */ content,
  ) => {
    if (key.endsWith("/manifest.json")) {
      const error = /** @type {Error & {code: string}} */ (
        new Error(
          "EACCES: permission denied, open 'board-archives/manifest.json'",
        )
      );
      error.code = "EACCES";
      throw error;
    }
    return realPut(key, content);
  };
  return () => {
    fixture.archiveStore.putArchive = realPut;
  };
}

/**
 * Opens the Board Session and connects the organizer's socket through the
 * real hosted admission gate.
 *
 * @param {any} scenario
 * @param {any} fixture
 * @returns {Promise<any>} the connected socket wrapper
 */
async function openOwnerSocket(scenario, fixture) {
  fixture.holder.now = fixture.boardSession.startsAtMs;
  await fixture.organizerStore.advanceLifecycle({
    now: fixture.holder.now,
  });
  const connected = await connectSocket(
    scenario,
    fixture.hostedModule,
    fixture.event.boardName,
    cookieFor(fixture.owner.rawSessionId),
    "socket-owner",
  );
  if (connected.ok === false || !connected.created) {
    throw new Error(
      `socket connection was refused: ${connected.ok === false ? connected.reason : "no socket"}`,
    );
  }
  return connected.created;
}

test("an object storage fault is a recoverable ARCHIVE_FAILED, retried automatically after its backoff", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-archive-storage-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now(), {
        config: scenario.sockets.__config,
      });
      scenario.sockets.__test.registerCloseEffects(
        scenario.sockets.__config,
        fixture.hostedModule,
      );
      // Open the session before anyone can connect through admission.
      const alice = await openOwnerSocket(scenario, fixture);
      await scenario.invoke(
        alice,
        "broadcast",
        rectangleCreate("rect-1", "cm-1"),
      );
      fixture.holder.now = fixture.boardSession.endsAtMs + MINUTE;
      await fixture.organizerStore.advanceLifecycle({
        now: fixture.holder.now,
      });

      // The commit marker cannot be persisted: canvas and ledger objects
      // exist, no manifest vouches for them, and the session is visibly
      // failed — never reported as closed.
      const restoreStorage = failManifestWrites(fixture);
      const closed = await fixture.boardArchivePipeline.runDueCloses({
        now: fixture.holder.now,
      });
      assert.deepEqual(closed, []);
      const session = fixture.organizerStore.getBoardSessionForEvent(
        fixture.event.eventId,
      );
      assert.equal(session?.status, "archive_failed");
      assert.equal(session?.archiveFailure?.code, "storage_write_failed");
      assert.equal(session?.archiveFailure?.attempts, 1);
      assert.ok(session?.archiveFailure?.message.includes("EACCES"));
      assert.equal(
        await fixture.archiveStore.readArchive(
          `board-archives/${session?.boardSessionId}/manifest.json`,
        ),
        null,
      );
      assert.ok(
        await fixture.archiveStore.readArchive(
          `board-archives/${session?.boardSessionId}/canvas.svg`,
        ),
        "the already-written canvas object stays in place",
      );
      assert.equal(
        alice.emitted.some(
          /** @param {{event: string, payload: any}} emitted */
          (emitted) =>
            emitted.event === "boardstate" &&
            emitted.payload?.eventClosed === true,
        ),
        false,
        "participants are not told the event closed while the archive failed",
      );

      // Automatic recovery waits for the retry backoff: a pass inside the
      // window makes no new attempt (the failure context is untouched).
      await fixture.boardArchivePipeline.runDueCloses({
        now: fixture.holder.now + 5 * MINUTE,
      });
      assert.equal(
        fixture.organizerStore.getBoardSessionForEvent(fixture.event.eventId)
          ?.archiveFailure?.attempts,
        1,
        "no attempt happens before the backoff elapses",
      );

      // After the backoff the pipeline retries automatically. The immutable
      // store accepts the regenerated canvas and ledger as the byte-identical
      // no-ops they are, the manifest lands, and the session seals.
      restoreStorage();
      fixture.holder.now += 15 * MINUTE;
      const retried = await fixture.boardArchivePipeline.runDueCloses({
        now: fixture.holder.now,
      });
      assert.equal(retried.length, 1);
      const sealed = fixture.organizerStore.getBoardSessionForEvent(
        fixture.event.eventId,
      );
      assert.equal(sealed?.status, "closed");
      assert.equal(sealed?.archiveFailure, null);
      assert.equal(sealed?.archivedFinalSeq, 1);
      const manifest = JSON.parse(
        (
          await fixture.archiveStore.readArchive(
            `board-archives/${session?.boardSessionId}/manifest.json`,
          )
        )?.toString("utf8") || "{}",
      );
      assert.equal(manifest.finalSeq, 1);

      // The completion state reaches participants only now that the archive
      // is real, and the audit trail shows failure then recovery — one seal.
      assert.ok(
        alice.emitted.some(
          /** @param {{event: string, payload: any}} emitted */
          (emitted) =>
            emitted.event === "boardstate" &&
            emitted.payload?.eventClosed === true,
        ),
        "the completion state is emitted once the archive succeeded",
      );
      const audit = fixture.organizerStore
        .listAuditForOrganizer(fixture.event.organizerId)
        .filter((record) => record.subjectId === session?.boardSessionId);
      assert.equal(
        audit.filter((r) => r.action === "board_session.archive_failed").length,
        1,
      );
      assert.equal(
        audit.filter((r) => r.action === "board_session.closed").length,
        1,
      );
    },
  );
});

test("a snapshot save fault fails the close without producing an archive", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-archive-savefault-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now(), {
        config: scenario.sockets.__config,
      });
      // Open the session before anyone can connect through admission.
      const alice = await openOwnerSocket(scenario, fixture);
      await scenario.invoke(
        alice,
        "broadcast",
        rectangleCreate("rect-1", "cm-1"),
      );
      fixture.holder.now = fixture.boardSession.endsAtMs + MINUTE;
      await fixture.organizerStore.advanceLifecycle({
        now: fixture.holder.now,
      });

      // The snapshot projection cannot settle: the close refuses to build an
      // archive on top of it.
      const board = await scenario.getLoadedBoard(fixture.event.boardName);
      const realSave = board.save.bind(board);
      board.save = async () => ({ status: "failed" });
      await fixture.boardArchivePipeline.runDueCloses({
        now: fixture.holder.now,
      });
      const session = fixture.organizerStore.getBoardSessionForEvent(
        fixture.event.eventId,
      );
      assert.equal(session?.status, "archive_failed");
      assert.equal(session?.archiveFailure?.code, "snapshot_save_failed");
      assert.equal(session?.archiveKey, null);

      // Once saves settle again, the authorized operator retry makes the
      // session due immediately and the retry seals it.
      board.save = realSave;
      assert.ok(
        (
          await fixture.organizerStore.retryBoardSessionArchive({
            boardSessionId: /** @type {string} */ (session?.boardSessionId),
            operatorAccountId: "operator-1",
          })
        ).ok,
      );
      const retried = await fixture.boardArchivePipeline.runDueCloses({
        now: fixture.holder.now,
      });
      assert.equal(retried.length, 1);
      assert.equal(
        fixture.organizerStore.getBoardSessionForEvent(fixture.event.eventId)
          ?.status,
        "closed",
      );
    },
  );
});

test("a crashed close resumes after a restart: a fresh composition finishes the work", async () => {
  const fixture = await createFixture(Date.now(), {});
  fixture.holder.now = fixture.boardSession.endsAtMs + MINUTE;
  await fixture.organizerStore.advanceLifecycle({ now: fixture.holder.now });

  // The pre-crash process fails its close attempt and dies.
  const restoreStorage = failManifestWrites(fixture);
  await fixture.boardArchivePipeline.runDueCloses({
    now: fixture.holder.now,
  });
  await fixture.organizerStore.flush();
  restoreStorage();

  // The restarted process recomposes every store and the pipeline from the
  // same durable directory — no in-memory state survives.
  deleteLoadedBoard(fixture.event.boardName);
  const restartedStore = createFileOrganizerStore({
    dataDir: fixture.dataDir,
    clock: () => fixture.holder.now,
  });
  const restartedPipeline = createBoardArchivePipeline({
    organizerStore: restartedStore,
    archiveStore: createFileBoardArchiveStore({ dataDir: fixture.dataDir }),
    config: PRODUCTION_CONFIG,
    clock: () => fixture.holder.now,
  });

  // The failure is durably visible to the new process...
  const failed = restartedStore.listArchiveFailedBoardSessions();
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.archiveFailure?.code, "storage_write_failed");

  // ...an authorized operator retries it, and the fresh pipeline finishes
  // the close with exactly the result a single clean execution would have
  // produced.
  assert.ok(
    (
      await restartedStore.retryBoardSessionArchive({
        boardSessionId: failed[0]?.boardSessionId ?? "",
        operatorAccountId: "operator-1",
      })
    ).ok,
  );
  const closed = await restartedPipeline.runDueCloses({
    now: fixture.holder.now,
  });
  assert.equal(closed.length, 1);
  const session = restartedStore.getBoardSessionById(
    /** @type {string} */ (failed[0]?.boardSessionId),
  );
  assert.equal(session?.status, "closed");
  assert.equal(session?.archiveFailure, null);
  assert.equal(session?.archivedFinalSeq, 0);
  const manifest = JSON.parse(
    (
      await fixture.archiveStore.readArchive(
        `board-archives/${session?.boardSessionId}/manifest.json`,
      )
    )?.toString("utf8") || "{}",
  );
  assert.equal(manifest.finalSeq, 0);
});

/** @param {number} ms */
const dtLocal = (ms) => new Date(ms).toISOString().slice(0, 16);
/** @param {{csrfCookie: string}} jar */
const csrf = (jar) => jar.csrfCookie.split("=")[1] || "";
/** @param {{sessionCookie: string, csrfCookie: string}} jar */
const jarCookie = (jar) => `${jar.sessionCookie}; ${jar.csrfCookie}`;

test("the operator console lists failed archives, retries them idempotently, and organizers only see the failure status", async () => {
  const holder = { now: Date.now() };
  const { app, root, outboxDir, hostedEventModule } = await createHostedServer({
    HOSTED_CLOCK: () => holder.now,
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
    // The test jumps the clock to the event's end, far past the defaults;
    // sign-in sessions must survive that jump.
    HOSTED_SESSION_MAX_AGE_MS: 1000 * DAY,
    HOSTED_SESSION_IDLE_TIMEOUT_MS: 1000 * DAY,
  });
  try {
    // Provision an operator and an organizer through the real HTTP flows.
    const operator = await signUpAndLogin(
      app,
      outboxDir,
      OPERATOR_EMAIL,
      STRONG_PASSWORD,
    );
    const owner = await signUpAndLogin(
      app,
      outboxDir,
      `owner-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      STRONG_PASSWORD,
    );
    const applied = await requestWithCookies(app, "/organizer/apply?lang=en", {
      method: "POST",
      cookie: jarCookie(owner),
      body: new URLSearchParams({
        _csrf: csrf(owner),
        organizerName: "Aurora Collective",
        contactName: "Mika Rin",
        contactEmail: "contact@example.com",
        description: "Jams.",
      }).toString(),
    });
    assert.equal(applied.statusCode, 303);
    const queue = await requestWithCookies(app, "/operator?lang=en", {
      cookie: jarCookie(operator),
    });
    const applicationId = /operator\/applications\/([^"]+)"/.exec(
      queue.body,
    )?.[1];
    assert.ok(applicationId);
    await requestWithCookies(
      app,
      `/operator/applications/${applicationId}/approve`,
      {
        method: "POST",
        cookie: jarCookie(operator),
        body: new URLSearchParams({ _csrf: csrf(operator) }).toString(),
      },
    );
    const consolePage = await requestWithCookies(app, "/organizer?lang=en", {
      cookie: jarCookie(owner),
    });
    const organizerId = /organizers\/([^"/]+)"/.exec(consolePage.body)?.[1];
    assert.ok(organizerId);
    const start = holder.now + DAY;
    const created = await requestWithCookies(
      app,
      `/organizers/${organizerId}/reservations?lang=en`,
      {
        method: "POST",
        cookie: jarCookie(owner),
        body: new URLSearchParams({
          _csrf: csrf(owner),
          eventName: "Launch Party",
          startsAt: dtLocal(start),
          endsAt: dtLocal(start + HOUR),
          requestedSeats: "20",
          visibility: "public",
          description: "Come draw with us.",
        }).toString(),
      },
    );
    assert.equal(created.statusCode, 303);
    const reservationId = /reservations\/([^"/]+)$/.exec(
      created.headers.location || "",
    )?.[1];
    assert.ok(reservationId);
    const submitted = await requestWithCookies(
      app,
      `/organizers/${organizerId}/reservations/${reservationId}/submit?lang=en`,
      {
        method: "POST",
        cookie: jarCookie(owner),
        body: new URLSearchParams({ _csrf: csrf(owner) }).toString(),
      },
    );
    assert.equal(submitted.statusCode, 303);
    // The operator approves through the console like production does.
    const approved = await requestWithCookies(
      app,
      `/operator/reservations/${reservationId}/approve?lang=en`,
      {
        method: "POST",
        cookie: jarCookie(operator),
        body: new URLSearchParams({ _csrf: csrf(operator) }).toString(),
      },
    );
    assert.equal(approved.statusCode, 303);

    /**
     * A fresh read-only view of the durable state the running server
     * persists. Every instance loads from disk on first use — the server's
     * own in-memory index is never shared with the test.
     *
     * @returns {ReturnType<typeof createFileOrganizerStore>}
     */
    const freshStore = () =>
      createFileOrganizerStore({
        dataDir: path.join(root, "hosted-data"),
        clock: () => holder.now,
      });

    // Fault injection at the real storage boundary: the archive object store
    // becomes unwritable.
    const hostedDataDir = path.join(root, "hosted-data");
    const archiveDir = path.join(hostedDataDir, "board-archives");
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.chmod(archiveDir, 0o500);

    // Past the end plus the drain window, one lifecycle pass leaves the
    // session durably ARCHIVE_FAILED.
    const sessionBefore =
      freshStore().getBoardSessionForReservation(reservationId);
    assert.ok(sessionBefore);
    holder.now = sessionBefore.endsAtMs + 2 * MINUTE;
    await hostedEventModule.refreshEventLifecycle();
    const failed = freshStore().listArchiveFailedBoardSessions();
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.boardSessionId, sessionBefore.boardSessionId);
    assert.equal(failed[0]?.archiveFailure?.code, "storage_write_failed");
    assert.equal(failed[0]?.archiveFailure?.attempts, 1);
    const boardSessionId = /** @type {string} */ (failed[0]?.boardSessionId);

    // The operator console lists the failure with its event and reason.
    const consoleHtml = await requestWithCookies(app, "/operator?lang=en", {
      cookie: jarCookie(operator),
    });
    assert.equal(consoleHtml.statusCode, 200);
    assert.ok(consoleHtml.body.includes("Launch Party"));
    assert.ok(
      consoleHtml.body.includes("Archive object storage write failed"),
      "the failure reason renders on the operator console",
    );
    assert.ok(
      consoleHtml.body.includes(
        `operator/board-sessions/${boardSessionId}/archive-retry`,
      ),
    );

    // The organizer sees only the failure status — no internal error text,
    // no archive key, no retry surface.
    const organizerView = await requestWithCookies(
      app,
      `/organizers/${organizerId}/reservations/${reservationId}?lang=en`,
      { cookie: jarCookie(owner) },
    );
    assert.equal(organizerView.statusCode, 200);
    assert.ok(organizerView.body.includes("Archive failed"));
    assert.ok(
      !organizerView.body.includes("EACCES"),
      "internal error details never reach the organizer",
    );
    assert.ok(
      !organizerView.body.includes(boardSessionId),
      "internal session ids never reach the organizer",
    );

    // A signed-in non-operator cannot retry.
    const forbidden = await requestWithCookies(
      app,
      `/operator/board-sessions/${boardSessionId}/archive-retry?lang=en`,
      {
        method: "POST",
        cookie: jarCookie(owner),
        body: new URLSearchParams({ _csrf: csrf(owner) }).toString(),
      },
    );
    assert.equal(forbidden.statusCode, 403);

    // A retry without a valid CSRF token is refused deterministically.
    const badCsrf = await requestWithCookies(
      app,
      `/operator/board-sessions/${boardSessionId}/archive-retry?lang=en`,
      {
        method: "POST",
        cookie: jarCookie(operator),
        body: new URLSearchParams({ _csrf: "0".repeat(32) }).toString(),
      },
    );
    assert.equal(badCsrf.statusCode, 403);

    // The authorized retry runs the pipeline now; storage is still broken,
    // so the failure context refreshes (attempts grow) and the console says
    // so — the failure is never misreported as success.
    const retryPage = await requestWithCookies(
      app,
      `/operator/board-sessions/${boardSessionId}/archive-retry?lang=en`,
      {
        method: "POST",
        cookie: jarCookie(operator),
        body: new URLSearchParams({ _csrf: csrf(operator) }).toString(),
      },
    );
    assert.equal(retryPage.statusCode, 200);
    assert.ok(retryPage.body.includes("The retry failed again"));
    assert.equal(
      freshStore().getBoardSessionById(boardSessionId)?.archiveFailure
        ?.attempts,
      2,
    );

    // Storage recovers; the same authorized retry now completes the archive.
    await fs.chmod(archiveDir, 0o700);
    const successPage = await requestWithCookies(
      app,
      `/operator/board-sessions/${boardSessionId}/archive-retry?lang=en`,
      {
        method: "POST",
        cookie: jarCookie(operator),
        body: new URLSearchParams({ _csrf: csrf(operator) }).toString(),
      },
    );
    assert.equal(successPage.statusCode, 200);
    assert.ok(successPage.body.includes("The board archive completed"));
    const sealed = freshStore().getBoardSessionById(boardSessionId);
    assert.equal(sealed?.status, "closed");
    assert.equal(sealed?.archiveFailure, null);
    assert.ok(
      await createFileBoardArchiveStore({ dataDir: hostedDataDir }).readArchive(
        `board-archives/${boardSessionId}/manifest.json`,
      ),
    );
    assert.ok(
      !successPage.body.includes(boardSessionId),
      "a sealed session leaves the operator failure list",
    );

    // Retrying again is a deterministic refusal — never a second archive.
    const again = await requestWithCookies(
      app,
      `/operator/board-sessions/${boardSessionId}/archive-retry?lang=en`,
      {
        method: "POST",
        cookie: jarCookie(operator),
        body: new URLSearchParams({ _csrf: csrf(operator) }).toString(),
      },
    );
    assert.equal(again.statusCode, 409);
    assert.ok(again.body.includes("no longer waiting for an archive retry"));
    const audit = freshStore()
      .listAuditForOrganizer(/** @type {string} */ (sealed?.organizerId))
      .filter((record) => record.subjectId === boardSessionId);
    assert.equal(
      audit.filter((record) => record.action === "board_session.closed").length,
      1,
    );
  } finally {
    await closeServer(app);
  }
});
