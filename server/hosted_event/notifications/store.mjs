import observability from "../../observability/index.mjs";
import { isValidNormalizedEmail, normalizeEmail } from "../accounts/emails.mjs";
import { createFileStateDocuments } from "../storage/documents.mjs";

const { logger } = observability;

const STORE_FORMAT_VERSION = 1;

/**
 * How long a sent notice stays as an idempotency tombstone. The tombstone
 * carries no recipient or content — only its stable id — so a duplicate
 * trigger after a restart cannot resend a delivered notice. Pruning keeps the
 * durable file bounded; a logical notice is never re-triggered on these
 * timescales.
 */
const SENT_NOTICE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Longest failure detail kept on a notice record. */
const MAX_LAST_ERROR_LENGTH = 300;

/**
 * @typedef {{
 *   notificationId: string,
 *   kind: string,
 *   to: string,
 *   subject: string,
 *   body: string,
 *   status: "pending" | "sent",
 *   attempts: number,
 *   firstQueuedAtMs: number,
 *   lastAttemptAtMs: number | null,
 *   sentAtMs: number | null,
 *   lastError: string | null,
 *   nextAttemptAtMs: number,
 * }} StoredNotice
 */

/**
 * Durable storage for outgoing Hosted Event Service notices. Reads come from
 * an in-memory index loaded on first use, and every mutation replaces a state
 * document through the selected durable adapter. Enqueue is idempotent on the
 * caller-supplied stable
 * notification id, so retries, duplicate trigger passes, and process restarts
 * can never queue the same logical notice twice.
 *
 * Recipient and content live only on pending records; a sent record shrinks
 * to an idempotency tombstone, so delivered account links do not linger.
 *
 * @param {{
 *   dataDir: string,
 *   clock?: () => number,
 *   stateDocuments?: import("../storage/documents.mjs").StateDocuments,
 * }} options
 */
function createFileNotificationStore(options) {
  const dataDir = options.dataDir;
  const stateDocuments =
    options.stateDocuments || createFileStateDocuments({ dataDir });
  const clock = options.clock || (() => Date.now());

  /** @type {Map<string, StoredNotice>} */
  const noticesById = new Map();
  let loaded = false;
  let writeQueue = Promise.resolve();

  const NOTICES_FILE = "notifications.json";

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    const stored = readStoreFile(NOTICES_FILE, { notices: [] });
    for (const notice of /** @type {StoredNotice[]} */ (stored.notices || [])) {
      noticesById.set(notice.notificationId, notice);
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
      throw new Error(
        `Unsupported hosted notification store format in ${filePath}`,
      );
    }
    return parsed;
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
        logger.error("hosted_notification_store.write_failed", { error });
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
        key: NOTICES_FILE,
        payload: {
          version: STORE_FORMAT_VERSION,
          notices: [...noticesById.values()],
        },
      },
    ]);
  }

  /**
   * Drops sent tombstones past their retention. Runs inside write passes, so
   * the durable file cannot grow without bound.
   *
   * @returns {boolean} whether anything was pruned
   */
  function pruneSentNotices() {
    const now = clock();
    let pruned = false;
    for (const [notificationId, notice] of noticesById) {
      if (
        notice.status === "sent" &&
        notice.sentAtMs !== null &&
        now - notice.sentAtMs > SENT_NOTICE_RETENTION_MS
      ) {
        noticesById.delete(notificationId);
        pruned = true;
      }
    }
    return pruned;
  }

  /**
   * Validates one enqueue input and builds its pending record.
   *
   * @param {{
   *   notificationId: string,
   *   kind: string,
   *   to: string,
   *   subject: string,
   *   body: string,
   * }} input
   * @returns {StoredNotice}
   */
  function buildNotice(input) {
    const notificationId = String(input.notificationId || "");
    const kind = String(input.kind || "");
    const to = normalizeEmail(input.to);
    const subject = String(input.subject || "");
    const body = String(input.body || "");
    if (
      notificationId === "" ||
      notificationId.length > 200 ||
      !/^[A-Za-z0-9._:-]+$/.test(notificationId)
    ) {
      throw new Error("enqueue requires a plain, bounded notification id");
    }
    if (kind === "" || kind.length > 64) {
      throw new Error("enqueue requires a notice kind");
    }
    if (!isValidNormalizedEmail(to)) {
      throw new Error("enqueue requires a valid recipient");
    }
    if (subject === "" || body === "") {
      throw new Error("enqueue requires a subject and body");
    }
    return {
      notificationId,
      kind,
      to,
      subject,
      body,
      status: "pending",
      attempts: 0,
      firstQueuedAtMs: clock(),
      lastAttemptAtMs: null,
      sentAtMs: null,
      lastError: null,
      nextAttemptAtMs: clock(),
    };
  }

  /**
   * Queues notices for delivery in one durable write. Idempotent on each
   * stable notification id: a duplicate enqueue leaves the existing record
   * untouched, whatever its state, so re-running a trigger pass never re-sends
   * a delivered notice and never resets a retrying one. The first invalid
   * record rejects the whole batch without partial application.
   *
   * @param {{
   *   notificationId: string,
   *   kind: string,
   *   to: string,
   *   subject: string,
   *   body: string,
   * }[]} records
   * @returns {Promise<{created: number}>}
   */
  async function enqueueMany(records) {
    ensureLoaded();
    const built = [];
    let created = 0;
    for (const record of records) {
      const existing = noticesById.get(String(record.notificationId || ""));
      if (existing) continue;
      built.push(buildNotice(record));
      created += 1;
    }
    if (built.length === 0) return { created: 0 };
    for (const notice of built) {
      noticesById.set(notice.notificationId, notice);
    }
    pruneSentNotices();
    await enqueueWrite(persistNow);
    return { created };
  }

  /**
   * Queues one notice for delivery.
   *
   * @param {{
   *   notificationId: string,
   *   kind: string,
   *   to: string,
   *   subject: string,
   *   body: string,
   * }} input
   * @returns {Promise<{created: boolean}>}
   */
  async function enqueue(input) {
    const result = await enqueueMany([input]);
    return { created: result.created > 0 };
  }

  /**
   * Pending notices whose next attempt is due, oldest first.
   *
   * @param {{now: number}} input
   * @returns {StoredNotice[]}
   */
  function listDue(input) {
    ensureLoaded();
    const now = input.now;
    return [...noticesById.values()]
      .filter(
        (notice) =>
          notice.status === "pending" && notice.nextAttemptAtMs <= now,
      )
      .sort((left, right) => left.firstQueuedAtMs - right.firstQueuedAtMs);
  }

  /**
   * Pending notices that already failed at least once — the operator
   * console's observable retry list. Sent notices never appear.
   *
   * @returns {StoredNotice[]}
   */
  function listRetrying() {
    ensureLoaded();
    return [...noticesById.values()]
      .filter((notice) => notice.status === "pending" && notice.attempts > 0)
      .sort(
        (left, right) =>
          (right.lastAttemptAtMs || 0) - (left.lastAttemptAtMs || 0),
      );
  }

  /**
   * Marks one notice delivered. Only a pending notice can be marked; the
   * recipient and content are dropped so the delivered notice becomes a plain
   * idempotency tombstone.
   *
   * @param {{notificationId: string, sentAtMs: number}} input
   * @returns {Promise<void>}
   */
  async function markSent(input) {
    ensureLoaded();
    const notice = noticesById.get(String(input.notificationId || ""));
    if (!notice || notice.status !== "pending") return;
    notice.status = "sent";
    notice.sentAtMs = input.sentAtMs;
    notice.to = "";
    notice.subject = "";
    notice.body = "";
    await enqueueWrite(persistNow);
  }

  /**
   * Records one failed delivery attempt and schedules the next one. The
   * failure detail is clamped and never contains the notice body.
   *
   * @param {{notificationId: string, message: string, nextAttemptAtMs: number}} input
   * @returns {Promise<void>}
   */
  async function markFailed(input) {
    ensureLoaded();
    const notice = noticesById.get(String(input.notificationId || ""));
    if (!notice || notice.status !== "pending") return;
    notice.attempts += 1;
    notice.lastAttemptAtMs = clock();
    notice.lastError = String(input.message || "")
      .slice(0, MAX_LAST_ERROR_LENGTH)
      .trim();
    notice.nextAttemptAtMs = Math.max(0, input.nextAttemptAtMs);
    await enqueueWrite(persistNow);
  }

  async function flush() {
    ensureLoaded();
    await writeQueue;
  }

  return {
    enqueue,
    enqueueMany,
    listDue,
    listRetrying,
    markSent,
    markFailed,
    flush,
  };
}

export { createFileNotificationStore };
