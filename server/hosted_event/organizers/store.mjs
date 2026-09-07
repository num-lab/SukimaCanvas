import crypto from "node:crypto";

import observability from "../../observability/index.mjs";
import {
  digestAccessCode,
  generateAccessCode,
  normalizeAccessCode,
} from "../memberships/access_codes.mjs";
import { createFileStateDocuments } from "../storage/documents.mjs";

const { logger } = observability;

const STORE_FORMAT_VERSION = 1;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * An unguessable, non-enumerable Event Public ID for public service URLs. 16
 * base64url characters (96 bits of entropy) — internal reservation and board
 * session identifiers never appear in public URLs.
 *
 * @returns {string}
 */
function randomPublicEventId() {
  return crypto.randomBytes(12).toString("base64url");
}

/**
 * The WBO board name behind an event's Board Session: an `event-` prefixed,
 * lowercase hex encoding of 12 random bytes (96 bits). It is a second public,
 * unguessable identifier — distinct from the internal Board Session id — and
 * stays a valid board name (lowercase letters, digits, single dashes), so it
 * can flow through board-name normalization untouched.
 *
 * @returns {string}
 */
function randomEventBoardName() {
  return `event-${crypto.randomBytes(12).toString("hex")}`;
}

/** Application field bounds; the route validates first, the store clamps defensively. */
const MAX_ORGANIZER_NAME_LENGTH = 120;
const MAX_CONTACT_NAME_LENGTH = 120;
const MAX_CONTACT_EMAIL_LENGTH = 254;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_OPERATOR_NOTE_LENGTH = 2000;
/** Public-facing event tagline shown on the discovery card and event page. */
const MAX_EVENT_TAGLINE_LENGTH = 280;

/**
 * The lifecycle state of an approved event's board session derived from the
 * service clock: upcoming before its start, live between start and end, and
 * ended afterward. Discovery only surfaces events that are not yet ended.
 *
 * @param {{startsAtMs: number, endsAtMs: number}} event
 * @param {number} now
 * @returns {EventLifecycleState}
 */
function eventLifecycleState(event, now) {
  if (now < event.startsAtMs) return "scheduled";
  if (now < event.endsAtMs) return "open";
  return "ended";
}

/** @typedef {"owner" | "admin"} MemberRole */

/**
 * @typedef {"pending" | "approved" | "rejected"} ApplicationStatus
 */
/**
 * @typedef {{
 *   applicationId: string,
 *   accountId: string,
 *   organizerName: string,
 *   contactName: string,
 *   contactEmail: string,
 *   description: string,
 *   status: ApplicationStatus,
 *   createdAtMs: number,
 *   decidedAtMs: number | null,
 *   decidedByAccountId: string | null,
 *   operatorNote: string | null,
 *   organizerId: string | null,
 * }} StoredApplication
 */
/**
 * @typedef {{
 *   organizerId: string,
 *   name: string,
 *   createdAtMs: number,
 *   createdFromApplicationId: string,
 * }} StoredOrganizer
 */
/**
 * @typedef {{
 *   organizerId: string,
 *   accountId: string,
 *   role: MemberRole,
 *   grantedAtMs: number,
 * }} StoredRole
 */
/**
 * @typedef {"pending" | "accepted" | "revoked" | "declined"} InvitationStatus
 */
/**
 * @typedef {{
 *   invitationId: string,
 *   organizerId: string,
 *   email: string,
 *   role: MemberRole,
 *   status: InvitationStatus,
 *   invitedByAccountId: string,
 *   createdAtMs: number,
 *   expiresAtMs: number,
 *   acceptedByAccountId: string | null,
 *   acceptedAtMs: number | null,
 * }} StoredInvitation
 */
/**
 * @typedef {"draft" | "submitted" | "approved" | "rejected" | "cancelled"} ReservationStatus
 */
/**
 * @typedef {{
 *   reservationId: string,
 *   organizerId: string,
 *   eventName: string,
 *   description: string,
 *   visibility: "public" | "unlisted",
 *   startsAtMs: number,
 *   endsAtMs: number,
 *   requestedSeats: number,
 *   status: ReservationStatus,
 *   createdByAccountId: string,
 *   createdAtMs: number,
 *   submittedAtMs: number | null,
 *   decidedAtMs: number | null,
 *   decidedByAccountId: string | null,
 *   operatorNote: string | null,
 *   eventId: string | null,
 * }} StoredReservation
 */
/**
 * @typedef {{
 *   eventId: string,
 *   publicId: string,
 *   boardName: string,
 *   reservationId: string,
 *   organizerId: string,
 *   name: string,
 *   visibility: "public" | "unlisted",
 *   tagline: string,
 *   coverAssetId: string | null,
 *   status: "active" | "cancelled",
 *   startsAtMs: number,
 *   endsAtMs: number,
 *   createdAtMs: number,
 *   accessCodeDigest: string | null,
 *   accessCodeSetAtMs: number | null,
 *   entryLocked: boolean,
 *   entryLockedAtMs: number | null,
 *   outcomeDeletion: StoredEventOutcomeDeletion | null,
 *   outcomePurgeFailure: StoredOutcomePurgeFailure | null,
 * }} StoredEvent
 */
/**
 * An Owner/Admin's early deletion of an event's outcomes, inside its
 * recoverable window: the request immediately invalidates the Published
 * Canvas and every Image Export download link, and when `purgeAtMs` elapses
 * the retention pipeline purges the Private Board Archive, Item Attribution,
 * Change Audit, and associated exports. Restoring the request inside the
 * window removes the record entirely; after the purge completes
 * `purgedAtMs` stays as the durable marker of what happened.
 *
 * @typedef {{
 *   requestedAtMs: number,
 *   requestedByAccountId: string,
 *   purgeAtMs: number,
 *   purgedAtMs: number | null,
 * }} StoredEventOutcomeDeletion
 */
/**
 * The durable failure context of an event's last failed outcome purge, kept
 * on the event so it is visible on the organizer event console and the
 * operator console and retried after its backoff. Cleared when a purge
 * finally succeeds.
 *
 * @typedef {{
 *   code: string,
 *   message: string,
 *   attempts: number,
 *   firstFailedAtMs: number,
 *   lastFailedAtMs: number,
 * }} StoredOutcomePurgeFailure
 */
/**
 * @typedef {"scheduled" | "open" | "ended"} EventLifecycleState
 */
/**
 * The authoritative Board Session lifecycle advanced by durable background work.
 * `scheduled` before the event's start, `open` while it runs, `closing` while
 * accepted writes drain, `closed` once the session is sealed behind a Private
 * Board Archive, and `cancelled` when a future event is withdrawn. A close
 * attempt that cannot validate the final sequence or persist the archive moves
 * the session to `archive_failed`: it admits no writes, shows no archived
 * result, and stays there — visible and recoverable — until a retry (the
 * pipeline's automatic backoff or an authorized Platform Operator) succeeds
 * and seals it `closed`. `closed` and `cancelled` are terminal: a closed
 * session can never be re-edited or reopened, and further creation needs a new
 * Board Session.
 *
 * @typedef {"scheduled" | "open" | "closing" | "archive_failed" | "closed" | "cancelled"} BoardSessionStatus
 */
/**
 * The durable failure context of a Board Session waiting for its archive: why
 * the last close attempt failed (`code` is a deterministic failure code and
 * `message` the internal detail — both are operator-console material and never
 * render on organizer or participant surfaces), how many attempts have failed
 * so far, and when the first and latest failures happened. Cleared when a
 * retry finally seals the session.
 *
 * @typedef {{
 *   code: string,
 *   message: string,
 *   attempts: number,
 *   firstFailedAtMs: number,
 *   lastFailedAtMs: number,
 * }} StoredBoardSessionArchiveFailure
 */
/**
 * @typedef {{
 *   boardSessionId: string,
 *   eventId: string,
 *   reservationId: string,
 *   organizerId: string,
 *   status: BoardSessionStatus,
 *   seats: number,
 *   startsAtMs: number,
 *   endsAtMs: number,
 *   windowStartMs: number,
 *   windowEndMs: number,
 *   createdAtMs: number,
 *   openedAtMs: number | null,
 *   closingAtMs: number | null,
 *   closedAtMs: number | null,
 *   cancelledAtMs: number | null,
 *   archiveKey: string | null,
 *   archivedAtMs: number | null,
 *   archivedFinalSeq: number | null,
 *   archiveFailure: StoredBoardSessionArchiveFailure | null,
 *   outcomesPurgedAtMs: number | null,
 * }} StoredBoardSession
 */
/**
 * @typedef {"amend" | "cancel"} ChangeRequestKind
 */
/**
 * @typedef {"pending" | "applied" | "rejected"} ChangeRequestStatus
 */
/**
 * @typedef {{
 *   changeRequestId: string,
 *   reservationId: string,
 *   organizerId: string,
 *   kind: ChangeRequestKind,
 *   proposedStartsAtMs: number | null,
 *   proposedEndsAtMs: number | null,
 *   proposedSeats: number | null,
 *   status: ChangeRequestStatus,
 *   requestedByAccountId: string,
 *   createdAtMs: number,
 *   decidedAtMs: number | null,
 *   decidedByAccountId: string | null,
 *   operatorNote: string | null,
 * }} StoredChangeRequest
 */
/**
 * @typedef {{
 *   recordId: string,
 *   createdAtMs: number,
 *   actorAccountId: string,
 *   actorKind: "account" | "operator" | "system",
 *   action: string,
 *   subjectType: string,
 *   subjectId: string,
 *   organizerId: string | null,
 * }} StoredAuditRecord
 */
/**
 * A per-event realtime governance grant. An Event Moderator may enter the
 * event's Board Session during the Preparation Window and while it is open
 * and act on reports there, but holds no organizer membership, console
 * access, or authority over any other event.
 *
 * @typedef {{
 *   eventId: string,
 *   organizerId: string,
 *   accountId: string,
 *   grantedAtMs: number,
 *   grantedByAccountId: string,
 * }} StoredEventModerator
 */

/**
 * Computes the peak concurrent Board Session count and Participant Seat total
 * within a candidate capacity window, including the candidate itself. The
 * active count only rises at an allocation's start, so evaluating every start
 * point inside the window (plus the window's own start) finds both peaks.
 *
 * @param {number} windowStartMs
 * @param {number} windowEndMs
 * @param {number} seats
 * @param {{windowStartMs: number, windowEndMs: number, seats: number}[]} allocations
 * @returns {{maxSessions: number, maxSeats: number}}
 */
function computeCapacityPeak(windowStartMs, windowEndMs, seats, allocations) {
  const overlapping = allocations.filter(
    (a) => a.windowStartMs < windowEndMs && windowStartMs < a.windowEndMs,
  );
  const points = [windowStartMs];
  for (const a of overlapping) {
    if (a.windowStartMs >= windowStartMs && a.windowStartMs < windowEndMs) {
      points.push(a.windowStartMs);
    }
  }
  let maxSessions = 0;
  let maxSeats = 0;
  for (const t of points) {
    let sessions = 1;
    let total = seats;
    for (const a of overlapping) {
      if (a.windowStartMs <= t && t < a.windowEndMs) {
        sessions += 1;
        total += a.seats;
      }
    }
    if (sessions > maxSessions) maxSessions = sessions;
    if (total > maxSeats) maxSeats = total;
  }
  return { maxSessions, maxSeats };
}

/**
 * Durable storage for Organizer Applications, Organizers, their role grants,
 * and the Change Audit of administrative actions.
 *
 * Like the account store, reads come from an in-memory index loaded on first
 * use and every mutation is appended to a serialized queue that replaces the
 * store's state documents through the selected adapter. State-machine
 * transitions (submit,
 * approve, reject) run their check-and-mutate synchronously before yielding, so
 * concurrent approvals cannot create a second Organizer or duplicate roles.
 *
 * @param {{
 *   dataDir: string,
 *   clock?: () => number,
 *   randomId?: () => string,
 *   invitationTtlMs?: number,
 *   stateDocuments?: import("../storage/documents.mjs").StateDocuments,
 * }} options
 */
function createFileOrganizerStore(options) {
  const dataDir = options.dataDir;
  const stateDocuments =
    options.stateDocuments || createFileStateDocuments({ dataDir });
  const clock = options.clock || (() => Date.now());
  const randomId = options.randomId || (() => crypto.randomUUID());
  const invitationTtlMs =
    typeof options.invitationTtlMs === "number" &&
    Number.isFinite(options.invitationTtlMs) &&
    options.invitationTtlMs > 0
      ? options.invitationTtlMs
      : INVITATION_TTL_MS;

  /** @type {Map<string, StoredApplication>} */
  const applicationsById = new Map();
  /** @type {Map<string, string[]>} */
  const applicationIdsByAccount = new Map();
  /** @type {Map<string, StoredOrganizer>} */
  const organizersById = new Map();
  /** @type {Map<string, StoredRole>} */
  const rolesByKey = new Map();
  /** @type {Map<string, StoredInvitation>} */
  const invitationsById = new Map();
  /** @type {Map<string, StoredReservation>} */
  const reservationsById = new Map();
  /** @type {Map<string, StoredEvent>} */
  const eventsById = new Map();
  /** @type {Map<string, string>} */
  const eventIdsByPublicId = new Map();
  /** @type {Map<string, string>} */
  const eventIdsByBoardName = new Map();
  /** @type {Map<string, StoredBoardSession>} */
  const boardSessionsById = new Map();
  /** @type {Map<string, StoredChangeRequest>} */
  const changeRequestsById = new Map();
  /** @type {Map<string, StoredEventModerator>} */
  const eventModeratorsByKey = new Map();
  /** @type {StoredAuditRecord[]} */
  const auditRecords = [];
  let loaded = false;
  let writeQueue = Promise.resolve();

  const APPLICATIONS_FILE = "organizer_applications.json";
  const ORGANIZERS_FILE = "organizers.json";
  const ROLES_FILE = "organizer_roles.json";
  const INVITATIONS_FILE = "organizer_invitations.json";
  const RESERVATIONS_FILE = "reservations.json";
  const EVENTS_FILE = "events.json";
  const BOARD_SESSIONS_FILE = "board_sessions.json";
  const CHANGE_REQUESTS_FILE = "reservation_change_requests.json";
  const EVENT_MODERATORS_FILE = "event_moderators.json";
  const AUDIT_FILE = "change_audit.json";

  /**
   * @param {string} organizerId
   * @param {string} accountId
   * @returns {string}
   */
  function roleKey(organizerId, accountId) {
    return `${organizerId}:${accountId}`;
  }

  /**
   * @param {string} eventId
   * @param {string} accountId
   * @returns {string}
   */
  function eventModeratorKey(eventId, accountId) {
    return `${eventId}:${accountId}`;
  }

  /**
   * Backfills the lifecycle fields added in issue 08 onto a Board Session loaded
   * from an older on-disk record, so state loads without a migration. Runs after
   * events are indexed, so the event supplies the authoritative start/end.
   *
   * @param {StoredBoardSession} session
   * @returns {void}
   */
  function hydrateBoardSession(session) {
    const event = eventsById.get(session.eventId);
    if (typeof session.startsAtMs !== "number") {
      session.startsAtMs = event ? event.startsAtMs : session.windowStartMs;
    }
    if (typeof session.endsAtMs !== "number") {
      session.endsAtMs = event ? event.endsAtMs : session.windowEndMs;
    }
    if (session.openedAtMs === undefined) session.openedAtMs = null;
    if (session.closingAtMs === undefined) session.closingAtMs = null;
    if (session.closedAtMs === undefined) session.closedAtMs = null;
    if (session.cancelledAtMs === undefined) session.cancelledAtMs = null;
    if (session.archiveKey === undefined) session.archiveKey = null;
    if (session.archivedAtMs === undefined) session.archivedAtMs = null;
    if (session.archivedFinalSeq === undefined) {
      session.archivedFinalSeq = null;
    }
    if (session.archiveFailure === undefined) session.archiveFailure = null;
    if (session.outcomesPurgedAtMs === undefined) {
      session.outcomesPurgedAtMs = null;
    }
  }

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    const applications = readStoreFile(APPLICATIONS_FILE, { applications: [] });
    for (const application of /** @type {StoredApplication[]} */ (
      applications.applications || []
    )) {
      applicationsById.set(application.applicationId, application);
      const list = applicationIdsByAccount.get(application.accountId) || [];
      list.push(application.applicationId);
      applicationIdsByAccount.set(application.accountId, list);
    }
    // Preserve submission order for each account so "current" is deterministic.
    for (const list of applicationIdsByAccount.values()) {
      list.sort((left, right) => {
        const leftApp = applicationsById.get(left);
        const rightApp = applicationsById.get(right);
        return (leftApp?.createdAtMs || 0) - (rightApp?.createdAtMs || 0);
      });
    }
    const organizers = readStoreFile(ORGANIZERS_FILE, { organizers: [] });
    for (const organizer of /** @type {StoredOrganizer[]} */ (
      organizers.organizers || []
    )) {
      organizersById.set(organizer.organizerId, organizer);
    }
    const roles = readStoreFile(ROLES_FILE, { roles: [] });
    for (const role of /** @type {StoredRole[]} */ (roles.roles || [])) {
      rolesByKey.set(roleKey(role.organizerId, role.accountId), role);
    }
    const invitations = readStoreFile(INVITATIONS_FILE, { invitations: [] });
    for (const invitation of /** @type {StoredInvitation[]} */ (
      invitations.invitations || []
    )) {
      invitationsById.set(invitation.invitationId, invitation);
    }
    const reservations = readStoreFile(RESERVATIONS_FILE, { reservations: [] });
    for (const reservation of /** @type {StoredReservation[]} */ (
      reservations.reservations || []
    )) {
      reservationsById.set(reservation.reservationId, reservation);
    }
    const events = readStoreFile(EVENTS_FILE, { events: [] });
    for (const event of /** @type {StoredEvent[]} */ (events.events || [])) {
      // Display and status fields were added after the first events were minted;
      // default them so older records load without a migration.
      if (typeof event.tagline !== "string") event.tagline = "";
      if (event.coverAssetId === undefined) event.coverAssetId = null;
      if (event.status !== "cancelled") event.status = "active";
      if (event.accessCodeDigest === undefined) {
        event.accessCodeDigest = null;
      }
      if (event.accessCodeSetAtMs === undefined) {
        event.accessCodeSetAtMs = null;
      }
      if (typeof event.entryLocked !== "boolean") event.entryLocked = false;
      if (event.entryLockedAtMs === undefined) event.entryLockedAtMs = null;
      if (typeof event.boardName !== "string" || event.boardName === "") {
        event.boardName = randomEventBoardName();
      }
      if (event.outcomeDeletion === undefined) event.outcomeDeletion = null;
      if (event.outcomePurgeFailure === undefined) {
        event.outcomePurgeFailure = null;
      }
      eventsById.set(event.eventId, event);
      eventIdsByPublicId.set(event.publicId, event.eventId);
      eventIdsByBoardName.set(event.boardName, event.eventId);
    }
    const boardSessions = readStoreFile(BOARD_SESSIONS_FILE, {
      boardSessions: [],
    });
    for (const boardSession of /** @type {StoredBoardSession[]} */ (
      boardSessions.boardSessions || []
    )) {
      hydrateBoardSession(boardSession);
      boardSessionsById.set(boardSession.boardSessionId, boardSession);
    }
    const changeRequests = readStoreFile(CHANGE_REQUESTS_FILE, {
      changeRequests: [],
    });
    for (const changeRequest of /** @type {StoredChangeRequest[]} */ (
      changeRequests.changeRequests || []
    )) {
      changeRequestsById.set(changeRequest.changeRequestId, changeRequest);
    }
    const audit = readStoreFile(AUDIT_FILE, { records: [] });
    for (const record of /** @type {StoredAuditRecord[]} */ (
      audit.records || []
    )) {
      auditRecords.push(record);
    }
    const eventModerators = readStoreFile(EVENT_MODERATORS_FILE, {
      moderators: [],
    });
    for (const moderator of /** @type {StoredEventModerator[]} */ (
      eventModerators.moderators || []
    )) {
      eventModeratorsByKey.set(
        eventModeratorKey(moderator.eventId, moderator.accountId),
        moderator,
      );
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
        `Unsupported hosted organizer store format in ${filePath}`,
      );
    }
    return parsed;
  }

  /**
   * Appends one persistence task to the serialized write queue. The caller
   * observes failures of its own task; the chain itself stays alive so a single
   * failed write cannot poison later ones.
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
        logger.error("hosted_organizer_store.write_failed", { error });
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
        key: APPLICATIONS_FILE,
        payload: {
          version: STORE_FORMAT_VERSION,
          applications: [...applicationsById.values()],
        },
      },
      {
        key: ORGANIZERS_FILE,
        payload: {
          version: STORE_FORMAT_VERSION,
          organizers: [...organizersById.values()],
        },
      },
      {
        key: ROLES_FILE,
        payload: {
          version: STORE_FORMAT_VERSION,
          roles: [...rolesByKey.values()],
        },
      },
      {
        key: INVITATIONS_FILE,
        payload: {
          version: STORE_FORMAT_VERSION,
          invitations: [...invitationsById.values()],
        },
      },
      {
        key: RESERVATIONS_FILE,
        payload: {
          version: STORE_FORMAT_VERSION,
          reservations: [...reservationsById.values()],
        },
      },
      {
        key: EVENTS_FILE,
        payload: {
          version: STORE_FORMAT_VERSION,
          events: [...eventsById.values()],
        },
      },
      {
        key: BOARD_SESSIONS_FILE,
        payload: {
          version: STORE_FORMAT_VERSION,
          boardSessions: [...boardSessionsById.values()],
        },
      },
      {
        key: CHANGE_REQUESTS_FILE,
        payload: {
          version: STORE_FORMAT_VERSION,
          changeRequests: [...changeRequestsById.values()],
        },
      },
      {
        key: EVENT_MODERATORS_FILE,
        payload: {
          version: STORE_FORMAT_VERSION,
          moderators: [...eventModeratorsByKey.values()],
        },
      },
      {
        key: AUDIT_FILE,
        payload: { version: STORE_FORMAT_VERSION, records: auditRecords },
      },
    ]);
  }

  /**
   * @param {string} value
   * @param {number} maxLength
   * @returns {string}
   */
  function clampString(value, maxLength) {
    return String(value == null ? "" : value)
      .trim()
      .slice(0, maxLength);
  }

  /**
   * Appends one Change Audit record for an administrative action. In-memory
   * only until the enclosing mutation persists.
   *
   * @param {{
   *   actorAccountId: string,
   *   actorKind: "account" | "operator" | "system",
   *   action: string,
   *   subjectType: string,
   *   subjectId: string,
   *   organizerId?: string | null,
   * }} input
   * @returns {void}
   */
  function recordAudit(input) {
    auditRecords.push({
      recordId: randomId(),
      createdAtMs: clock(),
      actorAccountId: input.actorAccountId,
      actorKind: input.actorKind,
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      organizerId: input.organizerId ?? null,
    });
  }

  /**
   * Returns the account's most recent application, or null.
   *
   * @param {string} accountId
   * @returns {StoredApplication | null}
   */
  function currentApplicationFor(accountId) {
    const list = applicationIdsByAccount.get(accountId);
    if (!list || list.length === 0) return null;
    const newestId = list[list.length - 1];
    return (newestId && applicationsById.get(newestId)) || null;
  }

  /**
   * Submits a new Organizer Application for a verified account. Only an account
   * whose most recent application was rejected (or who has none) may apply, so a
   * repeat submission while one is under review — or after one was already
   * approved — is refused deterministically without creating a conflicting
   * application or a duplicate Organizer.
   *
   * @param {{
   *   accountId: string,
   *   organizerName: string,
   *   contactName: string,
   *   contactEmail: string,
   *   description?: string,
   * }} input
   * @returns {Promise<{ok: true, application: StoredApplication} | {ok: false, reason: "already_pending" | "already_approved"}>}
   */
  async function submitApplication(input) {
    ensureLoaded();
    const accountId = String(input.accountId || "");
    if (accountId === "")
      throw new Error("submitApplication requires accountId");
    const existing = currentApplicationFor(accountId);
    if (existing && existing.status === "pending") {
      return { ok: false, reason: "already_pending" };
    }
    if (existing && existing.status === "approved") {
      return { ok: false, reason: "already_approved" };
    }
    /** @type {StoredApplication} */
    const application = {
      applicationId: randomId(),
      accountId,
      organizerName: clampString(
        input.organizerName,
        MAX_ORGANIZER_NAME_LENGTH,
      ),
      contactName: clampString(input.contactName, MAX_CONTACT_NAME_LENGTH),
      contactEmail: clampString(input.contactEmail, MAX_CONTACT_EMAIL_LENGTH),
      description: clampString(input.description || "", MAX_DESCRIPTION_LENGTH),
      status: "pending",
      createdAtMs: clock(),
      decidedAtMs: null,
      decidedByAccountId: null,
      operatorNote: null,
      organizerId: null,
    };
    applicationsById.set(application.applicationId, application);
    const list = applicationIdsByAccount.get(accountId) || [];
    list.push(application.applicationId);
    applicationIdsByAccount.set(accountId, list);
    recordAudit({
      actorAccountId: accountId,
      actorKind: "account",
      action: "organizer_application.submitted",
      subjectType: "organizer_application",
      subjectId: application.applicationId,
    });
    await enqueueWrite(persistNow);
    return { ok: true, application };
  }

  /**
   * The applicant-facing projection of their current application: it never
   * exposes the operator-only note or the deciding operator's identity.
   *
   * @param {string} accountId
   * @returns {{
   *   applicationId: string,
   *   status: ApplicationStatus,
   *   organizerName: string,
   *   contactName: string,
   *   contactEmail: string,
   *   description: string,
   *   createdAtMs: number,
   *   decidedAtMs: number | null,
   *   organizerId: string | null,
   * } | null}
   */
  function getApplicantView(accountId) {
    ensureLoaded();
    const application = currentApplicationFor(String(accountId || ""));
    if (!application) return null;
    return {
      applicationId: application.applicationId,
      status: application.status,
      organizerName: application.organizerName,
      contactName: application.contactName,
      contactEmail: application.contactEmail,
      description: application.description,
      createdAtMs: application.createdAtMs,
      decidedAtMs: application.decidedAtMs,
      organizerId: application.organizerId,
    };
  }

  /**
   * The pending review queue, oldest submission first.
   *
   * @returns {StoredApplication[]}
   */
  function listPendingApplications() {
    ensureLoaded();
    return [...applicationsById.values()]
      .filter((application) => application.status === "pending")
      .sort((left, right) => left.createdAtMs - right.createdAtMs);
  }

  /**
   * @param {string} applicationId
   * @returns {StoredApplication | null}
   */
  function getApplicationById(applicationId) {
    ensureLoaded();
    if (typeof applicationId !== "string" || applicationId === "") return null;
    return applicationsById.get(applicationId) || null;
  }

  /**
   * Approves a pending application: atomically creates the Organizer, grants
   * the applicant Organizer Owner, and marks the application approved. The
   * check-and-mutate is synchronous, so a concurrent second approval sees a
   * non-pending status and creates nothing.
   *
   * @param {{applicationId: string, operatorAccountId: string}} input
   * @returns {Promise<{ok: true, organizerId: string} | {ok: false, reason: "not_found" | "not_pending"}>}
   */
  async function approveApplication(input) {
    ensureLoaded();
    const application = applicationsById.get(String(input.applicationId || ""));
    if (!application) return { ok: false, reason: "not_found" };
    if (application.status !== "pending") {
      return { ok: false, reason: "not_pending" };
    }
    const operatorAccountId = String(input.operatorAccountId || "");
    const now = clock();
    const organizerId = randomId();
    organizersById.set(organizerId, {
      organizerId,
      name: application.organizerName,
      createdAtMs: now,
      createdFromApplicationId: application.applicationId,
    });
    rolesByKey.set(roleKey(organizerId, application.accountId), {
      organizerId,
      accountId: application.accountId,
      role: "owner",
      grantedAtMs: now,
    });
    application.status = "approved";
    application.decidedAtMs = now;
    application.decidedByAccountId = operatorAccountId;
    application.organizerId = organizerId;
    recordAudit({
      actorAccountId: operatorAccountId,
      actorKind: "operator",
      action: "organizer_application.approved",
      subjectType: "organizer_application",
      subjectId: application.applicationId,
      organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true, organizerId };
  }

  /**
   * Rejects a pending application, recording an operator-only note that is
   * never shown to the applicant.
   *
   * @param {{applicationId: string, operatorAccountId: string, note?: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found" | "not_pending"}>}
   */
  async function rejectApplication(input) {
    ensureLoaded();
    const application = applicationsById.get(String(input.applicationId || ""));
    if (!application) return { ok: false, reason: "not_found" };
    if (application.status !== "pending") {
      return { ok: false, reason: "not_pending" };
    }
    const operatorAccountId = String(input.operatorAccountId || "");
    application.status = "rejected";
    application.decidedAtMs = clock();
    application.decidedByAccountId = operatorAccountId;
    application.operatorNote = clampString(
      input.note || "",
      MAX_OPERATOR_NOTE_LENGTH,
    );
    recordAudit({
      actorAccountId: operatorAccountId,
      actorKind: "operator",
      action: "organizer_application.rejected",
      subjectType: "organizer_application",
      subjectId: application.applicationId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * Change Audit records for one application, oldest first.
   *
   * @param {string} applicationId
   * @returns {StoredAuditRecord[]}
   */
  function listAuditForApplication(applicationId) {
    ensureLoaded();
    return auditRecords
      .filter(
        (record) =>
          record.subjectType === "organizer_application" &&
          record.subjectId === applicationId,
      )
      .sort((left, right) => left.createdAtMs - right.createdAtMs);
  }

  /**
   * @param {string} organizerId
   * @returns {StoredOrganizer | null}
   */
  function getOrganizerById(organizerId) {
    ensureLoaded();
    if (typeof organizerId !== "string" || organizerId === "") return null;
    return organizersById.get(organizerId) || null;
  }

  /**
   * @param {string} organizerId
   * @returns {StoredRole[]}
   */
  function listRolesForOrganizer(organizerId) {
    ensureLoaded();
    return [...rolesByKey.values()].filter(
      (role) => role.organizerId === organizerId,
    );
  }

  /**
   * @param {string} accountId
   * @returns {StoredRole[]}
   */
  function listRolesForAccount(accountId) {
    ensureLoaded();
    return [...rolesByKey.values()].filter(
      (role) => role.accountId === accountId,
    );
  }

  // --- membership & role management ----------------------------------------

  /**
   * The role an account holds in an organizer, or null if it is not a member.
   *
   * @param {string} organizerId
   * @param {string} accountId
   * @returns {MemberRole | null}
   */
  function getMemberRole(organizerId, accountId) {
    ensureLoaded();
    return rolesByKey.get(roleKey(organizerId, accountId))?.role ?? null;
  }

  /**
   * @param {string} organizerId
   * @returns {number}
   */
  function countOwners(organizerId) {
    let owners = 0;
    for (const role of rolesByKey.values()) {
      if (role.organizerId === organizerId && role.role === "owner")
        owners += 1;
    }
    return owners;
  }

  /**
   * Members of an organizer, owners first then by grant time.
   *
   * @param {string} organizerId
   * @returns {StoredRole[]}
   */
  function listMembers(organizerId) {
    ensureLoaded();
    return [...rolesByKey.values()]
      .filter((role) => role.organizerId === organizerId)
      .sort((left, right) => {
        if (left.role !== right.role) return left.role === "owner" ? -1 : 1;
        return left.grantedAtMs - right.grantedAtMs;
      });
  }

  /**
   * Organizers the account belongs to, with the account's role in each.
   *
   * @param {string} accountId
   * @returns {{organizerId: string, name: string, role: MemberRole}[]}
   */
  function listOrganizersForAccount(accountId) {
    ensureLoaded();
    return [...rolesByKey.values()]
      .filter((role) => role.accountId === accountId)
      .map((role) => ({
        organizerId: role.organizerId,
        name: organizersById.get(role.organizerId)?.name || "",
        role: role.role,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * Every provisioned Organizer, oldest first. This is an operator-console
   * selection surface (e.g. the Historical Archive import target list); it is
   * never exposed to organizer or participant pages.
   *
   * @returns {{organizerId: string, name: string}[]}
   */
  function listOrganizers() {
    ensureLoaded();
    return [...organizersById.values()]
      .sort((left, right) => left.createdAtMs - right.createdAtMs)
      .map((organizer) => ({
        organizerId: organizer.organizerId,
        name: organizer.name,
      }));
  }

  /**
   * Changes an existing member's role. Owner-only in the route layer; the store
   * refuses to demote the last remaining Owner so an organizer can never be left
   * with no one able to manage it.
   *
   * @param {{organizerId: string, targetAccountId: string, newRole: MemberRole, actorAccountId: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_member" | "last_owner" | "invalid_role"}>}
   */
  async function changeMemberRole(input) {
    ensureLoaded();
    const { organizerId, targetAccountId, newRole, actorAccountId } = input;
    if (newRole !== "owner" && newRole !== "admin") {
      return { ok: false, reason: "invalid_role" };
    }
    const key = roleKey(organizerId, targetAccountId);
    const role = rolesByKey.get(key);
    if (!role) return { ok: false, reason: "not_member" };
    if (role.role === newRole) return { ok: true };
    if (
      role.role === "owner" &&
      newRole === "admin" &&
      countOwners(organizerId) <= 1
    ) {
      return { ok: false, reason: "last_owner" };
    }
    role.role = newRole;
    recordAudit({
      actorAccountId: String(actorAccountId || ""),
      actorKind: "account",
      action: "organizer_member.role_changed",
      subjectType: "organizer_member",
      subjectId: targetAccountId,
      organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * Removes a member from an organizer. Owner-only in the route layer; the last
   * remaining Owner cannot be removed. Historical Change Audit and attribution
   * are left intact.
   *
   * @param {{organizerId: string, targetAccountId: string, actorAccountId: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_member" | "last_owner"}>}
   */
  async function removeMember(input) {
    ensureLoaded();
    const { organizerId, targetAccountId, actorAccountId } = input;
    const key = roleKey(organizerId, targetAccountId);
    const role = rolesByKey.get(key);
    if (!role) return { ok: false, reason: "not_member" };
    if (role.role === "owner" && countOwners(organizerId) <= 1) {
      return { ok: false, reason: "last_owner" };
    }
    rolesByKey.delete(key);
    recordAudit({
      actorAccountId: String(actorAccountId || ""),
      actorKind: "account",
      action: "organizer_member.removed",
      subjectType: "organizer_member",
      subjectId: targetAccountId,
      organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  // --- invitations ---------------------------------------------------------

  /**
   * @param {StoredInvitation} invitation
   * @param {number} now
   * @returns {boolean}
   */
  function isRedeemable(invitation, now) {
    return invitation.status === "pending" && invitation.expiresAtMs > now;
  }

  /**
   * Creates a 7-day Organizer Invitation for a target email. Refuses to invite
   * an email that already belongs to a member, or to stack a second live
   * invitation for the same email in the same organizer.
   *
   * @param {{organizerId: string, email: string, role: MemberRole, invitedByAccountId: string, memberAccountId?: string | null}} input
   * @returns {Promise<{ok: true, invitation: StoredInvitation} | {ok: false, reason: "invalid_role" | "already_member" | "already_invited"}>}
   */
  async function createInvitation(input) {
    ensureLoaded();
    const { organizerId, role, invitedByAccountId } = input;
    const email = String(input.email || "")
      .trim()
      .toLowerCase()
      .slice(0, MAX_CONTACT_EMAIL_LENGTH);
    if (role !== "owner" && role !== "admin") {
      return { ok: false, reason: "invalid_role" };
    }
    // If the invitee already has an account and is already a member, there is
    // nothing to invite them to.
    if (
      input.memberAccountId &&
      rolesByKey.has(roleKey(organizerId, input.memberAccountId))
    ) {
      return { ok: false, reason: "already_member" };
    }
    const now = clock();
    for (const invitation of invitationsById.values()) {
      if (
        invitation.organizerId === organizerId &&
        invitation.email === email &&
        isRedeemable(invitation, now)
      ) {
        return { ok: false, reason: "already_invited" };
      }
    }
    /** @type {StoredInvitation} */
    const invitation = {
      invitationId: randomId(),
      organizerId,
      email,
      role,
      status: "pending",
      invitedByAccountId: String(invitedByAccountId || ""),
      createdAtMs: now,
      expiresAtMs: now + invitationTtlMs,
      acceptedByAccountId: null,
      acceptedAtMs: null,
    };
    invitationsById.set(invitation.invitationId, invitation);
    recordAudit({
      actorAccountId: invitation.invitedByAccountId,
      actorKind: "account",
      action: "organizer_invitation.created",
      subjectType: "organizer_invitation",
      subjectId: invitation.invitationId,
      organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true, invitation };
  }

  /**
   * @param {string} invitationId
   * @returns {StoredInvitation | null}
   */
  function getInvitationById(invitationId) {
    ensureLoaded();
    if (typeof invitationId !== "string" || invitationId === "") return null;
    return invitationsById.get(invitationId) || null;
  }

  /**
   * Live (pending, unexpired) invitations for an organizer, oldest first.
   *
   * @param {string} organizerId
   * @returns {StoredInvitation[]}
   */
  function listInvitationsForOrganizer(organizerId) {
    ensureLoaded();
    const now = clock();
    return [...invitationsById.values()]
      .filter(
        (invitation) =>
          invitation.organizerId === organizerId &&
          isRedeemable(invitation, now),
      )
      .sort((left, right) => left.createdAtMs - right.createdAtMs);
  }

  /**
   * Live invitations addressed to an email, with the organizer name resolved,
   * for the invitee's console. Never exposes organizers the account has no
   * invitation to.
   *
   * @param {string} email
   * @returns {{invitationId: string, organizerId: string, organizerName: string, role: MemberRole, expiresAtMs: number}[]}
   */
  function listPendingInvitationsForEmail(email) {
    ensureLoaded();
    const now = clock();
    const normalized = String(email || "")
      .trim()
      .toLowerCase();
    if (normalized === "") return [];
    return [...invitationsById.values()]
      .filter(
        (invitation) =>
          invitation.email === normalized && isRedeemable(invitation, now),
      )
      .sort((left, right) => left.createdAtMs - right.createdAtMs)
      .map((invitation) => ({
        invitationId: invitation.invitationId,
        organizerId: invitation.organizerId,
        organizerName: organizersById.get(invitation.organizerId)?.name || "",
        role: invitation.role,
        expiresAtMs: invitation.expiresAtMs,
      }));
  }

  /**
   * Accepts an invitation. Only the account whose verified email matches the
   * invitation may accept, and only while it is still pending and unexpired.
   * The check-and-consume is synchronous, so concurrent accepts establish
   * membership exactly once. Invalid, expired, revoked, used, and
   * wrong-recipient invitations all fail identically so nothing about other
   * organizers leaks.
   *
   * @param {{invitationId: string, accountId: string, accountEmail: string}} input
   * @returns {Promise<{ok: true, organizerId: string, role: MemberRole} | {ok: false, reason: "invalid"}>}
   */
  async function acceptInvitation(input) {
    ensureLoaded();
    const invitation = invitationsById.get(String(input.invitationId || ""));
    const accountEmail = String(input.accountEmail || "")
      .trim()
      .toLowerCase();
    const now = clock();
    if (
      !invitation ||
      !isRedeemable(invitation, now) ||
      invitation.email !== accountEmail
    ) {
      return { ok: false, reason: "invalid" };
    }
    const accountId = String(input.accountId || "");
    invitation.status = "accepted";
    invitation.acceptedByAccountId = accountId;
    invitation.acceptedAtMs = now;
    // Establishing membership never downgrades an existing role: if the account
    // already holds a role (gained through another path since the invite), keep
    // it and report the real role rather than the invitation's.
    const key = roleKey(invitation.organizerId, accountId);
    const existingRole = rolesByKey.get(key);
    if (!existingRole) {
      rolesByKey.set(key, {
        organizerId: invitation.organizerId,
        accountId,
        role: invitation.role,
        grantedAtMs: now,
      });
    }
    recordAudit({
      actorAccountId: accountId,
      actorKind: "account",
      action: "organizer_invitation.accepted",
      subjectType: "organizer_invitation",
      subjectId: invitation.invitationId,
      organizerId: invitation.organizerId,
    });
    await enqueueWrite(persistNow);
    return {
      ok: true,
      organizerId: invitation.organizerId,
      role: existingRole ? existingRole.role : invitation.role,
    };
  }

  /**
   * Declines an invitation. Only the target account may decline, and only a
   * still-live invitation.
   *
   * @param {{invitationId: string, accountId: string, accountEmail: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "invalid"}>}
   */
  async function declineInvitation(input) {
    ensureLoaded();
    const invitation = invitationsById.get(String(input.invitationId || ""));
    const accountEmail = String(input.accountEmail || "")
      .trim()
      .toLowerCase();
    if (
      !invitation ||
      !isRedeemable(invitation, clock()) ||
      invitation.email !== accountEmail
    ) {
      return { ok: false, reason: "invalid" };
    }
    invitation.status = "declined";
    recordAudit({
      actorAccountId: String(input.accountId || ""),
      actorKind: "account",
      action: "organizer_invitation.declined",
      subjectType: "organizer_invitation",
      subjectId: invitation.invitationId,
      organizerId: invitation.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * Revokes a still-live invitation. Owner-only in the route layer.
   *
   * @param {{invitationId: string, actorAccountId: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "invalid"}>}
   */
  async function revokeInvitation(input) {
    ensureLoaded();
    const invitation = invitationsById.get(String(input.invitationId || ""));
    if (!invitation || invitation.status !== "pending") {
      return { ok: false, reason: "invalid" };
    }
    invitation.status = "revoked";
    recordAudit({
      actorAccountId: String(input.actorAccountId || ""),
      actorKind: "account",
      action: "organizer_invitation.revoked",
      subjectType: "organizer_invitation",
      subjectId: invitation.invitationId,
      organizerId: invitation.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * Change Audit records scoped to one organizer, oldest first.
   *
   * @param {string} organizerId
   * @returns {StoredAuditRecord[]}
   */
  function listAuditForOrganizer(organizerId) {
    ensureLoaded();
    return auditRecords
      .filter((record) => record.organizerId === organizerId)
      .sort((left, right) => left.createdAtMs - right.createdAtMs);
  }

  // --- reservations, events, board sessions & capacity ---------------------

  /**
   * @param {number} value
   * @param {number} fallback
   * @returns {number}
   */
  function integerOr(value, fallback) {
    return Number.isInteger(value) ? value : fallback;
  }

  /**
   * Creates a DRAFT reservation. Field legality (time ordering, seat range) is
   * validated by the route for per-field feedback; the store clamps strings and
   * coerces numbers defensively.
   *
   * @param {{
   *   organizerId: string,
   *   createdByAccountId: string,
   *   eventName: string,
   *   description?: string,
   *   visibility: "public" | "unlisted",
   *   startsAtMs: number,
   *   endsAtMs: number,
   *   requestedSeats: number,
   * }} input
   * @returns {Promise<{ok: true, reservation: StoredReservation}>}
   */
  async function createReservation(input) {
    ensureLoaded();
    /** @type {StoredReservation} */
    const reservation = {
      reservationId: randomId(),
      organizerId: String(input.organizerId || ""),
      eventName: clampString(input.eventName, MAX_ORGANIZER_NAME_LENGTH),
      description: clampString(input.description || "", MAX_DESCRIPTION_LENGTH),
      visibility: input.visibility === "public" ? "public" : "unlisted",
      startsAtMs: integerOr(input.startsAtMs, 0),
      endsAtMs: integerOr(input.endsAtMs, 0),
      requestedSeats: integerOr(input.requestedSeats, 0),
      status: "draft",
      createdByAccountId: String(input.createdByAccountId || ""),
      createdAtMs: clock(),
      submittedAtMs: null,
      decidedAtMs: null,
      decidedByAccountId: null,
      operatorNote: null,
      eventId: null,
    };
    reservationsById.set(reservation.reservationId, reservation);
    recordAudit({
      actorAccountId: reservation.createdByAccountId,
      actorKind: "account",
      action: "reservation.created",
      subjectType: "reservation",
      subjectId: reservation.reservationId,
      organizerId: reservation.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true, reservation };
  }

  /**
   * Overwrites the editable fields of a DRAFT reservation. Submitted or decided
   * reservations reject direct edits (they change only through a Change
   * Request).
   *
   * @param {{
   *   reservationId: string,
   *   eventName: string,
   *   description?: string,
   *   visibility: "public" | "unlisted",
   *   startsAtMs: number,
   *   endsAtMs: number,
   *   requestedSeats: number,
   * }} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found" | "not_draft"}>}
   */
  async function updateReservation(input) {
    ensureLoaded();
    const reservation = reservationsById.get(String(input.reservationId || ""));
    if (!reservation) return { ok: false, reason: "not_found" };
    if (reservation.status !== "draft") {
      return { ok: false, reason: "not_draft" };
    }
    reservation.eventName = clampString(
      input.eventName,
      MAX_ORGANIZER_NAME_LENGTH,
    );
    reservation.description = clampString(
      input.description || "",
      MAX_DESCRIPTION_LENGTH,
    );
    reservation.visibility =
      input.visibility === "public" ? "public" : "unlisted";
    reservation.startsAtMs = integerOr(input.startsAtMs, 0);
    reservation.endsAtMs = integerOr(input.endsAtMs, 0);
    reservation.requestedSeats = integerOr(input.requestedSeats, 0);
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * Transitions a DRAFT to SUBMITTED. Only a legal draft with a future start
   * may submit; after submission the approval-affecting fields are frozen.
   *
   * @param {{reservationId: string, actorAccountId: string, now: number}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found" | "not_draft" | "past_start"}>}
   */
  async function submitReservation(input) {
    ensureLoaded();
    const reservation = reservationsById.get(String(input.reservationId || ""));
    if (!reservation) return { ok: false, reason: "not_found" };
    if (reservation.status !== "draft") {
      return { ok: false, reason: "not_draft" };
    }
    if (reservation.startsAtMs <= input.now) {
      return { ok: false, reason: "past_start" };
    }
    reservation.status = "submitted";
    reservation.submittedAtMs = clock();
    recordAudit({
      actorAccountId: String(input.actorAccountId || ""),
      actorKind: "account",
      action: "reservation.submitted",
      subjectType: "reservation",
      subjectId: reservation.reservationId,
      organizerId: reservation.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * Cancels a DRAFT or SUBMITTED reservation (a withdrawal). Approved
   * reservations are cancelled through the change/cancel workstream, not here.
   *
   * @param {{reservationId: string, actorAccountId: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found" | "not_cancellable"}>}
   */
  async function cancelReservation(input) {
    ensureLoaded();
    const reservation = reservationsById.get(String(input.reservationId || ""));
    if (!reservation) return { ok: false, reason: "not_found" };
    if (reservation.status !== "draft" && reservation.status !== "submitted") {
      return { ok: false, reason: "not_cancellable" };
    }
    reservation.status = "cancelled";
    recordAudit({
      actorAccountId: String(input.actorAccountId || ""),
      actorKind: "account",
      action: "reservation.cancelled",
      subjectType: "reservation",
      subjectId: reservation.reservationId,
      organizerId: reservation.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * The capacity window of a reservation: the buffer before its start to the
   * buffer after its end.
   *
   * @param {StoredReservation} reservation
   * @param {number} bufferMs
   * @returns {{windowStartMs: number, windowEndMs: number}}
   */
  function reservationWindow(reservation, bufferMs) {
    return {
      windowStartMs: reservation.startsAtMs - bufferMs,
      windowEndMs: reservation.endsAtMs + bufferMs,
    };
  }

  /**
   * Live Capacity Allocations: the windows and seats held by every Board
   * Session that still commits capacity. A cancelled session has released its
   * future capacity and no longer counts; `excludeBoardSessionId` drops the
   * session being re-planned so an in-place change is measured against the rest.
   *
   * @param {string} [excludeBoardSessionId]
   * @returns {{windowStartMs: number, windowEndMs: number, seats: number}[]}
   */
  function activeAllocations(excludeBoardSessionId) {
    return [...boardSessionsById.values()]
      .filter(
        (session) =>
          session.status !== "cancelled" &&
          session.boardSessionId !== excludeBoardSessionId,
      )
      .map((session) => ({
        windowStartMs: session.windowStartMs,
        windowEndMs: session.windowEndMs,
        seats: session.seats,
      }));
  }

  /**
   * Peak Capacity Allocation impact if a submitted reservation were approved
   * now, for the operator console. Includes the reservation itself.
   *
   * @param {{reservationId: string, bufferMs: number, sessionLimit: number, seatLimit: number}} input
   * @returns {{maxSessions: number, maxSeats: number, sessionLimit: number, seatLimit: number, wouldExceed: boolean} | null}
   */
  function capacityImpact(input) {
    ensureLoaded();
    const reservation = reservationsById.get(String(input.reservationId || ""));
    if (!reservation) return null;
    const window = reservationWindow(reservation, input.bufferMs);
    const peak = computeCapacityPeak(
      window.windowStartMs,
      window.windowEndMs,
      reservation.requestedSeats,
      activeAllocations(),
    );
    return {
      maxSessions: peak.maxSessions,
      maxSeats: peak.maxSeats,
      sessionLimit: input.sessionLimit,
      seatLimit: input.seatLimit,
      wouldExceed:
        peak.maxSessions > input.sessionLimit ||
        peak.maxSeats > input.seatLimit,
    };
  }

  /**
   * Approves a SUBMITTED reservation: checks Capacity Allocation against the
   * concurrent limits and, if it fits, atomically mints an unguessable Event
   * Public ID, creates the Event and its scheduled Board Session, and marks the
   * reservation approved. The check-and-commit is synchronous, so concurrent
   * approvals can never oversell or partially approve.
   *
   * @param {{reservationId: string, operatorAccountId: string, now: number, bufferMs: number, sessionLimit: number, seatLimit: number}} input
   * @returns {Promise<{ok: true, publicId: string, eventId: string} | {ok: false, reason: "not_found" | "not_submitted" | "past_start" | "capacity", maxSessions?: number, maxSeats?: number}>}
   */
  async function approveReservation(input) {
    ensureLoaded();
    const reservation = reservationsById.get(String(input.reservationId || ""));
    if (!reservation) return { ok: false, reason: "not_found" };
    if (reservation.status !== "submitted") {
      return { ok: false, reason: "not_submitted" };
    }
    // A reservation whose start has passed since submission cannot be approved
    // into the past.
    if (reservation.startsAtMs <= input.now) {
      return { ok: false, reason: "past_start" };
    }
    const window = reservationWindow(reservation, input.bufferMs);
    const peak = computeCapacityPeak(
      window.windowStartMs,
      window.windowEndMs,
      reservation.requestedSeats,
      activeAllocations(),
    );
    if (
      peak.maxSessions > input.sessionLimit ||
      peak.maxSeats > input.seatLimit
    ) {
      return {
        ok: false,
        reason: "capacity",
        maxSessions: peak.maxSessions,
        maxSeats: peak.maxSeats,
      };
    }
    const now = clock();
    const eventId = randomId();
    let publicId = randomPublicEventId();
    while (eventIdsByPublicId.has(publicId)) publicId = randomPublicEventId();
    let boardName = randomEventBoardName();
    while (eventIdsByBoardName.has(boardName)) {
      boardName = randomEventBoardName();
    }
    const boardSessionId = randomId();
    eventsById.set(eventId, {
      eventId,
      publicId,
      boardName,
      reservationId: reservation.reservationId,
      organizerId: reservation.organizerId,
      name: reservation.eventName,
      visibility: reservation.visibility,
      tagline: "",
      coverAssetId: null,
      status: "active",
      startsAtMs: reservation.startsAtMs,
      endsAtMs: reservation.endsAtMs,
      createdAtMs: now,
      // The shared Access Code is minted on demand by the managing
      // Owner/Admin so its raw value is revealed exactly once; until then no
      // code exists and none can be guessed.
      accessCodeDigest: null,
      accessCodeSetAtMs: null,
      entryLocked: false,
      entryLockedAtMs: null,
      outcomeDeletion: null,
      outcomePurgeFailure: null,
    });
    eventIdsByPublicId.set(publicId, eventId);
    eventIdsByBoardName.set(boardName, eventId);
    boardSessionsById.set(boardSessionId, {
      boardSessionId,
      eventId,
      reservationId: reservation.reservationId,
      organizerId: reservation.organizerId,
      status: "scheduled",
      seats: reservation.requestedSeats,
      startsAtMs: reservation.startsAtMs,
      endsAtMs: reservation.endsAtMs,
      windowStartMs: window.windowStartMs,
      windowEndMs: window.windowEndMs,
      createdAtMs: now,
      openedAtMs: null,
      closingAtMs: null,
      closedAtMs: null,
      cancelledAtMs: null,
      archiveKey: null,
      archivedAtMs: null,
      archivedFinalSeq: null,
      archiveFailure: null,
      outcomesPurgedAtMs: null,
    });
    reservation.status = "approved";
    reservation.decidedAtMs = now;
    reservation.decidedByAccountId = String(input.operatorAccountId || "");
    reservation.eventId = eventId;
    recordAudit({
      actorAccountId: String(input.operatorAccountId || ""),
      actorKind: "operator",
      action: "reservation.approved",
      subjectType: "reservation",
      subjectId: reservation.reservationId,
      organizerId: reservation.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true, publicId, eventId };
  }

  /**
   * Rejects a SUBMITTED reservation with an operator-only note.
   *
   * @param {{reservationId: string, operatorAccountId: string, note?: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found" | "not_submitted"}>}
   */
  async function rejectReservation(input) {
    ensureLoaded();
    const reservation = reservationsById.get(String(input.reservationId || ""));
    if (!reservation) return { ok: false, reason: "not_found" };
    if (reservation.status !== "submitted") {
      return { ok: false, reason: "not_submitted" };
    }
    reservation.status = "rejected";
    reservation.decidedAtMs = clock();
    reservation.decidedByAccountId = String(input.operatorAccountId || "");
    reservation.operatorNote = clampString(
      input.note || "",
      MAX_OPERATOR_NOTE_LENGTH,
    );
    recordAudit({
      actorAccountId: String(input.operatorAccountId || ""),
      actorKind: "operator",
      action: "reservation.rejected",
      subjectType: "reservation",
      subjectId: reservation.reservationId,
      organizerId: reservation.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  // --- board session lifecycle & reservation change requests ---------------

  /**
   * @param {string} reservationId
   * @returns {StoredBoardSession | null}
   */
  function boardSessionByReservationId(reservationId) {
    for (const session of boardSessionsById.values()) {
      if (session.reservationId === reservationId) return session;
    }
    return null;
  }

  /**
   * The Board Session backing an approved reservation, or null.
   *
   * @param {string} reservationId
   * @returns {StoredBoardSession | null}
   */
  function getBoardSessionForReservation(reservationId) {
    ensureLoaded();
    return boardSessionByReservationId(String(reservationId || ""));
  }

  /**
   * Durable, idempotent lifecycle advancement — the authoritative background
   * work that moves Board Sessions forward, not an in-process timer. Each
   * non-terminal session is advanced to the state its own start/end times imply
   * at `now`: `scheduled → open` at start and `open → closing` at end. The
   * `closing → closed` seal is deliberately NOT a time transition: it happens
   * only after the close pipeline drained accepted writes, validated the final
   * sequence, and archived the board, so a failed or unfinished archive never
   * masquerades as a closed session. Every transition is guarded by the
   * current status, so running the same `now` twice (or catching up after a
   * restart that skipped the exact moment) never double-transitions or
   * produces a contradictory state. Returns the transitions applied so callers
   * can log observable lifecycle progress.
   *
   * @param {{now: number, closeDrainMs?: number}} input
   * @returns {Promise<{boardSessionId: string, from: BoardSessionStatus, to: BoardSessionStatus}[]>}
   */
  async function advanceLifecycle(input) {
    ensureLoaded();
    const now = input.now;
    /** @type {{boardSessionId: string, from: BoardSessionStatus, to: BoardSessionStatus}[]} */
    const transitions = [];
    for (const session of boardSessionsById.values()) {
      // Advance this session as far as `now` allows; the loop lets a long outage
      // catch up through several boundaries in one pass.
      while (true) {
        const from = session.status;
        /** @type {BoardSessionStatus | null} */
        let to = null;
        if (from === "scheduled" && now >= session.startsAtMs) to = "open";
        else if (from === "open" && now >= session.endsAtMs) to = "closing";
        if (!to) break;
        session.status = to;
        if (to === "open") session.openedAtMs = now;
        else if (to === "closing") session.closingAtMs = now;
        recordAudit({
          actorAccountId: "",
          actorKind: "system",
          action: `board_session.${to}`,
          subjectType: "board_session",
          subjectId: session.boardSessionId,
          organizerId: session.organizerId,
        });
        transitions.push({ boardSessionId: session.boardSessionId, from, to });
      }
    }
    if (transitions.length > 0) await enqueueWrite(persistNow);
    return transitions;
  }

  /**
   * Board Sessions the close pipeline should attempt now, joined with the
   * event board name the pipeline needs to reach the board: sessions still in
   * their `closing` drain window whose drain has elapsed, and `archive_failed`
   * sessions whose automatic retry backoff has elapsed. The list is a work
   * queue read, not a mutation: it never changes state, so concurrent close
   * attempts stay guarded by the store's own status transitions.
   *
   * @param {{now: number, closeDrainMs?: number, archiveRetryMs?: number}} input
   * @returns {{boardSessionId: string, eventId: string, organizerId: string, boardName: string}[]}
   */
  function listBoardSessionsDueToClose(input) {
    ensureLoaded();
    const now = input.now;
    const closeDrainMs =
      typeof input.closeDrainMs === "number" &&
      Number.isFinite(input.closeDrainMs)
        ? Math.max(0, input.closeDrainMs)
        : 0;
    const archiveRetryMs =
      typeof input.archiveRetryMs === "number" &&
      Number.isFinite(input.archiveRetryMs)
        ? Math.max(0, input.archiveRetryMs)
        : 0;
    /** @type {{boardSessionId: string, eventId: string, organizerId: string, boardName: string}[]} */
    const due = [];
    for (const session of boardSessionsById.values()) {
      if (session.status === "closing") {
        if (session.archiveKey !== null) continue;
        if (now < session.endsAtMs + closeDrainMs) continue;
      } else if (session.status === "archive_failed") {
        // Automatic recovery: a failed archive retries after its backoff, so
        // a transient storage fault heals without human toil. A backoff of
        // zero disables the automatic retry entirely; an authorized operator
        // retry resets the session to `closing` instead and never waits.
        const failure = session.archiveFailure;
        if (!failure || archiveRetryMs <= 0) continue;
        if (now < failure.lastFailedAtMs + archiveRetryMs) continue;
      } else {
        continue;
      }
      const event = eventsById.get(session.eventId);
      if (!event) continue;
      due.push({
        boardSessionId: session.boardSessionId,
        eventId: session.eventId,
        organizerId: session.organizerId,
        boardName: event.boardName,
      });
    }
    return due;
  }

  /**
   * Board Sessions whose scheduled start falls inside the notice window
   * ahead of `now` — the upcoming-start work queue read for lifecycle
   * notices. Like the close work queue this is a read, not a mutation:
   * idempotent notice keys, not this list, keep repeats from double-sending.
   *
   * @param {{now: number, windowMs: number}} input
   * @returns {{boardSessionId: string, eventId: string, organizerId: string, startsAtMs: number}[]}
   */
  function listBoardSessionsStartingWithin(input) {
    ensureLoaded();
    const now = input.now;
    const windowMs =
      typeof input.windowMs === "number" && Number.isFinite(input.windowMs)
        ? Math.max(0, input.windowMs)
        : 0;
    /** @type {{boardSessionId: string, eventId: string, organizerId: string, startsAtMs: number}[]} */
    const due = [];
    if (windowMs <= 0) return due;
    for (const session of boardSessionsById.values()) {
      if (session.status !== "scheduled") continue;
      if (session.startsAtMs <= now) continue;
      if (session.startsAtMs - now > windowMs) continue;
      const event = eventsById.get(session.eventId);
      if (!event || event.status !== "active") continue;
      due.push({
        boardSessionId: session.boardSessionId,
        eventId: session.eventId,
        organizerId: session.organizerId,
        startsAtMs: session.startsAtMs,
      });
    }
    return due;
  }

  /**
   * Seals a draining or archive-failed Board Session CLOSED after its Private
   * Board Archive succeeded: the terminal transition records the archive's
   * object-storage key and the validated final sequence, and is guarded so
   * only a `closing` or `archive_failed` session can be sealed (a closed or
   * cancelled session is refused, and a session that was never archived is
   * never marked closed). A session sealed here can never be re-edited or
   * reopened; continued creation needs a new Board Session.
   *
   * @param {{boardSessionId: string, archiveKey: string, finalSeq: number, archivedAtMs: number}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found" | "not_closing" | "invalid_archive"}>}
   */
  async function markBoardSessionClosed(input) {
    ensureLoaded();
    const session = boardSessionsById.get(String(input.boardSessionId || ""));
    if (!session) return { ok: false, reason: "not_found" };
    if (session.status !== "closing" && session.status !== "archive_failed") {
      return { ok: false, reason: "not_closing" };
    }
    const archiveKey = String(input.archiveKey || "");
    const finalSeq = input.finalSeq;
    if (archiveKey === "" || !Number.isSafeInteger(finalSeq) || finalSeq < 0) {
      return { ok: false, reason: "invalid_archive" };
    }
    session.status = "closed";
    session.closedAtMs = input.archivedAtMs;
    session.archiveKey = archiveKey;
    session.archivedAtMs = input.archivedAtMs;
    session.archivedFinalSeq = finalSeq;
    session.archiveFailure = null;
    recordAudit({
      actorAccountId: "",
      actorKind: "system",
      action: "board_session.closed",
      subjectType: "board_session",
      subjectId: session.boardSessionId,
      organizerId: session.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * The longest failure detail kept on a session record. Close failures can
   * carry storage-layer text; the store bounds it so one hostile error cannot
   * grow the durable state unboundedly. The full error still goes to the
   * structured log.
   */
  const MAX_ARCHIVE_FAILURE_MESSAGE_LENGTH = 500;

  /**
   * Records one failed close attempt against a Board Session that was trying
   * to archive. The first failure transitions the session from `closing` to
   * `archive_failed` — an observable, recoverable state that admits no writes
   * and never displays an archived result; a failing retry attempt keeps the
   * session in `archive_failed` and refreshes the failure context. Each failed
   * attempt appends its own Change Audit record (automatic retries are bounded
   * by the pipeline's backoff, so the trail cannot spin). Unknown or
   * non-waiting sessions are ignored: a sealed or cancelled session can never
   * fail its way back into the pipeline.
   *
   * @param {{boardSessionId: string, code?: string, message?: string}} input
   * @returns {Promise<void>}
   */
  async function recordBoardSessionArchiveFailed(input) {
    ensureLoaded();
    const session = boardSessionsById.get(String(input.boardSessionId || ""));
    if (
      !session ||
      (session.status !== "closing" && session.status !== "archive_failed")
    ) {
      return;
    }
    const now = clock();
    const code =
      clampString(String(input.code || "internal"), 64) || "internal";
    const message = clampString(
      String(input.message || ""),
      MAX_ARCHIVE_FAILURE_MESSAGE_LENGTH,
    );
    const previous = session.archiveFailure;
    session.archiveFailure = {
      code,
      message,
      attempts: (previous?.attempts || 0) + 1,
      firstFailedAtMs: previous?.firstFailedAtMs ?? now,
      lastFailedAtMs: now,
    };
    const entered = session.status !== "archive_failed";
    session.status = "archive_failed";
    recordAudit({
      actorAccountId: "",
      actorKind: "system",
      action: "board_session.archive_failed",
      subjectType: "board_session",
      subjectId: session.boardSessionId,
      organizerId: session.organizerId,
    });
    if (entered) {
      logger.warn("hosted.board_session_archive_failed_entered", {
        board_session: session.boardSessionId,
        failure_code: code,
        attempts: session.archiveFailure.attempts,
      });
    }
    await enqueueWrite(persistNow);
  }

  /**
   * A Platform Operator's authorized manual retry: moves an `archive_failed`
   * Board Session back to `closing` so the very next close pass picks it up
   * immediately, without waiting for the automatic retry backoff. The failure
   * context stays on the session as retry context until a retry either seals
   * it `closed` (clearing it) or fails again (refreshing it), so attempts and
   * history are never lost across retries. Guarded by the current status, so
   * double submissions, racing operators, and retries of sessions that are no
   * longer failed are deterministic refusals — never duplicate advancement.
   *
   * @param {{boardSessionId: string, operatorAccountId: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found" | "not_failed"}>}
   */
  async function retryBoardSessionArchive(input) {
    ensureLoaded();
    const session = boardSessionsById.get(String(input.boardSessionId || ""));
    if (!session) return { ok: false, reason: "not_found" };
    if (session.status !== "archive_failed") {
      return { ok: false, reason: "not_failed" };
    }
    session.status = "closing";
    recordAudit({
      actorAccountId: String(input.operatorAccountId || ""),
      actorKind: "operator",
      action: "board_session.archive_retry_requested",
      subjectType: "board_session",
      subjectId: session.boardSessionId,
      organizerId: session.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  // --- outcome retention, early deletion, and expiry purge -----------------

  /**
   * Every Board Session of an event, oldest first. The retention pipeline and
   * the event audit view iterate them: outcomes are archived per session, so
   * a purge must cover each one.
   *
   * @param {string} eventId
   * @returns {StoredBoardSession[]}
   */
  function listBoardSessionsForEvent(eventId) {
    ensureLoaded();
    if (typeof eventId !== "string" || eventId === "") return [];
    return [...boardSessionsById.values()]
      .filter((session) => session.eventId === eventId)
      .sort((left, right) => left.createdAtMs - right.createdAtMs);
  }

  /**
   * Whether the event still holds recoverable outcomes: at least one closed
   * Board Session that is neither purged nor waiting for an archive. Early
   * deletion and the retention deadline both only apply to real outcomes.
   *
   * @param {StoredEvent} event
   * @returns {boolean}
   */
  function eventHasPurgeableOutcomes(event) {
    for (const session of listBoardSessionsForEvent(event.eventId)) {
      if (
        session.status === "closed" &&
        session.archiveKey !== null &&
        session.outcomesPurgedAtMs === null
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * An Owner/Admin's early deletion of the event's outcomes: the request
   * itself changes no outcome objects — it enters the recoverable window and
   * invalidates the Published Canvas and export download links because every
   * read path consults this record. Requires a closed, archived, not-yet-
   * purged Board Session, and is refused while a deletion is already pending
   * or the outcomes are already purged.
   *
   * @param {{eventId: string, actorAccountId: string, deleteWindowMs: number}} input
   * @returns {Promise<{ok: true, deletion: StoredEventOutcomeDeletion} | {ok: false, reason: "not_found" | "not_archived" | "already_pending" | "already_purged"}>}
   */
  async function requestEventOutcomeDeletion(input) {
    ensureLoaded();
    const event = eventsById.get(String(input.eventId || ""));
    if (!event) return { ok: false, reason: "not_found" };
    if (event.outcomeDeletion && event.outcomeDeletion.purgedAtMs === null) {
      return { ok: false, reason: "already_pending" };
    }
    if (event.outcomeDeletion && event.outcomeDeletion.purgedAtMs !== null) {
      return { ok: false, reason: "already_purged" };
    }
    if (!eventHasPurgeableOutcomes(event)) {
      return { ok: false, reason: "not_archived" };
    }
    const now = clock();
    const deleteWindowMs =
      typeof input.deleteWindowMs === "number" &&
      Number.isFinite(input.deleteWindowMs) &&
      input.deleteWindowMs >= 0
        ? input.deleteWindowMs
        : 0;
    /** @type {StoredEventOutcomeDeletion} */
    const deletion = {
      requestedAtMs: now,
      requestedByAccountId: String(input.actorAccountId || ""),
      purgeAtMs: now + deleteWindowMs,
      purgedAtMs: null,
    };
    event.outcomeDeletion = deletion;
    recordAudit({
      actorAccountId: deletion.requestedByAccountId,
      actorKind: "account",
      action: "event_outcome.delete_requested",
      subjectType: "event",
      subjectId: event.eventId,
      organizerId: event.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true, deletion };
  }

  /**
   * Restores a pending outcome deletion inside its recoverable window. The
   * request changed no outcome objects, so the restore is pure state removal:
   * the Published Canvas, export links, archive, attribution, and audit all
   * come back exactly as they were, by construction. A stale form (nothing
   * pending) or a request after the window elapsed is refused without side
   * effects.
   *
   * @param {{eventId: string, actorAccountId: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found" | "not_pending" | "window_elapsed"}>}
   */
  async function restoreEventOutcomeDeletion(input) {
    ensureLoaded();
    const event = eventsById.get(String(input.eventId || ""));
    if (!event) return { ok: false, reason: "not_found" };
    const deletion = event.outcomeDeletion;
    if (!deletion || deletion.purgedAtMs !== null) {
      return { ok: false, reason: "not_pending" };
    }
    if (clock() >= deletion.purgeAtMs) {
      return { ok: false, reason: "window_elapsed" };
    }
    event.outcomeDeletion = null;
    // A purge attempt that already failed against this pending deletion is
    // reset together with it: restoring means the owner changed their mind,
    // and a later due trigger records its own fresh failure context.
    event.outcomePurgeFailure = null;
    recordAudit({
      actorAccountId: String(input.actorAccountId || ""),
      actorKind: "account",
      action: "event_outcome.delete_restored",
      subjectType: "event",
      subjectId: event.eventId,
      organizerId: event.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * Finalizes a completed outcome purge: the closed Board Sessions the purge
   * covered are stamped purged (their archive key cleared, so no surface can
   * keep treating the outcomes as present), a pending deletion record keeps
   * its durable `purgedAtMs` marker once any purge ran (a partially purged
   * event must never restore as if untouched), and the failure context — if
   * any — is cleared. Without `sessionIds` every still-stamped closed session
   * of the event is covered (the early-deletion purge); with `sessionIds`
   * exactly those are stamped, so a retention-driven purge of one session can
   * never destroy a newer session's outcomes before their own 90 days.
   * Idempotent: sessions already purged and already-finalized deletions are
   * skipped, so repeated calls after a crash replay safely.
   *
   * @param {{eventId: string, sessionIds?: string[]}} input
   * @returns {Promise<{purgedSessions: number, finalizedDeletion: boolean}>}
   */
  async function markEventOutcomesPurged(input) {
    ensureLoaded();
    const event = eventsById.get(String(input.eventId || ""));
    if (!event) return { purgedSessions: 0, finalizedDeletion: false };
    const now = clock();
    const scopedIds = Array.isArray(input.sessionIds)
      ? new Set(input.sessionIds)
      : null;
    let purgedSessions = 0;
    for (const session of listBoardSessionsForEvent(event.eventId)) {
      if (
        session.outcomesPurgedAtMs !== null ||
        session.status !== "closed" ||
        session.archiveKey === null ||
        (scopedIds !== null && !scopedIds.has(session.boardSessionId))
      ) {
        continue;
      }
      session.outcomesPurgedAtMs = now;
      session.archiveKey = null;
      purgedSessions += 1;
    }
    let finalizedDeletion = false;
    if (
      event.outcomeDeletion &&
      event.outcomeDeletion.purgedAtMs === null &&
      // Finalize once any purge ran — a partially purged event must never
      // restore as if untouched — or once nothing purgeable remains (an
      // earlier retention purge may already have cleared every outcome).
      (purgedSessions > 0 || !eventHasPurgeableOutcomes(event))
    ) {
      event.outcomeDeletion.purgedAtMs = now;
      finalizedDeletion = true;
    }
    if (purgedSessions > 0 || finalizedDeletion) {
      event.outcomePurgeFailure = null;
      recordAudit({
        actorAccountId: "",
        actorKind: "system",
        action: "event_outcome.purged",
        subjectType: "event",
        subjectId: event.eventId,
        organizerId: event.organizerId,
      });
      await enqueueWrite(persistNow);
    }
    return { purgedSessions, finalizedDeletion };
  }

  /**
   * Records one failed outcome purge attempt against the event, mirroring the
   * Board Session archive-failure contract: the first failure opens the
   * durable context, a failing retry refreshes it, and the automatic backoff
   * plus the operator retry route own the recovery. Unknown events are
   * ignored.
   *
   * @param {{eventId: string, code?: string, message?: string}} input
   * @returns {Promise<void>}
   */
  async function recordEventOutcomePurgeFailed(input) {
    ensureLoaded();
    const event = eventsById.get(String(input.eventId || ""));
    if (!event) return;
    const now = clock();
    const code =
      clampString(String(input.code || "internal"), 64) || "internal";
    const message = clampString(
      String(input.message || ""),
      MAX_ARCHIVE_FAILURE_MESSAGE_LENGTH,
    );
    const previous = event.outcomePurgeFailure;
    event.outcomePurgeFailure = {
      code,
      message,
      attempts: (previous?.attempts || 0) + 1,
      firstFailedAtMs: previous?.firstFailedAtMs ?? now,
      lastFailedAtMs: now,
    };
    recordAudit({
      actorAccountId: "",
      actorKind: "system",
      action: "event_outcome.purge_failed",
      subjectType: "event",
      subjectId: event.eventId,
      organizerId: event.organizerId,
    });
    logger.warn("hosted.event_outcome_purge_failed", {
      event: event.eventId,
      failure_code: code,
      attempts: event.outcomePurgeFailure.attempts,
    });
    await enqueueWrite(persistNow);
  }

  /**
   * A Platform Operator's authorized manual retry of a failed outcome purge:
   * clearing the failure context makes the event due again on the very next
   * retention pass, without waiting for the backoff. Guarded like the archive
   * retry: an event without a failure context is refused deterministically.
   *
   * @param {{eventId: string, operatorAccountId: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found" | "not_failed"}>}
   */
  async function retryEventOutcomePurge(input) {
    ensureLoaded();
    const event = eventsById.get(String(input.eventId || ""));
    if (!event) return { ok: false, reason: "not_found" };
    if (!event.outcomePurgeFailure) return { ok: false, reason: "not_failed" };
    event.outcomePurgeFailure = null;
    recordAudit({
      actorAccountId: String(input.operatorAccountId || ""),
      actorKind: "operator",
      action: "event_outcome.purge_retry_requested",
      subjectType: "event",
      subjectId: event.eventId,
      organizerId: event.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * The retention pipeline's work queue: events whose outcomes must be purged
   * now because a pending deletion's recoverable window elapsed, or because a
   * closed Board Session's retention deadline passed — minus events whose
   * last purge attempt failed and is still inside its automatic retry
   * backoff. A backoff of zero retries on the next pass. Read-only: the purge
   * itself is the pipeline's guarded mutation, so concurrent passes stay
   * serialized by the pipeline's in-flight guard.
   *
   * @param {{now: number, retentionMs?: number, retryMs?: number}} input
   * @returns {{eventId: string, organizerId: string, boardName: string}[]}
   */
  function listEventsDueForOutcomePurge(input) {
    ensureLoaded();
    const now = input.now;
    const retentionMs =
      typeof input.retentionMs === "number" &&
      Number.isFinite(input.retentionMs)
        ? Math.max(0, input.retentionMs)
        : 0;
    const retryMs =
      typeof input.retryMs === "number" && Number.isFinite(input.retryMs)
        ? Math.max(0, input.retryMs)
        : 0;
    /** @type {{eventId: string, organizerId: string, boardName: string}[]} */
    const due = [];
    for (const event of eventsById.values()) {
      const deletionPending =
        event.outcomeDeletion !== null &&
        event.outcomeDeletion.purgedAtMs === null &&
        now >= event.outcomeDeletion.purgeAtMs;
      // Both triggers are evaluated independently: a pending deletion whose
      // recoverable window runs past the retention deadline must not extend
      // how long the outcomes are kept — whichever elapses first purges.
      let retentionElapsed = false;
      if (retentionMs > 0) {
        for (const session of listBoardSessionsForEvent(event.eventId)) {
          if (
            session.status === "closed" &&
            session.archiveKey !== null &&
            session.outcomesPurgedAtMs === null &&
            session.archivedAtMs !== null &&
            now >= session.archivedAtMs + retentionMs
          ) {
            retentionElapsed = true;
            break;
          }
        }
      }
      if (!deletionPending && !retentionElapsed) continue;
      const failure = event.outcomePurgeFailure;
      if (failure && retryMs > 0 && now < failure.lastFailedAtMs + retryMs) {
        continue;
      }
      due.push({
        eventId: event.eventId,
        organizerId: event.organizerId,
        boardName: event.boardName,
      });
    }
    return due;
  }

  /**
   * The outcome-purge work list for the operator console: events with a
   * pending deletion or a failed purge, oldest relevant timestamp first, so
   * failures stay visible even while their retry backoff runs. A read-only
   * projection — recovery stays behind the dedicated retry method.
   *
   * @returns {{event: StoredEvent, deletion: StoredEventOutcomeDeletion | null}[]}
   */
  function listOutcomePurgeWork() {
    ensureLoaded();
    return [...eventsById.values()]
      .filter(
        (event) =>
          (event.outcomeDeletion !== null &&
            event.outcomeDeletion.purgedAtMs === null) ||
          event.outcomePurgeFailure !== null,
      )
      .sort(
        (left, right) =>
          (left.outcomePurgeFailure?.lastFailedAtMs ||
            left.outcomeDeletion?.requestedAtMs ||
            0) -
          (right.outcomePurgeFailure?.lastFailedAtMs ||
            right.outcomeDeletion?.requestedAtMs ||
            0),
      )
      .map((event) => ({
        event,
        deletion: event.outcomeDeletion,
      }));
  }

  /**
   * The event-scoped Change Audit trail for one event: administrative records
   * whose subject is the event, its reservation, or one of its Board
   * Sessions, newest first. This is the Owner/Admin audit view's admin-action
   * history; board write history comes from the durable mutation ledger.
   *
   * @param {string} eventId
   * @param {{limit?: number}} [options]
   * @returns {StoredAuditRecord[]}
   */
  function listAuditForEvent(eventId, options = {}) {
    ensureLoaded();
    const limit =
      typeof options.limit === "number" && options.limit > 0
        ? options.limit
        : 50;
    const normalized = String(eventId || "");
    const event = eventsById.get(normalized);
    if (!event) return [];
    const sessionIds = new Set(
      listBoardSessionsForEvent(normalized).map(
        (session) => session.boardSessionId,
      ),
    );
    return auditRecords
      .filter((record) => {
        if (record.subjectType === "event") {
          return record.subjectId === normalized;
        }
        if (record.subjectType === "board_session") {
          return sessionIds.has(record.subjectId);
        }
        if (record.subjectType === "reservation") {
          return record.subjectId === event.reservationId;
        }
        return false;
      })
      .sort((left, right) => right.createdAtMs - left.createdAtMs)
      .slice(0, limit);
  }

  /**
   * Submits an amend Reservation Change Request (reschedule/extend/capacity) for
   * an approved reservation whose Board Session is still scheduled. Only one
   * pending request may exist at a time. The proposal is not applied until an
   * operator approves it (capacity is re-checked then).
   *
   * @param {{
   *   reservationId: string,
   *   organizerId: string,
   *   proposedStartsAtMs: number,
   *   proposedEndsAtMs: number,
   *   proposedSeats: number,
   *   requestedByAccountId: string,
   * }} input
   * @returns {Promise<{ok: true, changeRequest: StoredChangeRequest} | {ok: false, reason: "not_found" | "not_approved" | "not_scheduled" | "already_pending"}>}
   */
  async function submitChangeRequest(input) {
    ensureLoaded();
    const reservation = reservationsById.get(String(input.reservationId || ""));
    if (!reservation || reservation.organizerId !== input.organizerId) {
      return { ok: false, reason: "not_found" };
    }
    if (reservation.status !== "approved") {
      return { ok: false, reason: "not_approved" };
    }
    const session = boardSessionByReservationId(reservation.reservationId);
    if (!session || session.status !== "scheduled") {
      return { ok: false, reason: "not_scheduled" };
    }
    for (const request of changeRequestsById.values()) {
      if (
        request.reservationId === reservation.reservationId &&
        request.status === "pending"
      ) {
        return { ok: false, reason: "already_pending" };
      }
    }
    /** @type {StoredChangeRequest} */
    const changeRequest = {
      changeRequestId: randomId(),
      reservationId: reservation.reservationId,
      organizerId: reservation.organizerId,
      kind: "amend",
      proposedStartsAtMs: integerOr(
        input.proposedStartsAtMs,
        reservation.startsAtMs,
      ),
      proposedEndsAtMs: integerOr(input.proposedEndsAtMs, reservation.endsAtMs),
      proposedSeats: integerOr(input.proposedSeats, reservation.requestedSeats),
      status: "pending",
      requestedByAccountId: String(input.requestedByAccountId || ""),
      createdAtMs: clock(),
      decidedAtMs: null,
      decidedByAccountId: null,
      operatorNote: null,
    };
    changeRequestsById.set(changeRequest.changeRequestId, changeRequest);
    recordAudit({
      actorAccountId: changeRequest.requestedByAccountId,
      actorKind: "account",
      action: "change_request.submitted",
      subjectType: "change_request",
      subjectId: changeRequest.changeRequestId,
      organizerId: reservation.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true, changeRequest };
  }

  /**
   * Peak Capacity Allocation impact if a pending amend were applied now, for the
   * operator console — measured against every other live allocation with the
   * reservation's current allocation excluded.
   *
   * @param {{changeRequestId: string, bufferMs: number, sessionLimit: number, seatLimit: number}} input
   * @returns {{maxSessions: number, maxSeats: number, sessionLimit: number, seatLimit: number, wouldExceed: boolean} | null}
   */
  function changeRequestCapacityImpact(input) {
    ensureLoaded();
    const request = changeRequestsById.get(String(input.changeRequestId || ""));
    if (!request || request.kind !== "amend") return null;
    const reservation = reservationsById.get(request.reservationId);
    const session = boardSessionByReservationId(request.reservationId);
    if (!reservation || !session) return null;
    const proposedStart = request.proposedStartsAtMs ?? reservation.startsAtMs;
    const proposedEnd = request.proposedEndsAtMs ?? reservation.endsAtMs;
    const proposedSeats = request.proposedSeats ?? reservation.requestedSeats;
    const peak = computeCapacityPeak(
      proposedStart - input.bufferMs,
      proposedEnd + input.bufferMs,
      proposedSeats,
      activeAllocations(session.boardSessionId),
    );
    return {
      maxSessions: peak.maxSessions,
      maxSeats: peak.maxSeats,
      sessionLimit: input.sessionLimit,
      seatLimit: input.seatLimit,
      wouldExceed:
        peak.maxSessions > input.sessionLimit ||
        peak.maxSeats > input.seatLimit,
    };
  }

  /**
   * Approves and applies a pending amend: re-runs the full overlapping capacity
   * constraint with the reservation's own allocation excluded and, only if the
   * proposal fits, atomically updates the reservation, event, and Board Session.
   * The check-and-apply is synchronous, so concurrent approvals cannot oversell.
   *
   * @param {{changeRequestId: string, operatorAccountId: string, now: number, bufferMs: number, sessionLimit: number, seatLimit: number}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found" | "not_pending" | "not_applicable" | "past_start" | "capacity", maxSessions?: number, maxSeats?: number}>}
   */
  async function approveChangeRequest(input) {
    ensureLoaded();
    const request = changeRequestsById.get(String(input.changeRequestId || ""));
    if (!request) return { ok: false, reason: "not_found" };
    if (request.status !== "pending" || request.kind !== "amend") {
      return { ok: false, reason: "not_pending" };
    }
    const reservation = reservationsById.get(request.reservationId);
    const session = boardSessionByReservationId(request.reservationId);
    const event =
      reservation && reservation.eventId
        ? eventsById.get(reservation.eventId)
        : null;
    if (
      !reservation ||
      !session ||
      !event ||
      reservation.status !== "approved" ||
      session.status !== "scheduled"
    ) {
      return { ok: false, reason: "not_applicable" };
    }
    const proposedStart = request.proposedStartsAtMs ?? reservation.startsAtMs;
    const proposedEnd = request.proposedEndsAtMs ?? reservation.endsAtMs;
    const proposedSeats = request.proposedSeats ?? reservation.requestedSeats;
    if (proposedStart <= input.now) return { ok: false, reason: "past_start" };
    const windowStartMs = proposedStart - input.bufferMs;
    const windowEndMs = proposedEnd + input.bufferMs;
    const peak = computeCapacityPeak(
      windowStartMs,
      windowEndMs,
      proposedSeats,
      activeAllocations(session.boardSessionId),
    );
    if (
      peak.maxSessions > input.sessionLimit ||
      peak.maxSeats > input.seatLimit
    ) {
      return {
        ok: false,
        reason: "capacity",
        maxSessions: peak.maxSessions,
        maxSeats: peak.maxSeats,
      };
    }
    const now = clock();
    reservation.startsAtMs = proposedStart;
    reservation.endsAtMs = proposedEnd;
    reservation.requestedSeats = proposedSeats;
    event.startsAtMs = proposedStart;
    event.endsAtMs = proposedEnd;
    session.startsAtMs = proposedStart;
    session.endsAtMs = proposedEnd;
    session.windowStartMs = windowStartMs;
    session.windowEndMs = windowEndMs;
    session.seats = proposedSeats;
    request.status = "applied";
    request.decidedAtMs = now;
    request.decidedByAccountId = String(input.operatorAccountId || "");
    recordAudit({
      actorAccountId: String(input.operatorAccountId || ""),
      actorKind: "operator",
      action: "change_request.applied",
      subjectType: "change_request",
      subjectId: request.changeRequestId,
      organizerId: reservation.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * Rejects a pending amend with an operator-only note; nothing changes on the
   * reservation, event, or Board Session.
   *
   * @param {{changeRequestId: string, operatorAccountId: string, note?: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found" | "not_pending"}>}
   */
  async function rejectChangeRequest(input) {
    ensureLoaded();
    const request = changeRequestsById.get(String(input.changeRequestId || ""));
    if (!request) return { ok: false, reason: "not_found" };
    if (request.status !== "pending" || request.kind !== "amend") {
      return { ok: false, reason: "not_pending" };
    }
    request.status = "rejected";
    request.decidedAtMs = clock();
    request.decidedByAccountId = String(input.operatorAccountId || "");
    request.operatorNote = clampString(
      input.note || "",
      MAX_OPERATOR_NOTE_LENGTH,
    );
    recordAudit({
      actorAccountId: String(input.operatorAccountId || ""),
      actorKind: "operator",
      action: "change_request.rejected",
      subjectType: "change_request",
      subjectId: request.changeRequestId,
      organizerId: request.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * Cancels an approved, still-future Event directly (a capacity-releasing
   * change that needs no operator approval): the reservation, event, and Board
   * Session move to cancelled, releasing the future Capacity Allocation and
   * blocking new entry, while every existing audit record is preserved. The
   * cancellation is recorded as an applied cancel Change Request for the
   * history.
   *
   * @param {{reservationId: string, organizerId: string, actorAccountId: string, now: number}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found" | "not_approved" | "not_future"}>}
   */
  async function cancelApprovedEvent(input) {
    ensureLoaded();
    const reservation = reservationsById.get(String(input.reservationId || ""));
    if (!reservation || reservation.organizerId !== input.organizerId) {
      return { ok: false, reason: "not_found" };
    }
    if (reservation.status !== "approved") {
      return { ok: false, reason: "not_approved" };
    }
    const session = boardSessionByReservationId(reservation.reservationId);
    const event = reservation.eventId
      ? eventsById.get(reservation.eventId)
      : null;
    if (!session || !event) return { ok: false, reason: "not_found" };
    // Only a future Event (still scheduled and not yet started) can be cancelled.
    if (session.status !== "scheduled" || input.now >= session.startsAtMs) {
      return { ok: false, reason: "not_future" };
    }
    const now = clock();
    reservation.status = "cancelled";
    event.status = "cancelled";
    session.status = "cancelled";
    session.cancelledAtMs = now;
    // A still-pending amend can no longer apply to a cancelled reservation; it
    // is rejected with the cancelling actor and its own audit record, like any
    // other change-request decision.
    const actorAccountId = String(input.actorAccountId || "");
    for (const request of changeRequestsById.values()) {
      if (
        request.reservationId === reservation.reservationId &&
        request.status === "pending"
      ) {
        request.status = "rejected";
        request.decidedAtMs = now;
        request.decidedByAccountId = actorAccountId;
        recordAudit({
          actorAccountId,
          actorKind: "account",
          action: "change_request.rejected",
          subjectType: "change_request",
          subjectId: request.changeRequestId,
          organizerId: reservation.organizerId,
        });
      }
    }
    /** @type {StoredChangeRequest} */
    const changeRequest = {
      changeRequestId: randomId(),
      reservationId: reservation.reservationId,
      organizerId: reservation.organizerId,
      kind: "cancel",
      proposedStartsAtMs: null,
      proposedEndsAtMs: null,
      proposedSeats: null,
      status: "applied",
      requestedByAccountId: actorAccountId,
      createdAtMs: now,
      decidedAtMs: now,
      decidedByAccountId: actorAccountId,
      operatorNote: null,
    };
    changeRequestsById.set(changeRequest.changeRequestId, changeRequest);
    recordAudit({
      actorAccountId,
      actorKind: "account",
      action: "event.cancelled",
      subjectType: "event",
      subjectId: event.eventId,
      organizerId: reservation.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * @param {string} changeRequestId
   * @returns {StoredChangeRequest | null}
   */
  function getChangeRequestById(changeRequestId) {
    ensureLoaded();
    if (typeof changeRequestId !== "string" || changeRequestId === "") {
      return null;
    }
    return changeRequestsById.get(changeRequestId) || null;
  }

  /**
   * Change Requests for a reservation, newest first.
   *
   * @param {string} reservationId
   * @returns {StoredChangeRequest[]}
   */
  function listChangeRequestsForReservation(reservationId) {
    ensureLoaded();
    return [...changeRequestsById.values()]
      .filter((request) => request.reservationId === reservationId)
      .sort((left, right) => right.createdAtMs - left.createdAtMs);
  }

  /**
   * The reservation's pending amend, or null.
   *
   * @param {string} reservationId
   * @returns {StoredChangeRequest | null}
   */
  function getPendingChangeRequestForReservation(reservationId) {
    ensureLoaded();
    for (const request of changeRequestsById.values()) {
      if (
        request.reservationId === reservationId &&
        request.status === "pending"
      ) {
        return request;
      }
    }
    return null;
  }

  /**
   * The operator review queue: pending amend Change Requests, oldest first.
   *
   * @returns {StoredChangeRequest[]}
   */
  function listPendingChangeRequests() {
    ensureLoaded();
    return [...changeRequestsById.values()]
      .filter(
        (request) => request.status === "pending" && request.kind === "amend",
      )
      .sort((left, right) => left.createdAtMs - right.createdAtMs);
  }

  /**
   * @param {string} reservationId
   * @returns {StoredReservation | null}
   */
  function getReservationById(reservationId) {
    ensureLoaded();
    if (typeof reservationId !== "string" || reservationId === "") return null;
    return reservationsById.get(reservationId) || null;
  }

  /**
   * Reservations of an organizer, newest first.
   *
   * @param {string} organizerId
   * @returns {StoredReservation[]}
   */
  function listReservationsForOrganizer(organizerId) {
    ensureLoaded();
    return [...reservationsById.values()]
      .filter((reservation) => reservation.organizerId === organizerId)
      .sort((left, right) => right.createdAtMs - left.createdAtMs);
  }

  /**
   * The operator review queue: submitted reservations, oldest first.
   *
   * @returns {StoredReservation[]}
   */
  function listSubmittedReservations() {
    ensureLoaded();
    return [...reservationsById.values()]
      .filter((reservation) => reservation.status === "submitted")
      .sort(
        (left, right) => (left.submittedAtMs || 0) - (right.submittedAtMs || 0),
      );
  }

  /**
   * @param {string} eventId
   * @returns {StoredEvent | null}
   */
  function getEventById(eventId) {
    ensureLoaded();
    if (typeof eventId !== "string" || eventId === "") return null;
    return eventsById.get(eventId) || null;
  }

  /**
   * @param {string} publicId
   * @returns {StoredEvent | null}
   */
  function getEventByPublicId(publicId) {
    ensureLoaded();
    const eventId = eventIdsByPublicId.get(String(publicId || ""));
    return eventId ? eventsById.get(eventId) || null : null;
  }

  /**
   * The event behind a hosted board name, or null. Only events carry board
   * names, so legacy boards never resolve through this index.
   *
   * @param {string} boardName
   * @returns {StoredEvent | null}
   */
  function getEventByBoardName(boardName) {
    ensureLoaded();
    const eventId = eventIdsByBoardName.get(String(boardName || ""));
    return eventId ? eventsById.get(eventId) || null : null;
  }

  /**
   * The event that belongs to an organizer, or null. Cross-organizer ids fail
   * as absent so nothing about another organizer's events leaks.
   *
   * @param {string} organizerId
   * @param {string} eventId
   * @returns {StoredEvent | null}
   */
  function getEventForOrganizer(organizerId, eventId) {
    ensureLoaded();
    const event = eventsById.get(String(eventId || ""));
    if (!event || event.organizerId !== organizerId) return null;
    return event;
  }

  /**
   * Publicly discoverable events for the homepage: those set to public
   * visibility whose board session has not yet ended, soonest first. Unlisted,
   * ended, and cancelled events are never listed.
   *
   * @param {number} now
   * @returns {StoredEvent[]}
   */
  function listPublicDiscoverableEvents(now) {
    ensureLoaded();
    return [...eventsById.values()]
      .filter(
        (event) =>
          event.visibility === "public" &&
          event.status !== "cancelled" &&
          eventLifecycleState(event, now) !== "ended",
      )
      .sort((left, right) => left.startsAtMs - right.startsAtMs);
  }

  /**
   * Updates an approved event's public display: its visibility and tagline, and
   * optionally clears its cover. Owner/Admin-only in the route layer; the store
   * verifies the event belongs to the organizer.
   *
   * @param {{
   *   organizerId: string,
   *   eventId: string,
   *   visibility: "public" | "unlisted",
   *   tagline?: string,
   *   removeCover?: boolean,
   *   actorAccountId: string,
   * }} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found"}>}
   */
  async function updateEventDisplay(input) {
    ensureLoaded();
    const event = getEventForOrganizer(input.organizerId, input.eventId);
    if (!event) return { ok: false, reason: "not_found" };
    event.visibility = input.visibility === "public" ? "public" : "unlisted";
    event.tagline = clampString(input.tagline || "", MAX_EVENT_TAGLINE_LENGTH);
    if (input.removeCover) event.coverAssetId = null;
    recordAudit({
      actorAccountId: String(input.actorAccountId || ""),
      actorKind: "account",
      action: "event.display_updated",
      subjectType: "event",
      subjectId: event.eventId,
      organizerId: event.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * Points an approved event at a validated cover Brand Asset. Owner/Admin-only
   * in the route layer; the store verifies the event belongs to the organizer.
   *
   * @param {{organizerId: string, eventId: string, assetId: string, actorAccountId: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found"}>}
   */
  async function setEventCover(input) {
    ensureLoaded();
    const event = getEventForOrganizer(input.organizerId, input.eventId);
    if (!event) return { ok: false, reason: "not_found" };
    event.coverAssetId = String(input.assetId || "") || null;
    recordAudit({
      actorAccountId: String(input.actorAccountId || ""),
      actorKind: "account",
      action: "event.cover_set",
      subjectType: "event",
      subjectId: event.eventId,
      organizerId: event.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  // --- event admission: access code, entry lock, membership ---------------

  /**
   * The Board Session backing an event, or null.
   *
   * @param {string} eventId
   * @returns {StoredBoardSession | null}
   */
  function getBoardSessionForEvent(eventId) {
    ensureLoaded();
    if (typeof eventId !== "string" || eventId === "") return null;
    for (const session of boardSessionsById.values()) {
      if (session.eventId === eventId) return session;
    }
    return null;
  }

  /**
   * The Board Session behind an internal id, or null. Operator-console
   * surface only: internal Board Session identifiers never appear on public
   * or participant-facing URLs.
   *
   * @param {string} boardSessionId
   * @returns {StoredBoardSession | null}
   */
  function getBoardSessionById(boardSessionId) {
    ensureLoaded();
    return boardSessionsById.get(String(boardSessionId || "")) || null;
  }

  /**
   * The operator-facing capacity signal: how many Board Sessions are live
   * (open or draining) and how many Participant Seats they have committed,
   * against the confirmed platform limits (20 sessions / 1,000 seats).
   *
   * @returns {{activeSessions: number, committedSeats: number}}
   */
  function readCapacityUsage() {
    ensureLoaded();
    let activeSessions = 0;
    let committedSeats = 0;
    for (const session of boardSessionsById.values()) {
      if (session.status !== "open" && session.status !== "closing") continue;
      activeSessions += 1;
      committedSeats += session.seats;
    }
    return { activeSessions, committedSeats };
  }

  /**
   * Every Board Session, oldest first. The webhook pipeline derives its
   * lifecycle events from this durable state, so a full read-only scan is
   * the derivation surface; per-kind dedupe keys make repeated scans no-ops.
   *
   * @returns {StoredBoardSession[]}
   */
  function listBoardSessions() {
    ensureLoaded();
    return [...boardSessionsById.values()].sort(
      (left, right) => left.createdAtMs - right.createdAtMs,
    );
  }

  /**
   * The Platform Operator console's archive-failure work list: every Board
   * Session currently waiting in `archive_failed`, oldest failure first, with
   * the failure context and the identifiers the console needs to join event
   * and organizer names. A read-only projection — retry authorization and
   * state changes stay behind the dedicated retry method.
   *
   * @returns {StoredBoardSession[]}
   */
  function listArchiveFailedBoardSessions() {
    ensureLoaded();
    return [...boardSessionsById.values()]
      .filter((session) => session.status === "archive_failed")
      .sort(
        (left, right) =>
          (left.archiveFailure?.lastFailedAtMs || 0) -
          (right.archiveFailure?.lastFailedAtMs || 0),
      );
  }

  /**
   * Mints (or replaces) the event's shared Access Code and returns the raw
   * value exactly once. Only the SHA-256 digest is persisted, so a later read
   * can never reveal the code; rotating simply stops the previous digest from
   * matching and leaves every existing Event Membership untouched.
   * Owner/Admin-only in the route layer; the store verifies the event belongs
   * to the organizer.
   *
   * @param {{organizerId: string, eventId: string, actorAccountId: string}} input
   * @returns {Promise<{ok: true, accessCode: string, replaced: boolean} | {ok: false, reason: "not_found"}>}
   */
  async function rotateEventAccessCode(input) {
    ensureLoaded();
    const event = getEventForOrganizer(input.organizerId, input.eventId);
    if (!event) return { ok: false, reason: "not_found" };
    const replaced = event.accessCodeDigest !== null;
    const accessCode = generateAccessCode();
    event.accessCodeDigest = digestAccessCode(normalizeAccessCode(accessCode));
    event.accessCodeSetAtMs = clock();
    recordAudit({
      actorAccountId: String(input.actorAccountId || ""),
      actorKind: "account",
      action: replaced ? "event.access_code_rotated" : "event.access_code_set",
      subjectType: "event",
      subjectId: event.eventId,
      organizerId: event.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true, accessCode, replaced };
  }

  /**
   * Enables or disables the Event Lock. Locking rejects all future Access
   * Code admissions while every existing Event Membership is retained —
   * members stay members; they simply cannot be joined by anyone new.
   * Owner/Admin-only in the route layer.
   *
   * @param {{organizerId: string, eventId: string, locked: boolean, actorAccountId: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found"}>}
   */
  async function setEventEntryLock(input) {
    ensureLoaded();
    const event = getEventForOrganizer(input.organizerId, input.eventId);
    if (!event) return { ok: false, reason: "not_found" };
    const locked = input.locked === true;
    if (event.entryLocked === locked) return { ok: true };
    event.entryLocked = locked;
    event.entryLockedAtMs = clock();
    recordAudit({
      actorAccountId: String(input.actorAccountId || ""),
      actorKind: "account",
      action: locked ? "event.entry_locked" : "event.entry_unlocked",
      subjectType: "event",
      subjectId: event.eventId,
      organizerId: event.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  // --- event moderation grants ---------------------------------------------

  /**
   * Whether the account holds the Event Moderator grant for the event. The
   * check is deliberately narrow: it never implies organizer membership,
   * console access, or any authority beyond this one event's real-time
   * governance.
   *
   * @param {string} eventId
   * @param {string} accountId
   * @returns {boolean}
   */
  function isEventModerator(eventId, accountId) {
    ensureLoaded();
    if (typeof eventId !== "string" || typeof accountId !== "string") {
      return false;
    }
    if (eventId === "" || accountId === "") return false;
    return eventModeratorsByKey.has(eventModeratorKey(eventId, accountId));
  }

  /**
   * Event moderators of an event, oldest grant first.
   *
   * @param {string} eventId
   * @returns {StoredEventModerator[]}
   */
  function listEventModerators(eventId) {
    ensureLoaded();
    return [...eventModeratorsByKey.values()]
      .filter((moderator) => moderator.eventId === eventId)
      .sort((left, right) => left.grantedAtMs - right.grantedAtMs);
  }

  /**
   * Grants the Event Moderator role for one event to an account. Idempotent:
   * granting an existing moderator keeps the original grant. The store only
   * verifies the event belongs to the organizer; the route layer resolves the
   * target account and restricts the action to Owner/Admin.
   *
   * @param {{organizerId: string, eventId: string, targetAccountId: string, actorAccountId: string}} input
   * @returns {Promise<{ok: true, created: boolean} | {ok: false, reason: "not_found"}>}
   */
  async function grantEventModerator(input) {
    ensureLoaded();
    const event = getEventForOrganizer(input.organizerId, input.eventId);
    if (!event) return { ok: false, reason: "not_found" };
    const accountId = String(input.targetAccountId || "");
    if (accountId === "")
      throw new Error("grantEventModerator requires targetAccountId");
    const key = eventModeratorKey(event.eventId, accountId);
    if (eventModeratorsByKey.has(key)) return { ok: true, created: false };
    eventModeratorsByKey.set(key, {
      eventId: event.eventId,
      organizerId: event.organizerId,
      accountId,
      grantedAtMs: clock(),
      grantedByAccountId: String(input.actorAccountId || ""),
    });
    recordAudit({
      actorAccountId: String(input.actorAccountId || ""),
      actorKind: "account",
      action: "event_moderator.granted",
      subjectType: "event_moderator",
      subjectId: accountId,
      organizerId: event.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true, created: true };
  }

  /**
   * Revokes the Event Moderator grant for one event. Revoking an account that
   * is not a moderator fails without side effects. Existing live connections
   * of the revoked account are refreshed by the route layer through the
   * moderation socket effects, not here.
   *
   * @param {{organizerId: string, eventId: string, targetAccountId: string, actorAccountId: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found" | "not_moderator"}>}
   */
  async function revokeEventModerator(input) {
    ensureLoaded();
    const event = getEventForOrganizer(input.organizerId, input.eventId);
    if (!event) return { ok: false, reason: "not_found" };
    const key = eventModeratorKey(
      event.eventId,
      String(input.targetAccountId || ""),
    );
    if (!eventModeratorsByKey.has(key)) {
      return { ok: false, reason: "not_moderator" };
    }
    eventModeratorsByKey.delete(key);
    recordAudit({
      actorAccountId: String(input.actorAccountId || ""),
      actorKind: "account",
      action: "event_moderator.revoked",
      subjectType: "event_moderator",
      subjectId: String(input.targetAccountId || ""),
      organizerId: event.organizerId,
    });
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
    submitApplication,
    getApplicantView,
    listPendingApplications,
    getApplicationById,
    approveApplication,
    rejectApplication,
    listAuditForApplication,
    getOrganizerById,
    listRolesForOrganizer,
    listRolesForAccount,
    getMemberRole,
    listMembers,
    listOrganizersForAccount,
    listOrganizers,
    changeMemberRole,
    removeMember,
    createInvitation,
    getInvitationById,
    listInvitationsForOrganizer,
    listPendingInvitationsForEmail,
    acceptInvitation,
    declineInvitation,
    revokeInvitation,
    listAuditForOrganizer,
    listAuditForEvent,
    createReservation,
    updateReservation,
    submitReservation,
    cancelReservation,
    approveReservation,
    rejectReservation,
    capacityImpact,
    getReservationById,
    listReservationsForOrganizer,
    listSubmittedReservations,
    getBoardSessionForReservation,
    advanceLifecycle,
    listBoardSessionsDueToClose,
    listBoardSessionsStartingWithin,
    markBoardSessionClosed,
    recordBoardSessionArchiveFailed,
    retryBoardSessionArchive,
    listArchiveFailedBoardSessions,
    listBoardSessions,
    readCapacityUsage,
    getBoardSessionById,
    submitChangeRequest,
    approveChangeRequest,
    rejectChangeRequest,
    changeRequestCapacityImpact,
    cancelApprovedEvent,
    getChangeRequestById,
    listChangeRequestsForReservation,
    getPendingChangeRequestForReservation,
    listPendingChangeRequests,
    getEventById,
    getEventByPublicId,
    getEventByBoardName,
    getEventForOrganizer,
    getBoardSessionForEvent,
    listBoardSessionsForEvent,
    requestEventOutcomeDeletion,
    restoreEventOutcomeDeletion,
    markEventOutcomesPurged,
    recordEventOutcomePurgeFailed,
    retryEventOutcomePurge,
    listEventsDueForOutcomePurge,
    listOutcomePurgeWork,
    listPublicDiscoverableEvents,
    updateEventDisplay,
    setEventCover,
    rotateEventAccessCode,
    setEventEntryLock,
    isEventModerator,
    listEventModerators,
    grantEventModerator,
    revokeEventModerator,
    // Public audit append for sibling domain stores (e.g. API credentials)
    // whose administrative actions belong in the organizer's activity log.
    appendAudit: recordAudit,
    flush,
  };
}

export {
  computeCapacityPeak,
  createFileOrganizerStore,
  eventLifecycleState,
  MAX_EVENT_TAGLINE_LENGTH,
};
