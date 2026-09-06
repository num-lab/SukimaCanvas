import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import observability from "../../observability/index.mjs";

const { logger } = observability;

const STORE_FORMAT_VERSION = 1;

/**
 * Automatic retry budget for one export job. A job that failed this many
 * render attempts stays `failed` — recovery is a new export request, never an
 * endlessly repeating task.
 */
const MAX_EXPORT_ATTEMPTS = 3;

/** @typedef {"queued" | "processing" | "succeeded" | "failed"} BoardExportStatus */
/**
 * @typedef {{
 *   exportId: string,
 *   boardSessionId: string,
 *   eventId: string,
 *   organizerId: string,
 *   requestedByAccountId: string,
 *   status: BoardExportStatus,
 *   attempts: number,
 *   createdAtMs: number,
 *   startedAtMs: number | null,
 *   finishedAtMs: number | null,
 *   failure: {code: string, message: string, lastFailedAtMs: number} | null,
 *   result: {byteLength: number, width: number, height: number, sha256: string} | null,
 *   downloadRevokedAtMs: number | null,
 * }} StoredBoardExport
 */

/**
 * Derives the bearer token of an export's download link from values that are
 * already durable: the export id and its finish time, keyed by the deployment
 * secret. Nothing secret is stored at rest, the console can always re-derive
 * the current link, and revocation (a stored flag) kills the link immediately.
 *
 * @param {string} hmacKey
 * @param {string} exportId
 * @param {number} finishedAtMs
 * @returns {string}
 */
function deriveDownloadToken(hmacKey, exportId, finishedAtMs) {
  const mac = crypto
    .createHmac("sha256", hmacKey)
    .update(`board-export-download:${exportId}:${finishedAtMs}`)
    .digest("base64url");
  return `${exportId}.${mac}`;
}

/**
 * Durable storage for Board Image Export jobs and their PNG results.
 *
 * Following the brand-asset store, job metadata is a JSON index under one data
 * directory and the rendered PNG bytes are opaque files beside it — outside
 * the static web root, so the only read path is the authorized download route.
 * The download URL carries the export id plus an HMAC-derived token that must
 * still be presented by an authorized organizer member, and it stops working
 * the moment the export's link is revoked or the export deleted.
 *
 * Jobs are durable across restarts: a job found `processing` with no runner
 * attached (a crash between the processing claim and the terminal write) is
 * re-queued by the next runner pass, and terminal states are never re-run.
 *
 * @param {{
 *   dataDir: string,
 *   clock?: () => number,
 *   randomId?: () => string,
 *   linkTtlMs: number,
 *   hmacKey: string,
 * }} options
 */
function createFileBoardExportStore(options) {
  const dataDir = options.dataDir;
  const clock = options.clock || (() => Date.now());
  const randomId =
    options.randomId || (() => crypto.randomBytes(12).toString("base64url"));
  const linkTtlMs = options.linkTtlMs;
  const hmacKey = options.hmacKey;
  const exportsDir = path.join(dataDir, "board-exports");
  const INDEX_FILE = path.join(exportsDir, "index.json");

  /** @type {Map<string, StoredBoardExport>} */
  const exportsById = new Map();
  let loaded = false;
  let writeQueue = Promise.resolve();

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    fs.mkdirSync(exportsDir, { recursive: true });
    let contents;
    try {
      contents = fs.readFileSync(INDEX_FILE, "utf8");
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
        return;
      }
      throw error;
    }
    const parsed = JSON.parse(contents);
    if (parsed.version !== STORE_FORMAT_VERSION) {
      throw new Error(`Unsupported hosted board export store format`);
    }
    for (const record of /** @type {StoredBoardExport[]} */ (
      parsed.exports || []
    )) {
      exportsById.set(record.exportId, record);
    }
  }

  /**
   * @param {string} exportId
   * @returns {string}
   */
  function bytesPath(exportId) {
    return path.join(exportsDir, `${exportId}.png`);
  }

  /**
   * @template T
   * @param {() => T | Promise<T>} task
   * @returns {Promise<T>}
   */
  function enqueueWrite(task) {
    const pending = /** @type {Promise<void>} */ (
      writeQueue.then(
        () => {},
        () => {},
      )
    );
    const run = pending.then(task);
    writeQueue = run.then(
      () => {},
      (error) => {
        logger.error("hosted_board_export_store.write_failed", { error });
      },
    );
    return run;
  }

  /**
   * @returns {Promise<void>}
   */
  async function persistIndexNow() {
    fs.mkdirSync(exportsDir, { recursive: true });
    const temporaryPath = `${INDEX_FILE}.tmp-${process.pid}-${crypto
      .randomBytes(4)
      .toString("hex")}`;
    await fs.promises.writeFile(
      temporaryPath,
      JSON.stringify({
        version: STORE_FORMAT_VERSION,
        exports: [...exportsById.values()],
      }),
      "utf8",
    );
    await fs.promises.rename(temporaryPath, INDEX_FILE);
  }

  /**
   * @param {StoredBoardExport} record
   * @returns {StoredBoardExport}
   */
  function cloneCurrent(record) {
    return JSON.parse(JSON.stringify(record));
  }

  /**
   * Whether a job still holds the session's export slot: queued or processing,
   * or failed inside its retry budget (it will run again automatically, so a
   * second request must not pile up duplicate work).
   *
   * @param {StoredBoardExport} record
   * @returns {boolean}
   */
  function occupiesExportSlot(record) {
    return (
      record.status === "queued" ||
      record.status === "processing" ||
      (record.status === "failed" && record.attempts < MAX_EXPORT_ATTEMPTS)
    );
  }

  /**
   * Creates an export job for a Board Session. Idempotent while a job for the
   * same session is still unsettled (queued, processing, or failed inside its
   * retry budget): that job is returned instead of piling up duplicate work.
   * Terminal jobs do not block a fresh request.
   *
   * @param {{
   *   boardSessionId: string,
   *   eventId: string,
   *   organizerId: string,
   *   requestedByAccountId: string,
   * }} input
   * @returns {Promise<{export: StoredBoardExport, created: boolean}>}
   */
  async function createExport(input) {
    ensureLoaded();
    const boardSessionId = String(input.boardSessionId || "");
    for (const record of exportsById.values()) {
      if (
        record.boardSessionId === boardSessionId &&
        occupiesExportSlot(record)
      ) {
        return { export: cloneCurrent(record), created: false };
      }
    }
    const now = clock();
    /** @type {StoredBoardExport} */
    const record = {
      exportId: randomId(),
      boardSessionId,
      eventId: String(input.eventId || ""),
      organizerId: String(input.organizerId || ""),
      requestedByAccountId: String(input.requestedByAccountId || ""),
      status: "queued",
      attempts: 0,
      createdAtMs: now,
      startedAtMs: null,
      finishedAtMs: null,
      failure: null,
      result: null,
      downloadRevokedAtMs: null,
    };
    exportsById.set(record.exportId, record);
    await enqueueWrite(persistIndexNow);
    return { export: cloneCurrent(record), created: true };
  }

  /**
   * @param {string} exportId
   * @returns {StoredBoardExport | null}
   */
  function getExport(exportId) {
    ensureLoaded();
    const record = exportsById.get(String(exportId || ""));
    return record ? cloneCurrent(record) : null;
  }

  /**
   * @param {string} eventId
   * @param {{limit?: number}} [options]
   * @returns {StoredBoardExport[]}
   */
  function listExportsForEvent(eventId, options = {}) {
    ensureLoaded();
    const limit =
      typeof options.limit === "number" && options.limit > 0
        ? options.limit
        : 20;
    return [...exportsById.values()]
      .filter((record) => record.eventId === eventId)
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, limit)
      .map(cloneCurrent);
  }

  /**
   * The runner's work queue: queued jobs, failed jobs inside their retry
   * budget whose backoff elapsed, and `processing` jobs a previous process
   * never finished (the runner re-queues those orphans itself). Jobs beyond
   * the attempt budget are terminal and never due again.
   *
   * @param {{now?: number, retryMs?: number}} [input]
   * @returns {StoredBoardExport[]}
   */
  function listDueExports(input = {}) {
    ensureLoaded();
    const now = typeof input.now === "number" ? input.now : clock();
    const retryMs =
      typeof input.retryMs === "number" && input.retryMs >= 0
        ? input.retryMs
        : 0;
    return [...exportsById.values()]
      .filter((record) => {
        if (record.status === "queued") return true;
        if (record.status === "processing") return true;
        if (record.status !== "failed") return false;
        if (record.attempts >= MAX_EXPORT_ATTEMPTS) return false;
        const lastFailedAtMs = record.failure?.lastFailedAtMs ?? 0;
        return now >= lastFailedAtMs + retryMs;
      })
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map(cloneCurrent);
  }

  /**
   * Claims a job for rendering. `attempts` counts rendering attempts; the
   * attempt budget is enforced by `listDueExports`.
   *
   * @param {string} exportId
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async function markExportProcessing(exportId) {
    ensureLoaded();
    const record = exportsById.get(String(exportId || ""));
    if (!record) return { ok: false, reason: "unknown_export" };
    if (
      record.status !== "queued" &&
      record.status !== "failed" &&
      record.status !== "processing"
    ) {
      return { ok: false, reason: "not_claimable" };
    }
    record.status = "processing";
    record.attempts += 1;
    record.startedAtMs = clock();
    await enqueueWrite(persistIndexNow);
    return { ok: true };
  }

  /**
   * Re-queues a `processing` job orphaned by a restart. A no-op for any other
   * state, so a racing runner pass cannot resurrect a finished job.
   *
   * @param {string} exportId
   * @returns {Promise<void>}
   */
  async function requeueOrphanedExport(exportId) {
    ensureLoaded();
    const record = exportsById.get(String(exportId || ""));
    if (!record || record.status !== "processing") return;
    record.status = "queued";
    await enqueueWrite(persistIndexNow);
  }

  /**
   * Settles a claimed job as succeeded: the PNG bytes are stored first (atomic
   * rename) so the index never references missing data, then the record.
   *
   * @param {{
   *   exportId: string,
   *   bytes: Buffer,
   *   width: number,
   *   height: number,
   *   sha256: string,
   * }} input
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async function markExportSucceeded(input) {
    ensureLoaded();
    const record = exportsById.get(String(input.exportId || ""));
    if (!record) return { ok: false, reason: "unknown_export" };
    if (record.status !== "processing") {
      return { ok: false, reason: "not_processing" };
    }
    const bytesPathForRecord = `${bytesPath(record.exportId)}`;
    const temporaryPath = `${bytesPathForRecord}.tmp-${process.pid}-${crypto
      .randomBytes(4)
      .toString("hex")}`;
    await fs.promises.writeFile(temporaryPath, input.bytes);
    await fs.promises.rename(temporaryPath, bytesPathForRecord);
    const now = clock();
    record.status = "succeeded";
    record.finishedAtMs = now;
    record.failure = null;
    record.result = {
      byteLength: input.bytes.length,
      width: input.width,
      height: input.height,
      sha256: input.sha256,
    };
    record.downloadRevokedAtMs = null;
    await enqueueWrite(persistIndexNow);
    return { ok: true };
  }

  /**
   * Settles a claimed job as failed with its deterministic failure code. A job
   * inside its retry budget becomes due again after the backoff; a job past
   * the budget stays failed until a fresh export is requested.
   *
   * @param {{
   *   exportId: string,
   *   code: string,
   *   message: string,
   * }} input
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async function markExportFailed(input) {
    ensureLoaded();
    const record = exportsById.get(String(input.exportId || ""));
    if (!record) return { ok: false, reason: "unknown_export" };
    if (record.status !== "processing") {
      return { ok: false, reason: "not_processing" };
    }
    record.status = "failed";
    record.finishedAtMs = clock();
    record.failure = {
      code: String(input.code || "internal"),
      // The internal detail is operator/audit material, clamped like the
      // archive failure records.
      message: String(input.message || "").slice(0, 500),
      lastFailedAtMs: record.finishedAtMs,
    };
    await enqueueWrite(persistIndexNow);
    return { ok: true };
  }

  /**
   * Resolves the download-link state of an export: whether a link is currently
   * offerable and, when not, the deterministic reason it is not. One predicate
   * shared by the console link rendering and the download verification so the
   * two can never drift apart.
   *
   * @param {StoredBoardExport | undefined} record
   * @param {number} [nowMs]
   * @returns {{ok: true, finishedAtMs: number} | {ok: false, reason: "unknown_export" | "no_result" | "revoked" | "expired"}}
   */
  function downloadLinkState(record, nowMs) {
    if (
      !record ||
      record.status !== "succeeded" ||
      record.finishedAtMs === null
    ) {
      return { ok: false, reason: "unknown_export" };
    }
    if (record.result === null) {
      return { ok: false, reason: "no_result" };
    }
    if (record.downloadRevokedAtMs !== null) {
      return { ok: false, reason: "revoked" };
    }
    const now = typeof nowMs === "number" ? nowMs : clock();
    if (now >= record.finishedAtMs + linkTtlMs) {
      return { ok: false, reason: "expired" };
    }
    return { ok: true, finishedAtMs: record.finishedAtMs };
  }

  /**
   * The currently valid download token of a succeeded export, or null when no
   * link is offerable. The token is derived, never stored.
   *
   * @param {string} exportId
   * @returns {string | null}
   */
  function downloadHrefToken(exportId) {
    ensureLoaded();
    const state = downloadLinkState(exportsById.get(String(exportId || "")));
    return state.ok
      ? deriveDownloadToken(hmacKey, String(exportId), state.finishedAtMs)
      : null;
  }

  /**
   * @param {string} exportId
   * @returns {{expiresAtMs: number} | null}
   */
  function downloadLinkExpiry(exportId) {
    ensureLoaded();
    const state = downloadLinkState(exportsById.get(String(exportId || "")));
    return state.ok ? { expiresAtMs: state.finishedAtMs + linkTtlMs } : null;
  }

  /**
   * Verifies a download request against the export's link state: the export
   * must exist, be succeeded with stored bytes, not revoked, inside its
   * validity window, and present the exact derived token.
   *
   * @param {{exportId: string, token: string, nowMs?: number}} input
   * @returns {{ok: true} | {ok: false, reason: "unknown_export" | "no_result" | "revoked" | "expired" | "invalid_token"}}
   */
  function verifyExportDownloadToken(input) {
    ensureLoaded();
    const record = exportsById.get(String(input.exportId || ""));
    const state = downloadLinkState(record, input.nowMs);
    if (!state.ok) return state;
    const expected = deriveDownloadToken(
      hmacKey,
      /** @type {StoredBoardExport} */ (record).exportId,
      state.finishedAtMs,
    );
    const provided = String(input.token || "");
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: "invalid_token" };
    }
    return { ok: true };
  }

  /**
   * Revokes the download link of a succeeded export. The stored result stays;
   * every existing link stops working immediately.
   *
   * @param {string} exportId
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async function revokeExportDownload(exportId) {
    ensureLoaded();
    const record = exportsById.get(String(exportId || ""));
    if (!record) return { ok: false, reason: "unknown_export" };
    if (record.status !== "succeeded") {
      return { ok: false, reason: "not_succeeded" };
    }
    record.downloadRevokedAtMs = clock();
    await enqueueWrite(persistIndexNow);
    return { ok: true };
  }

  /**
   * Removes an export record and its stored bytes. Idempotent for unknown
   * ids. Any outstanding download link dies with the record.
   *
   * @param {string} exportId
   * @returns {Promise<{ok: boolean}>}
   */
  async function deleteExport(exportId) {
    ensureLoaded();
    const record = exportsById.get(String(exportId || ""));
    if (!record) return { ok: false };
    exportsById.delete(record.exportId);
    await enqueueWrite(async () => {
      await persistIndexNow();
      await fs.promises.rm(bytesPath(record.exportId), { force: true });
    });
    return { ok: true };
  }

  /**
   * Removes every export record and stored bytes of one event — the outcome
   * purge's associated-export contract. Scans the whole index rather than a
   * capped list, so a long export history is purged completely, and replays
   * idempotently when nothing is left. Records are dropped in memory first so
   * a concurrent console read can never offer a download whose bytes are
   * about to vanish.
   *
   * @param {string} eventId
   * @returns {Promise<number>} the number of export records removed
   */
  async function deleteExportsForEvent(eventId) {
    ensureLoaded();
    const normalized = String(eventId || "");
    /** @type {StoredBoardExport[]} */
    const removed = [];
    for (const record of exportsById.values()) {
      if (record.eventId === normalized) removed.push(record);
    }
    for (const record of removed) {
      exportsById.delete(record.exportId);
    }
    if (removed.length > 0) {
      await enqueueWrite(async () => {
        await persistIndexNow();
        for (const record of removed) {
          await fs.promises.rm(bytesPath(record.exportId), { force: true });
        }
      });
    }
    return removed.length;
  }

  /**
   * Removes every export record and stored bytes of one Board Session — the
   * session-scoped retention purge's associated-export contract, so a newer
   * session's jobs are never destroyed by an older session's 90-day expiry.
   * Same idempotent replay semantics as the event-wide variant.
   *
   * @param {string} boardSessionId
   * @returns {Promise<number>} the number of export records removed
   */
  async function deleteExportsForSession(boardSessionId) {
    ensureLoaded();
    const normalized = String(boardSessionId || "");
    /** @type {StoredBoardExport[]} */
    const removed = [];
    for (const record of exportsById.values()) {
      if (record.boardSessionId === normalized) removed.push(record);
    }
    for (const record of removed) {
      exportsById.delete(record.exportId);
    }
    if (removed.length > 0) {
      await enqueueWrite(async () => {
        await persistIndexNow();
        for (const record of removed) {
          await fs.promises.rm(bytesPath(record.exportId), { force: true });
        }
      });
    }
    return removed.length;
  }

  /**
   * Reads a succeeded export's PNG bytes, or null when they are gone.
   *
   * @param {string} exportId
   * @returns {Promise<Buffer | null>}
   */
  async function readExportBytes(exportId) {
    const record = getExport(exportId);
    if (!record || record.status !== "succeeded" || record.result === null) {
      return null;
    }
    try {
      return await fs.promises.readFile(bytesPath(record.exportId));
    } catch (error) {
      logger.error("hosted_board_export_store.read_failed", {
        error,
        export_id: record.exportId,
      });
      return null;
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async function flush() {
    ensureLoaded();
    await writeQueue;
  }

  return {
    createExport,
    getExport,
    listExportsForEvent,
    listDueExports,
    markExportProcessing,
    requeueOrphanedExport,
    markExportSucceeded,
    markExportFailed,
    downloadHrefToken,
    downloadLinkExpiry,
    verifyExportDownloadToken,
    revokeExportDownload,
    deleteExport,
    deleteExportsForEvent,
    deleteExportsForSession,
    readExportBytes,
    flush,
  };
}

export { createFileBoardExportStore, MAX_EXPORT_ATTEMPTS };
