import crypto from "node:crypto";

import observability from "../../observability/index.mjs";
import { renderArchivePng } from "./render.mjs";

const { logger, metrics } = observability;

/**
 * The durable Board Image Export pipeline.
 *
 * An export job turns one successfully sealed Private Board Archive into a
 * sanitized PNG projection — white background, content bounds plus margin,
 * capped edge, no attribution or internal metadata — and stores the result for
 * authorized, expiring download. The job reads the archive through the archive
 * store only (never a live Board Session), verifies the canvas against its
 * manifest integrity hash before rendering, and settles the job durably.
 *
 * Runs ride the same lifecycle poker as the close pipeline: every pass picks
 * up queued jobs, failed jobs whose retry backoff elapsed, and `processing`
 * jobs orphaned by a restart (they are re-queued and re-attempted). Terminal
 * states are never re-run, and a job past its attempt budget stays failed
 * until a fresh export is requested, so repeated passes can never produce
 * contradictory results or endlessly repeating tasks.
 *
 * @typedef {{
 *   exportStore: ReturnType<typeof import("./store.mjs").createFileBoardExportStore>,
 *   archiveStore: ReturnType<typeof import("../archive/store.mjs").createFileBoardArchiveStore>,
 *   organizerStore: ReturnType<typeof import("../organizers/store.mjs").createFileOrganizerStore>,
 *   config: import("../../../types/server-runtime.d.ts").ServerConfig,
 *   clock?: () => number,
 *   renderArchivePng?: typeof import("./render.mjs").renderArchivePng,
 * }} BoardExportPipelineDependencies
 */

/**
 * Deterministic failure codes an export job can settle with. Rendering codes
 * come from the render module; the pipeline adds its input-side codes.
 */
const EXPORT_JOB_FAILURE_CODES = {
  ARCHIVE_UNAVAILABLE: "archive_unavailable",
  STORAGE_WRITE_FAILED: "storage_write_failed",
  INTERNAL: "internal",
};

/** Object name of the archived canvas inside one Board Archive prefix. */
const ARCHIVE_CANVAS_OBJECT = "canvas.svg";

/**
 * Classifies one thrown export error into its durable failure record: a
 * deterministic code for the observable trail plus the error's own message as
 * the internal detail. The mapping never throws — an unknown failure records
 * as `internal` rather than vanishing.
 *
 * @param {unknown} error
 * @returns {{code: string, message: string}}
 */
function classifyExportFailure(error) {
  const code = /** @type {{code?: unknown}} */ (error || {}).code;
  const known = typeof code === "string" ? code : "";
  const mapped =
    /** @type {{[key: string]: string | undefined}} */ ({
      WBO_BOARD_EXPORT_ARCHIVE_UNAVAILABLE:
        EXPORT_JOB_FAILURE_CODES.ARCHIVE_UNAVAILABLE,
      WBO_BOARD_EXPORT_STORAGE_WRITE_FAILED:
        EXPORT_JOB_FAILURE_CODES.STORAGE_WRITE_FAILED,
    })[known] || known;
  return {
    code: mapped || EXPORT_JOB_FAILURE_CODES.INTERNAL,
    message: error instanceof Error ? error.message : String(error || ""),
  };
}

/**
 * Creates one export failure carrying its deterministic code.
 *
 * @param {string} code
 * @param {string} message
 * @returns {Error & {code: string}}
 */
function exportError(code, message) {
  const error = /** @type {Error & {code: string}} */ (new Error(message));
  error.code = code;
  return error;
}

/** @param {string | Uint8Array} content */
function sha256Hex(content) {
  return crypto
    .createHash("sha256")
    .update(
      typeof content === "string" ? Buffer.from(content, "utf8") : content,
    )
    .digest("hex");
}

/**
 * @param {BoardExportPipelineDependencies} dependencies
 */
function createBoardExportPipeline(dependencies) {
  const exportStore = dependencies.exportStore;
  const archiveStore = dependencies.archiveStore;
  const organizerStore = dependencies.organizerStore;
  const render = dependencies.renderArchivePng || renderArchivePng;
  const clock = dependencies.clock || (() => Date.now());
  // Captured once at composition, never re-read per job.
  const exportRetryMs =
    typeof dependencies.config.HOSTED_BOARD_EXPORT_RETRY_MS === "number" &&
    Number.isFinite(dependencies.config.HOSTED_BOARD_EXPORT_RETRY_MS)
      ? Math.max(0, dependencies.config.HOSTED_BOARD_EXPORT_RETRY_MS)
      : 0;
  /** @type {Set<string>} */
  const exportsInFlight = new Set();

  /**
   * Requests an export for one Board Session. Only a successfully archived
   * session — sealed `closed` with its archive key — qualifies: the job reads
   * the Private Board Archive, never a still-editable live Board Session, and
   * raw SVG is never exposed. Creation is idempotent while a job is pending.
   *
   * @param {{
   *   boardSessionId: string,
   *   eventId: string,
   *   organizerId: string,
   *   requestedByAccountId: string,
   *   now?: number,
   * }} input
   * @returns {Promise<{ok: true, export: import("./store.mjs").StoredBoardExport, created: boolean} | {ok: false, reason: "session_not_archived"}>}
   */
  async function requestExport(input) {
    const session = organizerStore.getBoardSessionById(input.boardSessionId);
    if (
      !session ||
      session.status !== "closed" ||
      session.archiveKey === null ||
      session.eventId !== input.eventId ||
      session.organizerId !== input.organizerId
    ) {
      return { ok: false, reason: "session_not_archived" };
    }
    const created = await exportStore.createExport({
      boardSessionId: input.boardSessionId,
      eventId: input.eventId,
      organizerId: input.organizerId,
      requestedByAccountId: input.requestedByAccountId,
    });
    return { ok: true, export: created.export, created: created.created };
  }

  /**
   * Loads and verifies the archived canvas for one job: the session's sealed
   * manifest is read back, the canvas located under the same archive prefix,
   * and its bytes proven against the manifest's integrity hash — the input of
   * an export is exactly the archived content, or the job fails.
   *
   * @param {import("./store.mjs").StoredBoardExport} job
   * @returns {Promise<string>}
   */
  async function readVerifiedArchiveCanvas(job) {
    const session = organizerStore.getBoardSessionById(job.boardSessionId);
    if (
      !session ||
      session.status !== "closed" ||
      typeof session.archiveKey !== "string"
    ) {
      throw exportError(
        "WBO_BOARD_EXPORT_ARCHIVE_UNAVAILABLE",
        "The Board Session has no sealed Private Board Archive to export",
      );
    }
    const prefix = session.archiveKey.slice(
      0,
      session.archiveKey.lastIndexOf("/"),
    );
    const manifestBytes = await archiveStore.readArchive(session.archiveKey);
    if (!manifestBytes) {
      throw exportError(
        "WBO_BOARD_EXPORT_ARCHIVE_UNAVAILABLE",
        "The sealed archive manifest is missing from storage",
      );
    }
    /** @type {{format?: unknown, boardSessionId?: unknown, integrity?: {[key: string]: unknown}}} */
    let manifest;
    try {
      manifest = JSON.parse(manifestBytes.toString("utf8"));
    } catch {
      throw exportError(
        "WBO_BOARD_EXPORT_ARCHIVE_UNAVAILABLE",
        "The sealed archive manifest is unreadable",
      );
    }
    if (manifest.boardSessionId !== job.boardSessionId) {
      throw exportError(
        "WBO_BOARD_EXPORT_ARCHIVE_UNAVAILABLE",
        "The sealed archive manifest does not bind this Board Session",
      );
    }
    const canvasKey = `${prefix}/${ARCHIVE_CANVAS_OBJECT}`;
    const canvasBytes = await archiveStore.readArchive(canvasKey);
    if (!canvasBytes) {
      throw exportError(
        "WBO_BOARD_EXPORT_ARCHIVE_UNAVAILABLE",
        "The archived canvas is missing from storage",
      );
    }
    const expectedDigest = manifest.integrity?.[ARCHIVE_CANVAS_OBJECT];
    if (
      typeof expectedDigest !== "string" ||
      expectedDigest !== sha256Hex(canvasBytes)
    ) {
      throw exportError(
        "WBO_BOARD_EXPORT_ARCHIVE_UNAVAILABLE",
        "The archived canvas does not match its manifest integrity hash",
      );
    }
    return canvasBytes.toString("utf8");
  }

  /**
   * Renders and settles one claimed job. Throws on failure — the caller
   * classifies the failure and records it durably, leaving the job recoverable
   * or terminally failed.
   *
   * @param {import("./store.mjs").StoredBoardExport} job
   * @returns {Promise<void>}
   */
  async function processOne(job) {
    const canvasSvg = await readVerifiedArchiveCanvas(job);
    const rendered = render({ canvasSvg });
    const stored = await exportStore.markExportSucceeded({
      exportId: job.exportId,
      bytes: rendered.png,
      width: rendered.width,
      height: rendered.height,
      sha256: sha256Hex(rendered.png),
    });
    if (stored.ok === false) {
      throw exportError(
        "WBO_BOARD_EXPORT_STORAGE_WRITE_FAILED",
        `The rendered export could not be stored: ${stored.reason}`,
      );
    }
  }

  /**
   * One runner pass: claims and settles every due export job, one at a time.
   * Failures never propagate to the caller (which may be a request path) and
   * never re-run a settled job.
   *
   * @param {{now?: number, retryMs?: number}} [input]
   * @returns {Promise<{succeeded: string[], failed: {exportId: string, code: string}[]}>}
   */
  async function runDueExports(input = {}) {
    const now = typeof input.now === "number" ? input.now : clock();
    const due = exportStore.listDueExports({
      now,
      retryMs:
        typeof input.retryMs === "number" ? input.retryMs : exportRetryMs,
    });
    /** @type {string[]} */
    const succeeded = [];
    /** @type {{exportId: string, code: string}[]} */
    const failed = [];
    for (const job of due) {
      if (exportsInFlight.has(job.exportId)) continue;
      if (job.status === "processing") {
        // Orphaned by a restart: no runner in this process holds it. Re-queue
        // it; the claim below then proceeds exactly like a fresh job.
        await exportStore.requeueOrphanedExport(job.exportId);
      }
      exportsInFlight.add(job.exportId);
      try {
        const claimed = await exportStore.markExportProcessing(job.exportId);
        if (claimed.ok === false) {
          // Deleted or settled between listing and claim: nothing to do.
          continue;
        }
        await processOne(job);
        succeeded.push(job.exportId);
        metrics.recordBoardExport("succeeded");
        logger.info("hosted.board_export_succeeded", {
          board_session: job.boardSessionId,
          event: job.eventId,
          export_id: job.exportId,
        });
      } catch (error) {
        const failure = classifyExportFailure(error);
        failed.push({ exportId: job.exportId, code: failure.code });
        metrics.recordBoardExport("failed", failure.code);
        logger.error("hosted.board_export_failed", {
          board_session: job.boardSessionId,
          export_id: job.exportId,
          failure_code: failure.code,
          error,
        });
        await exportStore
          .markExportFailed({
            exportId: job.exportId,
            code: failure.code,
            message: failure.message,
          })
          .catch((recordError) => {
            logger.error("hosted.board_export_failure_record_failed", {
              export_id: job.exportId,
              error: recordError,
            });
          });
      } finally {
        exportsInFlight.delete(job.exportId);
      }
    }
    return { succeeded, failed };
  }

  return { requestExport, runDueExports };
}

export { createBoardExportPipeline, EXPORT_JOB_FAILURE_CODES };
