/**
 * Participant Seat registry for Hosted Events.
 *
 * A Seat is held by a distinct Account inside one Event, never by a tab or
 * socket. While an Account has at least one live connection it occupies one
 * seat; its first live connection is the writable one and any further
 * connections (extra tabs, other devices) join as read-only. When the last
 * live connection drops, the seat stays reserved for a grace window so a
 * short network outage or refresh does not lose it; after the grace window
 * the seat is released lazily and must be re-acquired against the remaining
 * capacity.
 *
 * The registry is process-local by design: live connections die with the
 * process, so after a restart every Account simply re-contends for seats.
 * The injected clock (service time, not wall time) decides grace expiry.
 */

/**
 * @typedef {{
 *   connectionIds: Set<string>,
 *   writableId: string | null,
 *   graceUntilMs: number | null,
 * }} HeldSeat
 */

/**
 * @param {{
 *   clock?: () => number,
 *   graceMs?: number,
 * }} [options]
 */
function createSeatRegistry(options = {}) {
  const clock = options.clock || (() => Date.now());
  const graceMs =
    typeof options.graceMs === "number" && options.graceMs >= 0
      ? options.graceMs
      : 10 * 60 * 1000;

  /** @type {Map<string, Map<string, HeldSeat>>} */
  const seatsByEvent = new Map();
  /** @type {Map<string, {eventId: string, accountId: string}>} */
  const locationsBySocketId = new Map();

  /** @param {string} eventId */
  function eventSeats(eventId) {
    let seats = seatsByEvent.get(eventId);
    if (!seats) {
      seats = new Map();
      seatsByEvent.set(eventId, seats);
    }
    return seats;
  }

  /**
   * @param {string} eventId
   * @param {string} accountId
   * @returns {HeldSeat | undefined}
   */
  function liveSeat(eventId, accountId) {
    const seat = eventSeats(eventId).get(accountId);
    if (!seat) return undefined;
    if (seat.connectionIds.size === 0 && seat.graceUntilMs === null) {
      eventSeats(eventId).delete(accountId);
      return undefined;
    }
    return seat;
  }

  /**
   * Accounts currently occupying a seat: live connections plus grace-held
   * seats whose grace has not expired at `now`.
   * @param {string} eventId
   * @returns {number}
   */
  function occupiedSeats(eventId) {
    const now = clock();
    let occupied = 0;
    for (const seat of eventSeats(eventId).values()) {
      const live = seat.connectionIds.size > 0;
      const inGrace =
        seat.connectionIds.size === 0 &&
        seat.graceUntilMs !== null &&
        seat.graceUntilMs > now;
      if (live || inGrace) occupied += 1;
    }
    return occupied;
  }

  /**
   * Drops grace-held seats whose window has passed, so capacity they pin is
   * free again. Cheap enough to call on every admission decision.
   *
   * @param {string} eventId
   * @returns {void}
   */
  function releaseExpiredSeats(eventId) {
    const now = clock();
    const seats = eventSeats(eventId);
    for (const [accountId, seat] of seats) {
      if (
        seat.connectionIds.size === 0 &&
        seat.graceUntilMs !== null &&
        seat.graceUntilMs <= now
      ) {
        seats.delete(accountId);
      }
    }
  }

  /**
   * Whether the account currently holds a seat: a live connection or an
   * unexpired reconnect grace.
   *
   * @param {{eventId: string, accountId: string}} input
   * @returns {boolean}
   */
  function holdsSeat(input) {
    const seat = liveSeat(input.eventId, input.accountId);
    if (!seat) return false;
    if (seat.connectionIds.size > 0) return true;
    return seat.graceUntilMs !== null && seat.graceUntilMs > clock();
  }

  return {
    /**
     * Whether a fresh connection for the account can be admitted right now,
     * and whether it may claim the account's single writable slot. Capacity
     * is only consumed by an Account's first live connection — read-only
     * companions never need a new seat. The check is preview-only: no
     * connection is registered until `connect`, which re-checks capacity so
     * racing previews cannot oversubscribe the event.
     *
     * @param {{eventId: string, accountId: string, seats: number}} input
     * @returns {{admitted: true, writable: boolean} | {admitted: false, reason: "event_full"}}
     */
    preview(input) {
      releaseExpiredSeats(input.eventId);
      const seat = liveSeat(input.eventId, input.accountId);
      if (seat) {
        return {
          admitted: true,
          writable: seat.connectionIds.size === 0 || seat.writableId === null,
        };
      }
      if (occupiedSeats(input.eventId) >= input.seats) {
        return { admitted: false, reason: "event_full" };
      }
      return { admitted: true, writable: true };
    },

    /**
     * Whether the account currently holds a seat: a live connection or an
     * unexpired reconnect grace. Locked events refuse entry to accounts
     * without a held seat but never to seated ones.
     *
     * @param {{eventId: string, accountId: string}} input
     * @returns {boolean}
     */
    holdsSeat: (input) => holdsSeat(input),

    /**
     * Registers a live connection, re-checking capacity so two handshakes
     * whose previews raced ahead of their registrations cannot oversubscribe
     * the event: an account without a held seat is refused when the event is
     * full. Returns the socket's role in the account's connection set: the
     * first live connection of an account (or one re-claimed while the writer
     * slot is empty) is writable.
     *
     * @param {{eventId: string, accountId: string, socketId: string, seats: number}} input
     * @returns {{admitted: true, writable: boolean} | {admitted: false, reason: "event_full"}}
     */
    connect(input) {
      if (!holdsSeat(input)) {
        if (occupiedSeats(input.eventId) >= input.seats) {
          return { admitted: false, reason: "event_full" };
        }
      }
      const seat = eventSeats(input.eventId).get(input.accountId) || {
        connectionIds: new Set(),
        writableId: null,
        graceUntilMs: null,
      };
      seat.graceUntilMs = null;
      seat.connectionIds.add(input.socketId);
      const writable = seat.writableId === null;
      if (writable) seat.writableId = input.socketId;
      eventSeats(input.eventId).set(input.accountId, seat);
      locationsBySocketId.set(input.socketId, {
        eventId: input.eventId,
        accountId: input.accountId,
      });
      return { admitted: true, writable };
    },

    /**
     * Removes a live connection, resolving its seat through the socket id.
     * Returns the connection that was promoted to writer, if any: when the
     * writer leaves but the account keeps other live connections, the oldest
     * remaining one becomes writable so the account always has exactly one.
     * Unknown socket ids resolve to null.
     *
     * @param {string} socketId
     * @returns {{eventId: string, accountId: string, promotedSocketId: string | null} | null}
     */
    disconnectBySocketId(socketId) {
      const located = locationsBySocketId.get(socketId);
      if (!located) return null;
      locationsBySocketId.delete(socketId);
      const seat = eventSeats(located.eventId).get(located.accountId);
      if (!seat || !seat.connectionIds.delete(socketId)) {
        return { ...located, promotedSocketId: null };
      }
      let promotedSocketId = null;
      if (seat.writableId === socketId) {
        seat.writableId = null;
        if (seat.connectionIds.size > 0) {
          promotedSocketId = /** @type {string} */ (
            seat.connectionIds.values().next().value
          );
          seat.writableId = promotedSocketId;
        }
      }
      if (seat.connectionIds.size === 0) {
        // Keep the seat reserved through the grace window; expired seats are
        // dropped lazily by preview/release.
        seat.graceUntilMs = clock() + graceMs;
      }
      return { ...located, promotedSocketId };
    },

    /**
     * Whether the given connection currently holds the account's writer slot.
     *
     * @param {{eventId: string, accountId: string, socketId: string}} input
     * @returns {boolean}
     */
    isWriter(input) {
      return (
        liveSeat(input.eventId, input.accountId)?.writableId === input.socketId
      );
    },
  };
}

export { createSeatRegistry };
