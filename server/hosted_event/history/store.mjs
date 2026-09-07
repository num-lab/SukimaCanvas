import crypto from "node:crypto";

import observability from "../../observability/index.mjs";
import { createFileBoardArchiveStore } from "../archive/store.mjs";
import { createFileStateDocuments } from "../storage/documents.mjs";
import {
  IMPORT_FAILURE_CODES,
  importLegacySvgCanvas,
} from "./legacy_svg_import.mjs";

const { logger, metrics } = observability;

const STORE_FORMAT_VERSION = 1;

/** The upload filename is operator-supplied and hostile: bounded and clean. */
const MAX_SOURCE_LABEL_LENGTH = 200;

/**
 * Durable status of one import attempt. `imported` marks the archive as
 * complete; `failed` attempts carry the deterministic failure code and stay
 * in the audit trail forever.
 *
 * @typedef {"imported" | "failed"} HistoricalImportStatus
 */

/**
 * One Historical Archive import attempt. A record is created only after the
 * outcome is known: completed imports point at their immutable archive
 * objects, rejected attempts point at nothing but their reason.
 *
 * @typedef {{
 *   importId: string,
 *   organizerId: string,
 *   status: HistoricalImportStatus,
 *   sourceSha256: string,
 *   sourceLabel: string,
 *   sourceByteLength: number,
 *   itemCount: number | null,
 *   canvasKey: string | null,
 *   manifestKey: string | null,
 *   canvasSha256: string | null,
 *   strippedAttributionCount: number,
 *   importedByAccountId: string,
 *   attemptedAtMs: number,
 *   failure: {code: string, message: string} | null,
 * }} StoredHistoricalArchive
 */

/**
 * Control characters never belong in a source label.
 *
 * @param {unknown} value
 * @returns {string}
 */
function cleanSourceLabel(value) {
  const raw = String(value == null ? "" : value);
  let clean = "";
  for (const char of raw) {
    const code = char.codePointAt(0);
    clean += code !== undefined && (code < 0x20 || code === 0x7f) ? " " : char;
  }
  return clean.trim().slice(0, MAX_SOURCE_LABEL_LENGTH);
}

/**
 * Durable storage and controlled import for Historical Archives.
 *
 * Historical Archives preserve pre-platform WBO results without inventing
 * trust: they are operator-imported, private, read-only archive objects with
 * unknown authorship and no Change Audit — and they are never Board Sessions,
 * so nothing about them can reopen, publish, export, or expire through the
 * Board Session lifecycle. Each import is one explicit, auditable operation
 * by a Platform Operator.
 *
 * The import is idempotent by construction: the import id is derived
 * deterministically from the target organizer and the source content, and
 * the derived archive objects are content-deterministic, so a crashed import
 * (objects partially written, record missing) is completed — not duplicated —
 * by re-importing the same source. A completed import refuses the same
 * source for the same organizer outright: repeated imports never produce
 * indistinguishable conflicting artifacts.
 *
 * Records persist as JSON under the shared hosted data directory, exactly
 * like the other hosted stores; archive objects go through the same
 * write-once, immutable archive store the close pipeline uses, under their
 * own `historical-archives/` key namespace. Keys are internal identifiers,
 * never public access credentials.
 *
 * @param {{
 *   dataDir: string,
 *   clock?: () => number,
 *   archiveStore?: ReturnType<typeof createFileBoardArchiveStore>,
 *   organizerStore: ReturnType<typeof import("../organizers/store.mjs").createFileOrganizerStore>,
 *   stateDocuments?: import("../storage/documents.mjs").StateDocuments,
 * }} options
 */
function createFileHistoricalArchiveStore(options) {
  const dataDir = options.dataDir;
  const stateDocuments =
    options.stateDocuments || createFileStateDocuments({ dataDir });
  const clock = options.clock || (() => Date.now());
  const archiveStore =
    options.archiveStore || createFileBoardArchiveStore({ dataDir });
  const organizerStore = options.organizerStore;

  /** @type {StoredHistoricalArchive[]} */
  const imports = [];
  let loaded = false;
  let writeQueue = Promise.resolve();

  const IMPORTS_FILE = "historical_archives.json";

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    const fallback = { imports: [] };
    const stored = /** @type {any} */ (
      stateDocuments.read(IMPORTS_FILE, fallback)
    );
    if (stored === fallback) return;
    if (stored.version !== STORE_FORMAT_VERSION) {
      throw new Error(
        `Unsupported hosted historical archive store format in ${IMPORTS_FILE}`,
      );
    }
    for (const record of /** @type {StoredHistoricalArchive[]} */ (
      stored.imports || []
    )) {
      imports.push(record);
    }
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
        logger.error("hosted_historical_archive_store.write_failed", { error });
      },
    );
    return run;
  }

  /**
   * @returns {Promise<void>}
   */
  async function persistNow() {
    await stateDocuments.writeMany([
      {
        key: IMPORTS_FILE,
        payload: { version: STORE_FORMAT_VERSION, imports },
      },
    ]);
  }

  /**
   * The import id is a deterministic function of the target organizer and
   * the source content: the same input always addresses the same archive.
   *
   * @param {string} organizerId
   * @param {string} sourceSha256
   * @returns {string}
   */
  function deriveImportId(organizerId, sourceSha256) {
    return `ha-${crypto
      .createHash("sha256")
      .update(`${organizerId}:${sourceSha256}`, "utf8")
      .digest("hex")}`;
  }

  /**
   * The manifest is the archive's self-description and commit marker. Every
   * field is derived from the source content and target — never from the
   * clock or the operator — so a recovery attempt puts byte-identical
   * objects and the write-once store accepts them as the no-ops they are.
   *
   * @param {{importId: string, organizerId: string, sourceSha256: string, sourceByteLength: number, canvas: string, itemCount: number, strippedAttributionCount: number}} input
   * @returns {string}
   */
  function renderManifest(input) {
    return JSON.stringify(
      {
        format: "sukimacanvas-historical-archive-v1",
        importId: input.importId,
        organizerId: input.organizerId,
        // Authorship is never fabricated: a legacy file has no trusted Item
        // Attribution, and anything it claimed was stripped at import.
        authorship: "unknown",
        changeAudit: "none",
        finalSeq: 0,
        itemCount: input.itemCount,
        strippedAttributionCount: input.strippedAttributionCount,
        source: {
          sha256: input.sourceSha256,
          byteLength: input.sourceByteLength,
        },
        integrity: {
          "canvas.svg": crypto
            .createHash("sha256")
            .update(input.canvas, "utf8")
            .digest("hex"),
        },
      },
      null,
      2,
    );
  }

  /**
   * Imports one explicitly selected legacy SVG as a private Historical
   * Archive of the target Organizer. Deterministic outcomes only: the
   * source is parsed strictly, the archive objects are written (manifest
   * last, as the commit marker), and only then is the durable record
   * appended — so every failure leaves a state the same operation can
   * safely replay.
   *
   * @param {{
   *   organizerId: string,
   *   bytes: Uint8Array,
   *   sourceLabel?: string,
   *   operatorAccountId: string,
   * }} input
   * @returns {Promise<
   *   | {ok: true, record: StoredHistoricalArchive}
   *   | {ok: false, reason: "unknown_organizer"}
   *   | {ok: false, reason: "duplicate", record: StoredHistoricalArchive}
   *   | {ok: false, reason: "rejected" | "storage_write_failed", record: StoredHistoricalArchive, failure: {code: string, message: string}}
   * >}
   */
  async function importLegacySvg(input) {
    ensureLoaded();
    const organizerId = String(input.organizerId || "");
    const bytes = input.bytes;
    const operatorAccountId = String(input.operatorAccountId || "");
    if (!organizerStore.getOrganizerById(organizerId)) {
      return { ok: false, reason: "unknown_organizer" };
    }
    const sourceLabel = cleanSourceLabel(input.sourceLabel);
    const sourceSha256 = crypto
      .createHash("sha256")
      .update(bytes || Buffer.alloc(0))
      .digest("hex");
    const importId = deriveImportId(organizerId, sourceSha256);
    const completed = imports.find(
      (record) => record.importId === importId && record.status === "imported",
    );
    if (completed) {
      return { ok: false, reason: "duplicate", record: completed };
    }

    const sourceByteLength = bytes ? bytes.length : 0;
    /** @type {StoredHistoricalArchive} */
    const record = {
      importId,
      organizerId,
      status: "failed",
      sourceSha256,
      sourceLabel,
      sourceByteLength,
      itemCount: null,
      canvasKey: null,
      manifestKey: null,
      canvasSha256: null,
      strippedAttributionCount: 0,
      importedByAccountId: operatorAccountId,
      attemptedAtMs: clock(),
      failure: null,
    };
    try {
      const parsed = importLegacySvgCanvas({ bytes });
      const canvasKey = `historical-archives/${importId}/canvas.svg`;
      const manifestKey = `historical-archives/${importId}/manifest.json`;
      const manifest = renderManifest({
        importId,
        organizerId,
        sourceSha256,
        sourceByteLength,
        canvas: parsed.canvas,
        itemCount: parsed.itemCount,
        strippedAttributionCount: parsed.strippedAttributionCount,
      });
      // The manifest lands last: until it exists, no attempt ever claimed
      // the archive was complete.
      await archiveStore.putArchive(canvasKey, parsed.canvas);
      await archiveStore.putArchive(manifestKey, manifest);
      record.status = "imported";
      record.itemCount = parsed.itemCount;
      record.canvasKey = canvasKey;
      record.manifestKey = manifestKey;
      record.canvasSha256 = crypto
        .createHash("sha256")
        .update(parsed.canvas, "utf8")
        .digest("hex");
      record.strippedAttributionCount = parsed.strippedAttributionCount;
    } catch (error) {
      const rejected =
        typeof (/** @type {{code?: unknown}} */ (error || {}).code) ===
          "string" &&
        Object.values(IMPORT_FAILURE_CODES).includes(
          /** @type {string} */ (/** @type {{code?: unknown}} */ (error).code),
        );
      record.failure = {
        code: rejected
          ? /** @type {{code: string}} */ (error).code
          : "WBO_HISTORY_IMPORT_STORAGE_FAILED",
        message: error instanceof Error ? error.message : String(error || ""),
      };
      logger.warn("hosted.historical_import_failed", {
        organizer: organizerId,
        import_id: importId,
        failure_code: record.failure.code,
      });
      metrics.recordHistoricalImport(
        "rejected",
        rejected ? undefined : "storage_write_failed",
      );
      imports.push(record);
      await enqueueWrite(persistNow);
      return {
        ok: false,
        reason: rejected ? "rejected" : "storage_write_failed",
        record,
        failure: record.failure,
      };
    }
    logger.info("hosted.historical_import_completed", {
      organizer: organizerId,
      import_id: importId,
      items: record.itemCount,
    });
    metrics.recordHistoricalImport("imported");
    imports.push(record);
    await enqueueWrite(persistNow);
    return { ok: true, record };
  }

  /**
   * Every import attempt, newest first — the Platform Operator's audit trail.
   *
   * @returns {StoredHistoricalArchive[]}
   */
  function listImports() {
    ensureLoaded();
    return [...imports].sort(
      (left, right) => right.attemptedAtMs - left.attemptedAtMs,
    );
  }

  /**
   * Resolves once every scheduled write has landed on disk.
   *
   * @returns {Promise<void>}
   */
  async function flush() {
    ensureLoaded();
    await writeQueue;
  }

  return { importLegacySvg, listImports, flush };
}

export { createFileHistoricalArchiveStore };
