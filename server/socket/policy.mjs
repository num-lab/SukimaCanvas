import { isValidBoardName } from "../../client-data/js/board_name.js";
import {
  formatMessageTypeTag,
  getMutationType,
  getToolId,
} from "../../client-data/js/message_tool_metadata.js";
import { MutationType } from "../../client-data/js/mutation_type.js";
import RateLimitCommon from "../../client-data/js/rate_limit_common.js";
import { TOOL_CODE_BY_ID } from "../../client-data/tools/manifest.js";
import { BoardPermissions } from "../auth/board_capabilities.mjs";
import observability from "../observability/index.mjs";
import { getEditBanExpiresAt } from "./bans.mjs";
import { normalizeIncomingMessage } from "./message_validation.mjs";
import { getSocketUserSecret } from "./request.mjs";
import { getTemporaryModeratorExpiresAt } from "./temporary_moderators.mjs";

const { logger, metrics, tracing } = observability;

const CURSOR_TOOL_CODE = TOOL_CODE_BY_ID.cursor;

/** @typedef {import("../../types/server-runtime.d.ts").AppSocket} AppSocket */
/** @typedef {import("../../types/server-runtime.d.ts").BoardLike} BoardLike */
/** @typedef {import("../../types/server-runtime.d.ts").BroadcastResult} BroadcastResult */
/** @typedef {import("../../types/server-runtime.d.ts").MessageData} MessageData */
/** @typedef {import("../../types/server-runtime.d.ts").RejectedBroadcast} RejectedBroadcast */
/** @typedef {import("../../types/server-runtime.d.ts").SocketRequest} SocketRequest */
/** @typedef {import("../../types/app-runtime").BoardCapabilities} BoardCapabilities */
/** @typedef {import("../../types/app-runtime").AppBoardState} SocketBoardState */
/**
 * @typedef {{
 *   AUTH_SECRET_KEY: string,
 *   BLOCKED_TOOLS: string[],
 *   IP_SOURCE: string,
 *   MAX_BOARD_SIZE: number,
 *   MAX_CHILDREN: number,
 *   TRUST_PROXY_HOPS: number,
 *   BOARD_MODERATORS?: Map<string, Set<string>>,
 * }} SocketPolicyConfig
 */
/** @typedef {ReturnType<typeof BoardPermissions.forBoard>} SocketBoardPermissions */

/**
 * @param {string | string[] | undefined} value
 * @returns {string | undefined}
 */
function singleHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * @param {string} headerName
 * @returns {string}
 */
function normalizeHeaderName(headerName) {
  return headerName.trim().toLowerCase();
}

/**
 * @param {string} headerValue
 * @returns {string[]}
 */
function parseHeaderChain(headerValue) {
  return headerValue
    .split(",")
    .map(function trimHop(/** @type {string} */ hop) {
      return hop.trim();
    })
    .filter(Boolean);
}

/**
 * @param {string} value
 * @returns {string[]}
 */
function parseForwardedChain(value) {
  return value
    .split(",")
    .map(function parseForwardedEntry(/** @type {string} */ proxyEntry) {
      const forwardedFor = proxyEntry
        .split(";")
        .map(function trimPart(/** @type {string} */ part) {
          return part.trim();
        })
        .find(function isForPart(/** @type {string} */ part) {
          return /^for=/i.test(part);
        });
      if (!forwardedFor) {
        throw new Error("Missing for= in Forwarded header");
      }

      let resolved = forwardedFor.replace(/^for=/i, "").trim();
      if (
        resolved.startsWith('"') &&
        resolved.endsWith('"') &&
        resolved.length >= 2
      ) {
        resolved = resolved.slice(1, -1);
      }
      if (!resolved) {
        throw new Error("Invalid Forwarded header");
      }
      return resolved;
    })
    .filter(Boolean);
}

/**
 * @param {string[]} chain
 * @param {number} trustProxyHops
 * @returns {string}
 */
function selectTrustedClientIp(chain, trustProxyHops) {
  const trustedHops = Math.max(0, trustProxyHops || 0);
  const selectedIndex = Math.min(trustedHops, chain.length - 1);
  return chain[selectedIndex] || "";
}

/**
 * @param {string[]} chain
 * @param {string} directRemoteAddress
 * @param {number} trustProxyHops
 * @returns {string}
 */
function resolveClientIpChain(chain, directRemoteAddress, trustProxyHops) {
  if (trustProxyHops > 0 && directRemoteAddress) {
    chain.reverse();
    chain.unshift(directRemoteAddress);
    return selectTrustedClientIp(chain, trustProxyHops);
  }
  return chain[0] || "";
}

/**
 * @param {string | undefined} directRemoteAddress
 * @returns {string}
 */
function resolveRemoteAddressClientIp(directRemoteAddress) {
  if (directRemoteAddress) return directRemoteAddress;
  throw new Error("Missing remoteAddress");
}

/**
 * @param {{[key: string]: string | string[] | undefined}} headers
 * @param {string} directRemoteAddress
 * @param {number} trustProxyHops
 * @returns {string}
 */
function resolveForwardedForClientIp(
  headers,
  directRemoteAddress,
  trustProxyHops,
) {
  const forwardedForHeader = singleHeaderValue(headers["x-forwarded-for"]);
  if (!forwardedForHeader) {
    throw new Error(
      "Missing x-forwarded-for header. If you are not behind a proxy, set WBO_IP_SOURCE=remoteAddress.",
    );
  }
  return resolveClientIpChain(
    parseHeaderChain(forwardedForHeader),
    directRemoteAddress,
    trustProxyHops,
  );
}

/**
 * @param {{[key: string]: string | string[] | undefined}} headers
 * @param {string} directRemoteAddress
 * @param {number} trustProxyHops
 * @returns {string}
 */
function resolveForwardedHeaderClientIp(
  headers,
  directRemoteAddress,
  trustProxyHops,
) {
  const forwardedHeader = singleHeaderValue(headers.forwarded);
  if (!forwardedHeader) {
    throw new Error(
      "Missing Forwarded header. If you are not behind a proxy, set WBO_IP_SOURCE=remoteAddress.",
    );
  }
  return resolveClientIpChain(
    parseForwardedChain(forwardedHeader),
    directRemoteAddress,
    trustProxyHops,
  );
}

/**
 * @param {{[key: string]: string | string[] | undefined}} headers
 * @param {string} normalizedIpSource
 * @param {string} ipSource
 * @returns {string}
 */
function resolveCustomHeaderClientIp(headers, normalizedIpSource, ipSource) {
  const customHeader = singleHeaderValue(headers[normalizedIpSource]);
  if (customHeader?.trim()) return customHeader.trim();
  throw new Error(`Missing ${ipSource} header`);
}

/**
 * @param {SocketPolicyConfig} config
 * @param {SocketRequest | {headers?: {[key: string]: string | string[] | undefined}, socket?: {remoteAddress?: string | undefined} | undefined}} request
 * @returns {string}
 */
function getRequestClientIp(config, request) {
  const headers = request.headers || {};
  const directRemoteAddress = request.socket?.remoteAddress || "";
  const ipSource = config.IP_SOURCE || "remoteAddress";
  const normalizedIpSource = normalizeHeaderName(ipSource);
  const trustProxyHops = config.TRUST_PROXY_HOPS;

  switch (normalizedIpSource) {
    case "remoteaddress":
      return resolveRemoteAddressClientIp(directRemoteAddress);
    case "x-forwarded-for":
      return resolveForwardedForClientIp(
        headers,
        directRemoteAddress,
        trustProxyHops,
      );
    case "forwarded":
      return resolveForwardedHeaderClientIp(
        headers,
        directRemoteAddress,
        trustProxyHops,
      );
    default:
      return resolveCustomHeaderClientIp(headers, normalizedIpSource, ipSource);
  }
}

/**
 * @param {SocketPolicyConfig} config
 * @param {AppSocket} socket
 * @returns {string}
 */
function getClientIp(config, socket) {
  return getRequestClientIp(config, socket.client.request);
}

/**
 * Last-resort client IP from a raw request when the configured source is missing.
 * Shared so sockets, HTTP renders, bans, and presence all key on one value.
 * @param {{socket?: {remoteAddress?: string}} | null | undefined} request
 * @returns {string}
 */
function requestClientIpFallback(request) {
  return request?.socket?.remoteAddress || "unknown";
}

/**
 * Resolve a request's client IP without throwing.
 * @param {SocketPolicyConfig} config
 * @param {SocketRequest | {headers?: {[key: string]: string | string[] | undefined}, socket?: {remoteAddress?: string | undefined} | undefined}} request
 * @returns {string}
 */
function resolveRequestClientIpSafe(config, request) {
  try {
    return getRequestClientIp(config, request);
  } catch {
    return requestClientIpFallback(request);
  }
}

/**
 * @param {AppSocket} socket
 * @returns {string}
 */
function clientIpFallback(socket) {
  return requestClientIpFallback(socket.client?.request);
}

/**
 * Resolve a socket's client IP without throwing.
 * @param {SocketPolicyConfig} config
 * @param {AppSocket} socket
 * @returns {string}
 */
function resolveClientIpSafe(config, socket) {
  return resolveRequestClientIpSafe(config, socket.client?.request);
}

/**
 * @param {MessageData | null | undefined} data
 * @returns {number}
 */
const countDestructiveActions = RateLimitCommon.countDestructiveActions;
const countConstructiveActions = RateLimitCommon.countConstructiveActions;
const countTextCreationActions = RateLimitCommon.countTextCreationActions;

/**
 * @param {SocketPolicyConfig} config
 * @param {string} boardName
 * @param {MessageData | null | undefined} data
 * @param {BoardCapabilities} [capabilities]
 * @returns {BroadcastResult}
 */
function normalizeBroadcastData(config, boardName, data, capabilities) {
  if (!data) {
    return rejectedBroadcast(boardName, "missing data");
  }

  const blockedTools = config.BLOCKED_TOOLS;
  const rawToolId = getToolId(data.tool);
  if (rawToolId && blockedTools.includes(rawToolId)) {
    return rejectedBroadcast(boardName, "blocked tool");
  }

  const normalized = normalizeIncomingMessage(config, data, capabilities);
  if (normalized.ok === false) {
    return rejectedBroadcast(boardName, normalized.reason);
  }

  const normalizedToolId = getToolId(normalized.value.tool);
  if (normalizedToolId && blockedTools.includes(normalizedToolId)) {
    return rejectedBroadcast(boardName, "blocked tool");
  }

  return normalized;

  /**
   * @param {string} rejectedBoardName
   * @param {string} reason
   * @returns {RejectedBroadcast}
   */
  function rejectedBroadcast(rejectedBoardName, reason) {
    return tracing.withDetachedSpan(
      "socket.message_invalid",
      {
        attributes: {
          "wbo.socket.event": "broadcast_write",
          "wbo.board": rejectedBoardName,
          "wbo.rejection.reason": reason,
          "wbo.tool": getToolId(data?.tool),
          "wbo.message.type": formatMessageTypeTag(data?.type),
        },
      },
      function recordRejectedBroadcast() {
        logger.warn("socket.message_invalid", {
          board: rejectedBoardName,
          message: data,
          tool: getToolId(data?.tool),
          type: data?.type,
          reason: reason,
        });
        metrics.recordBoardMessage(
          { board: rejectedBoardName, ...(data || {}) },
          "invalid_message",
        );
        return { ok: false, reason: reason };
      },
    );
  }
}

/**
 * @param {AppSocket} socket
 * @returns {string | undefined}
 */
function getSocketToken(socket) {
  const token = socket.handshake.query?.token;
  return typeof token === "string" ? token : undefined;
}

/**
 * @param {unknown} boardName
 * @returns {string | null}
 */
function normalizeBoardName(boardName) {
  if (boardName === undefined || boardName === null || boardName === "") {
    return "anonymous";
  }
  return isValidBoardName(boardName) ? boardName : null;
}

/**
 * @param {SocketPolicyConfig} config
 * @param {string} boardName
 * @param {AppSocket} socket
 * @returns {SocketBoardPermissions}
 */
function boardPermissionsForSocket(config, boardName, socket) {
  const current = socket.boardPermissionContext;
  if (current?.boardName === boardName) return current.permissions;

  const userSecret = getSocketUserSecret(socket);
  const permissions = BoardPermissions.forBoard({
    config,
    boardName,
    userInfo: {
      token: getSocketToken(socket),
      userSecret,
      // Pinned by hosted admission before any capability query. Hosted boards
      // never consult JWTs, and a forged query token cannot escalate it.
      hostedRole: socket.hostedBoardRole || null,
    },
    // Lazy + live: only resolved when a capability query depends on the ban
    // (so canOpen never needs the IP), and re-read on every query so a ban and
    // its expiry take effect without reconnecting. The expiry is also exposed
    // in board state as a one-shot client access refresh delay. Tolerant of a
    // missing IP source, keying on the same address presence records.
    getBanExpiresAt: () =>
      getEditBanExpiresAt(
        boardName,
        userSecret,
        resolveClientIpSafe(config, socket),
        Date.now(),
      ),
    getTemporaryModeratorExpiresAt: () =>
      getTemporaryModeratorExpiresAt(boardName, userSecret, Date.now()),
  });
  socket.boardPermissionContext = { boardName, permissions };
  return permissions;
}

/**
 * @param {SocketPolicyConfig} config
 * @param {string} boardName
 * @param {AppSocket} socket
 * @returns {boolean}
 */
function canAccessBoard(config, boardName, socket) {
  return boardPermissionsForSocket(config, boardName, socket).canOpen();
}

/**
 * Returns true when the given socket belongs to an user who has the permission to ban others on the board.
 * @param {SocketPolicyConfig} config
 * @param {string} boardName
 * @param {AppSocket} socket
 * @returns {boolean}
 */
function canBanOnBoard(config, boardName, socket) {
  return boardPermissionsForSocket(config, boardName, socket).canBan();
}

/**
 * @param {SocketPolicyConfig} config
 * @param {string} boardName
 * @param {AppSocket} socket
 * @returns {boolean}
 */
function canGrantTemporaryModeratorOnBoard(config, boardName, socket) {
  return boardPermissionsForSocket(
    config,
    boardName,
    socket,
  ).canGrantTemporaryModerator();
}

/**
 * Returns whether the socket may report another user on this board.
 * @param {SocketPolicyConfig} config
 * @param {string} boardName
 * @param {AppSocket} socket
 * @returns {boolean}
 */
function canReportOnBoard(config, boardName, socket) {
  return boardPermissionsForSocket(config, boardName, socket).canReport();
}

/**
 * @param {SocketPolicyConfig} config
 * @param {string} boardName
 * @param {AppSocket} socket
 * @returns {BoardCapabilities}
 */
function boardCapabilitiesForSocket(config, boardName, socket) {
  return boardPermissionsForSocket(
    config,
    boardName,
    socket,
  ).resolveCapabilities({ name: boardName });
}

/**
 * @param {SocketPolicyConfig} config
 * @param {BoardLike} board
 * @param {AppSocket} socket
 * @returns {SocketBoardState}
 */
function boardStateForSocket(config, board, socket) {
  return boardPermissionsForSocket(config, board.name, socket).boardState(
    board,
  );
}

/**
 * @param {SocketPolicyConfig} config
 * @param {BoardLike} board
 * @param {AppSocket} socket
 * @returns {boolean}
 */
function canEditBoard(config, board, socket) {
  return boardStateForSocket(config, board, socket).canEdit || false;
}

/**
 * @param {SocketPolicyConfig} config
 * @param {BoardLike} board
 * @param {import("../../types/server-runtime.d.ts").NormalizedMessageData} data
 * @param {AppSocket} socket
 * @returns {boolean}
 */
function canApplyBoardMessage(config, board, data, socket) {
  // Hosted sockets re-validate against the admission module before any
  // persistent mutation: lifecycle, bans, and the account's writer slot can
  // all change while the connection stays open. Cursor messages stay with the
  // legacy capability check so read-only tabs keep sharing presence.
  const hosted = socket.hostedEventModule;
  const admission = socket.hostedEventAdmission;
  if (
    hosted?.enabled === true &&
    admission &&
    data &&
    data.tool !== CURSOR_TOOL_CODE
  ) {
    const verdict = hosted.revalidateSocketWrite(admission);
    if (verdict.ok === false) {
      logger.warn("socket.hosted_write_rejected", {
        socket: socket.id,
        board: board.name,
        reason: verdict.reason,
      });
      return false;
    }
    // Hosted events record who cleared and why; a Clear without a reason is
    // rejected like any other blocked write. Legacy boards are unaffected.
    if (
      getMutationType(data) === MutationType.CLEAR &&
      (() => {
        const reason = /** @type {{reason?: unknown}} */ (data).reason;
        return typeof reason !== "string" || reason.trim() === "";
      })()
    ) {
      logger.warn("socket.hosted_clear_reason_required", {
        socket: socket.id,
        board: board.name,
      });
      return false;
    }
  }
  return boardPermissionsForSocket(
    config,
    board.name,
    socket,
  ).canApplyBoardMessage(board, data);
}

export {
  boardCapabilitiesForSocket,
  boardStateForSocket,
  canAccessBoard,
  canApplyBoardMessage,
  canBanOnBoard,
  canEditBoard,
  canGrantTemporaryModeratorOnBoard,
  canReportOnBoard,
  clientIpFallback,
  countConstructiveActions,
  countDestructiveActions,
  countTextCreationActions,
  getClientIp,
  getRequestClientIp,
  normalizeBoardName,
  normalizeBroadcastData,
  parseForwardedChain,
  resolveRequestClientIpSafe,
};
