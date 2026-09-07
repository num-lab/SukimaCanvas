import {
  getMutationType,
  MutationType,
} from "../../client-data/js/message_tool_metadata.js";
import observability from "../observability/index.mjs";
import { SerialTaskQueue } from "./serial_task_queue.mjs";

/** @typedef {import("../../types/server-runtime.d.ts").MutationLogEntry} MutationLogEntry */
/** @typedef {import("./ledger_registry.mjs").BoardMutationLedger} BoardMutationLedger */
/** @typedef {import("../hosted_event/ledger/store.mjs").LedgerEntry} LedgerEntry */
/** @typedef {import("../../types/server-runtime.d.ts").NormalizedMessageData} NormalizedMessageData */
/** @typedef {{mutation: NormalizedMessageData}} MutationEffect */
/** @typedef {{ok: true} | {ok: false, reason: string}} BoardMutationResult */
/** @typedef {{ok: true, mutation?: NormalizedMessageData} | {ok: false, reason: string}} PreparedMutationResult */
/**
 * Server-authoritative operator resolved by the Hosted Event Module from the
 * hosted session, Event Membership, Board Session, and pinned role. Clients
 * can never supply any of these fields.
 *
 * @typedef {{
 *   eventId: string,
 *   boardSessionId: string,
 *   accountId: string,
 *   participantId: string,
 * }} MutationOperator
 */
/**
 * @typedef {{
 *   name: string,
 *   mutationLedger?: BoardMutationLedger | null,
 *   getSeq: () => number,
 *   processMessage: (message: NormalizedMessageData) => BoardMutationResult,
 *   recordPersistentMutation: (message: NormalizedMessageData, acceptedAtMs?: number, explicitSeq?: number) => MutationLogEntry,
 *   consumePendingRejectedMutationEffects?: () => MutationEffect[],
 *   consumePendingAcceptedMutationEffects?: () => MutationEffect[],
 *   preparePersistentMutation?: (message: NormalizedMessageData) => Promise<PreparedMutationResult> | PreparedMutationResult,
 * }} BoardSessionBoard
 */
/**
 * @typedef {{
 *   board: BoardSessionBoard,
 *   acceptedMutationsByClientMutationId: Map<string, MutationLogEntry>,
 *   pruneClientMutationIds: (nowMs: number) => void,
 *   sealWrites: () => Promise<void>,
 *   acceptPersistentMutation: (
 *     mutation: NormalizedMessageData,
 *     nowMs?: number,
 *     operator?: MutationOperator,
 *   ) => Promise<
 *     | {ok: true, value: NormalizedMessageData, entry: MutationLogEntry, followup?: MutationLogEntry[]}
 *     | {ok: false, reason: string, followup?: MutationLogEntry[]}
 *   >,
 *   noteReplayedLedgerEntry: (entry: LedgerEntry) => void,
 * }} BoardSession
 */

const { logger } = observability;

const LEDGER_UNAVAILABLE_REASON = "ledger_unavailable";
/** Deterministic refusal reason for persistent writes arriving after the close barrier. */
const WRITES_SEALED_REASON = "writes_sealed";
/** Duplicate-retry window, aligned with the reconnect-grace scale. */
const CLIENT_MUTATION_ID_TTL_MS = 15 * 60 * 1000;
const CLIENT_MUTATION_ID_MAP_LIMIT = 4096;

/**
 * Whether the message (parent or tool-owned child) creates a board item, so
 * the server must stamp its immutable creator.
 *
 * @param {unknown} message
 * @returns {boolean}
 */
function createsBoardItem(message) {
  const type = getMutationType(/** @type {any} */ (message));
  return type === MutationType.CREATE || type === MutationType.COPY;
}

/**
 * Stamps the operator's opaque Participant Identifier onto every item a
 * mutation creates. The value is server-resolved; normalization already
 * dropped any client-supplied attribution field, and updates never touch
 * `createdBy`, so attribution stays immutable for the item's lifetime.
 *
 * @param {NormalizedMessageData} mutation
 * @param {string} participantId
 * @returns {void}
 */
function stampMutationAttribution(mutation, participantId) {
  const stamped = /** @type {any} */ (mutation);
  if (createsBoardItem(stamped)) {
    stamped.createdBy = participantId;
  }
  if (Array.isArray(stamped._children)) {
    for (const child of stamped._children) {
      if (createsBoardItem(child)) {
        child.createdBy = participantId;
      }
    }
  }
}

/**
 * @param {BoardSession} session
 * @param {MutationLogEntry} entry
 * @returns {void}
 */
function rememberClientMutationId(session, entry) {
  const clientMutationId = /** @type {any} */ (entry.mutation)
    ?.clientMutationId;
  if (typeof clientMutationId !== "string" || clientMutationId === "") return;
  session.acceptedMutationsByClientMutationId.set(clientMutationId, entry);
  if (
    session.acceptedMutationsByClientMutationId.size >
    CLIENT_MUTATION_ID_MAP_LIMIT
  ) {
    session.pruneClientMutationIds(entry.acceptedAtMs);
  }
}

/**
 * @param {BoardSessionBoard} board
 * @param {(() => MutationEffect[]) | undefined} consumeEffects
 * @returns {MutationEffect[]}
 */
function consumePendingMutationEffects(board, consumeEffects) {
  return typeof consumeEffects === "function" ? consumeEffects.call(board) : [];
}

/** @type {WeakMap<BoardSessionBoard, BoardSession>} */
const BOARD_SESSIONS = new WeakMap();

/**
 * @param {BoardSessionBoard} board
 * @returns {BoardSession}
 */
export function createBoardSession(board) {
  const queue = new SerialTaskQueue();
  /** @type {Map<string, MutationLogEntry>} */
  const acceptedMutationsByClientMutationId = new Map();
  /** Write barrier for closing: flipped by sealWrites inside the queue. */
  let writesSealed = false;

  /**
   * Bounds duplicate tracking. Called only when the map overflows its cap —
   * never per acceptance, which is hot-path work. First drops entries that
   * left the retry window; if a burst within the window filled the map,
   * evicts the oldest by insertion order instead.
   *
   * @param {number} nowMs
   * @returns {void}
   */
  function pruneClientMutationIds(nowMs) {
    const cutoffMs = nowMs - CLIENT_MUTATION_ID_TTL_MS;
    for (const [
      clientMutationId,
      entry,
    ] of acceptedMutationsByClientMutationId) {
      if (entry.acceptedAtMs >= cutoffMs) continue;
      acceptedMutationsByClientMutationId.delete(clientMutationId);
    }
    let excess =
      acceptedMutationsByClientMutationId.size - CLIENT_MUTATION_ID_MAP_LIMIT;
    while (excess > 0) {
      const oldest = acceptedMutationsByClientMutationId.keys().next().value;
      if (oldest === undefined) break;
      acceptedMutationsByClientMutationId.delete(oldest);
      excess -= 1;
    }
  }

  /**
   * Durably records accepted mutations with ledger-assigned sequences and
   * then mirrors them into the in-memory log. The sender is only confirmed
   * and the mutation broadcast after `appendEntries` (one fsync) resolves, so
   * a failed ledger write leaves the mutation nowhere: it is rejected below
   * and the caller drops the mutated board instance for a clean reload.
   *
   * @param {NormalizedMessageData | null} acceptedMutation
   * @param {MutationEffect[]} followupEffects
   * @param {number} nowMs
   * @param {MutationOperator} operator
   * @returns {Promise<{ledgered: MutationLogEntry[], failure: boolean}>}
   */
  async function recordWithLedger(
    acceptedMutation,
    followupEffects,
    nowMs,
    operator,
  ) {
    const ledger = /** @type {BoardMutationLedger} */ (board.mutationLedger);
    /** @type {{mutation: NormalizedMessageData, seq: number}[]} */
    const pending = [];
    let nextSeq = board.getSeq() + 1;
    if (acceptedMutation) {
      pending.push({ mutation: acceptedMutation, seq: nextSeq });
      nextSeq += 1;
    }
    for (const effect of followupEffects) {
      pending.push({ mutation: effect.mutation, seq: nextSeq });
      nextSeq += 1;
    }
    try {
      await ledger.appendEntries(
        pending.map((item) => ({
          seq: item.seq,
          acceptedAtMs: nowMs,
          eventId: operator.eventId,
          boardSessionId: operator.boardSessionId,
          accountId: operator.accountId,
          mutation: item.mutation,
        })),
      );
    } catch (error) {
      logger.error("board.ledger_append_failed", {
        board: board.name,
        seq: pending[0]?.seq,
        error,
      });
      return { ledgered: [], failure: true };
    }
    const ledgered = pending.map((item) =>
      board.recordPersistentMutation(item.mutation, nowMs, item.seq),
    );
    return { ledgered, failure: false };
  }

  /** @type {BoardSession} */
  const session = {
    board,
    acceptedMutationsByClientMutationId,
    pruneClientMutationIds,
    /**
     * Forms the final write boundary for closing: once this resolves, every
     * mutation enqueued before it has finished its acceptance work (mutation
     * application, ledger append, log record), and any persistent mutation
     * enqueued afterwards is deterministically refused with
     * WRITES_SEALED_REASON. The close pipeline uses it so the board's final
     * authoritative sequence is exactly the sequence of everything already
     * admitted — nothing later can join the archived history. Already
     * accepted mutations still deduplicate by clientMutationId so sender
     * retries keep confirming the original entry.
     *
     * @returns {Promise<void>}
     */
    sealWrites() {
      return queue.runExclusive(async () => {
        writesSealed = true;
      });
    },
    async acceptPersistentMutation(mutation, nowMs = Date.now(), operator) {
      return queue.runExclusive(async () => {
        consumePendingMutationEffects(
          board,
          board.consumePendingRejectedMutationEffects,
        );
        consumePendingMutationEffects(
          board,
          board.consumePendingAcceptedMutationEffects,
        );
        if (operator) {
          // Hosted writes are durable-write-gated by contract: a missing
          // ledger adapter is an acceptance failure, never a silent fallback.
          if (!board.mutationLedger) {
            logger.error("board.ledger_adapter_missing", {
              board: board.name,
            });
            return { ok: false, reason: LEDGER_UNAVAILABLE_REASON };
          }
          const clientMutationId = /** @type {any} */ (mutation)
            ?.clientMutationId;
          if (typeof clientMutationId === "string") {
            const existing =
              acceptedMutationsByClientMutationId.get(clientMutationId);
            if (existing) {
              // Idempotent retry of an already-accepted mutation: the
              // original sequenced entry is re-confirmed and re-broadcast;
              // clients drop the stale frame and nothing is applied twice.
              return {
                ok: true,
                value: /** @type {NormalizedMessageData} */ (existing.mutation),
                entry: existing,
              };
            }
          }
          if (writesSealed) {
            // The write barrier landed after this mutation was enqueued: it
            // missed the archived history and is refused as a matter of
            // course. Live revalidation already refuses nearly everything;
            // this catches the remaining interleavings deterministically.
            return { ok: false, reason: WRITES_SEALED_REASON };
          }
        }
        let acceptedMutation = mutation;
        if (typeof board.preparePersistentMutation === "function") {
          const prepared =
            await board.preparePersistentMutation(acceptedMutation);
          if (prepared.ok === false) {
            return prepared;
          }
          if (prepared.mutation) {
            acceptedMutation = prepared.mutation;
          }
        }
        if (operator) {
          stampMutationAttribution(acceptedMutation, operator.participantId);
        }
        const result = board.processMessage(acceptedMutation);
        const followupEffects = consumePendingMutationEffects(
          board,
          result.ok === false
            ? board.consumePendingRejectedMutationEffects
            : board.consumePendingAcceptedMutationEffects,
        );
        if (operator) {
          const { ledgered, failure } = await recordWithLedger(
            result.ok === false ? null : acceptedMutation,
            followupEffects,
            nowMs,
            operator,
          );
          if (failure) {
            return { ok: false, reason: LEDGER_UNAVAILABLE_REASON };
          }
          if (result.ok === false) {
            // A rejected mutation can still carry accepted follow-up effects
            // (the shape-tool seed drop); those are durably recorded.
            return followupEffects.length > 0
              ? {
                  ok: false,
                  reason: result.reason,
                  followup: ledgered,
                }
              : result;
          }
          const entry = ledgered[0];
          if (!entry) {
            throw new Error(
              "Ledger recorded no entry for an accepted mutation",
            );
          }
          const followup = ledgered.slice(1);
          rememberClientMutationId(session, entry);
          return {
            ok: true,
            value: acceptedMutation,
            entry,
            ...(followup.length > 0 ? { followup } : {}),
          };
        }
        if (result.ok === false) {
          const followup = followupEffects.map((effect) =>
            board.recordPersistentMutation(effect.mutation, nowMs),
          );
          return followup.length > 0 ? { ...result, followup } : result;
        }
        const entry = board.recordPersistentMutation(acceptedMutation, nowMs);
        const followup = followupEffects.map((effect) =>
          board.recordPersistentMutation(effect.mutation, nowMs),
        );
        return {
          ok: true,
          value: acceptedMutation,
          entry,
          ...(followup.length > 0 ? { followup } : {}),
        };
      });
    },
    /**
     * Rebuilds duplicate tracking from ledger hydration so retries that span
     * a board reload or a process restart stay idempotent.
     *
     * @param {LedgerEntry} entry
     * @returns {void}
     */
    noteReplayedLedgerEntry(entry) {
      rememberClientMutationId(session, {
        seq: entry.seq,
        acceptedAtMs: entry.acceptedAtMs,
        mutation: /** @type {NormalizedMessageData} */ (
          /** @type {unknown} */ (entry.mutation)
        ),
      });
    },
  };
  return session;
}

/**
 * @param {BoardSessionBoard} board
 * @returns {BoardSession}
 */
export function getBoardSession(board) {
  const existing = BOARD_SESSIONS.get(board);
  if (existing) return existing;
  const created = createBoardSession(board);
  BOARD_SESSIONS.set(board, created);
  return created;
}

export { LEDGER_UNAVAILABLE_REASON, WRITES_SEALED_REASON };
