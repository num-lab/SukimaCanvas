import crypto from "node:crypto";

import observability from "../../observability/index.mjs";
import {
  NOTICE_KINDS,
  composeChangeRequestApplied,
  composeChangeRequestRejected,
  composeEventCancelled,
  composeReservationApproved,
  composeReservationRejected,
  composeSessionArchiveFailed,
  composeSessionArchived,
  composeSessionUpcoming,
  composeWebhookSuspended,
} from "./notices.mjs";

const { logger, metrics } = observability;

/**
 * Backoff cap between failed delivery attempts: retries keep pace with the
 * vendor's recovery instead of hammering it.
 */
const MAX_RETRY_BACKOFF_MS = 60 * 60 * 1000;

/**
 * @typedef {{
 *   store: ReturnType<typeof import("./store.mjs").createFileNotificationStore>,
 *   mail: {send: (message: {id?: string, to: string, subject: string, body: string}) => Promise<void>},
 *   accountStore: ReturnType<typeof import("../accounts/store.mjs").createFileAccountStore>,
 *   organizerStore: ReturnType<typeof import("../organizers/store.mjs").createFileOrganizerStore>,
 *   membershipStore: ReturnType<typeof import("../memberships/store.mjs").createFileEventMembershipStore>,
 *   config: Pick<import("../../../types/server-runtime.d.ts").ServerConfig,
 *     "HOSTED_MAIL_RETRY_MS" | "HOSTED_NOTICE_UPCOMING_WINDOW_MS" | "HOSTED_SERVICE_UTC_OFFSET_MINUTES">,
 *   clock?: () => number,
 * }} NotificationServiceDependencies
 */

/**
 * The Hosted Event Service notification service: one durable, idempotent
 * notice queue for account mail and event lifecycle mail, drained by a
 * resumable background pass.
 *
 * Every notice is enqueued with a stable idempotency key derived from its
 * logical identity (the state transition plus the recipient), so retries,
 * duplicate trigger passes, and process restarts never queue or send the same
 * logical notice twice. Delivery is at-least-once under one unavoidable
 * window: a crash between the vendor accepting a message and the sent mark
 * persisting leaves the record pending, and the restart re-delivers it — the
 * shared outbox adapter absorbs that by rewriting the same message file for a
 * given id. Delivery goes through the shared mail adapter; a failed attempt is
 * retried with capped exponential backoff and stays observable on the
 * operator console until it is delivered. Trigger methods fan out to the
 * right audiences — organizer members for reservation and archive outcomes,
 * Event Membership holders for event cancellation and close — and never
 * throw: a notification problem must not fail the state change or the request
 * that reported it.
 *
 * @param {NotificationServiceDependencies} dependencies
 */
function createNotificationService(dependencies) {
  const store = dependencies.store;
  const mail = dependencies.mail;
  const accountStore = dependencies.accountStore;
  const organizerStore = dependencies.organizerStore;
  const membershipStore = dependencies.membershipStore;
  const clock = dependencies.clock || (() => Date.now());
  // Captured once at composition, never re-read per notice.
  const retryBaseMs =
    typeof dependencies.config.HOSTED_MAIL_RETRY_MS === "number" &&
    Number.isFinite(dependencies.config.HOSTED_MAIL_RETRY_MS)
      ? Math.max(0, dependencies.config.HOSTED_MAIL_RETRY_MS)
      : 0;
  const upcomingWindowMs =
    typeof dependencies.config.HOSTED_NOTICE_UPCOMING_WINDOW_MS === "number" &&
    Number.isFinite(dependencies.config.HOSTED_NOTICE_UPCOMING_WINDOW_MS)
      ? Math.max(0, dependencies.config.HOSTED_NOTICE_UPCOMING_WINDOW_MS)
      : 0;
  const offsetMinutes = dependencies.config.HOSTED_SERVICE_UTC_OFFSET_MINUTES;

  /** @type {Promise<{sent: number, failed: number}> | null} */
  let drainTask = null;

  /**
   * The drain is a single-flight pass: overlapping callers (a request kick and
   * the lifecycle poker) coalesce onto the running pass instead of racing, and
   * a caller arriving during a pass waits for it so its own subsequent pass
   * sees a settled state.
   *
   * @param {{now?: number}} [input]
   * @returns {Promise<{sent: number, failed: number}>}
   */
  async function runDueSends(input = {}) {
    while (drainTask) {
      await drainTask.catch(() => {});
    }
    drainTask = drainPass(input);
    try {
      return await drainTask;
    } finally {
      drainTask = null;
    }
  }

  /**
   * Delivers every due notice, oldest first. One failed attempt records its
   * clamped error and a backed-off next attempt; it never stops the pass and
   * never throws — the drain runs detached from requests and the close
   * pipeline, so it has no caller to fail.
   *
   * @param {{now?: number}} input
   * @returns {Promise<{sent: number, failed: number}>}
   */
  async function drainPass(input) {
    /** @type {{sent: number, failed: number}} */
    const outcome = { sent: 0, failed: 0 };
    try {
      const now = typeof input.now === "number" ? input.now : clock();
      const due = store.listDue({ now });
      for (const notice of due) {
        try {
          await mail.send({
            id: notice.notificationId,
            to: notice.to,
            subject: notice.subject,
            body: notice.body,
          });
          await store.markSent({
            notificationId: notice.notificationId,
            sentAtMs: clock(),
          });
          outcome.sent += 1;
          metrics.recordNoticeDelivery("sent", notice.kind);
          logger.info("hosted.notice_sent", {
            notice_id: notice.notificationId,
            kind: notice.kind,
          });
        } catch (error) {
          const nextAttemptAtMs =
            now + backoffMs(notice.attempts + 1, retryBaseMs);
          outcome.failed += 1;
          metrics.recordNoticeDelivery("failed", notice.kind);
          logger.error("hosted.notice_send_failed", {
            notice_id: notice.notificationId,
            kind: notice.kind,
            error,
          });
          await store
            .markFailed({
              notificationId: notice.notificationId,
              message: error instanceof Error ? error.message : String(error),
              nextAttemptAtMs,
            })
            .catch((recordError) => {
              logger.error("hosted.notice_failure_record_failed", {
                notice_id: notice.notificationId,
                error: recordError,
              });
            });
        }
      }
    } catch (error) {
      logger.error("hosted.notice_drain_failed", { error });
    }
    return outcome;
  }

  /**
   * Capped exponential backoff before the next delivery attempt: the base
   * config delay doubles with each recorded failure. A base of zero retries
   * on the next pass.
   *
   * @param {number} failedAttempts failures recorded so far, including this one
   * @param {number} baseMs
   * @returns {number}
   */
  function backoffMs(failedAttempts, baseMs) {
    if (baseMs <= 0) return 0;
    return Math.min(MAX_RETRY_BACKOFF_MS, baseMs * 2 ** (failedAttempts - 1));
  }

  /**
   * @param {string} kind
   * @param {unknown} error
   * @returns {void}
   */
  function logFanoutFailure(kind, error) {
    logger.error("hosted.notice_fanout_failed", { kind, error });
  }

  /**
   * Kicks one drain pass detached from the caller. Enqueue already made the
   * notice durable, so delivery can happen entirely in the background — a
   * slow or failing vendor never blocks the request that queued the notice.
   *
   * @returns {void}
   */
  function kickDrain() {
    runDueSends().catch((error) => {
      logger.error("hosted.notice_drain_failed", { error });
    });
  }

  /**
   * Queues one composed notice per recipient in a single durable write, then
   * kicks a detached drain. The notification id derives from the logical
   * trigger plus the recipient account, which is exactly the identity that
   * must never be delivered twice. Never throws: a notice problem must not
   * fail the state change or request that reported it.
   *
   * @param {{
   *   kind: string,
   *   key: string,
   *   audience: "organizer" | "participant",
   *   recipients: {accountId: string, email: string}[],
   *   composed: {subject: string, body: string},
   * }} input
   * @returns {Promise<void>}
   */
  async function fanOut(input) {
    try {
      if (input.recipients.length === 0) return;
      const { created } = await store.enqueueMany(
        input.recipients.map((recipient) => ({
          notificationId: `${input.key}:${input.audience}:${recipient.accountId}`,
          kind: input.kind,
          to: recipient.email,
          subject: input.composed.subject,
          body: input.composed.body,
        })),
      );
      // A duplicate trigger pass enqueued nothing new, so no drain is needed.
      if (created > 0) kickDrain();
    } catch (error) {
      logFanoutFailure(input.kind, error);
    }
  }

  /**
   * Resolves accounts to deliverable recipients: active, with an email.
   *
   * @param {string[]} accountIds
   * @returns {{accountId: string, email: string}[]}
   */
  function resolveActiveRecipients(accountIds) {
    /** @type {{accountId: string, email: string}[]} */
    const recipients = [];
    for (const accountId of accountIds) {
      const account = accountStore.getAccountById(accountId);
      if (!account || account.status !== "active" || account.email === "") {
        continue;
      }
      recipients.push({ accountId: account.accountId, email: account.email });
    }
    return recipients;
  }

  /**
   * @param {string} organizerId
   * @returns {{accountId: string, email: string}[]}
   */
  function organizerMemberRecipients(organizerId) {
    return resolveActiveRecipients(
      organizerStore.listMembers(organizerId).map((member) => member.accountId),
    );
  }

  /**
   * Owner-only recipients, for notices whose subject matter — like a
   * suspended webhook's signing configuration — is an Owner concern.
   *
   * @param {string} organizerId
   * @returns {{accountId: string, email: string}[]}
   */
  function organizerOwnerRecipients(organizerId) {
    return resolveActiveRecipients(
      organizerStore
        .listRolesForOrganizer(organizerId)
        .filter((role) => role.role === "owner")
        .map((role) => role.accountId),
    );
  }

  /**
   * Only accounts holding an Event Membership for the event are reachable:
   * there is deliberately no way to address anyone who never established one.
   *
   * @param {string} eventId
   * @returns {{accountId: string, email: string}[]}
   */
  function participantRecipients(eventId) {
    return resolveActiveRecipients(
      membershipStore
        .listMembershipsForEvent(eventId)
        .map((membership) => membership.accountId),
    );
  }

  /**
   * Queues a composed account mail (verification, password reset). The
   * subject and body are composed by the account route in the request's
   * language and contain the single-use link; they are never logged here.
   * Each issuance carries a fresh one-time credential, so it is its own
   * logical notice and gets a fresh id; the queue's state machine still makes
   * each record exactly-once from enqueue to delivery.
   *
   * @param {{
   *   kind: string,
   *   to: string,
   *   subject: string,
   *   body: string,
   * }} input
   * @returns {Promise<void>}
   */
  async function queueAccountMail(input) {
    await store.enqueue({
      notificationId: `account-${crypto.randomBytes(8).toString("hex")}`,
      kind: input.kind,
      to: input.to,
      subject: input.subject,
      body: input.body,
    });
    kickDrain();
  }

  /**
   * Reservation approved: the organizer's members learn their event is
   * confirmed, with its schedule.
   *
   * @param {{
   *   reservationId: string,
   *   organizerId: string,
   *   eventName: string,
   *   startsAtMs: number,
   *   seats: number,
   * }} input
   * @returns {Promise<void>}
   */
  async function onReservationApproved(input) {
    await fanOut({
      kind: NOTICE_KINDS.RESERVATION_APPROVED,
      key: `reservation-approved:${input.reservationId}`,
      audience: "organizer",
      recipients: organizerMemberRecipients(input.organizerId),
      composed: composeReservationApproved({
        eventName: input.eventName,
        startsAtMs: input.startsAtMs,
        seats: input.seats,
        offsetMinutes,
      }),
    });
  }

  /**
   * Reservation rejected: the organizer's members learn the decision; the
   * console carries any operator note.
   *
   * @param {{reservationId: string, organizerId: string, eventName: string}} input
   * @returns {Promise<void>}
   */
  async function onReservationRejected(input) {
    await fanOut({
      kind: NOTICE_KINDS.RESERVATION_REJECTED,
      key: `reservation-rejected:${input.reservationId}`,
      audience: "organizer",
      recipients: organizerMemberRecipients(input.organizerId),
      composed: composeReservationRejected({ eventName: input.eventName }),
    });
  }

  /**
   * An amend Change Request was approved and applied: the organizer's members
   * learn the new schedule.
   *
   * @param {{
   *   changeRequestId: string,
   *   organizerId: string,
   *   eventName: string,
   *   startsAtMs: number,
   *   seats: number,
   * }} input
   * @returns {Promise<void>}
   */
  async function onChangeRequestApplied(input) {
    await fanOut({
      kind: NOTICE_KINDS.CHANGE_REQUEST_APPLIED,
      key: `change-applied:${input.changeRequestId}`,
      audience: "organizer",
      recipients: organizerMemberRecipients(input.organizerId),
      composed: composeChangeRequestApplied({
        eventName: input.eventName,
        startsAtMs: input.startsAtMs,
        seats: input.seats,
        offsetMinutes,
      }),
    });
  }

  /**
   * An amend Change Request was rejected: the event keeps its schedule.
   *
   * @param {{changeRequestId: string, organizerId: string, eventName: string}} input
   * @returns {Promise<void>}
   */
  async function onChangeRequestRejected(input) {
    await fanOut({
      kind: NOTICE_KINDS.CHANGE_REQUEST_REJECTED,
      key: `change-rejected:${input.changeRequestId}`,
      audience: "organizer",
      recipients: organizerMemberRecipients(input.organizerId),
      composed: composeChangeRequestRejected({ eventName: input.eventName }),
    });
  }

  /**
   * An approved event was cancelled: organizer members and every participant
   * holding an Event Membership learn the event is off. Accounts without a
   * membership — including unadmitted Access Code holders — are unreachable
   * by design.
   *
   * @param {{
   *   eventId: string,
   *   organizerId: string,
   *   eventName: string,
   *   startsAtMs: number,
   * }} input
   * @returns {Promise<void>}
   */
  async function onEventCancelled(input) {
    const composed = {
      organizer: composeEventCancelled({
        eventName: input.eventName,
        startsAtMs: input.startsAtMs,
        audience: "organizer",
        offsetMinutes,
      }),
      participant: composeEventCancelled({
        eventName: input.eventName,
        startsAtMs: input.startsAtMs,
        audience: "participant",
        offsetMinutes,
      }),
    };
    await fanOut({
      kind: NOTICE_KINDS.EVENT_CANCELLED,
      key: `event-cancelled:${input.eventId}`,
      audience: "organizer",
      recipients: organizerMemberRecipients(input.organizerId),
      composed: composed.organizer,
    });
    await fanOut({
      kind: NOTICE_KINDS.EVENT_CANCELLED,
      key: `event-cancelled:${input.eventId}`,
      audience: "participant",
      recipients: participantRecipients(input.eventId),
      composed: composed.participant,
    });
  }

  /**
   * A scheduled Board Session is about to start: the organizer's members get
   * one heads-up per session, inside the configured window before the start.
   *
   * @param {{now: number, windowMs?: number}} input
   * @returns {Promise<void>}
   */
  async function noticeUpcomingSessions(input) {
    const windowMs =
      typeof input.windowMs === "number" ? input.windowMs : upcomingWindowMs;
    if (windowMs <= 0) return;
    try {
      const sessions = organizerStore.listBoardSessionsStartingWithin({
        now: input.now,
        windowMs,
      });
      for (const session of sessions) {
        const event = organizerStore.getEventById(session.eventId);
        if (!event) continue;
        await fanOut({
          kind: NOTICE_KINDS.SESSION_UPCOMING,
          key: `session-upcoming:${session.boardSessionId}`,
          audience: "organizer",
          recipients: organizerMemberRecipients(session.organizerId),
          composed: composeSessionUpcoming({
            eventName: event.name,
            startsAtMs: session.startsAtMs,
            offsetMinutes,
          }),
        });
      }
    } catch (error) {
      logFanoutFailure(NOTICE_KINDS.SESSION_UPCOMING, error);
    }
  }

  /**
   * A Board Session sealed closed behind its Private Board Archive: organizer
   * members get the archive outcome, and the event's members learn the event
   * has ended.
   *
   * @param {{
   *   boardSessionId: string,
   *   eventId: string,
   *   organizerId: string,
   *   eventName: string,
   * }} input
   * @returns {Promise<void>}
   */
  async function onSessionArchived(input) {
    await fanOut({
      kind: NOTICE_KINDS.SESSION_ARCHIVED,
      key: `session-archived:${input.boardSessionId}`,
      audience: "organizer",
      recipients: organizerMemberRecipients(input.organizerId),
      composed: composeSessionArchived({
        eventName: input.eventName,
        audience: "organizer",
      }),
    });
    await fanOut({
      kind: NOTICE_KINDS.SESSION_ARCHIVED,
      key: `session-archived:${input.boardSessionId}`,
      audience: "participant",
      recipients: participantRecipients(input.eventId),
      composed: composeSessionArchived({
        eventName: input.eventName,
        audience: "participant",
      }),
    });
  }

  /**
   * A Board Session entered the durable ARCHIVE_FAILED state (first failure
   * of the episode only, so retry backoff cannot turn into a mail storm): the
   * organizer's members learn recovery is pending, with the classified
   * reason.
   *
   * @param {{
   *   boardSessionId: string,
   *   eventId: string,
   *   organizerId: string,
   *   eventName: string,
   *   failureCode: string,
   * }} input
   * @returns {Promise<void>}
   */
  async function onSessionArchiveFailed(input) {
    await fanOut({
      kind: NOTICE_KINDS.SESSION_ARCHIVE_FAILED,
      key: `session-archive-failed:${input.boardSessionId}`,
      audience: "organizer",
      recipients: organizerMemberRecipients(input.organizerId),
      composed: composeSessionArchiveFailed({
        eventName: input.eventName,
        failureCode: input.failureCode,
      }),
    });
  }

  /**
   * Notices waiting for a retry — the operator console's observable delivery
   * state.
   *
   * @returns {ReturnType<typeof store.listRetrying>}
   */
  function listRetrying() {
    return store.listRetrying();
  }

  /**
   * A webhook subscription was suspended after its deliveries kept failing
   * for the give-up window. Owner-only: the signing configuration is an
   * Owner concern. The key includes the suspension timestamp, so a resume ->
   * re-suspend episode notifies again while a double pass does not.
   *
   * @param {{
   *   organizerId: string,
   *   subscriptionId: string,
   *   endpointHost: string,
   *   suspendedAtMs?: number,
   * }} input
   * @returns {Promise<void>}
   */
  async function onWebhookSubscriptionSuspended(input) {
    const suspendedAtMs =
      typeof input.suspendedAtMs === "number"
        ? input.suspendedAtMs
        : clock();
    await fanOut({
      kind: NOTICE_KINDS.WEBHOOK_SUSPENDED,
      key: `webhook-suspended:${input.subscriptionId}:${suspendedAtMs}`,
      audience: "organizer",
      recipients: organizerOwnerRecipients(input.organizerId),
      composed: composeWebhookSuspended({
        endpointHost: input.endpointHost,
        suspendedAtMs,
        offsetMinutes,
      }),
    });
  }

  return {
    queueAccountMail,
    onReservationApproved,
    onReservationRejected,
    onChangeRequestApplied,
    onChangeRequestRejected,
    onEventCancelled,
    noticeUpcomingSessions,
    onSessionArchived,
    onSessionArchiveFailed,
    onWebhookSubscriptionSuspended,
    runDueSends,
    listRetrying,
  };
}

export { createNotificationService };

/**
 * The composed notification service surface shared by the route modules, the
 * archive pipeline, and the hosted module.
 *
 * @typedef {ReturnType<typeof createNotificationService>} NotificationService
 */
