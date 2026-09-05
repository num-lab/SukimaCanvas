import crypto from "node:crypto";
import fsp from "node:fs/promises";
import { BoardData } from "../../board/data.mjs";
import {
  deleteLoadedBoard,
  getLoadedBoard,
  setLoadedBoard,
} from "../../board/registry.mjs";
import { getBoardSession } from "../../board/session.mjs";
import observability from "../../observability/index.mjs";
import { readStoredSvgSeq } from "../../persistence/svg_board_store.mjs";
import {
  createDefaultStoredSvgEnvelope,
  serializeStoredSvgEnvelope,
} from "../../persistence/svg_envelope.mjs";

const { logger } = observability;

/**
 * The durable close pipeline for Board Sessions.
 *
 * When a Board Session's CLOSING drain window elapses, this pipeline forms the
 * final write boundary: it drains every already-admitted persistent write, the
 * stored SVG snapshot is brought level with the accepted-mutation ledger, and
 * both must agree on one final authoritative sequence before the immutable
 * Private Board Archive is produced. Only then is the session sealed CLOSED —
 * a validation or storage failure leaves the session draining and retries on
 * the next close pass, never dressing a failure up as a successful close.
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
 * - failure: still `closing`, with an observable failure audit record; the
 *   next close pass retries the whole pipeline.
 *
 * @typedef {{
 *   organizerStore: ReturnType<typeof import("../organizers/store.mjs").createFileOrganizerStore>,
 *   archiveStore: ReturnType<typeof import("./store.mjs").createFileBoardArchiveStore>,
 *   config: import("../../../types/server-runtime.d.ts").ServerConfig,
 *   clock?: () => number,
 * }} BoardArchivePipelineDependencies
 */

const ARCHIVE_FORMAT = "sukimacanvas-board-archive-v1";
/** Every accepted mutation plus its follow-up effects carries an entry. */
const ARCHIVE_LEDGER_OBJECT = "ledger.jsonl";
const ARCHIVE_CANVAS_OBJECT = "canvas.svg";
const ARCHIVE_MANIFEST_OBJECT = "manifest.json";

/**
 * Loads or returns the process-cached board instance, mirroring the socket
 * layer's instance cache so the pipeline and live connections always observe
 * the same board. A load replays ledger entries past the stored snapshot and
 * fails loudly on ledger gaps or corruption — the first validation gate of
 * every close.
 *
 * @param {string} boardName
 * @param {BoardArchivePipelineDependencies} dependencies
 * @returns {Promise<import("../../board/data.mjs").BoardData>}
 */
async function getOrLoadBoard(boardName, dependencies) {
  const cached = getLoadedBoard(boardName);
  if (cached) return cached;
  const loaded = BoardData.load(boardName, dependencies.config).then(
    (board) => {
      // A stale save cannot recover by itself: drop the instance so the next
      // load rebuilds from snapshot plus ledger. No live socket is attached
      // here — the socket layer owns its own instance-drop effects.
      board.onStaleSave = async () => {
        const current = await getLoadedBoard(boardName);
        if (current !== board) return;
        deleteLoadedBoard(boardName);
        board.dispose();
        logger.warn("board.stale_instance_dropped", {
          board: boardName,
          reason: "save_seq_mismatch",
          source: "board_archive_close",
        });
      };
      return board;
    },
  );
  setLoadedBoard(boardName, loaded);
  return loaded;
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
 * @param {BoardArchivePipelineDependencies} dependencies
 */
function createBoardArchivePipeline(dependencies) {
  const organizerStore = dependencies.organizerStore;
  const archiveStore = dependencies.archiveStore;
  const clock = dependencies.clock || (() => Date.now());
  /** @type {Set<string>} */
  const closesInFlight = new Set();

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
   * archive. Throws on validation or storage failure — the caller records the
   * failure and leaves the session draining.
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
      throw new Error(
        `Board snapshot save did not settle before archive: ${saveResult.status}`,
      );
    }

    const finalSeq = board.getSeq();
    const persistedSeq = await readPersistedSnapshotSeq(board);
    const ledger = board.mutationLedger;
    if (!ledger) {
      throw new Error("Board has no mutation ledger to validate against");
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
        throw new Error(
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
    const manifest = {
      format: ARCHIVE_FORMAT,
      boardSessionId: due.boardSessionId,
      eventId: due.eventId,
      organizerId: due.organizerId,
      finalSeq,
      itemCount: board.authoritativeItemCount(),
      acceptedMutationCount: exported.entryCount,
      closedAtMs: archivedAtMs,
      integrity: {
        [ARCHIVE_CANVAS_OBJECT]: sha256Hex(canvasContent),
        [ARCHIVE_LEDGER_OBJECT]: sha256Hex(exported.content),
      },
    };
    const keyPrefix = `board-archives/${due.boardSessionId}`;
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
    const manifestKey = `${keyPrefix}/${ARCHIVE_MANIFEST_OBJECT}`;
    await archiveStore.putArchive(
      manifestKey,
      JSON.stringify(manifest, null, 2),
    );

    const sealed = await organizerStore.markBoardSessionClosed({
      boardSessionId: due.boardSessionId,
      archiveKey: manifestKey,
      finalSeq,
      archivedAtMs,
    });
    if (sealed.ok === false) {
      throw new Error(`Board session could not be sealed: ${sealed.reason}`);
    }
    return {
      finalSeq,
      itemCount: manifest.itemCount,
      entryCount: exported.entryCount,
    };
  }

  /**
   * One close pass: seals every Board Session whose drain window has elapsed.
   * Failures are recorded and retried by the next pass; they never propagate
   * to the caller (which may be an admission path) and never seal a session
   * closed.
   *
   * @param {{now?: number, closeDrainMs?: number}} [input]
   * @returns {Promise<{boardSessionId: string, finalSeq: number}[]>}
   */
  async function runDueCloses(input = {}) {
    const now = typeof input.now === "number" ? input.now : clock();
    const due = organizerStore.listBoardSessionsDueToClose({
      now,
      closeDrainMs: input.closeDrainMs,
    });
    /** @type {{boardSessionId: string, finalSeq: number}[]} */
    const closed = [];
    for (const session of due) {
      if (closesInFlight.has(session.boardSessionId)) continue;
      closesInFlight.add(session.boardSessionId);
      try {
        const result = await closeOne(session);
        closed.push({
          boardSessionId: session.boardSessionId,
          finalSeq: result.finalSeq,
        });
        logger.info("hosted.board_session_archived", {
          board: session.boardName,
          board_session: session.boardSessionId,
          event: session.eventId,
          final_seq: result.finalSeq,
          items: result.itemCount,
          ledger_entries: result.entryCount,
        });
        await notifyBoardClosed(session.boardName);
      } catch (error) {
        logger.error("hosted.board_session_archive_failed", {
          board: session.boardName,
          board_session: session.boardSessionId,
          error,
        });
        await organizerStore
          .recordBoardSessionArchiveFailed({
            boardSessionId: session.boardSessionId,
          })
          .catch((auditError) => {
            logger.error("hosted.board_session_archive_audit_failed", {
              board_session: session.boardSessionId,
              error: auditError,
            });
          });
      } finally {
        closesInFlight.delete(session.boardSessionId);
      }
    }
    return closed;
  }

  return { registerCloseEffects, runDueCloses };
}

export { createBoardArchivePipeline };
