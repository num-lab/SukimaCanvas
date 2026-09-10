import fs from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import observability from "../../observability/index.mjs";

const { logger } = observability;

/**
 * Durable mutation ledger for one Board Session board.
 *
 * The ledger is the authoritative post-acceptance history of persistent
 * mutations: an accepted write is only confirmed to its sender and broadcast
 * after its ledger entry survived an fsync. Stored SVG snapshots are treated
 * as a rebuildable projection — a board load replays ledger entries newer
 * than the snapshot's sequence, so accepted writes are never lost to a stale
 * snapshot, and a lost or unreadable snapshot is rebuilt by replaying the
 * whole ledger. The ledger is append-only for the Board Session's lifetime;
 * retention-based trimming is owned by the change-audit and retention work
 * that builds on this ledger, never by the save path.
 *
 * Entries are one JSON document per line (`seq` strictly increasing). The
 * file adapter is the first production adapter behind this contract; a
 * PostgreSQL adapter can replace it without changing the acceptance flow.
 *
 * @typedef {{
 *   seq: number,
 *   acceptedAtMs: number,
 *   eventId: string,
 *   boardSessionId: string,
 *   accountId: string,
 *   mutation: import("../../../types/server-runtime.d.ts").NormalizedMessageData,
 * }} LedgerEntry
 */

const LEDGER_CORRUPT_ERROR_CODE = "WBO_LEDGER_CORRUPT";

/**
 * @param {unknown} value
 * @returns {value is LedgerEntry}
 */
function isValidLedgerEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = /** @type {any} */ (value);
  return (
    Number.isSafeInteger(entry.seq) &&
    entry.seq >= 0 &&
    Number.isSafeInteger(entry.acceptedAtMs) &&
    typeof entry.eventId === "string" &&
    typeof entry.boardSessionId === "string" &&
    typeof entry.accountId === "string" &&
    entry.mutation &&
    typeof entry.mutation === "object" &&
    !Array.isArray(entry.mutation)
  );
}

/**
 * @param {string} ledgerPath
 * @returns {Error & {code: string}}
 */
function createLedgerCorruptError(ledgerPath) {
  const error =
    /** @type {Error & {code: string}} */
    (new Error(`Mutation ledger is corrupt: ${ledgerPath}`));
  error.code = LEDGER_CORRUPT_ERROR_CODE;
  return error;
}

/**
 * @param {string} line
 * @returns {LedgerEntry | null}
 */
function parseLedgerLine(line) {
  try {
    const parsed = JSON.parse(line);
    return isValidLedgerEntry(parsed)
      ? /** @type {LedgerEntry} */ (parsed)
      : null;
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   boardName: string,
 *   dataDir: string,
 * }} dependencies
 * @returns {{
 *   close: () => Promise<void>,
 *   appendEntries: (entries: LedgerEntry[]) => Promise<void>,
 *   readEntriesAfter: (fromExclusiveSeq: number) => Promise<LedgerEntry[]>,
 * }}
 */
function createFileBoardMutationLedger(dependencies) {
  const boardName = String(dependencies.boardName || "");
  if (!/^[A-Za-z0-9_-]+$/.test(boardName)) {
    throw new Error(`Refusing ledger for unsafe board name: ${boardName}`);
  }
  const ledgerDir = path.join(dependencies.dataDir, "mutation-ledger");
  const ledgerPath = path.join(ledgerDir, `${boardName}.jsonl`);
  /** @type {fs.promises.FileHandle | null} */
  let appendHandle = null;
  let closed = false;
  /** @type {Promise<void> | null} */
  let closePromise = null;
  /** @type {Promise<void>} */
  let tail = Promise.resolve();

  /**
   * Serializes appends and close within this adapter instance.
   *
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  function enqueue(operation) {
    const run = tail.then(operation, operation);
    tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /**
   * @returns {Promise<fs.promises.FileHandle>}
   */
  async function openAppendHandle() {
    if (appendHandle) return appendHandle;
    await mkdir(ledgerDir, { recursive: true });
    appendHandle = await fs.promises.open(ledgerPath, "a");
    return appendHandle;
  }

  /** @type {Promise<void> | null} */
  let appendBoundary = null;

  /**
   * Runs once per adapter instance before the first append. After a crash
   * mid-append the file can end with bytes that never completed their fsync:
   *
   * - a partial JSON line is unconfirmed and unrecoverable — reads drop it,
   *   so it is truncated away. Appending after torn bytes would bury them
   *   mid-file and fail every later read as corruption;
   * - a complete final entry whose trailing newline was lost is sealed with
   *   a newline instead, because reads accept it and truncating it would
   *   contradict the recovered history.
   *
   * In-process appends are serialized here and always newline-terminated, so
   * the boundary stays clean afterwards. A failed repair rejects this cached
   * promise and every later append on the instance with it — fail-closed, so
   * the mutated board instance is dropped and reloaded from snapshot plus
   * ledger.
   *
   * @returns {Promise<void>}
   */
  function ensureAppendBoundary() {
    appendBoundary ??= repairAppendBoundary();
    return appendBoundary;
  }

  /**
   * @returns {Promise<void>}
   */
  async function repairAppendBoundary() {
    let content;
    try {
      content = await readFile(ledgerPath, "utf8");
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "ENOENT") return;
      throw error;
    }
    if (content === "" || content.endsWith("\n")) return;
    const lastNewline = content.lastIndexOf("\n");
    const trailingLine = content.slice(lastNewline + 1);
    if (parseLedgerLine(trailingLine)) {
      const handle = await openAppendHandle();
      await handle.write("\n", null, "utf8");
      return;
    }
    const validByteLength =
      lastNewline === -1
        ? 0
        : Buffer.byteLength(content.slice(0, lastNewline + 1), "utf8");
    await fs.promises.truncate(ledgerPath, validByteLength);
    logger.warn("hosted.ledger_torn_tail_truncated", {
      board: boardName,
      truncated_bytes: Buffer.byteLength(content, "utf8") - validByteLength,
    });
  }

  /**
   * Durably appends one or more entries with a single fsync, so an accepted
   * mutation and its follow-up effects are confirmed together.
   *
   * @param {LedgerEntry[]} entries
   * @returns {Promise<void>}
   */
  async function appendEntries(entries) {
    if (closed) throw new Error("Mutation ledger is closed");
    if (!Array.isArray(entries) || entries.length === 0) return;
    for (const entry of entries) {
      if (!isValidLedgerEntry(entry)) {
        throw new Error("Refusing to append an invalid ledger entry");
      }
    }
    await enqueue(async () => {
      await ensureAppendBoundary();
      const handle = await openAppendHandle();
      const payload = `${entries
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`;
      await handle.write(payload, null, "utf8");
      await handle.sync();
    });
  }

  /**
   * Reads all durable entries after a sequence, oldest first. A torn final
   * line (a crash mid-append) is dropped: it was never confirmed, and the
   * append boundary repair keeps later appends from burying the torn bytes
   * mid-file. Corruption anywhere else is an error — silently skipping
   * ledger history would fake recovery.
   *
   * @param {number} fromExclusiveSeq
   * @returns {Promise<LedgerEntry[]>}
   */
  async function readEntriesAfter(fromExclusiveSeq) {
    let content;
    try {
      content = await readFile(ledgerPath, "utf8");
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "ENOENT") return [];
      throw error;
    }
    const floorSeq = Number(fromExclusiveSeq) || 0;
    const lines = content.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    /** @type {LedgerEntry[]} */
    const entries = [];
    for (const [index, line] of lines.entries()) {
      if (line === "") throw createLedgerCorruptError(ledgerPath);
      const entry = parseLedgerLine(line);
      if (!entry) {
        if (index === lines.length - 1) {
          logger.warn("hosted.ledger_torn_tail_dropped", {
            board: boardName,
            line_index: index,
          });
          break;
        }
        throw createLedgerCorruptError(ledgerPath);
      }
      if (entry.seq > floorSeq) entries.push(entry);
    }
    entries.sort((a, b) => a.seq - b.seq);
    return entries;
  }

  /**
   * Refuses new appends immediately, then releases the handle after queued
   * appends settle. Reads remain available for archive and recovery.
   * @returns {Promise<void>}
   */
  function close() {
    closed = true;
    closePromise ??= enqueue(async () => {
      if (appendHandle) {
        await appendHandle.close();
        appendHandle = null;
      }
    });
    return closePromise;
  }

  return { appendEntries, readEntriesAfter, close };
}

/**
 * Removes a board's durable ledger file, the Change Audit boundary of a Board
 * Session, when the outcome-retention pipeline purges the event's outcomes.
 * Refuses unsafe board names exactly like the adapter constructor; a missing
 * file is already gone, so the delete is a no-op success and a purge that
 * crashed mid-way replays idempotently. Sealing a session closes its append handle
 * and refuses further writes before retention can delete the file.
 *
 * @param {{
 *   boardName: string,
 *   dataDir: string,
 * }} dependencies
 * @returns {Promise<void>}
 */
async function deleteBoardMutationLedgerFile(dependencies) {
  const boardName = String(dependencies.boardName || "");
  if (!/^[A-Za-z0-9_-]+$/.test(boardName)) {
    throw new Error(
      `Refusing ledger deletion for unsafe board name: ${boardName}`,
    );
  }
  const ledgerPath = path.join(
    dependencies.dataDir,
    "mutation-ledger",
    `${boardName}.jsonl`,
  );
  await fs.promises.rm(ledgerPath, { force: true });
}

export {
  createFileBoardMutationLedger,
  deleteBoardMutationLedgerFile,
  LEDGER_CORRUPT_ERROR_CODE,
};
