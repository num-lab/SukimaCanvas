import {
  ModerationActions,
  SocketEvents,
} from "../../client-data/js/socket_events.js";
import observability from "../observability/index.mjs";
import { canBanOnBoard, canReportOnBoard } from "./policy.mjs";
import { MAX_REASON_LENGTH } from "../hosted_event/moderation/store.mjs";
import { getBoardUser, getBoardUserMap } from "./presence.mjs";

const { logger, tracing } = observability;

/** @import { AppSocket, ServerConfig } from "../../types/server-runtime.d.ts" */
/** @typedef {{socketId: string, userId: string, name: string, ip: string, userSecret: string, userAgent: string, language: string, participantId?: string}} BoardUser */
/** @typedef {(socketId: string) => AppSocket | undefined} GetActiveSocket */
/** @typedef {(socket: AppSocket, eventName: string, infos: {[key: string]: any}) => void} CloseSocket */
/**
 * The hosted governance surface the socket handlers rely on, as composed onto
 * the Hosted Event Module by `createEventModeration`.
 *
 * @typedef {{
 *   recordEventReport: (input: {
 *     eventId: string,
 *     reporterAccountId: string,
 *     reportedAccountId: string,
 *     reportedParticipantId: string,
 *     reportedName: string,
 *     reason?: string,
 *   }) => Promise<void>,
 *   applyModeration: (input: {
 *     eventId: string,
 *     action: "warn" | "kick" | "ban" | "unban",
 *     reason: string,
 *     operatorAccountId: string,
 *     targetAccountId: string,
 *     targetParticipantId: string | null,
 *     targetName: string,
 *   }) => Promise<{ok: true} | {ok: false, reason: string}>,
 *   eventBanSummaries: (eventId: string) => Promise<{accountId: string, participantId: string, name: string, bannedAtMs: number}[]>,
 * }} HostedModerationApi
 */
/** @typedef {import("../hosted_event/moderation/socket_effects.mjs").ModerationSocketEffects | null} ModerationEffects */
/** @typedef {{socket: AppSocket, boardName: string, message: unknown, config: ServerConfig, now: number, getActiveSocket: GetActiveSocket, closeSocket: CloseSocket, hosted?: HostedModerationApi, effects: ModerationEffects}} HostedModerationContext */

/**
 * The disposition actions and their wire validation. A missing or malformed
 * field rejects the whole message deterministically.
 */
const DISPOSITION_ACTIONS = /** @type {Set<string>} */ (
  new Set([
    ModerationActions.WARN,
    ModerationActions.KICK,
    ModerationActions.BAN,
    ModerationActions.UNBAN,
  ])
);
/**
 * @param {unknown} value
 * @returns {string}
 */
function nonEmptyString(value) {
  return typeof value === "string" ? value : "";
}

/**
 * @param {unknown} reason
 * @returns {string}
 */
function normalizeReason(reason) {
  return nonEmptyString(reason).trim().slice(0, MAX_REASON_LENGTH);
}

/**
 * Marks the active span with the moderation outcome.
 *
 * @param {string} result
 * @returns {void}
 */
function setModerationResult(result) {
  tracing.setActiveSpanAttributes({
    "wbo.board.result": result,
  });
}

/**
 * Resolves the target socket's presence record and live socket for one
 * hosted board. Everything is scoped to the board, so a socket id from
 * another board or a malformed id simply does not resolve.
 *
 * @param {HostedModerationContext} context
 * @param {string} targetSocketId
 * @returns {{user: BoardUser, targetSocket: AppSocket} | null}
 */
function resolveOnlineTarget(context, targetSocketId) {
  const user = getBoardUser(context.boardName, targetSocketId);
  if (!user) return null;
  const targetSocket = context.getActiveSocket(targetSocketId);
  if (!targetSocket || !targetSocket.rooms.has(context.boardName)) return null;
  return { user, targetSocket };
}

/**
 * Hosted participant reports: a participant reports another online
 * participant of the same event. Self-reports, targets on other boards, and
 * malformed socket ids are deterministically rejected; the report is never
 * a disconnect trigger — it is recorded and surfaced to the event's
 * moderators, who decide.
 *
 * @param {HostedModerationContext} context
 * @returns {Promise<void>}
 */
async function handleHostedReportUserMessage(context) {
  const { socket, boardName, message, config, hosted } = context;
  const reporterAdmission = socket.hostedEventAdmission;
  if (!hosted || !reporterAdmission || !socket.rooms.has(boardName)) {
    setModerationResult("report_ignored");
    return;
  }
  const targetSocketId = nonEmptyString(
    /** @type {{socketId?: unknown}} */ (message || {})?.socketId,
  );
  const resolved = targetSocketId
    ? resolveOnlineTarget(context, targetSocketId)
    : null;
  if (!resolved) {
    setModerationResult("report_target_not_found");
    logger.warn("hosted.report_rejected", {
      board: boardName,
      socket: socket.id,
      reason: "target_not_found",
    });
    return;
  }
  if (!canReportOnBoard(config, boardName, socket)) {
    setModerationResult("blocked_reporter_ignored");
    return;
  }
  const targetAdmission = resolved.targetSocket.hostedEventAdmission;
  if (!targetAdmission) {
    setModerationResult("report_ignored");
    return;
  }
  if (
    targetAdmission.accountId === reporterAdmission.accountId ||
    targetSocketId === socket.id
  ) {
    setModerationResult("self_report_ignored");
    logger.warn("hosted.report_rejected", {
      board: boardName,
      socket: socket.id,
      reason: "self_report",
    });
    return;
  }
  if (canBanOnBoard(config, boardName, resolved.targetSocket)) {
    // Governance roles are protected targets: reports against them are
    // refused without recording, matching the client's hidden report button.
    setModerationResult("protected_report_ignored");
    logger.warn("hosted.report_rejected", {
      board: boardName,
      socket: socket.id,
      reason: "protected_target",
    });
    return;
  }
  await hosted.recordEventReport({
    eventId: reporterAdmission.eventId,
    reporterAccountId: reporterAdmission.accountId,
    reportedAccountId: targetAdmission.accountId,
    reportedParticipantId: targetAdmission.participantId,
    reportedName: resolved.user.name,
  });
  setModerationResult("reported");
  logger.info("hosted.report_recorded", {
    board: boardName,
    reporter_socket: socket.id,
    reported_socket: targetSocketId,
    event_id: reporterAdmission.eventId,
  });
  notifyEventModeratorsOfReport(context, {
    reporter: getBoardUser(boardName, socket.id),
    reported: resolved.user,
  });
}

/**
 * Emits the report notification to every moderator on the board.
 *
 * @param {HostedModerationContext} context
 * @param {{reporter: BoardUser | undefined, reported: BoardUser}} users
 * @returns {void}
 */
function notifyEventModeratorsOfReport(context, users) {
  if (!users.reporter) return;
  const payload = {
    reporterName: users.reporter.name,
    reportedName: users.reported.name,
  };
  getBoardUserMap(context.boardName).forEach(function notifyUser(user) {
    const moderatorSocket = context.getActiveSocket(user.socketId);
    if (
      !moderatorSocket ||
      !moderatorSocket.rooms.has(context.boardName) ||
      !canBanOnBoard(context.config, context.boardName, moderatorSocket)
    ) {
      return;
    }
    moderatorSocket.emit(SocketEvents.USER_REPORTED, payload);
  });
}

/**
 * Hosted moderator dispositions: warn, kick, event-scoped ban, and unban,
 * each with a required reason. The disposition is recorded with the actual
 * operator before any real-time effect, and a ban immediately evicts every
 * connection the target account holds on the event.
 *
 * @param {HostedModerationContext & {ack?: (result: unknown) => void}} context
 * @returns {Promise<void>}
 */
async function handleHostedModerationActionMessage(context) {
  const { socket, boardName, message, config, hosted, effects, ack } = context;
  /** @type {(ok: boolean, reason?: string) => void} */
  const settle = (ok, reason) => {
    if (typeof ack === "function")
      ack(ok ? { ok: true } : { ok: false, reason });
  };
  const actorAdmission = socket.hostedEventAdmission;
  if (!hosted || !actorAdmission || !socket.rooms.has(boardName)) {
    setModerationResult("moderation_ignored");
    settle(false, "not_allowed");
    return;
  }
  if (!canBanOnBoard(config, boardName, socket)) {
    setModerationResult("moderation_ignored");
    logger.warn("hosted.moderation_rejected", {
      board: boardName,
      socket: socket.id,
      reason: "not_moderator",
    });
    settle(false, "not_allowed");
    return;
  }
  const raw = /** @type {Record<string, unknown>} */ (
    message !== null && typeof message === "object" ? message : {}
  );
  const action = nonEmptyString(raw.action);
  const reason = normalizeReason(raw.reason);
  if (!DISPOSITION_ACTIONS.has(action)) {
    setModerationResult("moderation_rejected");
    settle(false, "invalid_action");
    return;
  }
  if (reason === "") {
    setModerationResult("moderation_rejected");
    logger.warn("hosted.moderation_rejected", {
      board: boardName,
      socket: socket.id,
      reason: "missing_reason",
      action,
    });
    settle(false, "missing_reason");
    return;
  }
  if (action === ModerationActions.UNBAN) {
    await applyUnban(
      context,
      nonEmptyString(raw.participantId),
      reason,
      settle,
    );
    return;
  }
  const targetSocketId = nonEmptyString(raw.socketId);
  const resolved = targetSocketId
    ? resolveOnlineTarget(context, targetSocketId)
    : null;
  const targetAdmission = resolved?.targetSocket.hostedEventAdmission;
  if (!resolved || !targetAdmission) {
    setModerationResult("moderation_target_not_found");
    settle(false, "target_not_found");
    return;
  }
  if (targetAdmission.accountId === actorAdmission.accountId) {
    setModerationResult("moderation_rejected");
    settle(false, "self_target");
    return;
  }
  if (canBanOnBoard(config, boardName, resolved.targetSocket)) {
    // Governance roles are protected: one moderator never disposes another.
    setModerationResult("moderation_rejected");
    logger.warn("hosted.moderation_rejected", {
      board: boardName,
      socket: socket.id,
      reason: "protected_target",
      action,
    });
    settle(false, "protected_target");
    return;
  }
  const dispositionAction = /** @type {"warn" | "kick" | "ban"} */ (action);
  const applied = await hosted.applyModeration({
    eventId: actorAdmission.eventId,
    action: dispositionAction,
    reason,
    operatorAccountId: actorAdmission.accountId,
    targetAccountId: targetAdmission.accountId,
    targetParticipantId: targetAdmission.participantId,
    targetName: resolved.user.name,
  });
  if (applied.ok === false) {
    setModerationResult("moderation_rejected");
    settle(false, applied.reason);
    return;
  }
  logger.info("hosted.moderation_applied", {
    board: boardName,
    socket: socket.id,
    action,
    event_id: actorAdmission.eventId,
  });
  if (action === ModerationActions.WARN) {
    resolved.targetSocket.emit(SocketEvents.MODERATION_NOTICE, { reason });
  } else if (effects) {
    // Kick and ban both remove every connection the target account holds on
    // this event; a ban additionally blocks re-entry at the admission gate.
    effects.evictEventAccount(
      actorAdmission.eventId,
      targetAdmission.accountId,
      {
        banDurationMs: 0,
        source: action === ModerationActions.BAN ? "event_ban" : "moderator",
      },
    );
  }
  setModerationResult("moderation_applied");
  settle(true);
}

/**
 * Applies an unban resolved by Participant Identifier. The identifier is
 * matched against the event's current bans, so unknown, already-lifted, or
 * foreign identifiers are rejected deterministically.
 *
 * @param {HostedModerationContext & {ack?: (result: unknown) => void}} context
 * @param {string} participantId
 * @param {string} reason
 * @param {(ok: boolean, reason?: string) => void} settle
 * @returns {Promise<void>}
 */
async function applyUnban(context, participantId, reason, settle) {
  const { socket, boardName, hosted } = context;
  if (!hosted) {
    setModerationResult("moderation_ignored");
    settle(false, "not_allowed");
    return;
  }
  const actorAdmission =
    /** @type {NonNullable<AppSocket["hostedEventAdmission"]>} */ (
      socket.hostedEventAdmission
    );
  if (participantId === "") {
    setModerationResult("moderation_rejected");
    settle(false, "missing_target");
    return;
  }
  const bans = await hosted.eventBanSummaries(actorAdmission.eventId);
  const banned = bans.find((entry) => entry.participantId === participantId);
  if (!banned) {
    setModerationResult("moderation_target_not_found");
    logger.warn("hosted.moderation_rejected", {
      board: boardName,
      socket: socket.id,
      reason: "unban_target_not_found",
    });
    settle(false, "target_not_found");
    return;
  }
  const applied = await hosted.applyModeration({
    eventId: actorAdmission.eventId,
    action: ModerationActions.UNBAN,
    reason,
    operatorAccountId: actorAdmission.accountId,
    targetAccountId: banned.accountId,
    targetParticipantId: banned.participantId,
    targetName: banned.name,
  });
  if (applied.ok === false) {
    setModerationResult("moderation_rejected");
    settle(false, applied.reason);
    return;
  }
  logger.info("hosted.moderation_applied", {
    board: boardName,
    socket: socket.id,
    action: ModerationActions.UNBAN,
    event_id: actorAdmission.eventId,
  });
  // A lifted ban never resurrects the revoked membership; evicted sockets
  // stay disconnected until the account is re-admitted through the code.
  setModerationResult("moderation_applied");
  settle(true);
}

/**
 * Serves the event's ban list to a moderator on the board: Participant
 * Identifiers with frozen display names, never emails or Account ids.
 *
 * @param {{socket: AppSocket, boardName: string, config: ServerConfig, hosted?: HostedModerationApi, ack?: (result: unknown) => void}} context
 * @returns {Promise<void>}
 */
async function handleModerationStateMessage(context) {
  const { socket, boardName, config, hosted, ack } = context;
  if (
    !hosted ||
    !socket.hostedEventAdmission ||
    !socket.rooms.has(boardName) ||
    !canBanOnBoard(config, boardName, socket)
  ) {
    if (typeof ack === "function") ack({ banned: [] });
    return;
  }
  const bans = await hosted.eventBanSummaries(
    socket.hostedEventAdmission.eventId,
  );
  if (typeof ack === "function") {
    ack({
      banned: bans.map((ban) => ({
        participantId: ban.participantId,
        name: ban.name,
      })),
    });
  }
}

export {
  handleHostedModerationActionMessage,
  handleHostedReportUserMessage,
  handleModerationStateMessage,
};
