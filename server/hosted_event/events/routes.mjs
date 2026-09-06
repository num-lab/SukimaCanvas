import { BoundaryError } from "../../http/boundary_errors.mjs";
import { publicPath } from "../../http/request_url.mjs";
import observability from "../../observability/index.mjs";
import { resolveRequestClientIpSafe } from "../../socket/policy.mjs";
import { resolveSignedInAccountFromRequest } from "../accounts/routes.mjs";
import { sniffImage } from "../assets/image_validation.mjs";
import { readMultipartFormData } from "../assets/upload.mjs";
import {
  createFormSecurity,
  readFormBody,
  seeOther,
  translate,
} from "../http_forms.mjs";
import { createStoreLifecycleAdvancer } from "../lifecycle.mjs";
import { accessCodeMatches } from "../memberships/access_codes.mjs";
import { MAX_REASON_LENGTH } from "../moderation/store.mjs";
import { moderationSocketEffects } from "../moderation/socket_effects.mjs";
import {
  eventLifecycleState,
  MAX_EVENT_TAGLINE_LENGTH,
} from "../organizers/store.mjs";
import { EXPORT_FAILURE_CODES } from "../export/render.mjs";
import { EXPORT_JOB_FAILURE_CODES } from "../export/pipeline.mjs";
import { formatServiceTime } from "../service_time.mjs";

const { logger } = observability;

/** @import { HttpRequest, HttpResponse, HttpRouteContext, ServerConfig } from "../../../types/server-runtime.d.ts" */

/**
 * @typedef {import("../../http/templating.mjs").Template & {
 *   serveWithStatus: (request: HttpRequest, response: HttpResponse, statusCode: number, extraParams?: object) => {encoding?: unknown},
 * }} HostedTemplate
 */

/** Event lifecycle state -> translation key for a display badge. */
const EVENT_STATUS_KEYS = {
  scheduled: "hosted_event_status_scheduled",
  open: "hosted_event_status_open",
  ended: "hosted_event_status_ended",
};

/** Export job failure codes that carry their own console label. */
const EXPORT_FAILURE_LABEL_CODES = new Set([
  ...Object.values(EXPORT_FAILURE_CODES),
  ...Object.values(EXPORT_JOB_FAILURE_CODES),
]);

/**
 * HTTP flows for Event discovery, Access Code admission, Event Membership,
 * and Brand Asset display.
 *
 * Visitors discover public, still-live events on the home page or open an
 * unlisted event through its unguessable Public ID; before an Access Code is
 * verified the event page exposes only the event's name, the organizer's
 * display name, its cover, its times, and a lifecycle status — never capacity,
 * participants, or administrative data. A signed-in Participant submits the
 * shared Access Code to create (or restore) a durable Event Membership that
 * survives refreshes, code rotation, and Event Locks. Admission failures — a
 * wrong code, an unknown Public ID on the POST path, a locked or otherwise
 * not-enterable event — all render one uniform response so the entry form
 * cannot be used to enumerate or probe events, and attempts are rate limited
 * per Account and per IP. Organizer Owners/Admins toggle visibility, manage
 * the event's public display and cover Brand Asset, mint and rotate the
 * Access Code (revealed exactly once, stored only as a digest), and enable
 * the Event Lock. Brand Assets are only ever stored after real image decoding
 * and are served through a controlled read path that can never become an
 * executable page.
 *
 * @param {{
 *   config: ServerConfig,
 *   accountStore: ReturnType<typeof import("../accounts/store.mjs").createFileAccountStore>,
 *   organizerStore: ReturnType<typeof import("../organizers/store.mjs").createFileOrganizerStore>,
 *   membershipStore: ReturnType<typeof import("../memberships/store.mjs").createFileEventMembershipStore>,
 *   moderation: ReturnType<typeof import("../moderation/index.mjs").createEventModeration>,
 *   assetStore: ReturnType<typeof import("../assets/store.mjs").createFileBrandAssetStore>,
 *   exportStore: ReturnType<typeof import("../export/store.mjs").createFileBoardExportStore>,
 *   exportPipeline: ReturnType<typeof import("../export/pipeline.mjs").createBoardExportPipeline>,
 *   limiter: ReturnType<typeof import("../accounts/rate_limits.mjs").createRateLimiter>,
 *   advanceEventLifecycle?: () => Promise<void>,
 *   templates: {
 *     home: HostedTemplate,
 *     event: HostedTemplate,
 *     organizerEvent: HostedTemplate,
 *   },
 *   clock?: () => number,
 * }} dependencies
 */
function createEventRoutes(dependencies) {
  const {
    config,
    accountStore,
    organizerStore,
    membershipStore,
    moderation,
    assetStore,
    exportStore,
    exportPipeline,
    limiter,
    templates,
  } = dependencies;
  const clock = dependencies.clock || (() => Date.now());
  const { ensureCsrfToken, requestHasValidCsrf } = createFormSecurity(config);
  const offsetMinutes = config.HOSTED_SERVICE_UTC_OFFSET_MINUTES;

  /**
   * @param {HttpRouteContext} ctx
   * @returns {{accountId: string, email: string} | null}
   */
  function signedInAccount(ctx) {
    return resolveSignedInAccountFromRequest(accountStore, ctx.request);
  }

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
   * @param {number} ms
   * @returns {string}
   */
  function formatTimestamp(ms) {
    return formatServiceTime(ms, offsetMinutes);
  }

  /**
   * A stable, filesystem-safe download filename for an export: the event's
   * name reduced to a slug, disambiguated by the export id prefix.
   *
   * @param {string} eventName
   * @param {string} exportId
   * @returns {string}
   */
  function exportFilename(eventName, exportId) {
    const slug =
      eventName.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") ||
      "board";
    return `${slug}-${exportId.slice(0, 8)}.png`;
  }

  // --- public discovery ----------------------------------------------------

  /**
   * The Hosted home page. Lists only public, not-yet-ended events; unlisted and
   * ended events never appear here.
   *
   * @param {HttpRouteContext} ctx
   * @returns {void}
   */
  function serveHome(ctx) {
    const template = templates.home;
    const events = organizerStore
      .listPublicDiscoverableEvents(clock())
      .map((event) => ({
        name: event.name,
        organizerName:
          organizerStore.getOrganizerById(event.organizerId)?.name || "",
        tagline: event.tagline || undefined,
        startsAt: formatTimestamp(event.startsAtMs),
        href: `events/${event.publicId}`,
        coverHref: event.coverAssetId
          ? `assets/${event.coverAssetId}`
          : undefined,
      }));
    template.serveWithStatus(ctx.request, ctx.response, 200, {
      hostedEvents: events,
      hostedHasEvents: events.length > 0,
    });
  }

  /** Notices carried by the `?notice=` redirect from the board route. */
  const EVENT_PAGE_NOTICE_KEYS = {
    full: "hosted_event_notice_full",
    not_open: "hosted_event_notice_not_open",
    membership: "hosted_event_notice_membership",
    banned: "hosted_event_notice_banned",
    grant_invalid: "hosted_event_notice_grant_invalid",
  };

  /**
   * @param {string} notice
   * @returns {string | undefined}
   */
  function eventPageNoticeKey(notice) {
    return Object.prototype.hasOwnProperty.call(EVENT_PAGE_NOTICE_KEYS, notice)
      ? EVENT_PAGE_NOTICE_KEYS[
          /** @type {keyof typeof EVENT_PAGE_NOTICE_KEYS} */ (notice)
        ]
      : undefined;
  }

  /**
   * The participant-facing event page reached through the Public ID. Before an
   * Access Code is verified this deliberately renders only public, non-sensitive
   * fields.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveEventPage(ctx) {
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const event = organizerStore.getEventByPublicId(ctx.params.publicId || "");
    // A missing or unknown Public ID is an ordinary 404: the id space is
    // unguessable, and listing status is never confirmed here.
    if (!event) throw new BoundaryError(404, "event_not_found");
    // Advance the durable lifecycle so the displayed status is authoritative.
    await advanceLifecycleNow();
    const noticeParam = ctx.url.searchParams.get("notice") || "";
    renderEventPage(ctx, event, 200, {
      noticeKey: eventPageNoticeKey(noticeParam),
    });
  }

  /**
   * Renders the event page with the viewer's admission state. A signed-in
   * member sees their membership and anonymity controls; a signed-in
   * non-member sees the Access Code form while entry is possible; a
   * signed-out visitor sees only the public fields plus a login prompt. The
   * Event Lock state is deliberately never exposed here — it changes only
   * what a submission accepts, never what the page shows.
   *
   * @param {HttpRouteContext} ctx
   * @param {import("../organizers/store.mjs").StoredEvent} event
   * @param {number} statusCode
   * @param {{errorKey?: string, noticeKey?: string}} state
   * @returns {void}
   */
  function renderEventPage(ctx, event, statusCode, state) {
    const template = templates.event;
    const organizer = organizerStore.getOrganizerById(event.organizerId);
    const cancelled = event.status === "cancelled";
    const lifecycle = eventLifecycleState(event, clock());
    const account = signedInAccount(ctx);
    const membership = account
      ? membershipStore.getMembership(event.eventId, account.accountId)
      : null;
    const session = organizerStore.getBoardSessionForEvent(event.eventId);
    const viewerIsOwnerAdmin = account
      ? (() => {
          const role = organizerStore.getMemberRole(
            event.organizerId,
            account.accountId,
          );
          return role === "owner" || role === "admin";
        })()
      : false;
    // Event Moderators enter through the same governance windows as
    // Owner/Admin; the board link below is only a convenience — the board
    // route enforces the same rules server-side.
    const viewerIsGovernance =
      viewerIsOwnerAdmin ||
      (account
        ? organizerStore.isEventModerator(event.eventId, account.accountId)
        : false);
    template.serveWithStatus(ctx.request, ctx.response, statusCode, {
      hostedEventPublicId: event.publicId,
      hostedEventName: event.name,
      hostedEventOrganizerName: organizer ? organizer.name : "",
      hostedEventTagline: event.tagline || undefined,
      hostedEventCoverHref: event.coverAssetId
        ? `assets/${event.coverAssetId}`
        : undefined,
      hostedEventStartsAt: formatTimestamp(event.startsAtMs),
      hostedEventEndsAt: formatTimestamp(event.endsAtMs),
      hostedEventStatusLabel: translate(
        template,
        ctx,
        cancelled
          ? "hosted_event_status_cancelled"
          : EVENT_STATUS_KEYS[lifecycle],
      ),
      hostedEventCancelled: cancelled,
      hostedEventScheduled: !cancelled && lifecycle === "scheduled",
      hostedEventOpen: !cancelled && lifecycle === "open",
      hostedEventEnded: !cancelled && lifecycle === "ended",
      // Viewer admission state.
      hostedEventSignedIn: Boolean(account),
      hostedEventMember: Boolean(membership),
      hostedEventMemberAnonymous: membership?.anonymity === "anonymous",
      // The one-way switch to anonymous is offered only while the session has
      // not yet left its changeable window (scheduled or open).
      hostedEventAnonymityChangeable:
        Boolean(membership) && sessionChangeable(session),
      // New entry is offered only while the session is in its open window.
      hostedEventEnterForm:
        Boolean(account) && !membership && sessionOpen(session),
      // The board link: members enter once the session is open; governance
      // roles also during the Preparation Window.
      hostedEventBoardHref:
        account &&
        (membership
          ? sessionOpen(session)
          : viewerIsGovernance &&
            session !== null &&
            (session.status === "scheduled" || session.status === "open"))
          ? `b/${event.boardName}`
          : undefined,
      hostedEventLoginPrompt: !account && !cancelled && lifecycle !== "ended",
      // Governance board entry during the Preparation Window (they are not
      // members, so the membership block above does not apply to them).
      hostedEventOwnerBoardLink:
        viewerIsGovernance &&
        !membership &&
        session !== null &&
        (session.status === "scheduled" || session.status === "open")
          ? `b/${event.boardName}`
          : undefined,
      hostedEventEnterError: state.errorKey
        ? translate(template, ctx, state.errorKey)
        : undefined,
      hostedEventEnterNotice: state.noticeKey
        ? translate(template, ctx, state.noticeKey)
        : undefined,
      csrfToken: ensureCsrfToken(ctx),
    });
  }

  // --- access code admission & anonymity -----------------------------------

  /**
   * Whether the Board Session is in its open window — the only phase in which
   * fresh admission is accepted.
   *
   * @param {import("../organizers/store.mjs").StoredBoardSession | null} session
   * @returns {boolean}
   */
  function sessionOpen(session) {
    return session !== null && session.status === "open";
  }

  /**
   * Whether the anonymity choice can still change: until the session leaves
   * its pre-close window (scheduled or open). The closing drain and every
   * terminal state freeze it for archive stability.
   *
   * @param {import("../organizers/store.mjs").StoredBoardSession | null} session
   * @returns {boolean}
   */
  function sessionChangeable(session) {
    return (
      session !== null &&
      (session.status === "scheduled" || session.status === "open")
    );
  }

  /**
   * Whether a fresh Access Code submission may admit anyone to the event right
   * now: the session must be open, and the event neither locked nor cancelled.
   * A locked, cancelled, or non-open event refuses all new admission
   * regardless of the code.
   *
   * @param {import("../organizers/store.mjs").StoredEvent} event
   * @returns {boolean}
   */
  function eventEnterable(event) {
    if (event.status === "cancelled" || event.entryLocked) return false;
    return sessionOpen(organizerStore.getBoardSessionForEvent(event.eventId));
  }

  /**
   * Handles the Access Code submission from the event page. Unknown Public IDs
   * are a plain 404, exactly like the page route — this reveals nothing the
   * unguessable Public ID space has not already settled. Every other failure —
   * wrong code, locked, cancelled, or not-yet-open event — renders one uniform
   * message with the same status, so the form reveals nothing about which
   * condition failed. Attempts are rate limited per Account and per IP; the IP
   * bucket is consumed first so a saturated shared address cannot drain
   * honest accounts' budgets.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveEventEnter(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const event = organizerStore.getEventByPublicId(ctx.params.publicId || "");
    if (!event) throw new BoundaryError(404, "event_not_found");
    const account = signedInAccount(ctx);
    if (!account) {
      seeOther(ctx, publicPath(config, "/login"));
      return;
    }
    const form = await readFormBody(ctx.request);
    // Advance the durable lifecycle so admission sees the authoritative
    // session status at the current service clock.
    await advanceLifecycleNow();
    /**
     * @param {number} statusCode
     * @param {string} errorKey
     * @returns {void}
     */
    const enterFailure = (statusCode, errorKey) =>
      renderEventPage(ctx, event, statusCode, { errorKey });
    if (!requestHasValidCsrf(ctx.request, form)) {
      enterFailure(403, "hosted_error_csrf");
      return;
    }
    const address = resolveRequestClientIpSafe(config, ctx.request);
    const limit = config.HOSTED_ACCESS_CODE_ATTEMPTS_LIMIT;
    const windowMs = config.HOSTED_ACCESS_CODE_ATTEMPTS_WINDOW_MS;
    if (
      !limiter.consume("event_access_code", `ip:${address}`, limit, windowMs)
        .allowed ||
      !limiter.consume(
        "event_access_code",
        `account:${account.accountId}`,
        limit,
        windowMs,
      ).allowed
    ) {
      enterFailure(429, "hosted_error_rate_limited");
      return;
    }
    const admitted =
      eventEnterable(event) &&
      // An Event Ban overrides the shared Access Code: banned accounts are
      // refused here with the same uniform failure as every other admission
      // failure, and the board admission gate refuses them independently.
      !membershipStore.isEventBanned(event.eventId, account.accountId) &&
      accessCodeMatches(form.get("accessCode"), event.accessCodeDigest || "");
    if (!admitted) {
      logger.info("hosted.event_entry_rejected", {
        event_id: event.eventId,
      });
      enterFailure(403, "hosted_event_enter_error_invalid");
      return;
    }
    const anonymity =
      form.get("anonymity") === "anonymous" ? "anonymous" : "identified";
    const { created } = await membershipStore.admit({
      eventId: event.eventId,
      accountId: account.accountId,
      anonymity,
    });
    if (created) {
      logger.info("hosted.event_member_admitted", {
        event_id: event.eventId,
      });
    }
    seeOther(ctx, publicPath(config, `/events/${event.publicId}`));
  }

  /**
   * Handles a member's one-way switch to anonymity. The choice can only move
   * toward anonymous (withdrawing public attribution); once the Board Session
   * reaches closing or beyond, the choice is frozen for archive stability.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveEventAnonymity(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const event = organizerStore.getEventByPublicId(ctx.params.publicId || "");
    if (!event) throw new BoundaryError(404, "event_not_found");
    const account = signedInAccount(ctx);
    if (!account) {
      seeOther(ctx, publicPath(config, "/login"));
      return;
    }
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderEventPage(ctx, event, 403, { errorKey: "hosted_error_csrf" });
      return;
    }
    // Advance the durable lifecycle so the freeze decision sees the
    // authoritative session status.
    await advanceLifecycleNow();
    const membership = membershipStore.getMembership(
      event.eventId,
      account.accountId,
    );
    if (!membership) {
      renderEventPage(ctx, event, 403, {
        errorKey: "hosted_event_anonymity_error",
      });
      return;
    }
    // Once the session has left its open window — the closing drain and any
    // terminal state — the anonymity choice is frozen for archive stability.
    const session = organizerStore.getBoardSessionForEvent(event.eventId);
    if (!sessionOpen(session)) {
      renderEventPage(ctx, event, 409, {
        errorKey: "hosted_event_anonymity_frozen_note",
      });
      return;
    }
    await membershipStore.setAnonymity({
      eventId: event.eventId,
      accountId: account.accountId,
      anonymity: "anonymous",
    });
    seeOther(ctx, publicPath(config, `/events/${event.publicId}`));
  }

  /**
   * The controlled Brand Asset read path. Serves stored image bytes with the
   * sniffed content type, `nosniff`, and a locked-down CSP so an asset can never
   * be interpreted as an executable or script-bearing page, and never exposes
   * the internal object key.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveBrandAsset(ctx) {
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const assetId = ctx.params.assetId || "";
    const asset = assetStore.getAsset(assetId);
    if (!asset) throw new BoundaryError(404, "asset_not_found");
    const bytes = await assetStore.readAssetBytes(assetId);
    if (!bytes) throw new BoundaryError(404, "asset_not_found");
    ctx.response.writeHead(200, {
      "Content-Type": asset.contentType,
      "Content-Length": bytes.length,
      // An uploaded image must never be sniffed into another type, executed, or
      // treated as an active document.
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": config.IS_DEVELOPMENT
        ? "no-store"
        : "public, max-age=31536000, immutable",
    });
    ctx.response.end(bytes);
  }

  // --- organizer event management ------------------------------------------

  /**
   * Resolves the signed-in Owner/Admin member for an organizer's event.
   * Signed-out visitors are redirected to login (returns null); a signed-in
   * non-member, an unknown organizer, or an event that is not this organizer's
   * all 404 so nothing about other organizers or events leaks.
   *
   * @param {HttpRouteContext} ctx
   * @param {string} organizerId
   * @param {string} eventId
   * @returns {{account: {accountId: string, email: string}, event: import("../organizers/store.mjs").StoredEvent} | null}
   */
  function requireManagedEvent(ctx, organizerId, eventId) {
    const account = signedInAccount(ctx);
    if (!account) {
      seeOther(ctx, publicPath(config, "/login"));
      return null;
    }
    const role = organizerStore.getMemberRole(organizerId, account.accountId);
    if (!role || !organizerStore.getOrganizerById(organizerId)) {
      throw new BoundaryError(404, "organizer_not_found");
    }
    const event = organizerStore.getEventForOrganizer(organizerId, eventId);
    if (!event) throw new BoundaryError(404, "event_not_found");
    return { account, event };
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void | Promise<void>}
   */
  function serveOrganizerEvent(ctx) {
    if (ctx.request.method === "POST") return handleUpdateEvent(ctx);
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const managed = requireManagedEvent(
      ctx,
      organizerId,
      ctx.params.eventId || "",
    );
    if (!managed) return;
    return renderManageEvent(ctx, organizerId, managed.event, 200, {});
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {string} organizerId
   * @param {import("../organizers/store.mjs").StoredEvent} event
   * @param {number} statusCode
   * @param {{errorKey?: string, noticeKey?: string, accessCodeReveal?: string}} state
   * @returns {Promise<void>}
   */
  async function renderManageEvent(ctx, organizerId, event, statusCode, state) {
    // The console renders Board Session and export-job state, so it always
    // advances the durable lifecycle (and the idempotent pipelines) first —
    // refreshing the page shows the current truth, not the last poker pass.
    await advanceLifecycleNow();
    const template = templates.organizerEvent;
    const lifecycle = eventLifecycleState(event, clock());
    // The governance trail: per-event moderators, current bans projected to
    // Participant Identifiers with frozen names, and the latest moderation
    // records for this Owner/Admin view. Operator emails resolve here —
    // this console never renders target emails or Account ids.
    const moderators = organizerStore
      .listEventModerators(event.eventId)
      .map((grant) => ({
        accountId: grant.accountId,
        email: accountStore.getAccountById(grant.accountId)?.email || "",
        grantedAt: formatTimestamp(grant.grantedAtMs),
      }));
    const moderationRecords = (
      await moderation.listEventModeration(event.eventId, 20)
    ).map((record) => ({
      actionLabel: translate(
        template,
        ctx,
        `hosted_moderation_action_${record.action}`,
      ),
      operatorEmail:
        accountStore.getAccountById(record.operatorAccountId)?.email || "",
      targetParticipantId: record.targetParticipantId || undefined,
      targetName: record.targetName || undefined,
      reason: record.reason || undefined,
      createdAt: formatTimestamp(record.createdAtMs),
    }));
    // The Board Image Export queue: one line per job with its lifecycle state.
    // A succeeded job's download link is derived from the export id and its
    // finish time, so the console always renders the currently valid link —
    // revocation or expiry simply removes it.
    const exportJobs = exportStore
      .listExportsForEvent(event.eventId, { limit: 20 })
      .map((record) => {
        const token = exportStore.downloadHrefToken(record.exportId);
        const expiry = exportStore.downloadLinkExpiry(record.exportId);
        const failureCode = record.failure
          ? EXPORT_FAILURE_LABEL_CODES.has(record.failure.code)
            ? record.failure.code
            : "other"
          : undefined;
        return {
          exportId: record.exportId,
          filename: exportFilename(event.name, record.exportId),
          statusLabel: translate(
            template,
            ctx,
            `hosted_export_status_${record.status}`,
          ),
          createdAt: formatTimestamp(record.createdAtMs),
          failureLabel: failureCode
            ? translate(template, ctx, `hosted_export_failure_${failureCode}`)
            : undefined,
          dimensions:
            record.result === null
              ? undefined
              : `${record.result.width}×${record.result.height}`,
          downloadHref:
            token && expiry
              ? `organizers/${organizerId}/events/${event.eventId}/exports/${record.exportId}/download?token=${encodeURIComponent(token)}`
              : undefined,
          downloadExpiresAt: expiry
            ? formatTimestamp(expiry.expiresAtMs)
            : undefined,
          canRevoke: Boolean(token && expiry),
        };
      });
    template.serveWithStatus(ctx.request, ctx.response, statusCode, {
      hostedOrganizerId: organizerId,
      hostedEventId: event.eventId,
      hostedEventName: event.name,
      hostedEventReservationId: event.reservationId,
      hostedEventPublicPath: publicPath(config, `/events/${event.publicId}`),
      hostedEventPublicHref: `events/${event.publicId}`,
      hostedEventVisibilityPublic: event.visibility === "public",
      hostedEventTaglineValue: event.tagline || "",
      hostedEventCoverHref: event.coverAssetId
        ? `assets/${event.coverAssetId}`
        : undefined,
      hostedEventHasCover: Boolean(event.coverAssetId),
      hostedEventStartsAt: formatTimestamp(event.startsAtMs),
      hostedEventEndsAt: formatTimestamp(event.endsAtMs),
      hostedEventStatusLabel: translate(
        template,
        ctx,
        EVENT_STATUS_KEYS[lifecycle],
      ),
      hostedEventTaglineMax: MAX_EVENT_TAGLINE_LENGTH,
      // Admission management. The Access Code itself is never re-rendered;
      // only its one-time reveal after mint/rotation carries the raw value.
      hostedEventHasAccessCode: event.accessCodeDigest !== null,
      hostedEventAccessCodeSetAt: event.accessCodeSetAtMs
        ? formatTimestamp(event.accessCodeSetAtMs)
        : undefined,
      hostedEventEntryLocked: event.entryLocked,
      hostedEventAccessCodeReveal: state.accessCodeReveal || undefined,
      hostedEventManageError: state.errorKey
        ? translate(template, ctx, state.errorKey)
        : undefined,
      hostedEventManageNotice: state.noticeKey
        ? translate(template, ctx, state.noticeKey)
        : undefined,
      // Governance management.
      hostedEventModerators: moderators,
      hostedEventHasModerators: moderators.length > 0,
      hostedEventModerationRecords: moderationRecords,
      hostedEventHasModerationRecords: moderationRecords.length > 0,
      // Image export management.
      hostedEventExportJobs: exportJobs,
      hostedEventHasExportJobs: exportJobs.length > 0,
      csrfToken: ensureCsrfToken(ctx),
    });
  }

  /**
   * Updates visibility + tagline, or clears the cover, from the urlencoded
   * management form. Owner/Admin only.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleUpdateEvent(ctx) {
    const organizerId = ctx.params.organizerId || "";
    const managed = requireManagedEvent(
      ctx,
      organizerId,
      ctx.params.eventId || "",
    );
    if (!managed) return;
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      await renderManageEvent(ctx, organizerId, managed.event, 403, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    const tagline = (form.get("tagline") || "").trim();
    if (tagline.length > MAX_EVENT_TAGLINE_LENGTH) {
      await renderManageEvent(ctx, organizerId, managed.event, 400, {
        errorKey: "hosted_event_error_tagline",
      });
      return;
    }
    const visibility =
      form.get("visibility") === "public" ? "public" : "unlisted";
    const removeCover = form.get("removeCover") === "1";
    const previousCoverId = managed.event.coverAssetId;
    await organizerStore.updateEventDisplay({
      organizerId,
      eventId: managed.event.eventId,
      visibility,
      tagline,
      removeCover,
      actorAccountId: managed.account.accountId,
    });
    // Clearing the cover also deletes its bytes so the superseded image cannot
    // still be fetched through the controlled read path.
    if (removeCover && previousCoverId) {
      await assetStore.deleteAsset(previousCoverId);
    }
    logger.info("hosted.event_display_updated", {
      organizer_id: organizerId,
      event_id: managed.event.eventId,
    });
    seeOther(
      ctx,
      publicPath(
        config,
        `/organizers/${organizerId}/events/${managed.event.eventId}`,
      ),
    );
  }

  /**
   * Accepts a cover Brand Asset upload. The declared MIME type is ignored: the
   * bytes must decode as a real PNG/JPEG/WebP within the size cap. Owner/Admin
   * only.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerEventCover(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const managed = requireManagedEvent(
      ctx,
      organizerId,
      ctx.params.eventId || "",
    );
    if (!managed) return;
    // Throttle before reading the (up to multi-MiB) upload body, using the
    // session-derived account and the client IP — neither needs the body.
    const address = resolveRequestClientIpSafe(config, ctx.request);
    const limit = config.HOSTED_BRAND_ASSET_ATTEMPTS_LIMIT;
    const windowMs = config.HOSTED_BRAND_ASSET_ATTEMPTS_WINDOW_MS;
    if (
      !limiter.consume(
        "brand_asset",
        `account:${managed.account.accountId}`,
        limit,
        windowMs,
      ).allowed ||
      !limiter.consume("brand_asset", `ip:${address}`, limit, windowMs).allowed
    ) {
      await renderManageEvent(ctx, organizerId, managed.event, 429, {
        errorKey: "hosted_error_rate_limited",
      });
      return;
    }
    const upload = await readMultipartFormData(ctx.request);
    const csrfForm = new URLSearchParams({
      _csrf: upload.fields._csrf || "",
    });
    if (!requestHasValidCsrf(ctx.request, csrfForm)) {
      await renderManageEvent(ctx, organizerId, managed.event, 403, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    if (!upload.file || upload.file.bytes.length === 0) {
      await renderManageEvent(ctx, organizerId, managed.event, 400, {
        errorKey: "hosted_event_cover_error_invalid",
      });
      return;
    }
    const sniffed = sniffImage(upload.file.bytes);
    if (!sniffed.ok) {
      const errorKey =
        sniffed.reason === "too_large"
          ? "hosted_event_cover_error_too_large"
          : "hosted_event_cover_error_type";
      await renderManageEvent(ctx, organizerId, managed.event, 400, {
        errorKey,
      });
      return;
    }
    const previousCoverId = managed.event.coverAssetId;
    const stored = await assetStore.putAsset({
      kind: "event_cover",
      organizerId,
      eventId: managed.event.eventId,
      format: sniffed.format,
      contentType: sniffed.contentType,
      bytes: upload.file.bytes,
    });
    await organizerStore.setEventCover({
      organizerId,
      eventId: managed.event.eventId,
      assetId: stored.assetId,
      actorAccountId: managed.account.accountId,
    });
    // Drop the replaced cover's bytes now that the event points at the new one.
    if (previousCoverId && previousCoverId !== stored.assetId) {
      await assetStore.deleteAsset(previousCoverId);
    }
    logger.info("hosted.event_cover_set", {
      organizer_id: organizerId,
      event_id: managed.event.eventId,
      format: sniffed.format,
    });
    seeOther(
      ctx,
      publicPath(
        config,
        `/organizers/${organizerId}/events/${managed.event.eventId}`,
      ),
    );
  }

  /**
   * Mints or rotates the event's shared Access Code. The raw code is returned
   * in this response only — rendered once on the management page and never
   * persisted or shown again. Rotation stops future admission with the old
   * code and leaves every existing Event Membership untouched.
   * Owner/Admin only.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerEventAccessCode(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const managed = requireManagedEvent(
      ctx,
      organizerId,
      ctx.params.eventId || "",
    );
    if (!managed) return;
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      await renderManageEvent(ctx, organizerId, managed.event, 403, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    const rotated = await organizerStore.rotateEventAccessCode({
      organizerId,
      eventId: managed.event.eventId,
      actorAccountId: managed.account.accountId,
    });
    if (!rotated.ok) throw new BoundaryError(404, "event_not_found");
    logger.info("hosted.event_access_code_rotated", {
      organizer_id: organizerId,
      event_id: managed.event.eventId,
      replaced: rotated.replaced,
    });
    await renderManageEvent(ctx, organizerId, managed.event, 200, {
      accessCodeReveal: rotated.accessCode,
    });
  }

  /**
   * Enables or disables the Event Lock. Locking refuses all future Access
   * Code admission while existing memberships are kept. Owner/Admin only.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerEventEntryLock(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const managed = requireManagedEvent(
      ctx,
      organizerId,
      ctx.params.eventId || "",
    );
    if (!managed) return;
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      await renderManageEvent(ctx, organizerId, managed.event, 403, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    const locked = form.get("locked") === "1";
    const result = await organizerStore.setEventEntryLock({
      organizerId,
      eventId: managed.event.eventId,
      locked,
      actorAccountId: managed.account.accountId,
    });
    if (!result.ok) throw new BoundaryError(404, "event_not_found");
    // The governance trail carries the reason; the store audit carries the
    // administrative record. Both record the actual operator.
    await moderation.recordEntryLockChange({
      eventId: managed.event.eventId,
      locked,
      operatorAccountId: managed.account.accountId,
      reason: (form.get("reason") || "").trim().slice(0, MAX_REASON_LENGTH),
    });
    logger.info("hosted.event_entry_lock_changed", {
      organizer_id: organizerId,
      event_id: managed.event.eventId,
      locked,
    });
    seeOther(
      ctx,
      publicPath(
        config,
        `/organizers/${organizerId}/events/${managed.event.eventId}`,
      ),
    );
  }

  // --- Board Image Export ----------------------------------------------------

  /**
   * Requests an asynchronous PNG Image Export of the event's Board Session.
   * Only a successfully archived session qualifies: the job renders the sealed
   * Private Board Archive in the background, never a still-editable live
   * Board Session, and raw SVG is never exposed. Creation is idempotent while
   * a job is pending. Owner/Admin only.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerEventExports(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const managed = requireManagedEvent(
      ctx,
      organizerId,
      ctx.params.eventId || "",
    );
    if (!managed) return;
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      await renderManageEvent(ctx, organizerId, managed.event, 403, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    // Advance the durable lifecycle (closes included) so the request sees the
    // authoritative session state, not a stale in-flight close.
    await advanceLifecycleNow();
    const session = organizerStore.getBoardSessionForEvent(
      managed.event.eventId,
    );
    const requested = await exportPipeline.requestExport({
      boardSessionId: session?.boardSessionId || "",
      eventId: managed.event.eventId,
      organizerId,
      requestedByAccountId: managed.account.accountId,
    });
    if (!requested.ok) {
      await renderManageEvent(ctx, organizerId, managed.event, 409, {
        errorKey: "hosted_export_error_not_archived",
      });
      return;
    }
    logger.info("hosted.board_export_requested", {
      organizer_id: organizerId,
      event_id: managed.event.eventId,
      export_id: requested.export.exportId,
      created: requested.created,
    });
    seeOther(
      ctx,
      publicPath(
        config,
        `/organizers/${organizerId}/events/${managed.event.eventId}`,
      ),
    );
  }

  /**
   * The controlled export download path. The link must be presented by an
   * authorized organizer member, carry the export's exact derived token, and
   * fall inside the link's validity window — revocation or deletion kills it
   * immediately. Serves the sanitized PNG bytes only, never the archive.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerEventExportDownload(ctx) {
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const managed = requireManagedEvent(
      ctx,
      organizerId,
      ctx.params.eventId || "",
    );
    if (!managed) return;
    const exportId = ctx.params.exportId || "";
    const verdict = exportStore.verifyExportDownloadToken({
      exportId,
      token: ctx.url.searchParams.get("token") || "",
      nowMs: clock(),
    });
    if (!verdict.ok) throw new BoundaryError(404, "export_not_found");
    const bytes = await exportStore.readExportBytes(exportId);
    if (!bytes) throw new BoundaryError(404, "export_not_found");
    const filename = exportFilename(managed.event.name, exportId);
    ctx.response.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": bytes.length,
      // A generated image must never be sniffed into another type, executed,
      // or treated as an active document.
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      // An authorized, expiring artifact is never cacheable.
      "Cache-Control": "no-store",
    });
    ctx.response.end(bytes);
  }

  /**
   * Revokes a succeeded export's download link. The stored result stays; every
   * outstanding link stops working immediately. Owner/Admin only.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerEventExportRevoke(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const managed = requireManagedEvent(
      ctx,
      organizerId,
      ctx.params.eventId || "",
    );
    if (!managed) return;
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      await renderManageEvent(ctx, organizerId, managed.event, 403, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    await exportStore.revokeExportDownload(ctx.params.exportId || "");
    logger.info("hosted.board_export_link_revoked", {
      organizer_id: organizerId,
      event_id: managed.event.eventId,
      export_id: ctx.params.exportId || "",
    });
    seeOther(
      ctx,
      publicPath(
        config,
        `/organizers/${organizerId}/events/${managed.event.eventId}`,
      ),
    );
  }

  /**
   * Deletes an export job and its stored result. Any outstanding download
   * link dies with the record. Owner/Admin only.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerEventExportDelete(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const managed = requireManagedEvent(
      ctx,
      organizerId,
      ctx.params.eventId || "",
    );
    if (!managed) return;
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      await renderManageEvent(ctx, organizerId, managed.event, 403, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    await exportStore.deleteExport(ctx.params.exportId || "");
    logger.info("hosted.board_export_deleted", {
      organizer_id: organizerId,
      event_id: managed.event.eventId,
      export_id: ctx.params.exportId || "",
    });
    seeOther(
      ctx,
      publicPath(
        config,
        `/organizers/${organizerId}/events/${managed.event.eventId}`,
      ),
    );
  }

  // --- event moderator grants ----------------------------------------------

  /**
   * Grants the Event Moderator role for this event to the account behind an
   * email. The target must be a registered, verified, active account; an
   * Owner/Admin of the organizer is refused (they already hold stronger
   * rights). Owner/Admin only.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerEventModerators(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const managed = requireManagedEvent(
      ctx,
      organizerId,
      ctx.params.eventId || "",
    );
    if (!managed) return;
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      await renderManageEvent(ctx, organizerId, managed.event, 403, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    const email = (form.get("email") || "").trim().toLowerCase();
    const account = email === "" ? null : accountStore.getAccountByEmail(email);
    if (
      !account ||
      account.status !== "active" ||
      account.verifiedAtMs === null
    ) {
      await renderManageEvent(ctx, organizerId, managed.event, 400, {
        errorKey: "hosted_event_moderator_error_unknown",
      });
      return;
    }
    const organizerRole = organizerStore.getMemberRole(
      organizerId,
      account.accountId,
    );
    if (organizerRole === "owner" || organizerRole === "admin") {
      await renderManageEvent(ctx, organizerId, managed.event, 400, {
        errorKey: "hosted_event_moderator_error_organizer_member",
      });
      return;
    }
    const granted = await organizerStore.grantEventModerator({
      organizerId,
      eventId: managed.event.eventId,
      targetAccountId: account.accountId,
      actorAccountId: managed.account.accountId,
    });
    if (!granted.ok) throw new BoundaryError(404, "event_not_found");
    logger.info("hosted.event_moderator_granted", {
      organizer_id: organizerId,
      event_id: managed.event.eventId,
    });
    await renderManageEvent(ctx, organizerId, managed.event, 200, {
      noticeKey: granted.created
        ? "hosted_event_moderator_granted"
        : "hosted_event_moderator_already",
    });
  }

  /**
   * Revokes the Event Moderator grant for this event from one account and
   * refreshes the account's live connections: still-admissible connections
   * (an ordinary membership) get their new role immediately; refused ones are
   * dropped. Owner/Admin only.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerEventModeratorRevoke(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const managed = requireManagedEvent(
      ctx,
      organizerId,
      ctx.params.eventId || "",
    );
    if (!managed) return;
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      await renderManageEvent(ctx, organizerId, managed.event, 403, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    const revoked = await organizerStore.revokeEventModerator({
      organizerId,
      eventId: managed.event.eventId,
      targetAccountId: ctx.params.accountId || "",
      actorAccountId: managed.account.accountId,
    });
    if (revoked.ok === false) {
      if (revoked.reason === "not_found") {
        throw new BoundaryError(404, "event_not_found");
      }
      await renderManageEvent(ctx, organizerId, managed.event, 400, {
        errorKey: "hosted_event_moderator_error_not_moderator",
      });
      return;
    }
    moderationSocketEffects()?.refreshEventAccountAccess(
      managed.event.eventId,
      ctx.params.accountId || "",
    );
    logger.info("hosted.event_moderator_revoked", {
      organizer_id: organizerId,
      event_id: managed.event.eventId,
    });
    seeOther(
      ctx,
      publicPath(
        config,
        `/organizers/${organizerId}/events/${managed.event.eventId}`,
      ),
    );
  }

  return {
    serveHome,
    serveEventPage,
    serveEventEnter,
    serveEventAnonymity,
    serveBrandAsset,
    serveOrganizerEvent,
    serveOrganizerEventAccessCode,
    serveOrganizerEventEntryLock,
    serveOrganizerEventModerators,
    serveOrganizerEventModeratorRevoke,
    serveOrganizerEventCover,
    serveOrganizerEventExports,
    serveOrganizerEventExportDownload,
    serveOrganizerEventExportRevoke,
    serveOrganizerEventExportDelete,
  };
}

export { createEventRoutes };
