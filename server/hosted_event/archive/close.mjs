import crypto from "node:crypto";
import fsp from "node:fs/promises";
import { loadOrGetLoadedBoard } from "../../board/board_loader.mjs";
import { deleteLoadedBoard, getLoadedBoard } from "../../board/registry.mjs";
import { getBoardSession } from "../../board/session.mjs";
import observability from "../../observability/index.mjs";
import { readStoredSvgSeq } from "../../persistence/svg_board_store.mjs";
import {
  createDefaultStoredSvgEnvelope,
  serializeStoredSvgEnvelope,
} from "../../persistence/svg_envelope.mjs";

const { logger, metrics } = observability;

/**
 * The durable close pipeline for Board Sessions.
 *
 * When a Board Session's CLOSING drain window elapses, this pipeline forms the
 * final write boundary: it drains every already-admitted persistent write, the
 * stored SVG snapshot is brought level with the accepted-mutation ledger, and
 * both must agree on one final authoritative sequence before the immutable
 * Private Board Archive is produced. Only then is the session sealed CLOSED —
 * a validation or storage failure never dresses itself up as a successful
 * close.
 *
 * The archive stores the canvas SVG (with its server-stamped item
 * attribution), the full accepted-mutation ledger as the audit boundary, and a
 * manifest binding them together with integrity hashes. Objects are addressed
 * by internal keys under the archive store; keys are never public access
 * credentials and never appear in public URLs.
 *
 * Board Session states after a close pass:
 * - success: `closed`, carrying the archive key and final sequence — the
 *   session can never be re-edited or reopened.
 * - failure: `archive_failed`, carrying the classified failure code, the
 *   internal detail, and the attempt history. The state admits no writes and
 *   displays no archived result. Recovery is automatic — the pipeline re-attempts
 *   failed sessions after a backoff window, and every attempt is idempotent
 *   (deterministic archive objects, immutable store, guarded seal) — while
 *   Platform Operators can retry immediately from the operator console.
 *
 * @typedef {{
 *   organizerStore: ReturnType<typeof import("../organizers/store.mjs").createFileOrganizerStore>,
 *   archiveStore: ReturnType<typeof import("./store.mjs").createFileBoardArchiveStore>,
 *   config: import("../../../types/server-runtime.d.ts").ServerConfig,
 *   clock?: () => number,
 *   notifications?: import("../notifications/service.mjs").NotificationService,
 * }} BoardArchivePipelineDependencies
 */

const ARCHIVE_FORMAT = "sukimacanvas-board-archive-v1";
/** Every accepted mutation plus its follow-up effects carries an entry. */
const ARCHIVE_LEDGER_OBJECT = "ledger.jsonl";
const ARCHIVE_CANVAS_OBJECT = "canvas.svg";
const ARCHIVE_MANIFEST_OBJECT = "manifest.json";

/**
 * Deterministic failure codes for close attempts that could not validate the
 * final sequence or persist the archive. They land on the session's durable
 * failure record, in the Change Audit trail, and on archive metrics, and are
 * the operator console's stable handles for "why is this waiting".
 */
const ARCHIVE_FAILURE_CODES = {
  SAVE_FAILED: "snapshot_save_failed",
  LEDGER_MISSING: "ledger_unavailable",
  SEQ_MISMATCH: "final_sequence_mismatch",
  ARCHIVE_CONFLICT: "archive_conflict",
  STORAGE_WRITE_FAILED: "storage_write_failed",
  SEAL_REFUSED: "seal_failed",
  INTERNAL: "internal",
};

/**
 * Maps one thrown close error to its durable failure record: a deterministic
 * code for the observable trail plus the error's own message as the internal
 * detail. The mapping never throws — an unknown failure still records as
 * `internal` rather than vanishing.
 *
 * @param {unknown} error
 * @returns {{code: string, message: string}}
 */
function classifyArchiveFailure(error) {
  const code = /** @type {{code?: unknown}} */ (error || {}).code;
  const known = typeof code === "string" ? code : "";
  const mapped =
    /** @type {{[key: string]: string | undefined}} */ ({
      WBO_BOARD_ARCHIVE_SAVE_FAILED: ARCHIVE_FAILURE_CODES.SAVE_FAILED,
      WBO_BOARD_ARCHIVE_LEDGER_MISSING: ARCHIVE_FAILURE_CODES.LEDGER_MISSING,
      WBO_BOARD_ARCHIVE_SEQ_MISMATCH: ARCHIVE_FAILURE_CODES.SEQ_MISMATCH,
      WBO_BOARD_ARCHIVE_SNAPSHOT_MISSING: ARCHIVE_FAILURE_CODES.SAVE_FAILED,
      WBO_BOARD_ARCHIVE_SEAL_REFUSED: ARCHIVE_FAILURE_CODES.SEAL_REFUSED,
      WBO_BOARD_ARCHIVE_STORAGE_WRITE_FAILED:
        ARCHIVE_FAILURE_CODES.STORAGE_WRITE_FAILED,
      WBO_ARCHIVE_OBJECT_EXISTS: ARCHIVE_FAILURE_CODES.ARCHIVE_CONFLICT,
    })[known] || ARCHIVE_FAILURE_CODES.INTERNAL;
  return {
    code: mapped,
    message: error instanceof Error ? error.message : String(error || ""),
  };
}

/**
 * Loads or returns the process-cached board instance through the shared board
 * loader, so the pipeline and live connections always observe the same board.
 * A load replays ledger entries past the stored snapshot and fails loudly on
 * ledger gaps or corruption — the first validation gate of every close.
 *
 * @param {string} boardName
 * @param {BoardArchivePipelineDependencies} dependencies
 * @returns {Promise<import("../../board/data.mjs").BoardData>}
 */
function getOrLoadBoard(boardName, dependencies) {
  return loadOrGetLoadedBoard(boardName, dependencies.config, {
    // A stale save cannot recover by itself: drop the instance so the next
    // load rebuilds from snapshot plus ledger. No live socket is attached
    // here — the socket layer installs its own drop policy (with socket
    // eviction) when it loads first.
    onStaleSave: async (board) => {
      const current = await getLoadedBoard(boardName);
      if (current !== board) return;
      deleteLoadedBoard(boardName);
      board.dispose();
      logger.warn("board.stale_instance_dropped", {
        board: boardName,
        reason: "save_seq_mismatch",
        source: "board_archive_close",
      });
    },
  });
}

/**
 * Reads the stored snapshot's sequence from disk — the authoritative
 * projection level, independent of any in-memory bookkeeping.
 *
 * @param {import("../../board/data.mjs").BoardData} board
 * @returns {Promise<number>}
 */
function readPersistedSnapshotSeq(board) {
  return readStoredSvgSeq(board.name, { historyDir: board.historyDir });
}

/**
 * The serialized ledger content for the archive: every confirmed accepted
 * mutation, oldest first. Re-serializing the parsed entries guarantees the
 * archived audit boundary holds exactly the confirmed history (a torn,
 * never-confirmed tail is excluded), and the same read yields the ledger's
 * final sequence for validation.
 *
 * @param {NonNullable<import("../../board/data.mjs").BoardData["mutationLedger"]>} ledger
 * @returns {Promise<{content: string, lastSeq: number, entryCount: number}>}
 */
async function exportLedgerContent(ledger) {
  const entries = await ledger.readEntriesAfter(0);
  if (entries.length === 0) return { content: "", lastSeq: 0, entryCount: 0 };
  return {
    content: `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    lastSeq: entries[entries.length - 1]?.seq ?? 0,
    entryCount: entries.length,
  };
}

/**
 * @param {string | Uint8Array} content
 * @returns {string}
 */
function sha256Hex(content) {
  return crypto
    .createHash("sha256")
    .update(
      typeof content === "string" ? Buffer.from(content, "utf8") : content,
    )
    .digest("hex");
}

/**
 * Creates one close-failure error carrying its deterministic code — the
 * stable handle `classifyArchiveFailure` maps onto the durable failure
 * record.
 *
 * @param {string} code
 * @param {string} message
 * @returns {Error & {code: string}}
 */
function closeError(code, message) {
  const error = /** @type {Error & {code: string}} */ (new Error(message));
  error.code = code;
  return error;
}

/**
 * @param {BoardArchivePipelineDependencies} dependencies
 */
function createBoardArchivePipeline(dependencies) {
  const organizerStore = dependencies.organizerStore;
  const archiveStore = dependencies.archiveStore;
  const notifications = dependencies.notifications;
  const clock = dependencies.clock || (() => Date.now());
  // Captured once at composition, never re-read per close attempt.
  const archiveRetryMs =
    typeof dependencies.config.HOSTED_BOARD_SESSION_ARCHIVE_RETRY_MS ===
      "number" &&
    Number.isFinite(dependencies.config.HOSTED_BOARD_SESSION_ARCHIVE_RETRY_MS)
      ? Math.max(0, dependencies.config.HOSTED_BOARD_SESSION_ARCHIVE_RETRY_MS)
      : 0;
  /** @type {Set<string>} */
  const closesInFlight = new Set();

  /**
   * The event's display name for notice content, or empty when the event
   * record has vanished (a cancelled-and-pruned event still closes).
   *
   * @param {{eventId: string}} due
   * @returns {string}
   */
  function eventNameFor(due) {
    return organizerStore.getEventById(due.eventId)?.name || "";
  }

  /**
   * Awaits one notice trigger, never letting a notice problem disturb the
   * close pass: enqueueing is durable before delivery, and a failure is
   * logged, not classified as an archive failure.
   *
   * @param {Promise<void>} notice
   * @param {{boardSessionId: string}} due
   * @returns {Promise<void>}
   */
  async function notifyNotice(notice, due) {
    await notice.catch((notifyError) => {
      logger.error("hosted.board_session_archive_notify_failed", {
        board_session: due.boardSessionId,
        error: notifyError,
      });
    });
  }

  /**
   * The socket layer's real-time close effect: connected participants must end
   * on a read-only completion state and never regain write access through
   * their old sockets. Registered by the socket module at composition; absent
   * in compositions without sockets, where it is simply not needed.
   *
   * @type {(boardName: string) => Promise<void>}
   */
  let notifyBoardClosed = async () => {};

  /**
   * @param {{notifyBoardClosed?: (boardName: string) => Promise<void>}} effects
   * @returns {void}
   */
  function registerCloseEffects(effects) {
    if (typeof effects?.notifyBoardClosed === "function") {
      notifyBoardClosed = effects.notifyBoardClosed;
    }
  }

  /**
   * Drains already-admitted writes, levels the snapshot with the ledger,
   * validates one final authoritative sequence, and produces the immutable
   * archive. Throws on validation or storage failure — the caller classifies
   * the failure, records it durably, and leaves the session recoverable.
   *
   * @param {{boardSessionId: string, eventId: string, organizerId: string, boardName: string}} due
   * @returns {Promise<{finalSeq: number, itemCount: number, entryCount: number}>}
   */
  async function closeOne(due) {
    const board = await getOrLoadBoard(due.boardName, dependencies);
    // The write boundary: every mutation already admitted into the board
    // session queue completes its acceptance before this resolves, and any
    // persistent mutation enqueued afterwards is refused. Live revalidation
    // (the Board Session left its open window) refuses nearly everything;
    // the barrier makes the remaining interleavings deterministic.
    await getBoardSession(board).sealWrites();
    const saveResult = await board.save();
    if (saveResult.status === "failed" || saveResult.status === "stale") {
      throw closeError(
        "WBO_BOARD_ARCHIVE_SAVE_FAILED",
        `Board snapshot save did not settle before archive: ${saveResult.status}`,
      );
    }

    const finalSeq = board.getSeq();
    const persistedSeq = await readPersistedSnapshotSeq(board);
    const ledger = board.mutationLedger;
    if (!ledger) {
      throw closeError(
        "WBO_BOARD_ARCHIVE_LEDGER_MISSING",
        "Board has no mutation ledger to validate against",
      );
    }
    const exported = await exportLedgerContent(ledger);
    // The snapshot projection and the accepted-mutation ledger must agree on
    // the final authoritative sequence. A mismatch means accepted writes are
    // not durably settled — the archive must not be produced.
    if (persistedSeq !== finalSeq || exported.lastSeq !== finalSeq) {
      const error =
        /** @type {Error & {code: string, finalSeq: number, persistedSeq: number, ledgerSeq: number}} */
        (new Error("Close validation failed: final sequence disagreement"));
      error.code = "WBO_BOARD_ARCHIVE_SEQ_MISMATCH";
      error.finalSeq = finalSeq;
      error.persistedSeq = persistedSeq;
      error.ledgerSeq = exported.lastSeq;
      throw error;
    }

    // Canvas: the stored snapshot just settled at the final sequence; an
    // empty session has no snapshot file and archives a canonical empty
    // canvas instead.
    let canvasContent;
    try {
      canvasContent = await fsp.readFile(board.file);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {
        throw error;
      }
      if (finalSeq !== 0) {
        throw closeError(
          "WBO_BOARD_ARCHIVE_SNAPSHOT_MISSING",
          "Close validation failed: snapshot file missing past sequence zero",
        );
      }
      const emptyEnvelope = createDefaultStoredSvgEnvelope(
        { readonly: false },
        0,
      );
      canvasContent = serializeStoredSvgEnvelope(
        emptyEnvelope.prefix,
        [],
        emptyEnvelope.suffix,
      );
    }

    const archivedAtMs = clock();
    // The manifest is deterministic given the sealed board state: no wall
    // clock fields. A close that crashed between the archive writes and the
    // lifecycle seal regenerates byte-identical objects, so the archive
    // store's immutable put accepts the retry as the no-op it is.
    const manifest = {
      format: ARCHIVE_FORMAT,
      boardSessionId: due.boardSessionId,
      eventId: due.eventId,
      organizerId: due.organizerId,
      finalSeq,
      itemCount: board.authoritativeItemCount(),
      acceptedMutationCount: exported.entryCount,
      integrity: {
        [ARCHIVE_CANVAS_OBJECT]: sha256Hex(canvasContent),
        [ARCHIVE_LEDGER_OBJECT]: sha256Hex(exported.content),
      },
    };
    const keyPrefix = `board-archives/${due.boardSessionId}`;
    const manifestKey = `${keyPrefix}/${ARCHIVE_MANIFEST_OBJECT}`;
    try {
      await archiveStore.putArchive(
        `${keyPrefix}/${ARCHIVE_CANVAS_OBJECT}`,
        canvasContent,
      );
      await archiveStore.putArchive(
        `${keyPrefix}/${ARCHIVE_LEDGER_OBJECT}`,
        exported.content,
      );
      // The manifest is the commit marker: it lands last, so an interrupted
      // close never leaves a manifest vouching for an incomplete archive.
      await archiveStore.putArchive(
        manifestKey,
        JSON.stringify(manifest, null, 2),
      );
    } catch (error) {
      // Storage faults keep the immutable-store conflict code (an integrity
      // signal of its own); every other failure is a storage write failure.
      if (
        /** @type {Error & {code?: unknown}} */ (error).code !==
        "WBO_ARCHIVE_OBJECT_EXISTS"
      ) {
        /** @type {Error & {code?: string}} */ (error).code =
          "WBO_BOARD_ARCHIVE_STORAGE_WRITE_FAILED";
      }
      throw error;
    }

    const sealed = await organizerStore.markBoardSessionClosed({
      boardSessionId: due.boardSessionId,
      archiveKey: manifestKey,
      finalSeq,
      archivedAtMs,
    });
    if (sealed.ok === false) {
      throw closeError(
        "WBO_BOARD_ARCHIVE_SEAL_REFUSED",
        `Board session could not be sealed: ${sealed.reason}`,
      );
    }
    return {
      finalSeq,
      itemCount: manifest.itemCount,
      entryCount: exported.entryCount,
    };
  }

  /**
   * One close pass: attempts every Board Session the store reports due —
   * drained `closing` sessions and `archive_failed` sessions whose automatic
   * retry backoff has elapsed. A failed attempt moves the session to
   * `archive_failed` with its classified failure reason and retry context
   * (or refreshes that context on a failing retry) and is retried by the next
   * eligible pass — automatic recovery or an operator's manual retry. A
   * success seals the session closed. Failures never propagate to the caller
   * (which may be an admission path) and never seal a session closed.
   *
   * @param {{now?: number, closeDrainMs?: number, archiveRetryMs?: number}} [input]
   * @returns {Promise<{boardSessionId: string, finalSeq: number}[]>}
   */
  async function runDueCloses(input = {}) {
    const now = typeof input.now === "number" ? input.now : clock();
    const due = organizerStore.listBoardSessionsDueToClose({
      now,
      closeDrainMs: input.closeDrainMs,
      archiveRetryMs:
        typeof input.archiveRetryMs === "number"
          ? input.archiveRetryMs
          : archiveRetryMs,
    });
    /** @type {{boardSessionId: string, finalSeq: number}[]} */
    const closed = [];
    for (const session of due) {
      if (closesInFlight.has(session.boardSessionId)) continue;
      closesInFlight.add(session.boardSessionId);
      let sealed = false;
      try {
        const result = await closeOne(session);
        sealed = true;
        closed.push({
          boardSessionId: session.boardSessionId,
          finalSeq: result.finalSeq,
        });
        metrics.recordBoardArchiveClose("archived");
        logger.info("hosted.board_session_archived", {
          board: session.boardName,
          board_session: session.boardSessionId,
          event: session.eventId,
          final_seq: result.finalSeq,
          items: result.itemCount,
          ledger_entries: result.entryCount,
        });
      } catch (error) {
        const failure = classifyArchiveFailure(error);
        metrics.recordBoardArchiveClose("failed", failure.code);
        logger.error("hosted.board_session_archive_failed", {
          board: session.boardName,
          board_session: session.boardSessionId,
          failure_code: failure.code,
          error,
        });
        await organizerStore
          .recordBoardSessionArchiveFailed({
            boardSessionId: session.boardSessionId,
            code: failure.code,
            message: failure.message,
          })
          .catch((auditError) => {
            logger.error("hosted.board_session_archive_audit_failed", {
              board_session: session.boardSessionId,
              error: auditError,
            });
          });
        if (notifications) {
          // The first failure of an episode informs the organizer once; the
          // retry backoff refreshes the durable failure context but must not
          // turn into a mail storm.
          const failed = organizerStore.getBoardSessionById(
            session.boardSessionId,
          );
          if (failed?.archiveFailure?.attempts === 1) {
            await notifyNotice(
              notifications.onSessionArchiveFailed({
                boardSessionId: session.boardSessionId,
                eventId: session.eventId,
                organizerId: session.organizerId,
                eventName: eventNameFor(session),
                failureCode: failure.code,
              }),
              session,
            );
          }
        }
      } finally {
        closesInFlight.delete(session.boardSessionId);
      }
      if (sealed) {
        // The session is sealed by now: the completion notification is
        // best-effort presentation, never part of the archive contract. A
        // failure here must not be recorded as an archive failure — the next
        // reconnect of any missed socket re-decides admission honestly. A
        // failed attempt skips this on purpose: connected participants are
        // not told the event closed, because it has not.
        await notifyBoardClosed(session.boardName).catch((error) => {
          logger.error("hosted.board_session_close_notify_failed", {
            board: session.boardName,
            error,
          });
        });
        if (notifications) {
          // The organizer learns the archive succeeded and the event's
          // members learn the event has ended. Enqueueing is durable before
          // delivery, so a slow or failing vendor cannot hold the close pass,
          // and a notice failure is never an archive failure.
          await notifyNotice(
            notifications.onSessionArchived({
              boardSessionId: session.boardSessionId,
              eventId: session.eventId,
              organizerId: session.organizerId,
              eventName: eventNameFor(session),
            }),
            session,
          );
        }
      }
    }
    return closed;
  }

  return { registerCloseEffects, runDueCloses };
}

export { createBoardArchivePipeline };
