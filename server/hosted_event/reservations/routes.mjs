import observability from "../../observability/index.mjs";
import { BoundaryError } from "../../http/boundary_errors.mjs";
import { resolveRequestClientIpSafe } from "../../socket/policy.mjs";
import { publicPath } from "../../http/request_url.mjs";
import {
  createFormSecurity,
  readFormBody,
  seeOther,
  translate,
} from "../http_forms.mjs";
import { createStoreLifecycleAdvancer } from "../lifecycle.mjs";
import {
  formatServiceTime,
  parseDateTimeLocal,
  toDateTimeLocal,
} from "../service_time.mjs";
import { resolveSignedInAccountFromRequest } from "../accounts/routes.mjs";

const { logger } = observability;

/** @import { HttpRequest, HttpResponse, HttpRouteContext, ServerConfig } from "../../../types/server-runtime.d.ts" */

/**
 * @typedef {import("../../http/templating.mjs").Template & {
 *   serveWithStatus: (request: HttpRequest, response: HttpResponse, statusCode: number, extraParams?: object) => {encoding?: unknown},
 * }} HostedTemplate
 */

const MAX_EVENT_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_OPERATOR_NOTE_LENGTH = 2000;

/** Reservation status -> translation key for a display badge. */
const STATUS_LABEL_KEYS = {
  draft: "hosted_reservation_status_draft",
  submitted: "hosted_reservation_status_submitted",
  approved: "hosted_reservation_status_approved",
  rejected: "hosted_reservation_status_rejected",
  cancelled: "hosted_reservation_status_cancelled",
};

/** Board Session lifecycle status -> translation key. */
const SESSION_STATUS_LABEL_KEYS = {
  scheduled: "hosted_session_status_scheduled",
  open: "hosted_session_status_open",
  closing: "hosted_session_status_closing",
  closed: "hosted_session_status_closed",
  cancelled: "hosted_session_status_cancelled",
};

/** Change Request status -> translation key. */
const CHANGE_STATUS_LABEL_KEYS = {
  pending: "hosted_change_status_pending",
  applied: "hosted_change_status_applied",
  rejected: "hosted_change_status_rejected",
};

/** Change Request kind -> translation key. */
const CHANGE_KIND_LABEL_KEYS = {
  amend: "hosted_change_kind_amend",
  cancel: "hosted_change_kind_cancel",
};

/**
 * HTTP flows for Reservations and their Platform Operator approval.
 *
 * Organizer members (owner or admin) draft, edit, and submit reservations;
 * after submission the approval-affecting fields are frozen. A Platform Operator
 * approves — within the concurrent capacity limits, minting an unguessable Event
 * Public ID — or rejects. All inputs are hostile until validated and every
 * failure is deterministic.
 *
 * @param {{
 *   config: ServerConfig,
 *   accountStore: ReturnType<typeof import("../accounts/store.mjs").createFileAccountStore>,
 *   organizerStore: ReturnType<typeof import("../organizers/store.mjs").createFileOrganizerStore>,
 *   limiter: ReturnType<typeof import("../accounts/rate_limits.mjs").createRateLimiter>,
 *   operatorEmails: Set<string>,
 *   advanceEventLifecycle?: () => Promise<void>,
 *   templates: {
 *     organizerReservations: HostedTemplate,
 *     organizerReservation: HostedTemplate,
 *     operatorReservations: HostedTemplate,
 *     operatorReservation: HostedTemplate,
 *     operatorChanges: HostedTemplate,
 *     operatorChange: HostedTemplate,
 *   },
 *   clock?: () => number,
 * }} dependencies
 */
function createReservationRoutes(dependencies) {
  const {
    config,
    accountStore,
    organizerStore,
    limiter,
    operatorEmails,
    templates,
  } = dependencies;
  const clock = dependencies.clock || (() => Date.now());
  const { ensureCsrfToken, requestHasValidCsrf } = createFormSecurity(config);
  const offsetMinutes = config.HOSTED_SERVICE_UTC_OFFSET_MINUTES;

  const capacityOptions = () => ({
    bufferMs: config.HOSTED_CAPACITY_WINDOW_BUFFER_MS,
    sessionLimit: config.HOSTED_MAX_CONCURRENT_BOARD_SESSIONS,
    seatLimit: config.HOSTED_MAX_CONCURRENT_SEATS,
  });

  /**
   * Lazily runs the durable lifecycle advancement and the Board Session close
   * pipeline, so any page or decision that reads Board Session state sees the
   * authoritative status at the current service clock. Idempotent, so calling
   * it on every read is safe. The composed module injects the full refresh
   * (including closes); the standalone default only advances the lifecycle.
   */
  const advanceLifecycleNow =
    dependencies.advanceEventLifecycle ||
    createStoreLifecycleAdvancer({ organizerStore, clock, config });

  /**
   * @param {HttpRouteContext} ctx
   * @returns {{accountId: string, email: string, publicId: string} | null}
   */
  function signedInAccount(ctx) {
    return resolveSignedInAccountFromRequest(accountStore, ctx.request);
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void}
   */
  function redirectToLogin(ctx) {
    seeOther(ctx, publicPath(config, "/login"));
  }

  /**
   * @param {number} ms
   * @returns {string}
   */
  function formatTimestamp(ms) {
    return formatServiceTime(ms, offsetMinutes);
  }

  /**
   * Resolves the signed-in account's membership in an organizer. Signed-out ->
   * login redirect (returns null); signed-in non-member -> 404 so the
   * organizer's existence is not disclosed.
   *
   * @param {HttpRouteContext} ctx
   * @param {string} organizerId
   * @returns {{accountId: string, email: string} | null}
   */
  function requireMember(ctx, organizerId) {
    const account = signedInAccount(ctx);
    if (!account) {
      redirectToLogin(ctx);
      return null;
    }
    const role = organizerStore.getMemberRole(organizerId, account.accountId);
    if (!role || !organizerStore.getOrganizerById(organizerId)) {
      throw new BoundaryError(404, "organizer_not_found");
    }
    return account;
  }

  /**
   * Resolves a Platform Operator. Signed-out -> login redirect; signed-in
   * non-operator -> 403.
   *
   * @param {HttpRouteContext} ctx
   * @returns {{accountId: string, email: string} | null}
   */
  function requireOperator(ctx) {
    const account = signedInAccount(ctx);
    if (!account) {
      redirectToLogin(ctx);
      return null;
    }
    if (!operatorEmails.has(account.email)) {
      throw new BoundaryError(403, "operator_required");
    }
    return account;
  }

  /**
   * Validates the scheduling fields (start, end, requested seats) shared by
   * reservations and change requests: parseable times, end after start, within
   * the maximum duration, optionally a future start, and a seat count in range.
   *
   * @param {URLSearchParams} form
   * @param {{requireFuture: boolean, now: number}} options
   * @returns {{ok: true, startsAtMs: number, endsAtMs: number, requestedSeats: number} | {ok: false, errorKey: string}}
   */
  function validateScheduleFields(form, options) {
    const startsAtMs = parseDateTimeLocal(form.get("startsAt"), offsetMinutes);
    const endsAtMs = parseDateTimeLocal(form.get("endsAt"), offsetMinutes);
    if (startsAtMs === null || endsAtMs === null) {
      return { ok: false, errorKey: "hosted_reservation_error_time" };
    }
    if (endsAtMs <= startsAtMs) {
      return { ok: false, errorKey: "hosted_reservation_error_time_order" };
    }
    if (endsAtMs - startsAtMs > config.HOSTED_MAX_EVENT_DURATION_MS) {
      return { ok: false, errorKey: "hosted_reservation_error_duration" };
    }
    if (options.requireFuture && startsAtMs <= options.now) {
      return { ok: false, errorKey: "hosted_reservation_error_past" };
    }
    const seatsRaw = (form.get("requestedSeats") || "").trim();
    const requestedSeats = Number.parseInt(seatsRaw, 10);
    if (
      !/^\d+$/.test(seatsRaw) ||
      requestedSeats < 1 ||
      requestedSeats > config.HOSTED_MAX_RESERVATION_SEATS
    ) {
      return { ok: false, errorKey: "hosted_reservation_error_seats" };
    }
    return { ok: true, startsAtMs, endsAtMs, requestedSeats };
  }

  /**
   * Validates reservation form input. `requireFuture` additionally requires the
   * start to be in the future (enforced at submit).
   *
   * @param {URLSearchParams} form
   * @param {{requireFuture: boolean, now: number}} options
   * @returns {{ok: true, parsed: {eventName: string, description: string, visibility: "public" | "unlisted", startsAtMs: number, endsAtMs: number, requestedSeats: number}} | {ok: false, errorKey: string}}
   */
  function validateReservation(form, options) {
    const eventName = (form.get("eventName") || "").trim();
    if (eventName.length < 1 || eventName.length > MAX_EVENT_NAME_LENGTH) {
      return { ok: false, errorKey: "hosted_reservation_error_name" };
    }
    const schedule = validateScheduleFields(form, options);
    if (!schedule.ok) return schedule;
    const description = (form.get("description") || "").trim();
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      return { ok: false, errorKey: "hosted_reservation_error_description" };
    }
    return {
      ok: true,
      parsed: {
        eventName,
        description,
        visibility: form.get("visibility") === "public" ? "public" : "unlisted",
        startsAtMs: schedule.startsAtMs,
        endsAtMs: schedule.endsAtMs,
        requestedSeats: schedule.requestedSeats,
      },
    };
  }

  /**
   * Validates a Change Request proposal (new start/end/seats), reusing the
   * shared scheduling rules and always requiring a future start.
   *
   * @param {URLSearchParams} form
   * @param {number} now
   * @returns {{ok: true, parsed: {proposedStartsAtMs: number, proposedEndsAtMs: number, proposedSeats: number}} | {ok: false, errorKey: string}}
   */
  function validateChange(form, now) {
    const schedule = validateScheduleFields(form, { requireFuture: true, now });
    if (!schedule.ok) return schedule;
    return {
      ok: true,
      parsed: {
        proposedStartsAtMs: schedule.startsAtMs,
        proposedEndsAtMs: schedule.endsAtMs,
        proposedSeats: schedule.requestedSeats,
      },
    };
  }

  // --- organizer reservation management ------------------------------------

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void | Promise<void>}
   */
  function serveOrganizerReservations(ctx) {
    if (ctx.request.method === "POST") return handleCreateReservation(ctx);
    if (ctx.request.method === "GET") {
      const organizerId = ctx.params.organizerId || "";
      const account = requireMember(ctx, organizerId);
      if (!account) return;
      renderReservationList(ctx, organizerId, 200, {});
      return;
    }
    throw new BoundaryError(405, "method_not_allowed");
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {string} organizerId
   * @param {number} statusCode
   * @param {{errorKey?: string, values?: {[key: string]: string}}} state
   * @returns {void}
   */
  function renderReservationList(ctx, organizerId, statusCode, state) {
    const template = templates.organizerReservations;
    const organizer = organizerStore.getOrganizerById(organizerId);
    if (!organizer) throw new BoundaryError(404, "organizer_not_found");
    const reservations = organizerStore
      .listReservationsForOrganizer(organizerId)
      .map((reservation) => ({
        reservationId: reservation.reservationId,
        eventName: reservation.eventName,
        statusLabel: translate(
          template,
          ctx,
          STATUS_LABEL_KEYS[reservation.status],
        ),
        startsAt: formatTimestamp(reservation.startsAtMs),
        requestedSeats: reservation.requestedSeats,
      }));
    const values = state.values || {};
    template.serveWithStatus(ctx.request, ctx.response, statusCode, {
      hostedOrganizerId: organizerId,
      hostedOrganizerName: organizer.name,
      hostedReservations: reservations,
      hostedHasReservations: reservations.length > 0,
      hostedReservationError: state.errorKey
        ? translate(template, ctx, state.errorKey)
        : undefined,
      hostedReservationSeatMax: config.HOSTED_MAX_RESERVATION_SEATS,
      hostedReservationNameValue: values.eventName || "",
      hostedReservationStartValue: values.startsAt || "",
      hostedReservationEndValue: values.endsAt || "",
      hostedReservationSeatsValue: values.requestedSeats || "",
      hostedReservationDescriptionValue: values.description || "",
      hostedReservationVisibilityPublic: values.visibility === "public",
      csrfToken: ensureCsrfToken(ctx),
    });
  }

  /**
   * @param {URLSearchParams} form
   * @returns {{[key: string]: string}}
   */
  function echoValues(form) {
    return {
      visibility: form.get("visibility") === "public" ? "public" : "unlisted",
      eventName: (form.get("eventName") || "").trim(),
      startsAt: (form.get("startsAt") || "").trim(),
      endsAt: (form.get("endsAt") || "").trim(),
      requestedSeats: (form.get("requestedSeats") || "").trim(),
      description: (form.get("description") || "").trim(),
    };
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {string} accountId
   * @returns {boolean}
   */
  function withinRateLimit(ctx, accountId) {
    const address = resolveRequestClientIpSafe(config, ctx.request);
    const limit = config.HOSTED_RESERVATION_ATTEMPTS_LIMIT;
    const windowMs = config.HOSTED_RESERVATION_ATTEMPTS_WINDOW_MS;
    return (
      limiter.consume("reservation", `account:${accountId}`, limit, windowMs)
        .allowed &&
      limiter.consume("reservation", `ip:${address}`, limit, windowMs).allowed
    );
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleCreateReservation(ctx) {
    const organizerId = ctx.params.organizerId || "";
    const account = requireMember(ctx, organizerId);
    if (!account) return;
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderReservationList(ctx, organizerId, 403, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    if (!withinRateLimit(ctx, account.accountId)) {
      renderReservationList(ctx, organizerId, 429, {
        errorKey: "hosted_error_rate_limited",
      });
      return;
    }
    const validation = validateReservation(form, {
      requireFuture: false,
      now: clock(),
    });
    if (!validation.ok) {
      renderReservationList(ctx, organizerId, 400, {
        errorKey: validation.errorKey,
        values: echoValues(form),
      });
      return;
    }
    const created = await organizerStore.createReservation({
      organizerId,
      createdByAccountId: account.accountId,
      ...validation.parsed,
    });
    logger.info("hosted.reservation_created", {
      organizer_id: organizerId,
      reservation_id: created.reservation.reservationId,
    });
    seeOther(
      ctx,
      publicPath(
        config,
        `/organizers/${organizerId}/reservations/${created.reservation.reservationId}`,
      ),
    );
  }

  /**
   * Loads a reservation that belongs to the organizer in the path, or 404.
   *
   * @param {string} organizerId
   * @param {string} reservationId
   * @returns {import("../organizers/store.mjs").StoredReservation}
   */
  function loadOwnedReservation(organizerId, reservationId) {
    const reservation = organizerStore.getReservationById(reservationId);
    if (!reservation || reservation.organizerId !== organizerId) {
      throw new BoundaryError(404, "reservation_not_found");
    }
    return reservation;
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void | Promise<void>}
   */
  function serveOrganizerReservation(ctx) {
    if (ctx.request.method === "POST") return handleUpdateReservation(ctx);
    if (ctx.request.method === "GET") return handleReservationDetailGet(ctx);
    throw new BoundaryError(405, "method_not_allowed");
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleReservationDetailGet(ctx) {
    const organizerId = ctx.params.organizerId || "";
    const account = requireMember(ctx, organizerId);
    if (!account) return;
    const reservation = loadOwnedReservation(
      organizerId,
      ctx.params.reservationId || "",
    );
    // Advance the durable lifecycle so the displayed status is authoritative.
    await advanceLifecycleNow();
    renderReservationDetail(ctx, organizerId, reservation, 200, {});
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {string} organizerId
   * @param {import("../organizers/store.mjs").StoredReservation} reservation
   * @param {number} statusCode
   * @param {{errorKey?: string}} state
   * @returns {void}
   */
  function renderReservationDetail(
    ctx,
    organizerId,
    reservation,
    statusCode,
    state,
  ) {
    const template = templates.organizerReservation;
    const event = reservation.eventId
      ? organizerStore.getEventById(reservation.eventId)
      : null;
    const session = organizerStore.getBoardSessionForReservation(
      reservation.reservationId,
    );
    const now = clock();
    // A future (still scheduled) approved event can be amended or cancelled.
    const isApprovedScheduled =
      reservation.status === "approved" &&
      !!session &&
      session.status === "scheduled" &&
      now < session.startsAtMs;
    const pendingChange = organizerStore.getPendingChangeRequestForReservation(
      reservation.reservationId,
    );
    /** @param {import("../organizers/store.mjs").StoredChangeRequest} request */
    const proposedSummary = (request) =>
      `${formatTimestamp(request.proposedStartsAtMs ?? reservation.startsAtMs)} → ${formatTimestamp(request.proposedEndsAtMs ?? reservation.endsAtMs)} · ${request.proposedSeats ?? reservation.requestedSeats}`;
    const changeHistory = organizerStore
      .listChangeRequestsForReservation(reservation.reservationId)
      .map((request) => ({
        kindLabel: translate(
          template,
          ctx,
          CHANGE_KIND_LABEL_KEYS[request.kind],
        ),
        statusLabel: translate(
          template,
          ctx,
          CHANGE_STATUS_LABEL_KEYS[request.status],
        ),
        createdAt: formatTimestamp(request.createdAtMs),
        proposedSummary:
          request.kind === "amend" ? proposedSummary(request) : undefined,
      }));
    template.serveWithStatus(ctx.request, ctx.response, statusCode, {
      hostedOrganizerId: organizerId,
      hostedReservationId: reservation.reservationId,
      hostedReservationName: reservation.eventName,
      hostedReservationDescription: reservation.description || undefined,
      hostedReservationStatusLabel: translate(
        template,
        ctx,
        STATUS_LABEL_KEYS[reservation.status],
      ),
      hostedReservationIsDraft: reservation.status === "draft",
      hostedReservationIsSubmitted: reservation.status === "submitted",
      hostedReservationIsApproved: reservation.status === "approved",
      hostedReservationIsRejected: reservation.status === "rejected",
      hostedReservationCancellable:
        reservation.status === "draft" ||
        reservation.status === "submitted" ||
        isApprovedScheduled,
      hostedReservationLifecycleLabel: session
        ? translate(template, ctx, SESSION_STATUS_LABEL_KEYS[session.status])
        : undefined,
      hostedReservationCanRequestChange: isApprovedScheduled && !pendingChange,
      hostedReservationPendingChange: pendingChange
        ? {
            statusLabel: translate(
              template,
              ctx,
              CHANGE_STATUS_LABEL_KEYS[pendingChange.status],
            ),
            summary: proposedSummary(pendingChange),
          }
        : undefined,
      hostedReservationChangeHistory: changeHistory,
      hostedReservationHasChangeHistory: changeHistory.length > 0,
      hostedReservationVisibilityPublic: reservation.visibility === "public",
      hostedReservationStartValue: toDateTimeLocal(
        reservation.startsAtMs,
        offsetMinutes,
      ),
      hostedReservationEndValue: toDateTimeLocal(
        reservation.endsAtMs,
        offsetMinutes,
      ),
      hostedReservationStartAt: formatTimestamp(reservation.startsAtMs),
      hostedReservationEndAt: formatTimestamp(reservation.endsAtMs),
      hostedReservationSeats: reservation.requestedSeats,
      hostedReservationSeatMax: config.HOSTED_MAX_RESERVATION_SEATS,
      hostedReservationVisibilityLabel: translate(
        template,
        ctx,
        reservation.visibility === "public"
          ? "hosted_reservation_visibility_public"
          : "hosted_reservation_visibility_unlisted",
      ),
      hostedReservationEventPublicPath: event
        ? publicPath(config, `/events/${event.publicId}`)
        : undefined,
      hostedReservationEventManagePath: event
        ? `organizers/${organizerId}/events/${event.eventId}`
        : undefined,
      hostedReservationError: state.errorKey
        ? translate(template, ctx, state.errorKey)
        : undefined,
      csrfToken: ensureCsrfToken(ctx),
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleUpdateReservation(ctx) {
    const organizerId = ctx.params.organizerId || "";
    const account = requireMember(ctx, organizerId);
    if (!account) return;
    const reservation = loadOwnedReservation(
      organizerId,
      ctx.params.reservationId || "",
    );
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderReservationDetail(ctx, organizerId, reservation, 403, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    if (reservation.status !== "draft") {
      // Approval-affecting fields are frozen after submission.
      renderReservationDetail(ctx, organizerId, reservation, 409, {
        errorKey: "hosted_reservation_error_locked",
      });
      return;
    }
    const validation = validateReservation(form, {
      requireFuture: false,
      now: clock(),
    });
    if (!validation.ok) {
      renderReservationDetail(ctx, organizerId, reservation, 400, {
        errorKey: validation.errorKey,
      });
      return;
    }
    await organizerStore.updateReservation({
      reservationId: reservation.reservationId,
      ...validation.parsed,
    });
    seeOther(
      ctx,
      publicPath(
        config,
        `/organizers/${organizerId}/reservations/${reservation.reservationId}`,
      ),
    );
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveSubmitReservation(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const account = requireMember(ctx, organizerId);
    if (!account) return;
    const reservation = loadOwnedReservation(
      organizerId,
      ctx.params.reservationId || "",
    );
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderReservationDetail(ctx, organizerId, reservation, 403, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    if (!withinRateLimit(ctx, account.accountId)) {
      renderReservationDetail(ctx, organizerId, reservation, 429, {
        errorKey: "hosted_error_rate_limited",
      });
      return;
    }
    // Re-validate the stored draft (structural legality + future start) before
    // freezing it for approval.
    const validation = validateReservation(
      new URLSearchParams({
        eventName: reservation.eventName,
        startsAt: toDateTimeLocal(reservation.startsAtMs, offsetMinutes),
        endsAt: toDateTimeLocal(reservation.endsAtMs, offsetMinutes),
        requestedSeats: String(reservation.requestedSeats),
        visibility: reservation.visibility,
        description: reservation.description,
      }),
      { requireFuture: true, now: clock() },
    );
    if (!validation.ok) {
      renderReservationDetail(ctx, organizerId, reservation, 400, {
        errorKey: validation.errorKey,
      });
      return;
    }
    const result = await organizerStore.submitReservation({
      reservationId: reservation.reservationId,
      actorAccountId: account.accountId,
      now: clock(),
    });
    if (!result.ok) {
      renderReservationDetail(ctx, organizerId, reservation, 409, {
        errorKey: "hosted_reservation_error_not_draft",
      });
      return;
    }
    logger.info("hosted.reservation_submitted", {
      organizer_id: organizerId,
      reservation_id: reservation.reservationId,
    });
    seeOther(
      ctx,
      publicPath(
        config,
        `/organizers/${organizerId}/reservations/${reservation.reservationId}`,
      ),
    );
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveCancelReservation(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const account = requireMember(ctx, organizerId);
    if (!account) return;
    const reservation = loadOwnedReservation(
      organizerId,
      ctx.params.reservationId || "",
    );
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderReservationDetail(ctx, organizerId, reservation, 403, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    // Approved (future) events are cancelled through the lifecycle-aware path,
    // which releases capacity; draft/submitted are simple withdrawals. Advance
    // first so a just-started event is correctly refused.
    if (reservation.status === "approved") {
      await advanceLifecycleNow();
      const result = await organizerStore.cancelApprovedEvent({
        reservationId: reservation.reservationId,
        organizerId,
        actorAccountId: account.accountId,
        now: clock(),
      });
      if (!result.ok) {
        renderReservationDetail(ctx, organizerId, reservation, 409, {
          errorKey:
            result.reason === "not_future"
              ? "hosted_change_error_not_future"
              : "hosted_reservation_error_not_cancellable",
        });
        return;
      }
      logger.info("hosted.event_cancelled", {
        organizer_id: organizerId,
        reservation_id: reservation.reservationId,
      });
    } else {
      const result = await organizerStore.cancelReservation({
        reservationId: reservation.reservationId,
        actorAccountId: account.accountId,
      });
      if (!result.ok) {
        renderReservationDetail(ctx, organizerId, reservation, 409, {
          errorKey: "hosted_reservation_error_not_cancellable",
        });
        return;
      }
    }
    seeOther(
      ctx,
      publicPath(
        config,
        `/organizers/${organizerId}/reservations/${reservation.reservationId}`,
      ),
    );
  }

  /**
   * Submits an amend Reservation Change Request for an approved, future event.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveSubmitChangeRequest(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const account = requireMember(ctx, organizerId);
    if (!account) return;
    const reservation = loadOwnedReservation(
      organizerId,
      ctx.params.reservationId || "",
    );
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderReservationDetail(ctx, organizerId, reservation, 403, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    if (!withinRateLimit(ctx, account.accountId)) {
      renderReservationDetail(ctx, organizerId, reservation, 429, {
        errorKey: "hosted_error_rate_limited",
      });
      return;
    }
    await advanceLifecycleNow();
    const validation = validateChange(form, clock());
    if (!validation.ok) {
      renderReservationDetail(ctx, organizerId, reservation, 400, {
        errorKey: validation.errorKey,
      });
      return;
    }
    const result = await organizerStore.submitChangeRequest({
      reservationId: reservation.reservationId,
      organizerId,
      ...validation.parsed,
      requestedByAccountId: account.accountId,
    });
    if (!result.ok) {
      const errorKey =
        result.reason === "already_pending"
          ? "hosted_change_error_pending"
          : result.reason === "not_scheduled"
            ? "hosted_change_error_not_scheduled"
            : "hosted_change_error_not_approved";
      renderReservationDetail(ctx, organizerId, reservation, 409, { errorKey });
      return;
    }
    logger.info("hosted.change_request_submitted", {
      organizer_id: organizerId,
      reservation_id: reservation.reservationId,
      change_request_id: result.changeRequest.changeRequestId,
    });
    seeOther(
      ctx,
      publicPath(
        config,
        `/organizers/${organizerId}/reservations/${reservation.reservationId}`,
      ),
    );
  }

  // --- operator reservation review -----------------------------------------

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void}
   */
  function serveOperatorReservations(ctx) {
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const operator = requireOperator(ctx);
    if (!operator) return;
    // Rendered through the operator-reservation template's queue mode.
    renderOperatorQueue(ctx);
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void}
   */
  function renderOperatorQueue(ctx) {
    const template = templates.operatorReservations;
    const pending = organizerStore
      .listSubmittedReservations()
      .map((reservation) => {
        const organizer = organizerStore.getOrganizerById(
          reservation.organizerId,
        );
        return {
          reservationId: reservation.reservationId,
          organizerName: organizer ? organizer.name : "",
          eventName: reservation.eventName,
          startsAt: formatTimestamp(reservation.startsAtMs),
          requestedSeats: reservation.requestedSeats,
        };
      });
    template.serveWithStatus(ctx.request, ctx.response, 200, {
      hostedOperatorReservations: pending,
      hostedOperatorHasReservations: pending.length > 0,
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void}
   */
  function serveOperatorReservation(ctx) {
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const operator = requireOperator(ctx);
    if (!operator) return;
    const reservation = organizerStore.getReservationById(
      ctx.params.reservationId || "",
    );
    if (!reservation) throw new BoundaryError(404, "reservation_not_found");
    renderOperatorReservation(ctx, reservation, 200, {});
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {import("../organizers/store.mjs").StoredReservation} reservation
   * @param {number} statusCode
   * @param {{noticeKey?: string}} state
   * @returns {void}
   */
  function renderOperatorReservation(ctx, reservation, statusCode, state) {
    const template = templates.operatorReservation;
    const organizer = organizerStore.getOrganizerById(reservation.organizerId);
    const impact =
      reservation.status === "submitted"
        ? organizerStore.capacityImpact({
            reservationId: reservation.reservationId,
            ...capacityOptions(),
          })
        : null;
    template.serveWithStatus(ctx.request, ctx.response, statusCode, {
      hostedReservationId: reservation.reservationId,
      hostedReservationOrganizerName: organizer ? organizer.name : "",
      hostedReservationName: reservation.eventName,
      hostedReservationDescription: reservation.description || undefined,
      hostedReservationStartAt: formatTimestamp(reservation.startsAtMs),
      hostedReservationEndAt: formatTimestamp(reservation.endsAtMs),
      hostedReservationSeats: reservation.requestedSeats,
      hostedReservationStatusLabel: translate(
        template,
        ctx,
        STATUS_LABEL_KEYS[reservation.status],
      ),
      hostedReservationIsSubmitted: reservation.status === "submitted",
      hostedReservationVisibilityLabel: translate(
        template,
        ctx,
        reservation.visibility === "public"
          ? "hosted_reservation_visibility_public"
          : "hosted_reservation_visibility_unlisted",
      ),
      hostedCapacity: impact
        ? {
            sessions: impact.maxSessions,
            sessionLimit: impact.sessionLimit,
            seats: impact.maxSeats,
            seatLimit: impact.seatLimit,
            wouldExceed: impact.wouldExceed,
          }
        : undefined,
      hostedOperatorReservationNotice: state.noticeKey
        ? translate(template, ctx, state.noticeKey)
        : undefined,
      csrfToken: ensureCsrfToken(ctx),
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {"approve" | "reject"} decision
   * @returns {Promise<void>}
   */
  async function handleDecision(ctx, decision) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const operator = requireOperator(ctx);
    if (!operator) return;
    const reservation = organizerStore.getReservationById(
      ctx.params.reservationId || "",
    );
    if (!reservation) throw new BoundaryError(404, "reservation_not_found");
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderOperatorReservation(ctx, reservation, 403, {
        noticeKey: "hosted_error_csrf",
      });
      return;
    }
    if (decision === "approve") {
      const result = await organizerStore.approveReservation({
        reservationId: reservation.reservationId,
        operatorAccountId: operator.accountId,
        now: clock(),
        ...capacityOptions(),
      });
      if (!result.ok) {
        const current =
          organizerStore.getReservationById(reservation.reservationId) ||
          reservation;
        const noticeKey =
          result.reason === "capacity"
            ? "hosted_operator_reservation_capacity_conflict"
            : result.reason === "past_start"
              ? "hosted_operator_reservation_past_start"
              : "hosted_operator_reservation_not_submitted";
        renderOperatorReservation(ctx, current, 409, { noticeKey });
        return;
      }
      logger.info("hosted.reservation_approved", {
        operator_account_id: operator.accountId,
        reservation_id: reservation.reservationId,
        event_id: result.eventId,
      });
    } else {
      const result = await organizerStore.rejectReservation({
        reservationId: reservation.reservationId,
        operatorAccountId: operator.accountId,
        note: (form.get("note") || "").slice(0, MAX_OPERATOR_NOTE_LENGTH),
      });
      if (!result.ok) {
        const current =
          organizerStore.getReservationById(reservation.reservationId) ||
          reservation;
        renderOperatorReservation(ctx, current, 409, {
          noticeKey: "hosted_operator_reservation_not_submitted",
        });
        return;
      }
      logger.info("hosted.reservation_rejected", {
        operator_account_id: operator.accountId,
        reservation_id: reservation.reservationId,
      });
    }
    seeOther(
      ctx,
      publicPath(config, `/operator/reservations/${reservation.reservationId}`),
    );
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  function serveOperatorApproveReservation(ctx) {
    return handleDecision(ctx, "approve");
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  function serveOperatorRejectReservation(ctx) {
    return handleDecision(ctx, "reject");
  }

  // --- operator change request review --------------------------------------

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void | Promise<void>}
   */
  function serveOperatorChanges(ctx) {
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const operator = requireOperator(ctx);
    if (!operator) return;
    return renderOperatorChangeQueue(ctx);
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function renderOperatorChangeQueue(ctx) {
    await advanceLifecycleNow();
    const template = templates.operatorChanges;
    const pending = organizerStore
      .listPendingChangeRequests()
      .map((request) => {
        const reservation = organizerStore.getReservationById(
          request.reservationId,
        );
        const organizer = reservation
          ? organizerStore.getOrganizerById(reservation.organizerId)
          : null;
        return {
          changeRequestId: request.changeRequestId,
          organizerName: organizer ? organizer.name : "",
          eventName: reservation ? reservation.eventName : "",
          proposedStart: formatTimestamp(request.proposedStartsAtMs ?? 0),
          proposedSeats: request.proposedSeats ?? 0,
        };
      });
    template.serveWithStatus(ctx.request, ctx.response, 200, {
      hostedOperatorChanges: pending,
      hostedOperatorHasChanges: pending.length > 0,
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void | Promise<void>}
   */
  function serveOperatorChange(ctx) {
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const operator = requireOperator(ctx);
    if (!operator) return;
    return renderOperatorChangeDetailGet(ctx);
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function renderOperatorChangeDetailGet(ctx) {
    await advanceLifecycleNow();
    const request = organizerStore.getChangeRequestById(
      ctx.params.changeRequestId || "",
    );
    if (!request) throw new BoundaryError(404, "change_request_not_found");
    renderOperatorChange(ctx, request, 200, {});
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {import("../organizers/store.mjs").StoredChangeRequest} request
   * @param {number} statusCode
   * @param {{noticeKey?: string}} state
   * @returns {void}
   */
  function renderOperatorChange(ctx, request, statusCode, state) {
    const template = templates.operatorChange;
    const reservation = organizerStore.getReservationById(
      request.reservationId,
    );
    const organizer = reservation
      ? organizerStore.getOrganizerById(reservation.organizerId)
      : null;
    const impact =
      request.status === "pending" && request.kind === "amend"
        ? organizerStore.changeRequestCapacityImpact({
            changeRequestId: request.changeRequestId,
            ...capacityOptions(),
          })
        : null;
    const currentStart = reservation ? reservation.startsAtMs : 0;
    const currentEnd = reservation ? reservation.endsAtMs : 0;
    const currentSeats = reservation ? reservation.requestedSeats : 0;
    template.serveWithStatus(ctx.request, ctx.response, statusCode, {
      hostedChangeRequestId: request.changeRequestId,
      hostedChangeOrganizerName: organizer ? organizer.name : "",
      hostedChangeEventName: reservation ? reservation.eventName : "",
      hostedChangeKindLabel: translate(
        template,
        ctx,
        CHANGE_KIND_LABEL_KEYS[request.kind],
      ),
      hostedChangeStatusLabel: translate(
        template,
        ctx,
        CHANGE_STATUS_LABEL_KEYS[request.status],
      ),
      hostedChangeIsPending: request.status === "pending",
      hostedChangeCurrentStart: formatTimestamp(currentStart),
      hostedChangeCurrentEnd: formatTimestamp(currentEnd),
      hostedChangeCurrentSeats: currentSeats,
      hostedChangeProposedStart: formatTimestamp(
        request.proposedStartsAtMs ?? currentStart,
      ),
      hostedChangeProposedEnd: formatTimestamp(
        request.proposedEndsAtMs ?? currentEnd,
      ),
      hostedChangeProposedSeats: request.proposedSeats ?? currentSeats,
      hostedCapacity: impact
        ? {
            sessions: impact.maxSessions,
            sessionLimit: impact.sessionLimit,
            seats: impact.maxSeats,
            seatLimit: impact.seatLimit,
            wouldExceed: impact.wouldExceed,
          }
        : undefined,
      hostedOperatorChangeNotice: state.noticeKey
        ? translate(template, ctx, state.noticeKey)
        : undefined,
      csrfToken: ensureCsrfToken(ctx),
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {"approve" | "reject"} decision
   * @returns {Promise<void>}
   */
  async function handleChangeDecision(ctx, decision) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const operator = requireOperator(ctx);
    if (!operator) return;
    const request = organizerStore.getChangeRequestById(
      ctx.params.changeRequestId || "",
    );
    if (!request) throw new BoundaryError(404, "change_request_not_found");
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderOperatorChange(ctx, request, 403, {
        noticeKey: "hosted_error_csrf",
      });
      return;
    }
    await advanceLifecycleNow();
    if (decision === "approve") {
      const result = await organizerStore.approveChangeRequest({
        changeRequestId: request.changeRequestId,
        operatorAccountId: operator.accountId,
        now: clock(),
        ...capacityOptions(),
      });
      if (!result.ok) {
        const current =
          organizerStore.getChangeRequestById(request.changeRequestId) ||
          request;
        const noticeKey =
          result.reason === "capacity"
            ? "hosted_operator_reservation_capacity_conflict"
            : result.reason === "past_start"
              ? "hosted_operator_reservation_past_start"
              : "hosted_change_error_not_applicable";
        renderOperatorChange(ctx, current, 409, { noticeKey });
        return;
      }
      logger.info("hosted.change_request_applied", {
        operator_account_id: operator.accountId,
        change_request_id: request.changeRequestId,
      });
    } else {
      const result = await organizerStore.rejectChangeRequest({
        changeRequestId: request.changeRequestId,
        operatorAccountId: operator.accountId,
        note: (form.get("note") || "").slice(0, MAX_OPERATOR_NOTE_LENGTH),
      });
      if (!result.ok) {
        const current =
          organizerStore.getChangeRequestById(request.changeRequestId) ||
          request;
        renderOperatorChange(ctx, current, 409, {
          noticeKey: "hosted_change_error_not_applicable",
        });
        return;
      }
      logger.info("hosted.change_request_rejected", {
        operator_account_id: operator.accountId,
        change_request_id: request.changeRequestId,
      });
    }
    seeOther(
      ctx,
      publicPath(config, `/operator/changes/${request.changeRequestId}`),
    );
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  function serveOperatorApproveChange(ctx) {
    return handleChangeDecision(ctx, "approve");
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  function serveOperatorRejectChange(ctx) {
    return handleChangeDecision(ctx, "reject");
  }

  return {
    serveOrganizerReservations,
    serveOrganizerReservation,
    serveSubmitReservation,
    serveCancelReservation,
    serveSubmitChangeRequest,
    serveOperatorReservations,
    serveOperatorReservation,
    serveOperatorApproveReservation,
    serveOperatorRejectReservation,
    serveOperatorChanges,
    serveOperatorChange,
    serveOperatorApproveChange,
    serveOperatorRejectChange,
  };
}

export { createReservationRoutes };
