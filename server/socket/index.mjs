import * as socketIO from "socket.io";
import { SocketEvents } from "../../client-data/js/socket_events.js";
import { BoardData } from "../board/data.mjs";
import {
  deleteLoadedBoard,
  discardPinnedReplayBaselinesBefore,
  getLoadedBoard,
  getMinPinnedReplayBaselineSeq,
  getNextReplayPinExpiry,
  listLoadedBoards,
  resetBoardRegistry,
  setLoadedBoard,
} from "../board/registry.mjs";
import { isGovernanceRole } from "../hosted_event/admission/index.mjs";
import {
  moderationSocketEffects,
  registerModerationSocketEffects,
} from "../hosted_event/moderation/socket_effects.mjs";
import observability from "../observability/index.mjs";
import { resetBans } from "./bans.mjs";
import {
  boardMutationTraceAttributes,
  handleBroadcastWriteMessage,
  shouldTraceBroadcast,
} from "./broadcasts.mjs";
import {
  handleHostedModerationActionMessage,
  handleHostedReportUserMessage,
  handleModerationStateMessage,
} from "./hosted_moderation.mjs";
import {
  boardStateForSocket,
  clientIpFallback,
  getClientIp,
  normalizeBroadcastData,
} from "./policy.mjs";
import {
  boardUserDebugFields,
  buildUserId,
  buildUserName,
  cleanupBoardUserMap,
  clearBoardUsers,
  buildBoardUserRecord as createBoardUserRecord,
  emitBoardUsersToSocket,
  emitUserJoinedToBoard,
  emitUserUpdatedToBoard,
  ensureBoardUser,
  getBoardUserMap,
  removeBoardUser,
  resetBoardUserMaps,
} from "./presence.mjs";
import {
  consumeFixedWindowRateLimit,
  countConstructiveActions,
  countDestructiveActions,
  countTextCreationActions,
  createRateLimitState,
  enforceBroadcastPreNormalization,
  rateLimitTestInternals,
  resetRateLimitMaps as resetSocketRateLimitMaps,
} from "./rate_limits.mjs";
import {
  createConnectionReplayError,
  prepareConnectionReplay,
} from "./replay.mjs";
import {
  getLastUserReportLog as getLastSocketUserReportLog,
  handleReportUserMessage,
  notifyModerationDisconnectThenClose,
  resetSocketReports,
} from "./reports.mjs";
import { getSocketUserSecret } from "./request.mjs";
import { handleSetTemporaryModeratorMessage } from "./temporary_moderator_actions.mjs";
import { resetTemporaryModerators } from "./temporary_moderators.mjs";
import { handleTurnstileTokenMessage } from "./turnstile.mjs";

const { Server } = socketIO;
const { logger, metrics, tracing } = observability;

/** @import { AppSocket, MessageData, NormalizedMessageData, ReportUserPayload, ServerConfig, ServerRuntime, SetTemporaryModeratorPayload, TurnstileAckCallback } from "../../types/server-runtime.d.ts" */
/** @typedef {{type: number, fromSeq: number, seq: number, _children: NormalizedMessageData[]}} ConnectionReplayBatch */
/** @typedef {{ok: true, boardName: string, board: BoardData, baselineSeq: number, latestSeq: number, minReplayableSeq: number, replayBatch: ConnectionReplayBatch, outcome: "empty" | "replayed"} | {ok: false, reason: string, boardName?: string, baselineSeq?: number, latestSeq?: number, minReplayableSeq?: number, error?: unknown}} ConnectionReplayBootstrap */
/** @type {Map<string, AppSocket>} */
const activeSockets = new Map();
/** @type {Set<string>} */
const syncedPersistentSockets = new Set();
let connectedUsersTotal = 0;
let invalidIpSourceLogged = false;
/** @type {import("socket.io").Server | undefined} */
let io;
let shuttingDown = false;
/**
 * @param {BoardData} board
 * @param {{[key: string]: unknown}=} extras
 * @returns {{[key: string]: unknown}}
 */
function boardDebugFields(board, extras) {
  return {
    board: board.name,
    "wbo.board.instance": board.instanceId,
    "wbo.board.seq": board.getSeq(),
    "wbo.board.persisted_seq": board.getPersistedSeq(),
    "wbo.board.min_replayable_seq": board.minReplayableSeq(),
    "wbo.board.has_persisted_baseline": board.hasPersistedBaseline,
    "wbo.board.users": board.users.size,
    ...(extras || {}),
  };
}
/**
 * Wraps a socket event handler with standard error logging and metrics.
 * @template {any[]} Args
 * @param {(...args: Args) => unknown} fn
 * @param {string=} eventName
 * @returns {(...args: Args) => Promise<unknown | undefined>}
 */
function wrapSocketEventHandler(fn, eventName) {
  return async function wrappedSocketEventHandler(...args) {
    const startedAt = eventName ? Date.now() : 0;
    /** @type {unknown} */
    let eventErrorType;
    const recordEventMetric = () => {
      if (!eventName) return;
      metrics.recordSocketEvent({
        event: eventName,
        durationMs: Date.now() - startedAt,
        errorType: eventErrorType,
      });
    };
    /**
     * @param {unknown} error
     */
    const logError = (error) => {
      eventErrorType = error;
      logger.error("socket.event_failed", {
        "wbo.socket.event": eventName,
        error: error,
      });
    };
    try {
      return await fn(...args);
    } catch (error) {
      logError(error);
      return undefined;
    } finally {
      recordEventMetric();
    }
  };
}

/**
 * Registers a socket event handler with standard error logging and metrics.
 * @template {any[]} Args
 * @param {AppSocket} socket
 * @param {string} eventName
 * @param {(...args: Args) => unknown} handler
 * @returns {void}
 */
function onSocketEvent(socket, eventName, handler) {
  socket.on(eventName, wrapSocketEventHandler(handler, eventName));
}

function updateLoadedBoardsGauge() {
  metrics.setLoadedBoards(listLoadedBoards().length);
}

function updateActiveSocketConnectionsGauge() {
  metrics.setActiveSocketConnections(activeSockets.size);
}

function updateConnectedUsersGauge() {
  metrics.setConnectedUsers(connectedUsersTotal);
}

/**
 * @param {BoardData} board
 * @returns {AppSocket[]}
 */
function detachBoardSockets(board) {
  const socketIds = [...board.users];
  board.users.clear();
  if (socketIds.length > 0) {
    connectedUsersTotal = Math.max(0, connectedUsersTotal - socketIds.length);
    updateConnectedUsersGauge();
  }
  clearBoardUsers(board.name);
  /** @type {AppSocket[]} */
  const sockets = [];
  for (const socketId of socketIds) {
    const socket = activeSockets.get(socketId);
    if (socket) {
      sockets.push(socket);
      activeSockets.delete(socketId);
    }
    syncedPersistentSockets.delete(socketId);
  }
  updateActiveSocketConnectionsGauge();
  return sockets;
}

/**
 * @param {BoardData} board
 * @param {{
 *   actualFileSeq?: number,
 *   baselineSeq?: number,
 *   durationMs?: number,
 *   logEvent?: string,
 *   persistedFileSeq?: number,
 *   reason?: string,
 *   saveTargetSeq?: number,
 * }=} details
 * @returns {Promise<boolean>}
 */
async function dropLoadedBoardInstance(board, details) {
  const loadedBoard = getLoadedBoard(board.name);
  if (!loadedBoard) return false;
  const currentBoard = await loadedBoard;
  if (currentBoard !== board) return false;

  const socketsToDisconnect = detachBoardSockets(board);
  deleteLoadedBoard(board.name);
  updateLoadedBoardsGauge();
  board.dispose();

  logger.warn(
    details?.logEvent || "board.stale_instance_dropped",
    boardDebugFields(board, {
      "wbo.board.actual_file_seq": details?.actualFileSeq,
      "wbo.board.persisted_file_seq": details?.persistedFileSeq,
      "wbo.board.save_target_seq": details?.saveTargetSeq,
      "wbo.socket.baseline_seq": details?.baselineSeq,
      duration_ms: details?.durationMs,
      "wbo.board.disconnected_sockets": socketsToDisconnect.length,
      reason: details?.reason,
    }),
  );

  socketsToDisconnect.forEach((socket) => {
    closeSocket(socket, "stale_board", {
      board: board.name,
      socket: socket.id,
    });
  });
  return true;
}

/**
 * @param {BoardData} board
 * @param {{
 *   actualFileSeq?: number,
 *   durationMs?: number,
 *   saveTargetSeq?: number,
 * }=} details
 * @returns {Promise<void>}
 */
async function handleStaleBoardSave(board, details) {
  await dropLoadedBoardInstance(board, {
    ...details,
    reason: "save_seq_mismatch",
  });
}

/**
 * @param {AppSocket} socket
 * @param {string} eventName
 * @param {{[key: string]: any}} infos
 * @returns {void}
 */
function closeSocket(socket, eventName, infos) {
  void eventName;
  void infos;
  if (eventName === "report_user") {
    const closeConnection = socket.client?.conn?.close;
    if (typeof closeConnection === "function") {
      closeConnection.call(socket.client.conn);
      return;
    }
  }
  socket.disconnect(true);
}

/**
 * @param {string} socketId
 * @returns {AppSocket | undefined}
 */
function getActiveSocket(socketId) {
  return activeSockets.get(socketId);
}

/**
 * Re-emits authoritative access and presence for every tab sharing an identity.
 * @param {string} boardName
 * @param {string} userSecret
 * @param {ServerConfig} config
 * @returns {Promise<void>}
 */
async function refreshUserAccess(boardName, userSecret, config) {
  if (!userSecret) return;
  const users = getBoardUserMap(boardName);
  for (const user of users.values()) {
    if (user.userSecret !== userSecret) continue;
    const targetSocket = activeSockets.get(user.socketId);
    if (!targetSocket || !targetSocket.rooms.has(boardName)) continue;
    await refreshSocketAccess(targetSocket, config);
  }
}

/**
 * @param {AppSocket} socket
 * @param {string} boardName
 * @param {{[key: string]: any}} extras
 * @returns {{[key: string]: any}}
 */
function buildSocketLogInfo(socket, boardName, extras) {
  return {
    board: boardName,
    socket: socket.id,
    ...extras,
  };
}

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
 * @param {AppSocket} socket
 * @param {string} eventName
 * @param {string} reason
 * @param {{[key: string]: unknown}=} extras
 * @returns {void}
 */
function rejectSocketRequest(socket, eventName, reason, extras) {
  tracing.setActiveSpanAttributes({
    "wbo.board.result": "rejected",
    "wbo.rejection.reason": reason,
  });
  logger.warn("socket.request_rejected", {
    socket: socket.id,
    "wbo.socket.event": eventName,
    reason,
    ...(extras || {}),
  });
}

/**
 * @param {AppSocket} socket
 * @param {string} clientIp
 * @returns {string}
 */
function getSocketUserName(socket, clientIp) {
  return buildUserName(clientIp, getSocketUserSecret(socket));
}

/**
 * @param {AppSocket} socket
 * @param {string} boardName
 * @param {ServerConfig} config
 * @returns {string}
 */
function resolveClientIp(socket, boardName, config) {
  try {
    return getClientIp(config, socket);
  } catch (err) {
    if (!invalidIpSourceLogged) {
      invalidIpSourceLogged = true;
      logger.warn(
        "socket.ip_resolve_failed",
        buildSocketLogInfo(socket, boardName, {
          error: err,
        }),
      );
    }
    return clientIpFallback(socket);
  }
}

/**
 * Runs the Hosted Event admission gate for one socket: in hosted mode every
 * connection must be admitted through the Hosted Event Module, which decides
 * role, seat, and eligibility from the hosted session cookie and the event
 * stores. Idempotent per socket — the middleware admits before replay, and
 * the connection handler only fills the gap when the middleware never ran
 * (socket scenarios). On success the socket carries its pinned board role and
 * admission verdict for every later capability decision.
 *
 * @param {AppSocket} socket
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
async function admitHostedSocket(socket) {
  const hosted = socket.hostedEventModule;
  if (hosted?.enabled !== true || socket.hostedEventAdmission) {
    return { ok: true };
  }
  // Advance the durable lifecycle so admission sees the authoritative Board
  // Session status at the current service clock.
  if (typeof hosted.refreshEventLifecycle === "function") {
    await hosted.refreshEventLifecycle();
  }
  const verdict = hosted.admitEventBoardSocket({
    boardName: String(socket.handshake.query?.board || ""),
    cookieHeader: socket.handshake.headers?.cookie,
  });
  if (verdict.ok === false) {
    return { ok: false, reason: verdict.reason };
  }
  socket.hostedEventAdmission = verdict;
  socket.hostedBoardRole = verdict.role;
  return { ok: true };
}

/**
 * Registers an admitted socket with the seat registry once the connection is
 * real (replay succeeded), reconciling the pinned role with the account's
 * actual writer slot. Registers nothing for Owner/Admin connections, which
 * never contend for Participant Seats.
 *
 * @param {AppSocket} socket
 * @returns {void}
 */
function registerHostedSocketConnection(socket) {
  const hosted = socket.hostedEventModule;
  const admission = socket.hostedEventAdmission;
  if (hosted?.enabled !== true || !admission) return;
  const connected = hosted.noteEventSocketConnected(admission, socket.id);
  if (!connected.admitted) {
    // A racing handshake consumed the last seat between this socket's
    // preview and its registration; the drop is the authoritative refusal.
    logger.warn("socket.hosted_seat_refused_on_connect", {
      socket: socket.id,
      board: admission.boardName,
    });
    closeSocket(socket, "connection", { reason: "event_full" });
    return;
  }
  admission.socketId = socket.id;
  // The writer slot may have been claimed between admission preview and
  // connection; the registry's answer is authoritative.
  if (!isGovernanceRole(admission.role)) {
    socket.hostedBoardRole = connected.writable ? "editor" : "reader";
    socket.boardPermissionContext = undefined;
  }
}

/**
 * Re-emits authoritative state for one socket after its hosted role changed
 * (for example a read-only tab promoted to writer), keeping the tab's
 * capabilities and presence in step without a reconnect.
 *
 * @param {AppSocket} targetSocket
 * @param {ServerConfig} config
 * @returns {Promise<void>}
 */
async function refreshSocketAccess(targetSocket, config) {
  const boardPromise = getLoadedBoard(targetSocket.boardName || "");
  if (!boardPromise) return;
  const board = await boardPromise;
  if (!targetSocket.rooms.has(board.name)) return;
  const boardState = boardStateForSocket(config, board, targetSocket);
  const user = getBoardUserMap(board.name).get(targetSocket.id);
  if (user) {
    user.canEdit = boardState.canEdit === true;
    user.canClear = boardState.canClear === true;
    user.canBan = boardState.canBan === true;
    user.canGrantTemporaryModerator =
      boardState.canGrantTemporaryModerator === true;
    emitUserUpdatedToBoard(targetSocket, board.name, user);
  }
  targetSocket.emit(SocketEvents.BOARDSTATE, boardState);
}

/**
 * Releases a hosted socket's seat on disconnect and refreshes the companion
 * connection promoted to the account's writer slot, if any.
 *
 * @param {AppSocket} socket
 * @param {ServerConfig} config
 * @returns {Promise<void>}
 */
async function releaseHostedSocket(socket, config) {
  const hosted = socket.hostedEventModule;
  const admission = socket.hostedEventAdmission;
  if (hosted?.enabled !== true || !admission) return;
  const released = hosted.releaseEventSocket(socket.id);
  if (!released.promotedSocketId) return;
  const promoted = activeSockets.get(released.promotedSocketId);
  if (!promoted || isGovernanceRole(promoted.hostedEventAdmission?.role)) {
    return;
  }
  promoted.hostedBoardRole = "editor";
  promoted.boardPermissionContext = undefined;
  await refreshSocketAccess(promoted, config);
}

/**
 * Re-runs the hosted admission decision for one live socket. Used when the
 * account's event-scoped authorizations changed under it (for example a
 * revoked Event Moderator grant): sockets still admissible keep their
 * connection with refreshed capabilities, refused ones are dropped so the
 * next connect decides honestly.
 *
 * @param {AppSocket} targetSocket
 * @param {ServerConfig} config
 * @returns {Promise<void>}
 */
async function refreshHostedSocketAdmission(targetSocket, config) {
  const hosted = targetSocket.hostedEventModule;
  const admission = targetSocket.hostedEventAdmission;
  if (hosted?.enabled !== true || !admission) return;
  const verdict = hosted.admitEventBoardSocket({
    boardName: admission.boardName,
    cookieHeader: targetSocket.handshake.headers?.cookie,
  });
  if (verdict.ok === false) {
    logger.info("socket.hosted_access_revoked", {
      socket: targetSocket.id,
      board: admission.boardName,
      reason: verdict.reason,
    });
    closeSocket(targetSocket, "connection", { reason: verdict.reason });
    return;
  }
  const previousRole = admission.role;
  targetSocket.hostedEventAdmission = verdict;
  targetSocket.hostedBoardRole = verdict.role;
  targetSocket.boardPermissionContext = undefined;
  if (previousRole !== verdict.role && !isGovernanceRole(verdict.role)) {
    // A governance connection demoted to a member seat must now join the
    // seat registry it previously bypassed.
    const connected = hosted.noteEventSocketConnected(verdict, targetSocket.id);
    if (!connected.admitted) {
      closeSocket(targetSocket, "connection", { reason: "event_full" });
      return;
    }
    targetSocket.hostedBoardRole = connected.writable ? "editor" : "reader";
  }
  await refreshSocketAccess(targetSocket, config);
}

/**
 * Ends the live connections of a sealed Board Session on their read-only
 * completion state: every socket is demoted to a read-only connection and
 * re-emitted its authoritative board state carrying the `eventClosed` marker,
 * so participants finish viewing the drained board but can never regain write
 * access through the old socket, page, or mutations. Connections stay open —
 * a reconnect is refused by admission and routes back to the event page,
 * which explains the completed event.
 *
 * @param {string} boardName
 * @param {ServerConfig} config
 * @returns {Promise<void>}
 */
async function notifyBoardSessionClosed(boardName, config) {
  const boardPromise = getLoadedBoard(boardName);
  if (!boardPromise) return;
  const board = await boardPromise;
  for (const target of [...activeSockets.values()]) {
    const admission = target.hostedEventAdmission;
    if (!admission || admission.boardName !== boardName) continue;
    if (!target.rooms.has(boardName)) continue;
    target.hostedBoardRole = "reader";
    target.boardPermissionContext = undefined;
    const user = getBoardUserMap(boardName).get(target.id);
    if (user) {
      user.canEdit = false;
      user.canClear = false;
      user.canBan = false;
      user.canGrantTemporaryModerator = false;
      emitUserUpdatedToBoard(target, boardName, user);
    }
    target.emit(SocketEvents.BOARDSTATE, {
      ...boardStateForSocket(config, board, target),
      eventClosed: true,
    });
  }
}

/**
 * Registers the real-time Board Session close effects with the Hosted Event
 * Module: when the close pipeline seals a session, its live sockets end on
 * the read-only completion state through {@link notifyBoardSessionClosed}.
 *
 * @param {ServerConfig} config
 * @param {{enabled: boolean, registerBoardCloseEffects?: (effects: {notifyBoardClosed: (boardName: string) => Promise<void>}) => void} | undefined} hostedEventModule
 * @returns {void}
 */
function registerCloseEffects(config, hostedEventModule) {
  if (hostedEventModule?.enabled !== true) return;
  hostedEventModule.registerBoardCloseEffects?.({
    notifyBoardClosed: (boardName) =>
      notifyBoardSessionClosed(boardName, config),
  });
}

/**
 * Registers the socket layer's moderation effects: the real-time
 * consequences of hosted governance decisions. Registered once per IO start
 * so hosted routes can evict banned accounts and refresh revoked moderators
 * without owning the socket table.
 *
 * @param {ServerConfig} config
 * @returns {void}
 */
function registerModerationEffects(config) {
  registerModerationSocketEffects({
    evictEventAccount(eventId, accountId, notice) {
      for (const target of [...activeSockets.values()]) {
        const admission = target.hostedEventAdmission;
        if (
          !admission ||
          admission.eventId !== eventId ||
          admission.accountId !== accountId
        ) {
          continue;
        }
        notifyModerationDisconnectThenClose(
          admission.boardName,
          target,
          closeSocket,
          /** @type {{banDurationMs: number, source: "moderator" | "peer_report" | "event_ban"}} */ (
            notice
          ),
        );
      }
    },
    async refreshEventAccountAccess(eventId, accountId) {
      for (const target of [...activeSockets.values()]) {
        const admission = target.hostedEventAdmission;
        if (
          !admission ||
          admission.eventId !== eventId ||
          admission.accountId !== accountId
        ) {
          continue;
        }
        await refreshHostedSocketAdmission(target, config);
      }
    },
  });
}

/**
 * @param {any} app
 * @param {ServerConfig} config
 * @param {ServerRuntime} runtime
 * @returns {Promise<import("socket.io").Server>}
 */
async function startIO(app, config, runtime) {
  io = new Server(app, { path: "/socket.io" });
  // Real-time moderation effects (evictions, access refreshes) are applied
  // through this registry by the hosted governance routes and handlers.
  registerModerationEffects(config);
  // Board Session close effects: sealed sessions end their live sockets on a
  // read-only completion state instead of stranding them mid-draw.
  registerCloseEffects(config, runtime.hostedEventModule);
  io.use(
    (
      /** @type {AppSocket} */ socket,
      /** @type {(error?: Error) => void} */ next,
    ) => {
      // Keep the same cold runtime object available to the real Socket.IO
      // lifecycle as the HTTP routes receive. Hosted capabilities can extend
      // this seam without creating a second configuration or template graph.
      socket.hostedEventModule = runtime.hostedEventModule;
      // In hosted mode every connection passes the Hosted Event admission
      // gate before anything else: roles and seats are decided here, and
      // legacy boards or unmet admission conditions never reach replay.
      admitHostedSocket(socket)
        .then((admission) => {
          if (admission.ok === false) {
            next(
              createConnectionReplayError({
                ok: false,
                reason: admission.reason,
              }),
            );
            return;
          }
          return prepareConnectionReplay(
            socket,
            config,
            getBoard,
            dropLoadedBoardInstance,
            boardDebugFields,
          ).then((replay) => {
            if (replay.ok === true) {
              socket.replayBootstrap = replay;
              next();
              return;
            }
            next(createConnectionReplayError(replay));
          });
        })
        .catch((error) => {
          next(error instanceof Error ? error : new Error(String(error)));
        });
    },
  );
  io.on(
    "connection",
    wrapSocketEventHandler(function onConnection(socket) {
      return handleSocketConnection(socket, config);
    }, "connection"),
  );
  return io;
}

/** Returns a promise to a BoardData with the given name
 * @param {string} name
 * @param {ServerConfig} config
 * @returns {Promise<BoardData>}
 */
function getBoard(name, config) {
  const loadedBoard = getLoadedBoard(name);
  if (loadedBoard) {
    if (logger.isEnabled("debug")) {
      logger.debug("board.cache_hit", {
        board: name,
      });
    }
    return loadedBoard;
  } else {
    const board = BoardData.load(name, config).then((loaded) => {
      /**
       * @param {{actualFileSeq?: number, durationMs?: number, saveTargetSeq?: number}} details
       * @returns {Promise<void>}
       */
      loaded.onStaleSave = function onStaleSave(details) {
        return handleStaleBoardSave(loaded, details);
      };
      return loaded;
    });
    setLoadedBoard(name, board);
    updateLoadedBoardsGauge();
    if (logger.isEnabled("debug")) {
      logger.debug("board.cache_miss", {
        board: name,
      });
    }
    return board;
  }
}

const socketBroadcastRuntime = {
  getActiveSocket,
  getBoard,
  getSocketUserName,
  resolveClientIp,
  isSyncedPersistentSocket: function isSyncedPersistentSocket(
    /** @type {AppSocket} */ socket,
  ) {
    return syncedPersistentSockets.has(socket.id);
  },
  // A board whose accepted mutation failed its durable ledger write holds
  // state that must not exist; dropping the instance disconnects its sockets
  // and the next connection reloads from snapshot plus ledger.
  discardBoardInstance: function discardBoardInstance(
    /** @type {BoardData} */ board,
    /** @type {{logEvent?: string} | undefined} */ details,
  ) {
    return dropLoadedBoardInstance(board, {
      reason: "ledger_unavailable",
      ...details,
    });
  },
};

/**
 * Executes on every new connection
 * @param {AppSocket} socket
 * @param {ConnectionReplayBootstrap & {ok: true}} replay
 * @param {ServerConfig} config
 * @returns {Promise<void>}
 */
async function bootstrapSocketBoard(socket, replay, config) {
  const { board, boardName } = replay;
  const replayCount = replay.replayBatch._children.length;
  return tracing.withActiveSpan(
    "socket.connect_board",
    {
      kind: tracing.SpanKind.INTERNAL,
      attributes: socketTraceAttributes("connect_board", {
        "wbo.board": boardName,
      }),
    },
    async function traceConnectBoard() {
      if (!socket.rooms.has(boardName)) socket.join(boardName);
      if (logger.isEnabled("debug")) {
        logger.debug(
          "socket.board_bootstrap",
          boardDebugFields(board, {
            socket: socket.id,
            "wbo.socket.baseline_seq": replay.baselineSeq,
            "wbo.socket.latest_seq": replay.latestSeq,
          }),
        );
      }
      // Capabilities the joining socket has on this board. Reused both as the
      // socket's own BOARDSTATE and as the capabilities other users see for it.
      const boardState = boardStateForSocket(config, board, socket);
      const wasJoined = board.users.has(socket.id);
      board.users.add(socket.id);
      if (!wasJoined || !getBoardUserMap(boardName).has(socket.id)) {
        const user = ensureBoardUser(
          socket,
          boardName,
          config,
          resolveClientIp,
          boardState,
        );
        if (!wasJoined) {
          connectedUsersTotal += 1;
          updateConnectedUsersGauge();
        }
        emitBoardUsersToSocket(socket, boardName);
        emitUserJoinedToBoard(socket, boardName, user);
        tracing.setActiveSpanAttributes({
          "user.name": user.name,
          "wbo.board.users": board.users.size,
          "wbo.board.result": "success",
          "wbo.socket.replay.count": replayCount,
        });
        logger.info("board.joined", {
          board: boardName,
          socket: socket.id,
          "user.name": user.name,
          "client.address": user.ip,
          users: board.users.size,
          "wbo.socket.replay.count": replayCount,
        });
      }
      socket.emit(SocketEvents.BOARDSTATE, boardState);
      syncedPersistentSockets.delete(socket.id);
      socket.emit(SocketEvents.BROADCAST, replay.replayBatch);
      syncedPersistentSockets.add(socket.id);
      tracing.setActiveSpanAttributes({
        "wbo.socket.replay.outcome": replay.outcome,
        "wbo.socket.replay.count": replayCount,
        "wbo.socket.baseline_seq": replay.baselineSeq,
        "wbo.socket.latest_seq": replay.latestSeq,
      });
    },
  );
}

/**
 * Executes on every new connection
 * @param {AppSocket} socket
 * @param {ServerConfig} config
 */
async function handleSocketConnection(socket, config) {
  // Fill in hosted admission when the middleware never ran (socket
  // scenarios); in the real server this is already decided before replay.
  const hostedAdmission = await admitHostedSocket(socket);
  if (hostedAdmission.ok === false) {
    rejectSocketRequest(socket, "connection", hostedAdmission.reason);
    closeSocket(socket, "connection", { reason: hostedAdmission.reason });
    return;
  }
  const replayBootstrap = /** @type {ConnectionReplayBootstrap | undefined} */ (
    socket.replayBootstrap
  );
  const replay =
    replayBootstrap?.ok === true
      ? replayBootstrap
      : await prepareConnectionReplay(
          socket,
          config,
          getBoard,
          dropLoadedBoardInstance,
          boardDebugFields,
        );
  if (replay.ok === false) {
    rejectSocketRequest(socket, "connection", replay.reason);
    closeSocket(socket, "connection", { reason: replay.reason });
    return;
  }
  const boardName = replay.boardName;
  activeSockets.set(socket.id, socket);
  updateActiveSocketConnectionsGauge();
  metrics.recordSocketConnection("connected");
  // The connection is real: register it with the hosted seat registry so the
  // account's writable slot and seat occupancy reflect live sockets only.
  registerHostedSocketConnection(socket);

  onSocketEvent(socket, "error", function onSocketError(error) {
    logger.error("socket.error", {
      socket: socket.id,
      error: error,
    });
  });

  onSocketEvent(
    socket,
    "turnstile_token",
    async function onTurnstileToken(
      /** @type {string} */ token,
      /** @type {TurnstileAckCallback | undefined} */ ack,
    ) {
      return tracing.withActiveSpan(
        "socket.turnstile_token",
        {
          kind: tracing.SpanKind.INTERNAL,
          attributes: socketTraceAttributes("turnstile_token"),
        },
        async function traceTurnstileToken() {
          const clientIp = resolveClientIp(socket, boardName, config);
          if (
            !enforceBroadcastPreNormalization({
              socket,
              boardName,
              data: undefined,
              clientIp,
              userName: getSocketUserName(socket, clientIp),
              now: Date.now(),
              config,
            })
          ) {
            return;
          }
          return handleTurnstileTokenMessage(
            socket,
            boardName,
            token,
            ack,
            config,
            resolveClientIp,
            getSocketUserName,
          );
        },
      );
    },
  );

  onSocketEvent(
    socket,
    "broadcast",
    async function onBroadcast(/** @type {MessageData | undefined} */ data) {
      const now = Date.now();
      const normalizedName = boardName;

      async function handleBroadcastWrite() {
        return handleBroadcastWriteMessage(
          socket,
          normalizedName,
          data,
          now,
          config,
          socketBroadcastRuntime,
        );
      }

      if (!shouldTraceBroadcast(data)) {
        return handleBroadcastWrite();
      }

      return tracing.withActiveSpan(
        "socket.broadcast_write",
        {
          kind: tracing.SpanKind.INTERNAL,
          attributes: boardMutationTraceAttributes(
            normalizedName,
            undefined,
            data,
          ),
        },
        handleBroadcastWrite,
      );
    },
  );

  onSocketEvent(
    socket,
    "report_user",
    function onReportUser(
      /** @type {ReportUserPayload | undefined} */ message,
    ) {
      const normalizedName = boardName;
      return tracing.withActiveSpan(
        "socket.report_user",
        {
          kind: tracing.SpanKind.INTERNAL,
          attributes: socketTraceAttributes("report_user", {
            "wbo.board": normalizedName,
          }),
        },
        function traceReportUser() {
          // Hosted events route reports through the event governance flow:
          // they are recorded and surfaced to the event's moderators, never
          // a disconnect trigger. Legacy boards keep the peer-report flow.
          const hosted = socket.hostedEventModule;
          if (socket.hostedEventAdmission && hosted?.enabled === true) {
            return handleHostedReportUserMessage({
              socket,
              boardName: normalizedName,
              message,
              config,
              now: Date.now(),
              getActiveSocket,
              closeSocket,
              hosted,
              effects: moderationSocketEffects(),
            });
          }
          handleReportUserMessage({
            socket,
            boardName: normalizedName,
            message,
            config,
            now: Date.now(),
            getActiveSocket,
            closeSocket,
          });
          return undefined;
        },
      );
    },
  );

  onSocketEvent(
    socket,
    SocketEvents.MODERATION_ACTION,
    function onModerationAction(
      /** @type {unknown} */ message,
      /** @type {((result: unknown) => void) | undefined} */ ack,
    ) {
      const normalizedName = boardName;
      return tracing.withActiveSpan(
        "socket.moderation_action",
        {
          kind: tracing.SpanKind.INTERNAL,
          attributes: socketTraceAttributes("moderation_action", {
            "wbo.board": normalizedName,
          }),
        },
        function traceModerationAction() {
          return handleHostedModerationActionMessage({
            socket,
            boardName: normalizedName,
            message,
            config,
            now: Date.now(),
            getActiveSocket,
            closeSocket,
            hosted: socket.hostedEventModule,
            effects: moderationSocketEffects(),
            ack,
          });
        },
      );
    },
  );

  onSocketEvent(
    socket,
    SocketEvents.MODERATION_STATE,
    function onModerationState(
      /** @type {((result: unknown) => void) | undefined} */ ack,
    ) {
      const normalizedName = boardName;
      return tracing.withActiveSpan(
        "socket.moderation_state",
        {
          kind: tracing.SpanKind.INTERNAL,
          attributes: socketTraceAttributes("moderation_state", {
            "wbo.board": normalizedName,
          }),
        },
        function traceModerationState() {
          return handleModerationStateMessage({
            socket,
            boardName: normalizedName,
            config,
            hosted: socket.hostedEventModule,
            ack,
          });
        },
      );
    },
  );

  onSocketEvent(
    socket,
    SocketEvents.SET_TEMPORARY_MODERATOR,
    function onSetTemporaryModerator(
      /** @type {SetTemporaryModeratorPayload | undefined} */ message,
    ) {
      return handleSetTemporaryModeratorMessage({
        socket,
        boardName,
        message,
        config,
        now: Date.now(),
        getActiveSocket,
        refreshUserAccess: (targetBoardName, userSecret) =>
          refreshUserAccess(targetBoardName, userSecret, config),
      });
    },
  );

  socket.on(
    "disconnecting",
    function onDisconnecting(/** @type {string} */ _reason) {
      activeSockets.delete(socket.id);
      syncedPersistentSockets.delete(socket.id);
      updateActiveSocketConnectionsGauge();
      metrics.recordSocketConnection("disconnected");
      // Release the hosted seat (and promote a companion to the writer slot)
      // before the room teardown so the promotion can still find its board.
      void releaseHostedSocket(socket, config).catch((error) => {
        logger.error("socket.hosted_release_failed", {
          socket: socket.id,
          error,
        });
      });
      socket.rooms.forEach(
        async function disconnectFrom(/** @type {string} */ room) {
          const boardPromise = getLoadedBoard(room);
          if (boardPromise) {
            const board = await boardPromise;
            if (logger.isEnabled("debug")) {
              logger.debug(
                "socket.board_disconnecting",
                boardDebugFields(board, {
                  socket: socket.id,
                }),
              );
            }
            const removed = board.users.delete(socket.id);
            removeBoardUser(socket, room);
            const userCount = board.users.size;
            if (removed) {
              connectedUsersTotal = Math.max(0, connectedUsersTotal - 1);
              updateConnectedUsersGauge();
            }
            if (logger.isEnabled("debug")) {
              logger.debug(
                "socket.board_disconnected",
                boardDebugFields(board, {
                  socket: socket.id,
                  "wbo.board.user_removed": removed,
                }),
              );
            }
            if (userCount === 0 && !shuttingDown) unloadBoard(room);
          }
        },
      );
    },
  );

  await bootstrapSocketBoard(socket, replay, config);
}

/**
 * Unloads a board from memory.
 * @param {string} boardName
 **/
async function unloadBoard(boardName) {
  const loadedBoard = getLoadedBoard(boardName);
  if (loadedBoard) {
    return tracing.withOptionalActiveSpan(
      "board.unload",
      {
        attributes: {
          "wbo.board": boardName,
          "wbo.board.operation": "unload",
        },
      },
      async function traceBoardUnload() {
        const startedAt = Date.now();
        const board = await loadedBoard;
        if (logger.isEnabled("debug")) {
          logger.debug("board.unload_started", boardDebugFields(board));
        }
        try {
          const saveResult = await board.save();
          if (saveResult.status === "stale") {
            if (logger.isEnabled("debug")) {
              logger.debug("board.unload_stale", boardDebugFields(board));
            }
            return;
          }
          if (saveResult.status === "failed" && !shuttingDown) {
            logger.warn(
              "board.unload_aborted_save_failed",
              boardDebugFields(board),
            );
            return;
          }
          if (board.users.size > 0) {
            if (logger.isEnabled("debug")) {
              logger.debug("board.unload_aborted", boardDebugFields(board));
            }
            return;
          }
          const minPinnedBaselineSeq = getMinPinnedReplayBaselineSeq(
            boardName,
            Date.now(),
          );
          if (
            minPinnedBaselineSeq !== null &&
            minPinnedBaselineSeq < board.getPersistedSeq()
          ) {
            const nextReplayPinExpiry = getNextReplayPinExpiry(
              boardName,
              Date.now(),
            );
            if (nextReplayPinExpiry !== null) {
              const retryDelayMs = Math.max(
                1,
                nextReplayPinExpiry - Date.now(),
              );
              setTimeout(() => {
                void unloadBoard(boardName);
              }, retryDelayMs);
            }
            if (logger.isEnabled("debug")) {
              logger.debug(
                "board.unload_delayed_for_replay_pins",
                boardDebugFields(board, {
                  "wbo.board.min_pinned_baseline_seq": minPinnedBaselineSeq,
                }),
              );
            }
            return;
          }
          discardPinnedReplayBaselinesBefore(
            boardName,
            board.getPersistedSeq(),
            Date.now(),
          );
          board.dispose();
          if (logger.isEnabled("debug")) {
            logger.debug("board.unload_completed", boardDebugFields(board));
          }
          tracing.setActiveSpanAttributes({
            "wbo.board": boardName,
            "wbo.board.result": "success",
          });
          metrics.recordBoardOperationDuration(
            "unload",
            boardName,
            (Date.now() - startedAt) / 1000,
          );
          deleteLoadedBoard(boardName);
          updateLoadedBoardsGauge();
        } catch (error) {
          tracing.recordActiveSpanError(error, {
            "wbo.board": boardName,
            "wbo.board.result": "error",
          });
          metrics.recordBoardOperationDuration(
            "unload",
            boardName,
            (Date.now() - startedAt) / 1000,
            error,
          );
          throw error;
        }
      },
    );
  }
}

/**
 * Persist and unload every loaded board.
 * @returns {Promise<void>}
 */
async function shutdownBoards() {
  const currentIo = io;
  shuttingDown = true;
  io = undefined;
  if (currentIo) {
    currentIo.disconnectSockets(true);
    currentIo.engine.close();
  }
  const loadedBoards = listLoadedBoards();
  await Promise.all(
    loadedBoards.map(async (boardName) => {
      const board = await /** @type {Promise<BoardData>} */ (
        getLoadedBoard(boardName)
      );
      board.users.clear();
      return unloadBoard(boardName);
    }),
  );
  resetBoardRegistry();
}

export const __test = {
  admitHostedSocket: function admitHostedSocketForTest(
    /** @type {AppSocket} */ socket,
  ) {
    return admitHostedSocket(socket);
  },
  /**
   * Test seam: registers the production moderation socket effects against a
   * scenario config so eviction and access-refresh tests exercise the real
   * implementation through handleSocketConnection sockets.
   */
  registerModerationEffects: function registerModerationEffectsForTest(
    /** @type {ServerConfig} */ config,
  ) {
    registerModerationEffects(config);
  },
  /**
   * Test seam: registers the production Board Session close effects against a
   * hosted module so close tests exercise the real read-only completion
   * notification through handleSocketConnection sockets.
   */
  registerCloseEffects: function registerCloseEffectsForTest(
    /** @type {ServerConfig} */ config,
    /** @type {{enabled: boolean, registerBoardCloseEffects?: (effects: {notifyBoardClosed: (boardName: string) => Promise<void>}) => void} | undefined} */ hostedEventModule,
  ) {
    registerCloseEffects(config, hostedEventModule);
  },
  buildBoardUserRecord: function buildBoardUserRecordForTest(
    /** @type {AppSocket} */ socket,
    /** @type {string} */ boardName,
    /** @type {ServerConfig} */ config,
    /** @type {number | undefined} */ now,
  ) {
    return createBoardUserRecord(
      socket,
      boardName,
      config,
      resolveClientIp,
      {
        canEdit: true,
        canClear: false,
        canBan: false,
        canGrantTemporaryModerator: false,
      },
      now,
    );
  },
  buildUserId,
  buildUserName,
  handleSocketConnection: function handleSocketConnectionForTest(
    /** @type {AppSocket} */ socket,
    /** @type {ServerConfig} */ config,
  ) {
    return handleSocketConnection(socket, config);
  },
  consumeFixedWindowRateLimit,
  countDestructiveActions,
  countConstructiveActions,
  countTextCreationActions,
  createRateLimitState,
  rateLimitTestInternals,
  getClientIp,
  normalizeBroadcastData,
  prepareConnectionReplay: function prepareConnectionReplayForTest(
    /** @type {AppSocket} */ socket,
    /** @type {ServerConfig} */ config,
  ) {
    return prepareConnectionReplay(
      socket,
      config,
      getBoard,
      dropLoadedBoardInstance,
      boardDebugFields,
    );
  },
  cleanupBoardUserMap,
  getBoardUserMap,
  boardUserDebugFields,
  getLoadedBoard: function getLoadedBoardForTest(/** @type {string} */ name) {
    return getLoadedBoard(name);
  },
  listLoadedBoards,
  getLastUserReportLog: function getLastUserReportLog() {
    return getLastSocketUserReportLog();
  },
  resetRateLimitMaps: function resetRateLimitMaps() {
    resetSocketRateLimitMaps();
    resetBans();
    resetTemporaryModerators();
    resetBoardUserMaps();
    activeSockets.clear();
    syncedPersistentSockets.clear();
    connectedUsersTotal = 0;
    resetSocketReports();
    invalidIpSourceLogged = false;
    shuttingDown = false;
    io = undefined;
    resetBoardRegistry();
  },
};

export { shutdownBoards as shutdown, startIO as start };
