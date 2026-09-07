import WBOMessageCommon from "../../client-data/js/message_common.js";
import {
  formatMessageTypeTag,
  getMutationType,
  getToolId,
} from "../../client-data/js/message_tool_metadata.js";
import { MutationType } from "../../client-data/js/mutation_type.js";
import { SocketEvents } from "../../client-data/js/socket_events.js";
import { Cursor } from "../../client-data/tools/index.js";
import {
  getBoardSession,
  LEDGER_UNAVAILABLE_REASON,
} from "../board/session.mjs";
import observability from "../observability/index.mjs";
import {
  boardCapabilitiesForSocket,
  boardStateForSocket,
  canApplyBoardMessage,
  normalizeBroadcastData,
} from "./policy.mjs";
import { updateBoardUserFromMessage } from "./presence.mjs";
import {
  enforceBroadcastPostNormalization,
  enforceBroadcastPreNormalization,
} from "./rate_limits.mjs";
import { isTurnstileValidationActive } from "./turnstile.mjs";

const { logger, metrics, tracing } = observability;

/** @import { AppSocket, MessageData, MutationLogEntry, NormalizedMessageData, SequencedMutationBroadcastData, ServerConfig } from "../../types/server-runtime.d.ts" */
/** @import { BoardData } from "../board/data.mjs" */
/** @typedef {{socketId: string, userId: string, name: string, ip: string, userAgent: string, language: string, color: string, size: number, lastTool: string, lastSeen: number, position: {x: number, y: number}}} BoardUser */
/**
 * @typedef {{
 *   getActiveSocket: (socketId: string) => AppSocket | undefined,
 *   getBoard: (name: string, config: ServerConfig) => Promise<BoardData>,
 *   getSocketUserName: (socket: AppSocket, clientIp: string) => string,
 *   isSyncedPersistentSocket: (socket: AppSocket) => boolean,
 *   resolveClientIp: (socket: AppSocket, boardName: string, config: ServerConfig) => string,
 *   discardBoardInstance?: (board: BoardData, details?: {[key: string]: unknown}) => Promise<boolean>,
 * }} SocketBroadcastRuntime
 */

/**
 * @param {string} eventName
 * @param {{[key: string]: unknown}=} extras
 * @returns {{[key: string]: unknown}}
 */
function socketTraceAttributes(eventName, extras) {
  return {
    "wbo.socket.event": eventName,
    ...extras,
  };
}

/**
 * @param {string} boardName
 * @param {string | undefined} userName
 * @param {{tool?: unknown, type?: unknown}=} message
 * @returns {{[key: string]: unknown}}
 */
function boardMutationTraceAttributes(boardName, userName, message) {
  return socketTraceAttributes("broadcast_write", {
    "wbo.board": boardName,
    "user.name": userName,
    "wbo.tool": getToolId(message?.tool),
    "wbo.message.type": formatMessageTypeTag(message?.type),
  });
}

/**
 * @param {MessageData | undefined} data
 * @returns {boolean}
 */
function shouldTraceBroadcast(data) {
  return !data || data.tool !== Cursor.id;
}

/**
 * @param {MutationLogEntry} entry
 * @param {string | undefined} liveSocketId
 * @returns {SequencedMutationBroadcastData}
 */
function buildSequencedMutationBroadcast(entry, liveSocketId = undefined) {
  // The retained log entry has no source socket. Only the primary live
  // broadcast gets one so the sender can acknowledge its optimistic write.
  const mutation = liveSocketId
    ? { ...entry.mutation, socket: liveSocketId }
    : entry.mutation;
  return {
    seq: entry.seq,
    acceptedAtMs: entry.acceptedAtMs,
    mutation,
  };
}

/**
 * @param {BoardData} board
 * @param {AppSocket} sourceSocket
 * @param {SequencedMutationBroadcastData} broadcast
 * @param {SocketBroadcastRuntime} runtime
 * @returns {void}
 */
function emitPersistentBoardMutation(board, sourceSocket, broadcast, runtime) {
  for (const socketId of board.users) {
    const targetSocket = runtime.getActiveSocket(socketId);
    if (!targetSocket) continue;
    if (targetSocket.id === sourceSocket.id) continue;
    if (!runtime.isSyncedPersistentSocket(targetSocket)) continue;
    targetSocket.emit(SocketEvents.BROADCAST, broadcast);
  }
  sourceSocket.emit(SocketEvents.BROADCAST, broadcast);
}

/**
 * @param {BoardData} board
 * @param {AppSocket} sourceSocket
 * @param {MutationLogEntry[] | undefined} followup
 * @param {SocketBroadcastRuntime} runtime
 * @returns {void}
 */
function emitPersistentBoardFollowupMutations(
  board,
  sourceSocket,
  followup,
  runtime,
) {
  if (!Array.isArray(followup) || followup.length === 0) return;
  followup.forEach((entry) => {
    emitPersistentBoardMutation(
      board,
      sourceSocket,
      buildSequencedMutationBroadcast(entry),
      runtime,
    );
  });
}

/**
 * Resolves the server-authoritative operator for a persistent hosted write
 * from the admission verdict pinned at handshake (hosted session cookie →
 * Account → Event Membership → Board Session → role). The verdict was live-
 * revalidated by the capability check before this point; clients can supply
 * none of these fields. A hosted socket without a complete verdict is an
 * invariant violation and fails the write loudly instead of silently falling
 * back to unattributed acceptance.
 *
 * @param {AppSocket} socket
 * @returns {{eventId: string, boardSessionId: string, accountId: string, participantId: string} | undefined}
 */
function hostedOperatorForSocket(socket) {
  const admission = socket.hostedEventAdmission;
  const hosted = socket.hostedEventModule;
  if (hosted?.enabled !== true) return undefined;
  if (
    !admission ||
    typeof admission.accountId !== "string" ||
    typeof admission.eventId !== "string" ||
    typeof admission.participantId !== "string" ||
    typeof admission.boardSessionId !== "string" ||
    admission.accountId === "" ||
    admission.eventId === "" ||
    admission.participantId === "" ||
    admission.boardSessionId === ""
  ) {
    throw new Error("hosted socket write without a complete admission verdict");
  }
  return {
    eventId: admission.eventId,
    boardSessionId: admission.boardSessionId,
    accountId: admission.accountId,
    participantId: admission.participantId,
  };
}

/**
 * @param {string} reason
 * @returns {void}
 */
function markBoardMutationRejected(reason) {
  tracing.setActiveSpanAttributes({
    "wbo.board.result": "rejected",
    "wbo.rejection.reason": reason,
  });
}

/**
 * @param {AppSocket} socket
 * @param {{clientMutationId?: unknown} | null | undefined} data
 * @param {string} reason
 * @returns {void}
 */
function emitMutationRejected(socket, data, reason) {
  const clientMutationId =
    typeof data?.clientMutationId === "string" && data.clientMutationId
      ? data.clientMutationId
      : undefined;
  /** @type {{reason: string, clientMutationId?: string}} */
  const payload = { reason };
  if (clientMutationId) {
    payload.clientMutationId = clientMutationId;
  }
  socket.emit(SocketEvents.MUTATION_REJECTED, payload);
}

/**
 * @param {string} boardName
 * @param {MessageData | undefined} data
 * @returns {void}
 */
function rejectTurnstileRequired(boardName, data) {
  markBoardMutationRejected("turnstile_validation_required");
  metrics.recordBoardMessage(
    { board: boardName, ...(data || {}) },
    "turnstile.validation_required",
  );
}

/**
 * @param {AppSocket} socket
 * @param {BoardData} board
 * @param {string} boardName
 * @param {NormalizedMessageData} data
 * @param {string} clientIp
 * @param {string} userName
 * @returns {void}
 */
function rejectBlockedBoardWrite(
  socket,
  board,
  boardName,
  data,
  clientIp,
  userName,
) {
  markBoardMutationRejected("write_blocked");
  logger.warn("board.write_blocked", {
    socket: socket.id,
    board: board.name,
    "client.address": clientIp,
    "user.name": userName,
    tool: getToolId(data.tool),
    type: getMutationType(data),
  });
  metrics.recordBoardMessage({ board: boardName, ...data }, "write");
  emitMutationRejected(socket, data, "write_blocked");
}

/**
 * @param {AppSocket} socket
 * @param {BoardData} board
 * @param {string} boardName
 * @param {NormalizedMessageData} data
 * @param {string} clientIp
 * @param {string} userName
 * @param {string} reason
 * @returns {void}
 */
function rejectBoardMessageWrite(
  socket,
  board,
  boardName,
  data,
  clientIp,
  userName,
  reason,
) {
  markBoardMutationRejected(reason);
  logger.warn("board.message_rejected", {
    socket: socket.id,
    board: board.name,
    "client.address": clientIp,
    "user.name": userName,
    tool: getToolId(data.tool),
    type: getMutationType(data),
    reason,
  });
  metrics.recordBoardMessage({ board: boardName, ...data }, "board_message");
  emitMutationRejected(socket, data, reason);
}

/**
 * @param {AppSocket} socket
 * @param {string} boardName
 * @param {NormalizedMessageData} data
 * @param {number} now
 * @param {string} userName
 * @returns {{user: BoardUser | undefined, liveData: NormalizedMessageData}}
 */
function recordSuccessfulBoardWrite(socket, boardName, data, now, userName) {
  const user = updateBoardUserFromMessage(socket, boardName, data, now);
  const liveData = user ? { ...data, socket: user.socketId } : data;
  tracing.setActiveSpanAttributes({
    "wbo.board.result": "success",
    "user.name": user ? user.name : userName,
  });
  metrics.recordBoardMessage({
    board: boardName,
    ...liveData,
  });
  return { user, liveData };
}

/**
 * @param {AppSocket} socket
 * @param {string} boardName
 * @param {NormalizedMessageData} data
 * @param {number} now
 * @param {string} userName
 * @returns {void}
 */
function finishSuccessfulEphemeralBoardWrite(
  socket,
  boardName,
  data,
  now,
  userName,
) {
  const { liveData } = recordSuccessfulBoardWrite(
    socket,
    boardName,
    data,
    now,
    userName,
  );
  socket.broadcast.to(boardName).emit(SocketEvents.BROADCAST, liveData);
}

/**
 * @param {AppSocket} socket
 * @param {BoardData} board
 * @param {string} boardName
 * @param {NormalizedMessageData} data
 * @param {number} now
 * @param {string} userName
 * @param {MutationLogEntry} entry
 * @param {MutationLogEntry[] | undefined} followup
 * @param {SocketBroadcastRuntime} runtime
 * @returns {void}
 */
function finishSuccessfulPersistentBoardWrite(
  socket,
  board,
  boardName,
  data,
  now,
  userName,
  entry,
  followup,
  runtime,
) {
  const { user } = recordSuccessfulBoardWrite(
    socket,
    boardName,
    data,
    now,
    userName,
  );
  const liveBroadcast = buildSequencedMutationBroadcast(
    entry,
    user?.socketId || socket.id,
  );
  emitPersistentBoardMutation(board, socket, liveBroadcast, runtime);
  emitPersistentBoardFollowupMutations(board, socket, followup, runtime);
}

/**
 * @param {AppSocket} socket
 * @param {BoardData} board
 * @param {string} boardName
 * @param {NormalizedMessageData} data
 * @param {string} clientIp
 * @param {string} userName
 * @param {number} now
 * @param {ServerConfig} config
 * @param {SocketBroadcastRuntime} runtime
 * @returns {Promise<void>}
 */
async function persistBoardBroadcast(
  socket,
  board,
  boardName,
  data,
  clientIp,
  userName,
  now,
  config,
  runtime,
) {
  if (!socket.rooms.has(boardName)) socket.join(boardName);
  if (!canApplyBoardMessage(config, board, data, socket)) {
    rejectBlockedBoardWrite(socket, board, boardName, data, clientIp, userName);
    return;
  }
  if (data.tool === Cursor.id) {
    finishSuccessfulEphemeralBoardWrite(socket, boardName, data, now, userName);
    return;
  }

  const handleResult = await getBoardSession(board).acceptPersistentMutation(
    data,
    now,
    hostedOperatorForSocket(socket),
  );
  if (handleResult.ok === false) {
    rejectBoardMessageWrite(
      socket,
      board,
      boardName,
      data,
      clientIp,
      userName,
      handleResult.reason,
    );
    emitPersistentBoardFollowupMutations(
      board,
      socket,
      handleResult.followup,
      runtime,
    );
    if (handleResult.reason === LEDGER_UNAVAILABLE_REASON) {
      // The mutated board instance is stale by definition: its memory holds
      // a mutation the durable ledger never confirmed. Drop it so every
      // client reloads from snapshot plus ledger instead of keeping state
      // that must not exist.
      await runtime.discardBoardInstance?.(board, {
        logEvent: "board.ledger_failure_dropped",
      });
    }
    return;
  }
  if (handleResult.value !== data) {
    Object.assign(data, handleResult.value);
  }
  recordHostedClearAudit(socket, handleResult.value);
  finishSuccessfulPersistentBoardWrite(
    socket,
    board,
    boardName,
    handleResult.value,
    now,
    userName,
    handleResult.entry,
    handleResult.followup,
    runtime,
  );
}

/**
 * Mirrors an accepted hosted Clear into the event's moderation trail with
 * the operator and the reason the tool collected. The mutation ledger
 * remains the technical audit; this makes the Clear visible beside the
 * other governance actions. Best-effort: never blocks or fails the write.
 *
 * @param {AppSocket} socket
 * @param {NormalizedMessageData} mutation
 * @returns {void}
 */
function recordHostedClearAudit(socket, mutation) {
  if (getMutationType(mutation) !== MutationType.CLEAR) return;
  const hosted = socket.hostedEventModule;
  const admission = socket.hostedEventAdmission;
  if (hosted?.enabled !== true || !admission) return;
  if (typeof hosted.recordClear !== "function") return;
  hosted
    .recordClear({
      eventId: admission.eventId,
      operatorAccountId: admission.accountId,
      reason:
        typeof (/** @type {any} */ (mutation).reason) === "string"
          ? /** @type {any} */ (mutation).reason
          : "",
    })
    .catch((error) => {
      logger.error("hosted.clear_audit_failed", { error });
    });
}

/**
 * @param {AppSocket} socket
 * @param {string} boardName
 * @param {MessageData | undefined} data
 * @param {number} now
 * @param {ServerConfig} config
 * @param {SocketBroadcastRuntime} runtime
 * @returns {Promise<void>}
 */
async function handleBroadcastWriteMessage(
  socket,
  boardName,
  data,
  now,
  config,
  runtime,
) {
  const clientIp = runtime.resolveClientIp(socket, boardName, config);
  const userName = runtime.getSocketUserName(socket, clientIp);
  tracing.setActiveSpanAttributes(
    boardMutationTraceAttributes(boardName, userName, data),
  );
  if (
    !enforceBroadcastPreNormalization({
      socket,
      boardName,
      data,
      clientIp,
      userName,
      now,
      config,
    })
  ) {
    return;
  }
  const capabilities = boardCapabilitiesForSocket(config, boardName, socket);
  if (
    config.TURNSTILE_SECRET_KEY &&
    data &&
    capabilities.canClear !== true &&
    WBOMessageCommon.requiresTurnstile(boardName, data.tool) &&
    !isTurnstileValidationActive(socket, now)
  ) {
    rejectTurnstileRequired(boardName, data);
    return;
  }

  const normalized = normalizeBroadcastData(
    config,
    boardName,
    data,
    capabilities,
  );
  if (normalized.ok === false) {
    markBoardMutationRejected(normalized.reason);
    emitMutationRejected(socket, data, normalized.reason);
    return;
  }
  const normalizedData = normalized.value;
  tracing.setActiveSpanAttributes(
    boardMutationTraceAttributes(boardName, userName, normalizedData),
  );
  const board = await runtime.getBoard(boardName, config);
  const boardState = boardStateForSocket(config, board, socket);
  if (
    !enforceBroadcastPostNormalization({
      socket,
      boardName,
      data: normalizedData,
      clientIp,
      userName,
      now,
      config,
      boardState,
    })
  ) {
    return;
  }
  await persistBoardBroadcast(
    socket,
    board,
    boardName,
    normalizedData,
    clientIp,
    userName,
    now,
    config,
    runtime,
  );
}

export {
  boardMutationTraceAttributes,
  handleBroadcastWriteMessage,
  shouldTraceBroadcast,
};
