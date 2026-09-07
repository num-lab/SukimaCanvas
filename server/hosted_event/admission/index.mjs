import {
  HOSTED_SESSION_COOKIE_NAME,
  readHostedCookie,
} from "../../auth/hosted_cookies.mjs";
import observability from "../../observability/index.mjs";
import { createSeatRegistry } from "./seats.mjs";

const { logger } = observability;

/**
 * The two governance roles that share the Preparation Window entry rules and
 * never contend for Participant Seats. Only the Owner/Admin role carries the
 * destructive Clear.
 *
 * @param {"moderator" | "event_moderator" | "editor" | "reader" | undefined} role
 * @returns {boolean}
 */
function isGovernanceRole(role) {
  return role === "moderator" || role === "event_moderator";
}

/**
 * Hosted Event admission for real-time board access.
 *
 * This module is the single authority that decides who may open an event's
 * Board Session, in which role, and with which seat. The socket layer and the
 * hosted board page both come through here, so there is no second admission
 * path to bypass: every check is server-authoritative and derived from the
 * hosted session cookie (never from client-claimed identity), the organizer
 * store's event and Board Session state, the membership store, and the seat
 * registry.
 *
 * Admission roles map onto the existing board permission roles:
 * - "moderator": Organizer Owner/Admin — may enter during the Preparation
 *   Window (scheduled) and while open; may clear the board; never contends
 *   for Participant Seats.
 * - "event_moderator": a per-event Event Moderator grant — the same entry
 *   window and seat exemption as Owner/Admin, with in-event governance
 *   (reports, warnings, kicks, event bans) but never the destructive Clear.
 * - "editor": a member holding the account's single writable connection.
 * - "reader": a member connected without the writable slot (extra tab or
 *   device) — explicitly read-only.
 *
 * Participant Seats are accounted per distinct Account per Event against the
 * Board Session's approved capacity; the socket layer reports connects and
 * disconnects so the registry can retain a seat for the reconnect grace
 * window after an account's last connection drops.
 *
 * @param {{
 *   seatGraceMs?: number,
 *   preparationWindowMs?: number,
 *   accountStore: ReturnType<typeof import("../accounts/store.mjs").createFileAccountStore>,
 *   organizerStore: ReturnType<typeof import("../organizers/store.mjs").createFileOrganizerStore>,
 *   membershipStore: ReturnType<typeof import("../memberships/store.mjs").createFileEventMembershipStore>,
 *   participantIdentifierFor: (eventId: string, accountId: string) => string,
 *   clock?: () => number,
 * }} dependencies
 */
function createEventAdmission(dependencies) {
  const { accountStore, organizerStore, membershipStore } = dependencies;
  const clock = dependencies.clock || (() => Date.now());
  // The participant identifier is the opaque, event-scoped creator identity
  // stamped onto accepted board items. It is resolved here so every admitted
  // connection carries its attribution identity without ever exposing the
  // internal Account id on items or broadcasts. Required, not defaulted: an
  // admission module without one must not compose.
  const participantIdentifierFor =
    typeof dependencies.participantIdentifierFor === "function"
      ? dependencies.participantIdentifierFor
      : function missingParticipantIdentifierResolver() {
          throw new Error(
            "createEventAdmission requires participantIdentifierFor",
          );
        };
  const seats = createSeatRegistry({
    clock,
    graceMs: dependencies.seatGraceMs,
  });
  const preparationWindowMs =
    typeof dependencies.preparationWindowMs === "number" &&
    dependencies.preparationWindowMs >= 0
      ? dependencies.preparationWindowMs
      : 15 * 60 * 1000;

  /** Event board names are `event-` prefixed by construction. */
  const HOSTED_BOARD_NAME_PREFIX = "event-";

  /**
   * The shared governance-entry decision: the Board Session must be inside
   * the governed window (Preparation Window while scheduled, or open).
   *
   * @param {import("../organizers/store.mjs").StoredBoardSession} session
   * @returns {{ok: true} | {ok: false, reason: string}}
   */
  function governanceWindowVerdict(session) {
    if (session.status === "scheduled") {
      if (clock() < session.startsAtMs - preparationWindowMs) {
        return { ok: false, reason: "event_not_open" };
      }
      return { ok: true };
    }
    if (session.status === "open") return { ok: true };
    return { ok: false, reason: "event_not_open" };
  }

  /**
   * Resolves the signed-in hosted account from a raw cookie header. Uses the
   * same digest lookup and expiry rules as the HTTP pages, so a socket can
   * never carry more identity than its browser session.
   *
   * @param {string | undefined} cookieHeader
   * @returns {{accountId: string, email: string} | null}
   */
  function accountFromCookieHeader(cookieHeader) {
    const rawSessionId = readHostedCookie(
      cookieHeader,
      HOSTED_SESSION_COOKIE_NAME,
    );
    if (!rawSessionId) return null;
    const session = accountStore.peekSession(rawSessionId);
    if (!session) return null;
    const account = accountStore.getAccountById(session.accountId);
    if (
      !account ||
      account.status !== "active" ||
      account.verifiedAtMs === null
    ) {
      return null;
    }
    return { accountId: account.accountId, email: account.email };
  }

  /**
   * Whether the account holds an Owner/Admin role in the event's organizer.
   *
   * @param {import("../organizers/store.mjs").StoredEvent} event
   * @param {string} accountId
   * @returns {boolean}
   */
  function isOwnerAdmin(event, accountId) {
    const role = organizerStore.getMemberRole(event.organizerId, accountId);
    return role === "owner" || role === "admin";
  }

  /**
   * The shared admission decision for one attempt to reach an event's Board
   * Session, by socket handshake or by board page load. This never registers
   * a connection: the previewed writability drives page first-paint, while
   * the socket layer reconciles the final role through
   * `noteEventSocketConnected` once the connection is truly established.
   *
   * Rejection reasons are coarse and stable; they never confirm or deny
   * anything the caller could not already know.
   *
   * @param {{
   *   boardName: string,
   *   cookieHeader: string | undefined,
   * }} input
   * @returns {{ok: true, role: "moderator" | "event_moderator" | "editor" | "reader", accountId: string, eventId: string, publicId: string, boardName: string, participantId: string, boardSessionId: string, seats: number} | {ok: false, reason: string}}
   */
  function admitEventBoard(input) {
    const boardName = String(input.boardName || "");
    if (!boardName.startsWith(HOSTED_BOARD_NAME_PREFIX)) {
      // Hosted mode serves no legacy or arbitrary boards: the only real-time
      // surfaces are event Board Sessions.
      return { ok: false, reason: "hosted_board_required" };
    }
    const event = organizerStore.getEventByBoardName(boardName);
    if (!event) return { ok: false, reason: "event_not_found" };
    const account = accountFromCookieHeader(input.cookieHeader);
    if (!account) return { ok: false, reason: "account_required" };
    if (event.status === "cancelled") {
      return { ok: false, reason: "event_not_open" };
    }
    if (membershipStore.isEventBanned(event.eventId, account.accountId)) {
      return { ok: false, reason: "event_banned" };
    }
    const session = organizerStore.getBoardSessionForEvent(event.eventId);
    if (!session || session.status === "cancelled") {
      return { ok: false, reason: "event_not_open" };
    }
    if (isOwnerAdmin(event, account.accountId)) {
      // The Preparation Window: Owner/Admin prepare the board shortly before
      // the planned start (the same 15-minute buffer the capacity window
      // uses) and stay admitted while open. Outside that window — a far-out
      // schedule or a closing/closed session — they are out like everyone.
      const windowVerdict = governanceWindowVerdict(session);
      if (windowVerdict.ok === false) return windowVerdict;
      return {
        ok: true,
        role: "moderator",
        accountId: account.accountId,
        eventId: event.eventId,
        publicId: event.publicId,
        boardName: event.boardName,
        participantId: participantIdentifierFor(
          event.eventId,
          account.accountId,
        ),
        boardSessionId: session.boardSessionId,
        seats: session.seats,
      };
    }
    if (organizerStore.isEventModerator(event.eventId, account.accountId)) {
      // Event Moderators share the Owner/Admin entry window and never
      // contend for Participant Seats; their capabilities stay scoped to
      // in-event governance on the board.
      const windowVerdict = governanceWindowVerdict(session);
      if (windowVerdict.ok === false) return windowVerdict;
      return {
        ok: true,
        role: "event_moderator",
        accountId: account.accountId,
        eventId: event.eventId,
        publicId: event.publicId,
        boardName: event.boardName,
        participantId: participantIdentifierFor(
          event.eventId,
          account.accountId,
        ),
        boardSessionId: session.boardSessionId,
        seats: session.seats,
      };
    }
    const membership = membershipStore.getMembership(
      event.eventId,
      account.accountId,
    );
    if (!membership) return { ok: false, reason: "membership_required" };
    if (session.status !== "open") {
      // Ordinary participants enter only once the Board Session is open.
      return { ok: false, reason: "event_not_open" };
    }
    if (
      event.entryLocked &&
      // The Entry Lock pauses all new entry: an account that does not
      // currently hold a seat (live or reconnect grace) cannot acquire one.
      // Seated accounts and grace reconnects keep their access.
      !seats.holdsSeat({
        eventId: event.eventId,
        accountId: account.accountId,
      })
    ) {
      return { ok: false, reason: "event_locked" };
    }
    const seatVerdict = seats.preview({
      eventId: event.eventId,
      accountId: account.accountId,
      seats: session.seats,
    });
    if (!seatVerdict.admitted) {
      return { ok: false, reason: seatVerdict.reason };
    }
    return {
      ok: true,
      role: seatVerdict.writable ? "editor" : "reader",
      accountId: account.accountId,
      eventId: event.eventId,
      publicId: event.publicId,
      boardName: event.boardName,
      participantId: participantIdentifierFor(event.eventId, account.accountId),
      boardSessionId: session.boardSessionId,
      seats: session.seats,
    };
  }

  /**
   * Live re-validation for a persistent write arriving over an admitted
   * socket. Lifecycle, bans, and the writer slot may all have changed since
   * the handshake; the stores are in-memory so this stays cheap enough for
   * per-message checks (never per-coordinate).
   *
   * @param {{eventId: string, accountId: string, role: "moderator" | "event_moderator" | "editor" | "reader", boardName: string, socketId?: string}} admission
   * @returns {{ok: true} | {ok: false, reason: string}}
   */
  function revalidateSocketWrite(admission) {
    const event = organizerStore.getEventByBoardName(admission.boardName);
    if (!event || event.status === "cancelled") {
      return { ok: false, reason: "event_not_open" };
    }
    if (membershipStore.isEventBanned(admission.eventId, admission.accountId)) {
      return { ok: false, reason: "event_banned" };
    }
    const session = organizerStore.getBoardSessionForEvent(admission.eventId);
    if (!session) return { ok: false, reason: "event_not_open" };
    if (isGovernanceRole(admission.role)) {
      const windowVerdict = governanceWindowVerdict(session);
      if (windowVerdict.ok === false) return windowVerdict;
      return { ok: true };
    }
    if (session.status !== "open") {
      return { ok: false, reason: "event_not_open" };
    }
    if (
      admission.role === "editor" &&
      !seats.isWriter({
        eventId: admission.eventId,
        accountId: admission.accountId,
        socketId: /** @type {string} */ (admission.socketId),
      })
    ) {
      // The account lost its writer slot after promotion moved elsewhere or
      // the connection was superseded; the socket stays read-only.
      return { ok: false, reason: "read_only_connection" };
    }
    return { ok: true };
  }

  return {
    /**
     * Socket handshake admission: the shared decision for a live connection.
     * The caller registers the established connection through
     * `noteEventSocketConnected` after replay succeeds, so a handshake that
     * never reaches `connection` cannot leak a seat.
     *
     * @param {{boardName: string, cookieHeader: string | undefined}} input
     * @returns {ReturnType<typeof admitEventBoard>}
     */
    admitEventBoardSocket(input) {
      return admitEventBoard(input);
    },

    /**
     * Board page admission by board name: the same decision as a socket
     * handshake, minus connection bookkeeping. The previewed writability
     * drives the page's first-paint capabilities; the socket that follows
     * settles the rest. Failures carry the event's Public ID when the event
     * itself resolved, so the route can route back to the event page.
     *
     * @param {{boardName: string, cookieHeader: string | undefined}} input
     * @returns {{ok: true, role: "moderator" | "event_moderator" | "editor" | "reader", accountId: string, eventId: string, publicId: string, boardName: string} | {ok: false, reason: string, publicId?: string}}
     */
    admitEventBoardPage(input) {
      const boardName = String(input.boardName || "");
      const verdict = admitEventBoard({
        boardName,
        cookieHeader: input.cookieHeader,
      });
      if (verdict.ok === true) return verdict;
      const event = organizerStore.getEventByBoardName(boardName);
      return event ? { ...verdict, publicId: event.publicId } : verdict;
    },

    /**
     * Reports an established live connection to the seat registry. Returns
     * whether the connection was admitted (re-checking capacity so racing
     * previews cannot oversubscribe) and whether it holds the account's
     * single writable slot; the caller derives the socket's final role from
     * it and must drop refused connections.
     *
     * @param {{eventId: string, accountId: string, role: "moderator" | "event_moderator" | "editor" | "reader", seats?: number}} admission
     * @param {string} socketId
     * @returns {{admitted: boolean, writable: boolean}}
     */
    noteEventSocketConnected(admission, socketId) {
      if (isGovernanceRole(admission.role)) {
        // Owner/Admin and Event Moderator presence never contends for
        // Participant Seats.
        return { admitted: true, writable: true };
      }
      const result = seats.connect({
        eventId: admission.eventId,
        accountId: admission.accountId,
        socketId,
        seats: /** @type {number} */ (admission.seats),
      });
      if (!result.admitted) {
        logger.warn("hosted.event_seat_race_lost", {
          event_id: admission.eventId,
          socket: socketId,
        });
        return { admitted: false, writable: false };
      }
      return { admitted: true, writable: result.writable };
    },

    /**
     * Reports a dropped connection by socket id. When the departing socket
     * held the account's writer slot and companions remain, the oldest
     * companion is promoted so the account keeps exactly one writable
     * connection. When the last connection drops, the seat enters the
     * reconnect grace window.
     *
     * @param {string} socketId
     * @returns {{promotedSocketId: string | null}}
     */
    releaseEventSocket(socketId) {
      // The location map routes the socket id back to its seat; connections
      // that were admitted but never registered (failed replay) resolve to
      // nothing and are ignored.
      const located = seats.disconnectBySocketId(socketId);
      if (!located) return { promotedSocketId: null };
      if (located.promotedSocketId) {
        logger.info("hosted.event_socket_promoted_to_writer", {
          event_id: located.eventId,
          socket: located.promotedSocketId,
        });
      }
      return { promotedSocketId: located.promotedSocketId };
    },

    revalidateSocketWrite,
  };
}

export { createEventAdmission, isGovernanceRole };
