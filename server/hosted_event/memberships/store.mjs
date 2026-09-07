import observability from "../../observability/index.mjs";
import { createFileStateDocuments } from "../storage/documents.mjs";

const { logger } = observability;

const STORE_FORMAT_VERSION = 1;

/**
 * @typedef {"identified" | "anonymous"} AnonymityChoice
 */

/**
 * Durable Event Membership: the record that an Account was admitted to an
 * Event through its Access Code. Memberships survive refreshes, reconnects,
 * session revocations, Access Code rotation, and Event Locks; only the
 * organizer store's lifecycle decisions (a cancelled event) outlive their
 * usefulness, and nothing here is ever deleted by them.
 *
 * The anonymity choice records whether the participant consents to their
 * Participant Identifier appearing in the future Published Canvas. It stays
 * editable until the event's Board Session closes; the route layer freezes
 * it afterwards because archive stability, not this store, owns that rule.
 *
 * @typedef {{
 *   eventId: string,
 *   accountId: string,
 *   joinedAtMs: number,
 *   anonymity: AnonymityChoice,
 *   anonymityUpdatedAtMs: number,
 * }} StoredEventMembership
 */
/**
 * A durable Event Ban: the Account is barred from the Event's Board Session
 * and from re-admission. Bans are keyed like memberships and survive
 * rotation, locks, and restarts; lifting a ban restores eligibility but
 * never resurrects the revoked membership.
 *
 * @typedef {{
 *   eventId: string,
 *   accountId: string,
 *   createdAtMs: number,
 * }} StoredEventBan
 */

/**
 * Durable storage for Event Memberships and Event Bans. Like the other hosted
 * stores, reads come from an in-memory index loaded on first use and every
 * mutation replaces state documents through the selected durable adapter.
 * Admission (check-and-create) runs synchronously before yielding, so a
 * participant who submits twice, or from two tabs, gains exactly one
 * membership whose first anonymity choice is the one that sticks.
 *
 * @param {{
 *   dataDir: string,
 *   clock?: () => number,
 *   stateDocuments?: import("../storage/documents.mjs").StateDocuments,
 * }} options
 */
function createFileEventMembershipStore(options) {
  const dataDir = options.dataDir;
  const stateDocuments =
    options.stateDocuments || createFileStateDocuments({ dataDir });
  const clock = options.clock || (() => Date.now());

  /** @type {Map<string, StoredEventMembership>} */
  const membershipsByKey = new Map();
  /** @type {Map<string, StoredEventBan>} */
  const bansByKey = new Map();
  let loaded = false;
  let writeQueue = Promise.resolve();

  const MEMBERSHIPS_FILE = "event_memberships.json";

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    const stored = readStoreFile(MEMBERSHIPS_FILE, {
      memberships: [],
      bans: [],
    });
    for (const membership of /** @type {StoredEventMembership[]} */ (
      stored.memberships || []
    )) {
      membershipsByKey.set(
        membershipKey(membership.eventId, membership.accountId),
        membership,
      );
    }
    for (const ban of /** @type {StoredEventBan[]} */ (stored.bans || [])) {
      bansByKey.set(banKey(ban.eventId, ban.accountId), ban);
    }
  }

  /**
   * Bans share the membership key namespace (same Event/Account pair, kept
   * in a separate map so lifting a ban never resurrects the membership).
   *
   * @param {string} eventId
   * @param {string} accountId
   * @returns {string}
   */
  function banKey(eventId, accountId) {
    return membershipKey(eventId, accountId);
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
        `Unsupported hosted membership store format in ${filePath}`,
      );
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
        logger.error("hosted_membership_store.write_failed", { error });
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
        key: MEMBERSHIPS_FILE,
        payload: {
          version: STORE_FORMAT_VERSION,
          memberships: [...membershipsByKey.values()],
          bans: [...bansByKey.values()],
        },
      },
    ]);
  }

  /**
   * @param {string} eventId
   * @param {string} accountId
   * @returns {string}
   */
  function membershipKey(eventId, accountId) {
    return `${eventId}:${accountId}`;
  }

  /**
   * The account's membership in an event, or null.
   *
   * @param {string} eventId
   * @param {string} accountId
   * @returns {StoredEventMembership | null}
   */
  function getMembership(eventId, accountId) {
    ensureLoaded();
    if (typeof eventId !== "string" || typeof accountId !== "string") {
      return null;
    }
    if (eventId === "" || accountId === "") return null;
    return membershipsByKey.get(membershipKey(eventId, accountId)) || null;
  }

  /**
   * Every membership of one event. The published canvas derivation reads
   * these to resolve each attributed item creator's frozen Presentation
   * Choice; identity projection happens above this store.
   *
   * @param {string} eventId
   * @returns {StoredEventMembership[]}
   */
  function listMembershipsForEvent(eventId) {
    ensureLoaded();
    return [...membershipsByKey.values()].filter(
      (membership) => membership.eventId === eventId,
    );
  }

  /**
   * Admits an account to an event: creates the membership on first admission
   * and restores the existing one afterwards, keeping the original anonymity
   * choice. Idempotent and synchronous in its check-and-create, so duplicate
   * submissions cannot produce two records or overwrite an existing choice.
   *
   * @param {{
   *   eventId: string,
   *   accountId: string,
   *   anonymity: AnonymityChoice,
   * }} input
   * @returns {Promise<{membership: StoredEventMembership, created: boolean}>}
   */
  async function admit(input) {
    ensureLoaded();
    const eventId = String(input.eventId || "");
    const accountId = String(input.accountId || "");
    if (eventId === "" || accountId === "") {
      throw new Error("admit requires eventId and accountId");
    }
    const existing = membershipsByKey.get(membershipKey(eventId, accountId));
    if (existing) return { membership: existing, created: false };
    /** @type {StoredEventMembership} */
    const membership = {
      eventId,
      accountId,
      joinedAtMs: clock(),
      anonymity: input.anonymity === "anonymous" ? "anonymous" : "identified",
      anonymityUpdatedAtMs: clock(),
    };
    membershipsByKey.set(membershipKey(eventId, accountId), membership);
    await enqueueWrite(persistNow);
    return { membership, created: true };
  }

  /**
   * Updates a member's anonymity choice. Membership is never created here;
   * changing the choice is only possible for an existing member before the
   * route layer's session-close freeze.
   *
   * @param {{
   *   eventId: string,
   *   accountId: string,
   *   anonymity: AnonymityChoice,
   * }} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_member"}>}
   */
  async function setAnonymity(input) {
    ensureLoaded();
    const membership = membershipsByKey.get(
      membershipKey(String(input.eventId || ""), String(input.accountId || "")),
    );
    if (!membership) return { ok: false, reason: "not_member" };
    membership.anonymity =
      input.anonymity === "anonymous" ? "anonymous" : "identified";
    membership.anonymityUpdatedAtMs = clock();
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  // --- event bans -----------------------------------------------------------

  /**
   * Whether the account is banned from the event. Deliberately membership-
   * independent: banning also blocks re-admission, and unbanning does not
   * resurrect a revoked membership.
   *
   * @param {string} eventId
   * @param {string} accountId
   * @returns {boolean}
   */
  function isEventBanned(eventId, accountId) {
    ensureLoaded();
    return bansByKey.has(banKey(eventId, accountId));
  }

  /**
   * Current bans for one event, oldest first. The console and the board's
   * unban flow list these; identity projection happens above this store.
   *
   * @param {string} eventId
   * @returns {StoredEventBan[]}
   */
  function listEventBans(eventId) {
    ensureLoaded();
    return [...bansByKey.values()]
      .filter((ban) => ban.eventId === eventId)
      .sort((left, right) => left.createdAtMs - right.createdAtMs);
  }

  /**
   * Bans an account from an event, revoking any existing membership so the
   * banned participant loses board access immediately. Idempotent.
   *
   * @param {{eventId: string, accountId: string}} input
   * @returns {Promise<{ok: true, revokedMembership: boolean}>}
   */
  async function banEvent(input) {
    ensureLoaded();
    const eventId = String(input.eventId || "");
    const accountId = String(input.accountId || "");
    if (eventId === "" || accountId === "") {
      throw new Error("banEvent requires eventId and accountId");
    }
    let revokedMembership = false;
    const key = membershipKey(eventId, accountId);
    if (membershipsByKey.has(key)) {
      membershipsByKey.delete(key);
      revokedMembership = true;
    }
    if (!bansByKey.has(key)) {
      bansByKey.set(key, {
        eventId,
        accountId,
        createdAtMs: clock(),
      });
    }
    await enqueueWrite(persistNow);
    return { ok: true, revokedMembership };
  }

  /**
   * Lifts an event ban. Eligibility is restored in the sense that the account
   * may be admitted again through the Access Code; a previously revoked
   * membership is not recreated.
   *
   * @param {{eventId: string, accountId: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_banned"}>}
   */
  async function unbanEvent(input) {
    ensureLoaded();
    const key = banKey(
      String(input.eventId || ""),
      String(input.accountId || ""),
    );
    if (!bansByKey.has(key)) return { ok: false, reason: "not_banned" };
    bansByKey.delete(key);
    await enqueueWrite(persistNow);
    return { ok: true };
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
    getMembership,
    listMembershipsForEvent,
    admit,
    setAnonymity,
    isEventBanned,
    listEventBans,
    banEvent,
    unbanEvent,
    flush,
  };
}

export { createFileEventMembershipStore };
