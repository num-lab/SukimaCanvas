/** End-to-end operational recovery drill for the Hosted Event Service. */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
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
const {
  createFileAccountStore,
} = require("../server/hosted_event/accounts/store.mjs");
const {
  createFileEventMembershipStore,
} = require("../server/hosted_event/memberships/store.mjs");
const {
  createFileNotificationStore,
} = require("../server/hosted_event/notifications/store.mjs");
const {
  createNotificationService,
} = require("../server/hosted_event/notifications/service.mjs");
const {
  createFileWebhookStore,
} = require("../server/hosted_event/webhooks/store.mjs");
const {
  createWebhookPipeline,
} = require("../server/hosted_event/webhooks/pipeline.mjs");
const {
  createFileBoardMutationLedger,
} = require("../server/hosted_event/ledger/store.mjs");
const {
  createParticipantIdentifierResolver,
} = require("../server/hosted_event/attribution.mjs");
const {
  createEventAdmission,
} = require("../server/hosted_event/admission/index.mjs");
const { deleteLoadedBoard } = require("../server/board/registry.mjs");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Platform RTO commitment for a full process recovery. */
const RTO_BUDGET_MS = 15 * MINUTE;

const PRODUCTION_CONFIG = require("../server/configuration.mjs");

/**
 * A volume snapshot may contain an atomic-write staging file, but restore never
 * consumes one. A recursive userspace copy must skip those transient names so
 * a rename racing the directory walk cannot turn the snapshot simulation into
 * an unrelated ENOENT.
 * @param {string} source
 */
function isDurableSnapshotPath(source) {
  return !/\.tmp-\d+-[0-9a-f]+$/i.test(path.basename(source));
}

/**
 * A controlled webhook receiver for the drill's post-recovery delivery.
 */
async function createReceiver() {
  /** @type {{body: string}[]} */
  const received = [];
  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ body: Buffer.concat(chunks).toString("utf8") });
      res.statusCode = 200;
      res.end("ok");
    });
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = /** @type {import("net").AddressInfo} */ (
    /** @type {any} */ (server.address())
  );
  return {
    received,
    endpoint: `http://127.0.0.1:${address.port}/lifecycle`,
    close: () =>
      /** @type {Promise<void>} */ (
        new Promise((resolve) => {
          server.close(() => resolve());
        })
      ),
  };
}

/**
 * A mail adapter the drill controls: the first send attempt always fails (a
 * mail-vendor outage), afterwards it records. This makes the notice queue's
 * retry state observable before and after the restart.
 */
function createDrillMail() {
  /** @type {{to: string, subject: string}[]} */
  const sent = [];
  let healthy = false;
  return {
    sent,
    markHealthy: () => {
      healthy = true;
    },
    async send(
      /** @type {{to: string, subject: string, body: string}} */ message,
    ) {
      if (!healthy) {
        throw new Error("drill: mail vendor unreachable");
      }
      sent.push({ to: message.to, subject: message.subject });
    },
  };
}

/**
 * Restores a crash-consistent backup into a fresh directory and re-ships
 * the current ledger tails — the documented PITR procedure.
 * @param {string} dataDir
 * @param {string} backupDir
 */
async function restoreInto(dataDir, backupDir) {
  const restoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-restore-"));
  await fs.cp(backupDir, restoreDir, { recursive: true });
  await fs.cp(
    path.join(dataDir, "mutation-ledger"),
    path.join(restoreDir, "mutation-ledger"),
    { recursive: true, force: true },
  );
  return restoreDir;
}

test("operational recovery drill: restart rebuilds every durable subsystem and finishes every task", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-recovery-drill-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now(), {
        config: scenario.sockets.__config,
      });
      const dataDir = fixture.dataDir;
      const clock = () => fixture.holder.now;
      scenario.sockets.__test.registerCloseEffects(
        scenario.sockets.__config,
        fixture.hostedModule,
      );

      // Durable companions of the board state: notice queue and webhook
      // outbox over the same data directory.
      const notificationStore = createFileNotificationStore({
        dataDir,
        clock,
      });
      const drillMail = createDrillMail();
      const notifications = createNotificationService({
        store: notificationStore,
        mail: drillMail,
        accountStore: fixture.accountStore,
        organizerStore: fixture.organizerStore,
        membershipStore: fixture.membershipStore,
        config: {
          ...PRODUCTION_CONFIG,
          HOSTED_MAIL_RETRY_MS: 0,
          HOSTED_NOTICE_UPCOMING_WINDOW_MS: 24 * HOUR,
        },
        clock,
      });
      const receiver = await createReceiver();
      try {
        const webhookStore = createFileWebhookStore({
          dataDir,
          clock,
          allowInsecureHttp: true,
        });
        const webhookPipeline = createWebhookPipeline({
          webhookStore,
          organizerStore: fixture.organizerStore,
          notificationService: notifications,
          config: {
            ...PRODUCTION_CONFIG,
            HOSTED_WEBHOOK_RETRY_MS: 50,
            HOSTED_WEBHOOK_GIVE_UP_MS: 24 * HOUR,
          },
          clock,
        });
        fixture.holder.now += 1;
        const subscribed = await webhookStore.createSubscription({
          organizerId: fixture.event.organizerId,
          url: receiver.endpoint,
          actorAccountId: fixture.owner.accountId,
        });
        assert.ok(subscribed.ok);

        // The upcoming-start notice is queued while the session is still
        // scheduled; the first delivery attempt fails (vendor outage),
        // leaving the record visibly retrying.
        await notifications.noticeUpcomingSessions({
          now: fixture.holder.now,
        });
        await notifications.runDueSends({ now: fixture.holder.now });
        assert.equal(drillMail.sent.length, 0);
        const retrying = await notificationStore.listRetrying();
        assert.equal(retrying.length, 1, "the notice is retrying");

        // Open the session and accept one persistent write through the real
        // admission gate and the ledger fsync boundary.
        fixture.holder.now = fixture.boardSession.startsAtMs;
        await fixture.organizerStore.advanceLifecycle({
          now: fixture.holder.now,
        });
        const alice = await connectSocket(
          scenario,
          fixture.hostedModule,
          fixture.event.boardName,
          cookieFor(fixture.owner.rawSessionId),
          "socket-owner",
        );
        assert.ok(alice.ok);
        await scenario.invoke(
          /** @type {any} */ (alice.created),
          "broadcast",
          rectangleCreate("rect-drill", "cm-drill"),
        );
        const acceptance = ownAcceptance(
          /** @type {any} */ (alice.created),
          "cm-drill",
        );

        // The permission boundary: an Owner, a live membership, and an Event
        // Ban — all durable.
        const member = await fixture.addMember("drill-member@example.com");
        const banned = await fixture.addMember("drill-banned@example.com");
        await fixture.membershipStore.banEvent({
          eventId: fixture.event.eventId,
          accountId: banned.accountId,
        });

        // A failing archive task: durable, visible, retryable.
        fixture.holder.now = fixture.boardSession.endsAtMs + MINUTE;
        await fixture.organizerStore.advanceLifecycle({
          now: fixture.holder.now,
        });
        const realPut = fixture.archiveStore.putArchive.bind(
          fixture.archiveStore,
        );
        fixture.archiveStore.putArchive = async (
          /** @type {string} */ key,
          /** @type {string | Uint8Array} */ content,
        ) => {
          if (key.endsWith("/manifest.json")) {
            const error = /** @type {Error & {code: string}} */ (
              new Error("EACCES: manifest write refused")
            );
            error.code = "EACCES";
            throw error;
          }
          return realPut(key, content);
        };
        await fixture.boardArchivePipeline.runDueCloses({
          now: fixture.holder.now,
        });
        const failedSession = fixture.organizerStore.getBoardSessionForEvent(
          fixture.event.eventId,
        );
        assert.equal(failedSession?.status, "archive_failed");

        // The webhook outbox derives opened + archive.failed; both stay
        // pending because the receiver is not consulted yet.
        await webhookPipeline.deriveLifecycleEvents();
        assert.ok(
          webhookStore.listDueDeliveries({ now: fixture.holder.now }).length >=
            2,
        );

        await fixture.organizerStore.flush();
        await webhookStore.flush();
        const crashAtMs = fixture.holder.now;

        // --- the process dies and is replaced: nothing survives in memory --
        deleteLoadedBoard(fixture.event.boardName);
        const recoveryStartMs = Date.now();
        const restartedOrganizerStore = createFileOrganizerStore({
          dataDir,
          clock,
        });
        const restartedAccountStore = createFileAccountStore({
          dataDir,
          clock,
          sessionMaxAgeMs: DAY,
          sessionIdleMs: DAY,
        });
        const restartedMembershipStore = createFileEventMembershipStore({
          dataDir,
          clock,
        });
        const restartedNotificationStore = createFileNotificationStore({
          dataDir,
          clock,
        });
        const restartedArchiveStore = createFileBoardArchiveStore({ dataDir });
        const restartedArchivePipeline = createBoardArchivePipeline({
          organizerStore: restartedOrganizerStore,
          archiveStore: restartedArchiveStore,
          config: PRODUCTION_CONFIG,
          clock,
        });
        const restartedWebhookStore = createFileWebhookStore({
          dataDir,
          clock,
          allowInsecureHttp: true,
        });
        const restartedMail = createDrillMail();
        restartedMail.markHealthy();
        const restartedNotifications = createNotificationService({
          store: restartedNotificationStore,
          mail: restartedMail,
          accountStore: restartedAccountStore,
          organizerStore: restartedOrganizerStore,
          membershipStore: restartedMembershipStore,
          config: {
            ...PRODUCTION_CONFIG,
            HOSTED_MAIL_RETRY_MS: 0,
            HOSTED_NOTICE_UPCOMING_WINDOW_MS: 24 * HOUR,
          },
          clock,
        });
        const restartedWebhookPipeline = createWebhookPipeline({
          webhookStore: restartedWebhookStore,
          organizerStore: restartedOrganizerStore,
          notificationService: restartedNotifications,
          config: {
            ...PRODUCTION_CONFIG,
            HOSTED_WEBHOOK_RETRY_MS: 50,
            HOSTED_WEBHOOK_GIVE_UP_MS: 24 * HOUR,
          },
          clock,
        });
        const restartedLedger = createFileBoardMutationLedger({
          boardName: fixture.event.boardName,
          dataDir,
        });

        // --- RPO: every write confirmed before the crash is still durable --
        // The ledger fsync gates the sequenced confirmation, so the accepted
        // write observed by its sender must be in the ledger after any crash.
        const ledgerEntries = await restartedLedger.readEntriesAfter(0);
        assert.equal(ledgerEntries.length, 1, "no confirmed write is lost");
        const accepted = ledgerEntries[0];
        assert.ok(accepted);
        assert.equal(accepted.seq, acceptance.seq);
        assert.equal(accepted.acceptedAtMs, acceptance.acceptedAtMs);
        assert.ok(accepted.acceptedAtMs <= crashAtMs);

        // --- task recovery: the failed archive is visible and due ---------
        const failed = restartedOrganizerStore.listArchiveFailedBoardSessions();
        assert.equal(failed.length, 1);
        assert.equal(
          failed[0]?.boardSessionId,
          fixture.boardSession.boardSessionId,
        );
        assert.equal(failed[0]?.archiveFailure?.code, "storage_write_failed");
        assert.deepEqual(
          restartedOrganizerStore
            .listBoardSessionsDueToClose({
              now: fixture.holder.now + 16 * MINUTE,
              closeDrainMs: 0,
              archiveRetryMs: 15 * MINUTE,
            })
            .map((session) => session.boardSessionId),
          [fixture.boardSession.boardSessionId],
        );

        // --- outbox recovery: the webhook events are still pending --------
        assert.ok(
          restartedWebhookStore.listDueDeliveries({
            now: fixture.holder.now,
          }).length >= 2,
        );

        // --- permission boundaries: roles, bans, memberships --------------
        assert.equal(
          restartedOrganizerStore.getMemberRole(
            fixture.event.organizerId,
            fixture.owner.accountId,
          ),
          "owner",
        );
        assert.equal(
          restartedMembershipStore.isEventBanned(
            fixture.event.eventId,
            banned.accountId,
          ),
          true,
        );
        assert.equal(
          restartedMembershipStore.getMembership(
            fixture.event.eventId,
            member.accountId,
          )?.anonymity,
          "identified",
        );
        const account = restartedAccountStore.getAccountById(
          fixture.owner.accountId,
        );
        assert.ok(account && account.status === "active");

        // --- notices: the retrying notice survives with its state ---------
        assert.equal(
          (await restartedNotificationStore.listRetrying()).length,
          1,
        );

        // --- recovery completes: the archive seals, the queues drain ------
        assert.ok(
          (
            await restartedOrganizerStore.retryBoardSessionArchive({
              boardSessionId: fixture.boardSession.boardSessionId,
              operatorAccountId: "drill-operator",
            })
          ).ok,
        );
        const closed = await restartedArchivePipeline.runDueCloses({
          now: fixture.holder.now,
        });
        assert.equal(closed.length, 1);
        const sealed = restartedOrganizerStore.getBoardSessionById(
          fixture.boardSession.boardSessionId,
        );
        assert.equal(sealed?.status, "closed");
        // Snapshot and ledger agree on one final authoritative sequence.
        assert.equal(sealed?.archivedFinalSeq, acceptance.seq);
        const manifest = JSON.parse(
          (
            await restartedArchiveStore.readArchive(
              `board-archives/${fixture.boardSession.boardSessionId}/manifest.json`,
            )
          )?.toString("utf8") || "{}",
        );
        assert.equal(manifest.finalSeq, acceptance.seq);
        assert.equal(manifest.acceptedMutationCount, 1);

        const delivered = await restartedWebhookPipeline.runDueDeliveries({
          now: fixture.holder.now,
        });
        assert.ok(delivered.delivered >= 2, "the outbox drains after recovery");
        assert.ok(receiver.received.length >= 2);

        await restartedNotifications.runDueSends({ now: fixture.holder.now });
        assert.ok(
          restartedMail.sent.length > 0,
          "the retrying notice delivers through the restarted adapter",
        );

        // --- RTO: full recompose and recovery is far inside 15 minutes ---
        const recoveryElapsedMs = Date.now() - recoveryStartMs;
        assert.ok(
          recoveryElapsedMs < RTO_BUDGET_MS,
          `recovery took ${recoveryElapsedMs}ms, over the 15-minute budget`,
        );
      } finally {
        await receiver.close();
      }
    },
  );
});

test("a fresh process answers admission decisions from durable state alone after recovery", async () => {
  const live = await /** @type {any} */ (
    new Promise((resolve) => {
      createSocketScenario(
        { historyDirPrefix: "wbo-recovery-admission-" },
        async (scenario) => {
          const fixture = await createFixture(Date.now(), {
            config: scenario.sockets.__config,
          });
          resolve({ fixture, scenario, done: () => undefined });
        },
      );
    })
  );
  const fixture = live.fixture;
  try {
    // A restarted composition answers the one question every request asks —
    // who may enter, in which role — from durable state alone.
    const clock = () => fixture.holder.now;
    const admission = createEventAdmission({
      seatGraceMs: 10 * MINUTE,
      accountStore: createFileAccountStore({
        dataDir: fixture.dataDir,
        clock,
        sessionMaxAgeMs: DAY,
        sessionIdleMs: DAY,
      }),
      organizerStore: createFileOrganizerStore({
        dataDir: fixture.dataDir,
        clock,
      }),
      membershipStore: createFileEventMembershipStore({
        dataDir: fixture.dataDir,
        clock,
      }),
      participantIdentifierFor: createParticipantIdentifierResolver(
        "attribution-test-secret",
      ),
      clock,
    });
    // The fresh composition advances the durable lifecycle first, exactly
    // like the real service does on every read.
    fixture.holder.now = fixture.boardSession.startsAtMs;
    const storeForAdmission = createFileOrganizerStore({
      dataDir: fixture.dataDir,
      clock,
    });
    await storeForAdmission.advanceLifecycle({ now: fixture.holder.now });
    const verdict = await admission.admitEventBoardSocket({
      boardName: fixture.event.boardName,
      cookieHeader: cookieFor(fixture.owner.rawSessionId),
    });
    assert.equal(verdict.ok, true);
    assert.equal(/** @type {{role: string}} */ (verdict).role, "moderator");
  } finally {
    live.done();
  }
});

test("restore drill: a crash-consistent backup plus re-shipped ledger rebuilds every write", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-restore-drill-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now(), {
        config: scenario.sockets.__config,
      });
      const dataDir = fixture.dataDir;
      const clock = () => fixture.holder.now;

      // Open the session and accept the first write.
      fixture.holder.now = fixture.boardSession.startsAtMs;
      await fixture.organizerStore.advanceLifecycle({
        now: fixture.holder.now,
      });
      const alice = await connectSocket(
        scenario,
        fixture.hostedModule,
        fixture.event.boardName,
        cookieFor(fixture.owner.rawSessionId),
        "socket-owner",
      );
      assert.ok(alice.ok);
      await scenario.invoke(
        /** @type {any} */ (alice.created),
        "broadcast",
        rectangleCreate("rect-backup", "cm-backup"),
      );
      ownAcceptance(/** @type {any} */ (alice.created), "cm-backup");

      // Take the crash-consistent backup: a plain recursive copy of the data
      // root, exactly what a volume snapshot captures.
      const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-backup-"));
      await fs.cp(dataDir, backupDir, {
        recursive: true,
        filter: isDurableSnapshotPath,
      });

      // Accept a second write AFTER the backup: only the re-shipped ledger
      // can bring it back.
      await scenario.invoke(
        /** @type {any} */ (alice.created),
        "broadcast",
        rectangleCreate("rect-pitr", "cm-pitr"),
      );
      ownAcceptance(/** @type {any} */ (alice.created), "cm-pitr");

      // Restore per the runbook: snapshot contents + re-shipped ledger tails.
      const restoreDir = await restoreInto(dataDir, backupDir);
      const restoredLedger = createFileBoardMutationLedger({
        boardName: fixture.event.boardName,
        dataDir: restoreDir,
      });
      const entries = await restoredLedger.readEntriesAfter(0);
      assert.deepEqual(
        entries.map((entry) => /** @type {any} */ (entry.mutation).id),
        ["rect-backup", "rect-pitr"],
        "backup plus re-shipped ledger rebuilds every accepted write",
      );

      // The restored state drives a complete close: the board loads from the
      // restored snapshot plus ledger and seals at the final sequence.
      const restoredOrganizerStore = createFileOrganizerStore({
        dataDir: restoreDir,
        clock,
      });
      fixture.holder.now = fixture.boardSession.endsAtMs + MINUTE;
      await restoredOrganizerStore.advanceLifecycle({
        now: fixture.holder.now,
      });
      const restoredArchiveStore = createFileBoardArchiveStore({
        dataDir: restoreDir,
      });
      const restoredPipeline = createBoardArchivePipeline({
        organizerStore: restoredOrganizerStore,
        archiveStore: restoredArchiveStore,
        config: PRODUCTION_CONFIG,
        clock,
      });
      const closed = await restoredPipeline.runDueCloses({
        now: fixture.holder.now,
      });
      assert.equal(closed.length, 1);
      const sealed = restoredOrganizerStore.getBoardSessionForEvent(
        fixture.event.eventId,
      );
      assert.equal(sealed?.status, "closed");
      assert.equal(sealed?.archivedFinalSeq, 2);
      const manifest = JSON.parse(
        (
          await restoredArchiveStore.readArchive(
            `board-archives/${fixture.boardSession.boardSessionId}/manifest.json`,
          )
        )?.toString("utf8") || "{}",
      );
      assert.equal(manifest.acceptedMutationCount, 2);
      assert.equal(
        manifest.integrity["ledger.jsonl"],
        crypto
          .createHash("sha256")
          .update(
            `${(
              await fs.readFile(
                path.join(
                  restoreDir,
                  "mutation-ledger",
                  `${fixture.event.boardName}.jsonl`,
                ),
              )
            )
              .toString("utf8")
              .replace(/\n$/, "")}\n`,
          )
          .digest("hex"),
        "the archived ledger object matches the re-shipped file",
      );
      await fs.rm(backupDir, { recursive: true, force: true });
      await fs.rm(restoreDir, { recursive: true, force: true });
    },
  );
});
