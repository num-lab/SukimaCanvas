import crypto from "node:crypto";

import observability from "../../observability/index.mjs";
import { createFileStateDocuments } from "../storage/documents.mjs";

const { logger } = observability;

const STORE_FORMAT_VERSION = 1;

/**
 * The governance actions recorded in the moderation log. Reports are
 * participant submissions; the rest are moderator or Owner/Admin
 * dispositions. Entry Lock and Clear record their operator and reason here
 * too so one event-scoped trail covers every governance action.
 *
 * @typedef {"report" | "warn" | "kick" | "ban" | "unban" | "lock" | "unlock" | "clear"} ModerationAction
 */
/**
 * One durable moderation record. The target is identified by its opaque,
 * event-scoped Participant Identifier and the display name observed at
 * action time (frozen here); the internal Account id is kept solely to
 * resolve repeat actions against the same participant and never rendered to
 * participants. The operator is recorded the same way, plus the internal
 * Account id for console accountability.
 *
 * @typedef {{
 *   recordId: string,
 *   eventId: string,
 *   action: ModerationAction,
 *   operatorAccountId: string,
 *   targetAccountId: string | null,
 *   targetParticipantId: string | null,
 *   targetName: string,
 *   reason: string,
 *   createdAtMs: number,
 * }} StoredModerationRecord
 */

/** Longest reason accepted; the store clamps defensively. */
const MAX_REASON_LENGTH = 500;

export { MAX_REASON_LENGTH };
/** Longest display name frozen into a record. */
const MAX_NAME_LENGTH = 120;

const ACTIONS = new Set([
  "report",
  "warn",
  "kick",
  "ban",
  "unban",
  "lock",
  "unlock",
  "clear",
]);

/**
 * @param {unknown} action
 * @returns {action is ModerationAction}
 */
function isModerationAction(action) {
  return typeof action === "string" && ACTIONS.has(action);
}

/**
 * Durable, event-scoped moderation trail in
 * `<dataDir>/moderation_log.json`, following the same store pattern as the
 * other hosted stores: an in-memory index loaded on first use and a
 * serialized write queue with atomic file replacement. Records are
 * append-only; nothing rewrites or deletes history.
 *
 * @param {{
 *   dataDir: string,
 *   clock?: () => number,
 *   randomId?: () => string,
 *   stateDocuments?: import("../storage/documents.mjs").StateDocuments,
 * }} options
 */
function createFileModerationStore(options) {
  const dataDir = options.dataDir;
  const stateDocuments =
    options.stateDocuments || createFileStateDocuments({ dataDir });
  const clock = options.clock || (() => Date.now());
  const randomId = options.randomId || (() => crypto.randomUUID());

  /** @type {StoredModerationRecord[]} */
  const records = [];
  let loaded = false;
  let writeQueue = Promise.resolve();

  const LOG_FILE = "moderation_log.json";

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    const stored = readStoreFile(LOG_FILE, { records: [] });
    for (const record of /** @type {StoredModerationRecord[]} */ (
      stored.records || []
    )) {
      if (isModerationAction(record.action)) records.push(record);
    }
  }

  /**
   * @template T
   * @param {string} filePath
   * @param {T} fallback
   * @returns {T}
   */
  function readStoreFile(filePath, fallback) {
    const parsed = /** @type {any} */ (stateDocuments.read(filePath, fallback));
    if (parsed === fallback) return fallback;
    if (parsed.version !== STORE_FORMAT_VERSION) {
      throw new Error(`Unsupported moderation log format in ${filePath}`);
    }
    return parsed;
  }

  /**
   * Appends one persistence task to the serialized write queue. The caller
   * observes failures of its own task; the chain itself stays alive so a
   * single failed write cannot poison later ones.
   *
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
        logger.error("hosted_moderation_store.write_failed", { error });
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
        key: LOG_FILE,
        payload: { version: STORE_FORMAT_VERSION, records },
      },
    ]);
  }

  /**
   * Appends one moderation record. The reason is clamped, and the display
   * name is frozen exactly as observed — later identity changes never
   * rewrite history.
   *
   * @param {{
   *   eventId: string,
   *   action: ModerationAction,
   *   operatorAccountId: string,
   *   targetAccountId?: string | null,
   *   targetParticipantId?: string | null,
   *   targetName?: string,
   *   reason?: string,
   * }} input
   * @returns {Promise<StoredModerationRecord>}
   */
  async function record(input) {
    ensureLoaded();
    if (!isModerationAction(input.action)) {
      throw new Error(`Unknown moderation action: ${String(input.action)}`);
    }
    /** @type {StoredModerationRecord} */
    const moderationRecord = {
      recordId: randomId(),
      eventId: String(input.eventId || ""),
      action: input.action,
      operatorAccountId: String(input.operatorAccountId || ""),
      targetAccountId: input.targetAccountId
        ? String(input.targetAccountId)
        : null,
      targetParticipantId: input.targetParticipantId
        ? String(input.targetParticipantId)
        : null,
      targetName: String(input.targetName || "")
        .trim()
        .slice(0, MAX_NAME_LENGTH),
      reason: String(input.reason || "")
        .trim()
        .slice(0, MAX_REASON_LENGTH),
      createdAtMs: clock(),
    };
    records.push(moderationRecord);
    await enqueueWrite(persistNow);
    return moderationRecord;
  }

  /**
   * Moderation records for one event, newest first.
   *
   * @param {string} eventId
   * @param {{limit?: number}} [options]
   * @returns {StoredModerationRecord[]}
   */
  function listForEvent(eventId, options) {
    ensureLoaded();
    const limit =
      typeof options?.limit === "number" && options.limit > 0
        ? options.limit
        : Number.POSITIVE_INFINITY;
    return records
      .filter((record) => record.eventId === eventId)
      .sort((left, right) => right.createdAtMs - left.createdAtMs)
      .slice(0, limit);
  }

  /**
   * The most recent record of one action for a target account, or null. Used
   * to freeze the display name shown for a banned participant after the
   * participant went offline.
   *
   * @param {string} eventId
   * @param {string} targetAccountId
   * @param {ModerationAction} action
   * @returns {StoredModerationRecord | null}
   */
  function latestForTarget(eventId, targetAccountId, action) {
    ensureLoaded();
    let latest = null;
    for (const record of records) {
      if (
        record.eventId === eventId &&
        record.action === action &&
        record.targetAccountId === targetAccountId &&
        (latest === null || record.createdAtMs > latest.createdAtMs)
      ) {
        latest = record;
      }
    }
    return latest;
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

  return {
    record,
    listForEvent,
    latestForTarget,
    flush,
  };
}

export { createFileModerationStore };
