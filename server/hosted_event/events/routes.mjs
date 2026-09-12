import crypto from "node:crypto";
import { BoundaryError } from "../../http/boundary_errors.mjs";
import { publicPath } from "../../http/request_url.mjs";
import observability from "../../observability/index.mjs";
import { resolveRequestClientIpSafe } from "../../socket/policy.mjs";
import { resolveSignedInAccountFromRequest } from "../accounts/routes.mjs";
import { sniffImage } from "../assets/image_validation.mjs";
import { readMultipartFormData } from "../assets/upload.mjs";
import { EXPORT_JOB_FAILURE_CODES } from "../export/pipeline.mjs";
import { EXPORT_FAILURE_CODES } from "../export/render.mjs";
import {
  createFormSecurity,
  readFormBody,
  seeOther,
  translate,
} from "../http_forms.mjs";
import { createFileBoardMutationLedger } from "../ledger/store.mjs";
import { MutationType } from "../../../client-data/js/mutation_type.js";
import { createStoreLifecycleAdvancer } from "../lifecycle.mjs";
import { accessCodeMatches } from "../memberships/access_codes.mjs";
import { moderationSocketEffects } from "../moderation/socket_effects.mjs";
import { MAX_REASON_LENGTH } from "../moderation/store.mjs";
import {
  eventLifecycleState,
  MAX_EVENT_TAGLINE_LENGTH,
} from "../organizers/store.mjs";
import {
  countStoredCanvasCreators,
  derivePublishedCanvas,
  listPublishedContributorIds,
} from "../publication/canvas.mjs";
import { resolveOutcomePurgeFailureLabel } from "../outcomes.mjs";
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

/** Mutation type code -> translation key for the Change Audit view. */
const MUTATION_LABEL_KEYS = {
  [MutationType.CREATE]: "hosted_audit_mutation_create",
  [MutationType.UPDATE]: "hosted_audit_mutation_update",
  [MutationType.DELETE]: "hosted_audit_mutation_delete",
  [MutationType.APPEND]: "hosted_audit_mutation_append",
  [MutationType.BATCH]: "hosted_audit_mutation_batch",
  [MutationType.CLEAR]: "hosted_audit_mutation_clear",
  [MutationType.COPY]: "hosted_audit_mutation_copy",
};

/** Event-scoped Change Audit action -> translation key for the audit view. */
const EVENT_AUDIT_ACTION_KEYS = {
  "reservation.created": "hosted_event_audit_action_reservation_created",
  "reservation.submitted": "hosted_event_audit_action_reservation_submitted",
  "reservation.approved": "hosted_event_audit_action_reservation_approved",
  "reservation.rejected": "hosted_event_audit_action_reservation_rejected",
  "reservation.cancelled": "hosted_event_audit_action_reservation_cancelled",
  "change_request.submitted": "hosted_event_audit_action_change_submitted",
  "change_request.applied": "hosted_event_audit_action_change_applied",
  "change_request.rejected": "hosted_event_audit_action_change_rejected",
  "event.cancelled": "hosted_event_audit_action_event_cancelled",
  "event.cover_set": "hosted_event_audit_action_cover_set",
  "event.display_updated": "hosted_event_audit_action_display_updated",
  "event_moderator.granted": "hosted_event_audit_action_moderator_granted",
  "event_moderator.revoked": "hosted_event_audit_action_moderator_revoked",
  "board_session.open": "hosted_event_audit_action_session_open",
  "board_session.closing": "hosted_event_audit_action_session_closing",
  "board_session.closed": "hosted_event_audit_action_session_closed",
  "board_session.archive_failed": "hosted_event_audit_action_session_failed",
  "board_session.archive_retry_requested":
    "hosted_event_audit_action_session_retry",
  "event_outcome.delete_requested":
    "hosted_event_audit_action_delete_requested",
  "event_outcome.delete_restored": "hosted_event_audit_action_delete_restored",
  "event_outcome.purge_failed": "hosted_event_audit_action_purge_failed",
  "event_outcome.purge_retry_requested":
    "hosted_event_audit_action_purge_retry",
  "event_outcome.purged": "hosted_event_audit_action_purged",
};

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
 * The Published Canvas flows also live here. Owner/Admins derive a sanitized,
 * read-only presentation from the event's Private Board Archive and choose
 * its Publication Audience; the public read route re-checks that audience on
 * every read, so revocation takes effect immediately.
 *
 * @param {{
 *   config: ServerConfig,
 *   accountStore: ReturnType<typeof import("../accounts/store.mjs").createFileAccountStore>,
 *   organizerStore: ReturnType<typeof import("../organizers/store.mjs").createFileOrganizerStore>,
 *   membershipStore: ReturnType<typeof import("../memberships/store.mjs").createFileEventMembershipStore>,
 *   moderation: ReturnType<typeof import("../moderation/index.mjs").createEventModeration>,
 *   assetStore: ReturnType<typeof import("../assets/store.mjs").createFileBrandAssetStore>,
 *   publicationStore: ReturnType<typeof import("../publication/store.mjs").createFilePublicationStore>,
 *   archiveStore: ReturnType<typeof import("../archive/store.mjs").createFileBoardArchiveStore>,
 *   participantIdentifierFor: (eventId: string, accountId: string) => string,
 *   createBoardMutationLedger?: (boardName: string) => import("../../board/ledger_registry.mjs").BoardMutationLedger,

 *   exportStore: ReturnType<typeof import("../export/store.mjs").createFileBoardExportStore>,
 *   exportPipeline: ReturnType<typeof import("../export/pipeline.mjs").createBoardExportPipeline>,
 *   limiter: ReturnType<typeof import("../accounts/rate_limits.mjs").createRateLimiter>,
 *   advanceEventLifecycle?: () => Promise<void>,
 *   templates: {
 *     home: HostedTemplate,
 *     event: HostedTemplate,
 *     organizerEvent: HostedTemplate,
 *     organizerEventAudit: HostedTemplate,
 *     publishedCanvas: HostedTemplate,
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
    publicationStore,
    archiveStore,
    participantIdentifierFor,

    exportStore,
    exportPipeline,
    limiter,
    templates,
  } = dependencies;
  const clock = dependencies.clock || (() => Date.now());
  const createBoardMutationLedger =
    dependencies.createBoardMutationLedger ||
    ((boardName) =>
      createFileBoardMutationLedger({
        boardName,
        dataDir: config.HOSTED_DATA_DIR,
      }));
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
   * Whether the account holds the Owner/Admin role of the organizer.
   *
   * @param {string} organizerId
   * @param {string} accountId
   * @returns {boolean}
   */
  function isOwnerAdminRole(organizerId, accountId) {
    const role = organizerStore.getMemberRole(organizerId, accountId);
    return role === "owner" || role === "admin";
  }

  /**
   * The one definition of Publication Audience admission, shared by the
   * event-page link, the manage page's view link, and the public read route:
   * a live published record admits the audience it names — organizer members
   * or event members. The `link` audience is admitted only through its own
   * unguessable share URL, never through the bare one.
   *
   * @param {{isOrganizerMember: boolean, isMember: boolean}} viewer
   * @param {import("../publication/store.mjs").StoredPublication} publication
   * @returns {boolean}
   */
  function publicationAudienceAdmits(viewer, publication) {
    if (publication.status !== "published") return false;
    if (publication.audience === "organizer") return viewer.isOrganizerMember;
    if (publication.audience === "members") return viewer.isMember;
    return false;
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

  /**
   * The one definition of outcome invalidation, shared by every read and
   * write surface of the Published Canvas and the Image Export downloads: a
   * pending outcome deletion (inside its recoverable window) or an already
   * purged Board Session blocks them all. The deletion request itself deletes
   * nothing, so restore brings every surface back unchanged.
   *
   * @param {import("../organizers/store.mjs").StoredEvent} event
   * @param {import("../organizers/store.mjs").StoredBoardSession | null} session
   * @returns {{deletionPending: boolean, purged: boolean}}
   */
  function eventOutcomeState(event, session) {
    return {
      deletionPending:
        event.outcomeDeletion !== null &&
        event.outcomeDeletion !== undefined &&
        event.outcomeDeletion.purgedAtMs === null,
      purged: Boolean(session && session.outcomesPurgedAtMs !== null),
    };
  }

  /**
   * The single invalidation verdict every Published Canvas and export surface
   * consults: a pending outcome deletion (inside its recoverable window) or
   * an already purged Board Session blocks them all.
   *
   * @param {import("../organizers/store.mjs").StoredEvent} event
   * @param {import("../organizers/store.mjs").StoredBoardSession | null} session
   * @returns {boolean}
   */
  function outcomesInvalidated(event, session) {
    const state = eventOutcomeState(event, session);
    return state.deletionPending || state.purged;
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
      ? isOwnerAdminRole(event.organizerId, account.accountId)
      : false;
    // A published canvas is surfaced on the event page only to viewers its
    // Publication Audience admits right now; link-audience viewers hold
    // their own unguessable URL and get no shortcut here.
    const publication = session
      ? publicationStore.getPublicationForBoardSession(session.boardSessionId)
      : null;
    const publicationViewable =
      publication !== null &&
      publicationAudienceAdmits(
        {
          isOrganizerMember: viewerIsOwnerAdmin,
          isMember: Boolean(membership),
        },
        publication,
      );
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
      hostedEventPublishedCanvasHref: publicationViewable
        ? `events/${event.publicId}/canvas`
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
   * @param {{errorKey?: string, noticeKey?: string, accessCodeReveal?: string, publicationShareUrl?: string}} state
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
    // Published Canvas state: the publication exists only after the Board
    // Session closed behind its Private Board Archive. The manage page's own
    // view link admits the signed-in Owner/Admin through the same audience
    // definition as the read route, so it never shows a link that would 404
    // (the owner may or may not hold an Event Membership).
    const session = organizerStore.getBoardSessionForEvent(event.eventId);
    const outcomeState = eventOutcomeState(event, session);
    const publication = session
      ? publicationStore.getPublicationForBoardSession(session.boardSessionId)
      : null;
    const viewerAccount = signedInAccount(ctx);
    const publicationViewable =
      publication !== null &&
      !outcomeState.deletionPending &&
      !outcomeState.purged &&
      publicationAudienceAdmits(
        {
          isOrganizerMember: true,
          isMember: Boolean(
            viewerAccount &&
              membershipStore.getMembership(
                event.eventId,
                viewerAccount.accountId,
              ),
          ),
        },
        publication,
      );
    const publicationAudienceKey =
      publication?.status === "published"
        ? `hosted_publication_audience_${publication.audience}`
        : "";

    // The Board Image Export queue: one line per job with its lifecycle state.
    // A succeeded job's download link is derived from the export id and its
    // finish time, so the console always renders the currently valid link —
    // revocation, expiry, or a pending outcome deletion simply removes it.
    const exportJobs = exportStore
      .listExportsForEvent(event.eventId, { limit: 20 })
      .map((record) => {
        const token = outcomeState.deletionPending
          ? null
          : exportStore.downloadHrefToken(record.exportId);
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
    // Outcome retention: the Private Board Archive, Item Attribution, and
    // Change Audit are retained until a server-derived deadline; an Owner/Admin
    // can request early deletion, which enters a recoverable window. Every
    // timestamp here is computed from the service clock — never the client's.
    const retention = outcomeRetentionView(template, ctx, session);
    const retentionMs = Number(config.HOSTED_OUTCOME_RETENTION_MS) || 0;
    const purgeFailureLabel = resolveOutcomePurgeFailureLabel(
      event.outcomePurgeFailure,
      translate,
      template,
      ctx,
    );

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
      // Published Canvas management. The share URL is only ever rendered on
      // the publish response that minted it; the record stores just a digest.
      hostedPublicationPublished: publication?.status === "published",
      hostedPublicationRevoked: publication?.status === "revoked",
      hostedPublicationAudienceOrganizer: publication?.audience === "organizer",
      hostedPublicationAudienceMembers: publication?.audience === "members",
      hostedPublicationAudienceLink: publication?.audience === "link",
      hostedPublicationAudienceLabel: publicationAudienceKey
        ? translate(template, ctx, publicationAudienceKey)
        : "",
      hostedPublicationAttribution: publication?.showAttribution === true,
      hostedPublicationPublishedAt: publication?.publishedAtMs
        ? formatTimestamp(publication.publishedAtMs)
        : "",
      hostedPublicationCanPublish:
        session?.status === "closed" &&
        Boolean(session?.archiveKey) &&
        !outcomeState.deletionPending,
      hostedPublicationShareUrl: state.publicationShareUrl,
      hostedPublicationViewHref: publicationViewable
        ? `events/${event.publicId}/canvas`
        : undefined,

      // Outcome retention and early deletion.
      hostedOutcomeArchived: Boolean(
        session && session.status === "closed" && session.archiveKey,
      ),
      hostedOutcomeRetentionUntil: retention.until,
      hostedOutcomeRetentionDaysLeft: retention.daysLeft,
      hostedOutcomeRetentionExpired: retention.expired,
      hostedOutcomeRetentionDisabled:
        Boolean(session && session.outcomesPurgedAtMs === null) &&
        retentionMs === 0,
      hostedOutcomeDeletionPending: outcomeState.deletionPending,
      hostedOutcomeDeletionRequestedAt: outcomeState.deletionPending
        ? formatTimestamp(
            /** @type {NonNullable<import("../organizers/store.mjs").StoredEvent["outcomeDeletion"]>} */ (
              event.outcomeDeletion
            ).requestedAtMs,
          )
        : undefined,
      hostedOutcomePurgeAt: outcomeState.deletionPending
        ? formatTimestamp(
            /** @type {NonNullable<import("../organizers/store.mjs").StoredEvent["outcomeDeletion"]>} */ (
              event.outcomeDeletion
            ).purgeAtMs,
          )
        : undefined,
      hostedOutcomePurged: outcomeState.purged,
      hostedOutcomePurgedAt:
        session?.outcomesPurgedAtMs !== null &&
        session?.outcomesPurgedAtMs !== undefined
          ? formatTimestamp(session.outcomesPurgedAtMs)
          : undefined,
      hostedOutcomePurgeFailed: event.outcomePurgeFailure !== null,
      hostedOutcomePurgeFailureAttempts: event.outcomePurgeFailure
        ? event.outcomePurgeFailure.attempts
        : undefined,
      hostedOutcomePurgeFailureLabel: purgeFailureLabel,
      hostedOutcomeCanRequestDeletion: Boolean(
        session &&
          session.status === "closed" &&
          session.archiveKey &&
          !outcomeState.deletionPending &&
          !outcomeState.purged,
      ),
      hostedOutcomeAuditHref: `organizers/${organizerId}/events/${event.eventId}/audit`,

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

  // --- published canvas -----------------------------------------------------

  /**
   * The Participant Identifiers whose frozen Presentation Choice allows
   * showing their attribution on a published canvas: memberships still marked
   * "identified", projected through the event-scoped identifier derivation.
   * Creators outside this set — anonymous, banned, or unknown — fail safe to
   * no identifier on the published artifact.
   *
   * @param {string} eventId
   * @returns {Set<string>}
   */
  function identifiedParticipantIdsFor(eventId) {
    const identifiers = new Set();
    for (const membership of membershipStore.listMembershipsForEvent(eventId)) {
      if (membership.anonymity === "identified") {
        identifiers.add(
          participantIdentifierFor(eventId, membership.accountId),
        );
      }
    }
    return identifiers;
  }

  /**
   * Reads a Board Session's archived canvas beside its archived manifest and
   * verifies it against the manifest's integrity hash. The close pipeline
   * always writes `canvas.svg` next to `manifest.json` and binds the canvas
   * content in the manifest; a missing object, an unreadable manifest, or a
   * hash disagreement means the archive cannot be trusted as a publication
   * source and refuses — publish never derives from unverified bytes.
   *
   * @param {import("../organizers/store.mjs").StoredBoardSession} session
   * @returns {Promise<{canvas: string, itemCount: number} | null>}
   */
  async function readArchivedCanvas(session) {
    if (typeof session.archiveKey !== "string") return null;
    const manifestBasename = "manifest.json";
    if (!session.archiveKey.endsWith(`/${manifestBasename}`)) return null;
    const canvasBytes = await archiveStore.readArchive(
      `${session.archiveKey.slice(0, -manifestBasename.length)}canvas.svg`,
    );
    const manifestBytes = await archiveStore.readArchive(session.archiveKey);
    if (!canvasBytes || !manifestBytes) return null;
    let manifest;
    try {
      manifest = JSON.parse(manifestBytes.toString("utf8"));
    } catch {
      return null;
    }
    const expectedSha256 = manifest?.integrity?.["canvas.svg"];
    const actualSha256 = crypto
      .createHash("sha256")
      .update(canvasBytes)
      .digest("hex");
    if (
      typeof expectedSha256 !== "string" ||
      expectedSha256.length !== actualSha256.length ||
      !crypto.timingSafeEqual(
        Buffer.from(expectedSha256, "utf8"),
        Buffer.from(actualSha256, "utf8"),
      )
    ) {
      return null;
    }
    const itemCount =
      Number.isSafeInteger(manifest?.itemCount) && manifest.itemCount >= 0
        ? manifest.itemCount
        : 0;
    return { canvas: canvasBytes.toString("utf8"), itemCount };
  }

  /**
   * Publishes or updates the event's Published Canvas from its Private Board
   * Archive. Owner/Admin only. The archived canvas is sanitized here — never
   * exposed directly — with the chosen Publication Audience and attribution
   * policy, and a `link` audience reveals its fresh share URL exactly once.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerEventPublication(ctx) {
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
    // Publication derives from the sealed Private Board Archive, so the
    // durable lifecycle must be current first: a session still draining (or
    // waiting on an archive retry) has nothing to publish yet.
    await advanceLifecycleNow();
    const session = organizerStore.getBoardSessionForEvent(
      managed.event.eventId,
    );
    if (!session || session.status !== "closed" || !session.archiveKey) {
      await renderManageEvent(ctx, organizerId, managed.event, 409, {
        errorKey: "hosted_publication_error_not_archived",
      });
      return;
    }
    // A pending outcome deletion (or a purged session) freezes the publication
    // surface: the archive is on its way out, so nothing new may derive from
    // it and nothing may be published while the recoverable window runs.
    if (outcomesInvalidated(managed.event, session)) {
      await renderManageEvent(ctx, organizerId, managed.event, 409, {
        errorKey: "hosted_outcome_error_state",
      });
      return;
    }
    const audienceValue = form.get("audience") || "";
    const audience = ["organizer", "members", "link"].includes(audienceValue)
      ? /** @type {"organizer" | "members" | "link"} */ (audienceValue)
      : null;
    if (!audience) {
      await renderManageEvent(ctx, organizerId, managed.event, 400, {
        errorKey: "hosted_publication_error_invalid",
      });
      return;
    }
    const showAttribution = form.get("showAttribution") === "1";
    const archived = await readArchivedCanvas(session);
    if (!archived) {
      // The session record names an archive the object store cannot serve:
      // an integrity failure on our side must never become a publication.
      logger.error("hosted.published_archive_unreadable", {
        organizer_id: organizerId,
        event_id: managed.event.eventId,
        board_session: session.boardSessionId,
      });
      throw new BoundaryError(500, "published_archive_unavailable");
    }
    const existing = publicationStore.getPublicationForBoardSession(
      session.boardSessionId,
    );
    const published = await publicationStore.publish({
      boardSessionId: session.boardSessionId,
      eventId: managed.event.eventId,
      organizerId,
      audience,
      showAttribution,
      canvasContent: derivePublishedCanvas({
        archiveCanvas: archived.canvas,
        showAttribution,
        identifiedParticipantIds: identifiedParticipantIdsFor(
          managed.event.eventId,
        ),
      }),
      archivedFinalSeq: session.archivedFinalSeq ?? 0,
      itemCount: archived.itemCount,
      actorAccountId: managed.account.accountId,
    });
    if (!published.ok) {
      await renderManageEvent(ctx, organizerId, managed.event, 400, {
        errorKey: "hosted_publication_error_invalid",
      });
      return;
    }
    logger.info("hosted.published_canvas_published", {
      organizer_id: organizerId,
      event_id: managed.event.eventId,
      audience,
      attribution: showAttribution,
      generation: published.publication.generation,
      updated: existing?.status === "published",
    });
    await renderManageEvent(ctx, organizerId, managed.event, 200, {
      noticeKey:
        existing?.status === "published"
          ? "hosted_publication_update_success"
          : "hosted_publication_publish_success",
      // The share token is stored only as a digest: the raw value renders
      // exactly once, on this response.
      publicationShareUrl: published.shareToken
        ? publicPath(
            config,
            `/events/${managed.event.publicId}/canvas/${published.shareToken}`,
          )
        : undefined,
    });
  }

  /**
   * Withdraws the event's Published Canvas. Every audience and share link
   * stops working immediately because every read consults the live record.
   * Owner/Admin only.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerEventPublicationRevoke(ctx) {
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
    const session = organizerStore.getBoardSessionForEvent(
      managed.event.eventId,
    );
    const revoked = session
      ? await publicationStore.revoke({
          boardSessionId: session.boardSessionId,
          actorAccountId: managed.account.accountId,
        })
      : { ok: false, reason: "not_found" };
    if (!revoked.ok) {
      // A stale form (nothing published) is refused without side effects.
      await renderManageEvent(ctx, organizerId, managed.event, 409, {
        errorKey: "hosted_publication_error_state",
      });
      return;
    }
    logger.info("hosted.published_canvas_revoked", {
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
   * Requests early deletion of the event's outcomes. The request enters the
   * recoverable window (7 days by default) and immediately invalidates the
   * Published Canvas and every Image Export download link — through the read
   * paths consulting the deletion record, not through deleting anything. The
   * purge itself runs when the window elapses. Owner/Admin only.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerEventOutcomeDelete(ctx) {
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
    await advanceLifecycleNow();
    const requested = await organizerStore.requestEventOutcomeDeletion({
      eventId: managed.event.eventId,
      actorAccountId: managed.account.accountId,
      deleteWindowMs: Number(config.HOSTED_OUTCOME_DELETE_WINDOW_MS) || 0,
    });
    if (!requested.ok) {
      if (requested.reason === "not_found") {
        throw new BoundaryError(404, "event_not_found");
      }
      await renderManageEvent(ctx, organizerId, managed.event, 409, {
        errorKey: "hosted_outcome_error_state",
      });
      return;
    }
    logger.info("hosted.event_outcome_delete_requested", {
      organizer_id: organizerId,
      event_id: managed.event.eventId,
      purge_at_ms: requested.deletion.purgeAtMs,
    });
    await renderManageEvent(ctx, organizerId, managed.event, 200, {
      noticeKey: "hosted_outcome_delete_requested",
    });
  }

  /**
   * Restores a pending outcome deletion inside its recoverable window. The
   * request changed nothing physically, so every affected surface — archive,
   * Published Canvas, export links — is consistent again immediately.
   * Owner/Admin only.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerEventOutcomeRestore(ctx) {
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
    const restored = await organizerStore.restoreEventOutcomeDeletion({
      eventId: managed.event.eventId,
      actorAccountId: managed.account.accountId,
    });
    if (!restored.ok) {
      await renderManageEvent(ctx, organizerId, managed.event, 409, {
        errorKey: "hosted_outcome_error_state",
      });
      return;
    }
    logger.info("hosted.event_outcome_delete_restored", {
      organizer_id: organizerId,
      event_id: managed.event.eventId,
    });
    await renderManageEvent(ctx, organizerId, managed.event, 200, {
      noticeKey: "hosted_outcome_delete_restored",
    });
  }

  /**
   * Renders the outcome-retention window state shared by the event console
   * and the audit page.
   *
   * @param {HostedTemplate} template
   * @param {HttpRouteContext} ctx
   * @param {import("../organizers/store.mjs").StoredBoardSession | null} session
   * @returns {{until?: string, daysLeft?: string, expired?: boolean, disabled?: boolean}}
   */
  function outcomeRetentionView(template, ctx, session) {
    const retentionMs = Number(config.HOSTED_OUTCOME_RETENTION_MS) || 0;
    if (
      !session ||
      session.archivedAtMs === null ||
      session.outcomesPurgedAtMs !== null
    ) {
      return {};
    }
    if (retentionMs <= 0) {
      return { disabled: true };
    }
    const deadlineMs = session.archivedAtMs + retentionMs;
    return {
      until: formatTimestamp(deadlineMs),
      daysLeft: translate(template, ctx, "hosted_outcome_retention_days_left", {
        days: String(
          Math.max(0, Math.floor((deadlineMs - clock()) / 86400000)),
        ),
      }),
      expired: clock() >= deadlineMs,
    };
  }

  /**
   * The Owner/Admin audit view of the event's outcomes: the Board Session and
   * its retention deadline, the Board Item Attribution of the archived canvas,
   * the recent Change Audit from the durable mutation ledger, and the event's
   * administrative activity trail. Only Owner/Admins reach this page at all —
   * Event Moderators and Participants keep their minimal surfaces — and
   * internal Account ids are always projected to Participant Identifiers.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerEventAudit(ctx) {
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
    await advanceLifecycleNow();
    const event =
      organizerStore.getEventById(managed.event.eventId) || managed.event;
    const template = templates.organizerEventAudit;
    const lifecycle = eventLifecycleState(event, clock());
    const sessions = organizerStore.listBoardSessionsForEvent(event.eventId);
    const session = organizerStore.getBoardSessionForEvent(event.eventId);
    const outcomeState = eventOutcomeState(event, session);
    const retention = outcomeRetentionView(template, ctx, session);
    const purgeFailureLabel = resolveOutcomePurgeFailureLabel(
      event.outcomePurgeFailure,
      translate,
      template,
      ctx,
    );

    // Board Item Attribution: counted from the Private Board Archive canvas,
    // whose items carry every creator's server-stamped Participant Identifier.
    const archived =
      session && session.archiveKey && !outcomeState.purged
        ? await readArchivedCanvas(session)
        : null;
    const attribution = archived
      ? countStoredCanvasCreators(archived.canvas)
      : [];

    // Change Audit: the event's accepted board mutations, newest first, with
    // the internal Account id projected to its Participant Identifier. The
    // ledger read is console-only — never part of a socket or write path.
    const ledger = createBoardMutationLedger(event.boardName);
    const ledgerEntries = archived ? await ledger.readEntriesAfter(0) : [];
    const sessionIds = new Set(sessions.map((item) => item.boardSessionId));
    const changeAudit = ledgerEntries
      .filter((entry) => sessionIds.has(entry.boardSessionId))
      .slice(-50)
      .reverse()
      .map((entry) => ({
        seq: entry.seq,
        createdAt: formatTimestamp(entry.acceptedAtMs),
        actionLabel: translate(
          template,
          ctx,
          MUTATION_LABEL_KEYS[
            /** @type {keyof typeof MUTATION_LABEL_KEYS} */ (
              /** @type {any} */ (entry.mutation).type
            )
          ] || "hosted_audit_mutation_unknown",
        ),
        participantId: participantIdentifierFor(event.eventId, entry.accountId),
      }));

    // Administrative activity: the event-scoped Change Audit records, with
    // actor emails resolved for Owner/Admin eyes and system actors labeled.
    const adminActivity = organizerStore
      .listAuditForEvent(event.eventId, { limit: 50 })
      .map((record) => {
        const actor =
          record.actorKind === "account"
            ? accountStore.getAccountById(record.actorAccountId)
            : null;
        return {
          actionLabel: translate(
            template,
            ctx,
            EVENT_AUDIT_ACTION_KEYS[
              /** @type {keyof typeof EVENT_AUDIT_ACTION_KEYS} */ (
                record.action
              )
            ] || "hosted_event_audit_action_other",
          ),
          actorLabel:
            record.actorKind === "system"
              ? translate(template, ctx, "hosted_event_audit_actor_system")
              : record.actorKind === "operator"
                ? translate(template, ctx, "hosted_event_audit_actor_platform")
                : actor
                  ? actor.email
                  : "",
          createdAt: formatTimestamp(record.createdAtMs),
        };
      });

    template.serveWithStatus(ctx.request, ctx.response, 200, {
      hostedOrganizerId: organizerId,
      hostedEventId: event.eventId,
      hostedEventName: event.name,
      hostedEventStatusLabel: translate(
        template,
        ctx,
        EVENT_STATUS_KEYS[lifecycle],
      ),
      hostedEventStartsAt: formatTimestamp(event.startsAtMs),
      hostedEventEndsAt: formatTimestamp(event.endsAtMs),
      hostedEventManageHref: `organizers/${organizerId}/events/${event.eventId}`,
      hostedEventSessionStatusLabel: session
        ? translate(template, ctx, `hosted_session_status_${session.status}`)
        : undefined,
      hostedOutcomeDeletionPending: outcomeState.deletionPending,
      hostedOutcomePurgeAt: outcomeState.deletionPending
        ? formatTimestamp(
            /** @type {NonNullable<import("../organizers/store.mjs").StoredEvent["outcomeDeletion"]>} */ (
              event.outcomeDeletion
            ).purgeAtMs,
          )
        : undefined,
      hostedOutcomePurged: outcomeState.purged,
      hostedOutcomePurgedAt:
        session?.outcomesPurgedAtMs !== null &&
        session?.outcomesPurgedAtMs !== undefined
          ? formatTimestamp(session.outcomesPurgedAtMs)
          : undefined,
      hostedOutcomeRetentionUntil: retention.until,
      hostedOutcomeRetentionDaysLeft: retention.daysLeft,
      hostedOutcomeRetentionExpired: retention.expired,
      hostedOutcomeRetentionDisabled: retention.disabled,
      hostedOutcomePurgeFailed: event.outcomePurgeFailure !== null,
      hostedOutcomePurgeFailureAttempts: event.outcomePurgeFailure
        ? event.outcomePurgeFailure.attempts
        : undefined,
      hostedOutcomePurgeFailureLabel: purgeFailureLabel,
      hostedAuditHasAttribution: attribution.length > 0,
      hostedAuditAttribution: attribution,
      hostedAuditHasChangeRecords: changeAudit.length > 0,
      hostedAuditChangeRecords: changeAudit,
      hostedAuditHasAdminActivity: adminActivity.length > 0,
      hostedAuditAdminActivity: adminActivity,
      csrfToken: ensureCsrfToken(ctx),
    });
  }

  /**
   * Whether the current viewer passes the publication's Publication Audience.
   * The organizer and members audiences resolve the signed-in viewer through
   * the shared admission definition; the link audience requires the
   * unguessable token bound to exactly this publication.
   *
   * @param {HttpRouteContext} ctx
   * @param {import("../organizers/store.mjs").StoredEvent} event
   * @param {import("../publication/store.mjs").StoredPublication} publication
   * @returns {boolean}
   */
  function viewerPassesPublicationAudience(ctx, event, publication) {
    if (publication.audience === "link") {
      const publicationByToken = publicationStore.getPublicationByShareToken(
        ctx.params.token || "",
      );
      return publicationByToken?.boardSessionId === publication.boardSessionId;
    }
    const account = signedInAccount(ctx);
    if (!account) return false;
    return publicationAudienceAdmits(
      {
        isOrganizerMember: isOwnerAdminRole(
          event.organizerId,
          account.accountId,
        ),
        isMember: Boolean(
          membershipStore.getMembership(event.eventId, account.accountId),
        ),
      },
      publication,
    );
  }

  /**
   * The public read route of the Published Canvas. Every read re-checks the
   * publication's current audience against the live record, so a withdrawal,
   * an audience change, or a rotated share link takes effect immediately.
   * Every refusal renders the same 404: probing for a canvas, an event, or a
   * share link reveals nothing.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function servePublishedCanvas(ctx) {
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const event = organizerStore.getEventByPublicId(ctx.params.publicId || "");
    const session = event
      ? organizerStore.getBoardSessionForEvent(event.eventId)
      : null;
    const publication = session
      ? publicationStore.getPublicationForBoardSession(session.boardSessionId)
      : null;
    if (
      !event ||
      !session ||
      !publication ||
      publication.status !== "published" ||
      !viewerPassesPublicationAudience(ctx, event, publication) ||
      // A pending outcome deletion or a purged session stops every audience
      // immediately, exactly like a withdrawal — the canvas is on its way out.
      outcomesInvalidated(event, session)
    ) {
      throw new BoundaryError(404, "published_canvas_not_found");
    }
    const canvasBytes = await archiveStore.readArchive(publication.canvasKey);
    if (!canvasBytes) {
      logger.error("hosted.published_canvas_object_missing", {
        event_id: event.eventId,
        board_session: session.boardSessionId,
      });
      throw new BoundaryError(404, "published_canvas_not_found");
    }
    const canvas = canvasBytes.toString("utf8");
    // Contributors derive from the derived artifact itself: only identified
    // participants' identifiers survive sanitization, so an anonymous
    // participant can never appear here.
    const contributors = publication.showAttribution
      ? listPublishedContributorIds(canvas)
      : [];
    const template = templates.publishedCanvas;
    // The canvas is audience-gated and revocable — the hosted shell is
    // already no-store — and search engines must never index it.
    ctx.response.setHeader("X-Robots-Tag", "noindex, nofollow");
    template.serveWithStatus(ctx.request, ctx.response, 200, {
      hostedCanvasEventName: event.name,
      hostedCanvasSvg: canvas,
      hostedCanvasAttribution: publication.showAttribution,
      hostedCanvasContributors: contributors.map((participantId) => ({
        participantId,
      })),
      hostedCanvasHasContributors: contributors.length > 0,
      hostedCanvasPublishedAt: publication.publishedAtMs
        ? formatTimestamp(publication.publishedAtMs)
        : "",
    });
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
    if (outcomesInvalidated(managed.event, session)) {
      await renderManageEvent(ctx, organizerId, managed.event, 409, {
        errorKey: "hosted_outcome_error_state",
      });
      return;
    }
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
    // A pending outcome deletion or a purged session kills every download
    // link immediately, on top of the token, revocation, and expiry checks.
    if (
      outcomesInvalidated(
        managed.event,
        organizerStore.getBoardSessionForEvent(managed.event.eventId),
      )
    ) {
      throw new BoundaryError(404, "export_not_found");
    }
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
    serveOrganizerEventPublication,
    serveOrganizerEventPublicationRevoke,
    serveOrganizerEventOutcomeDelete,
    serveOrganizerEventOutcomeRestore,
    serveOrganizerEventAudit,
    servePublishedCanvas,

    serveOrganizerEventExports,
    serveOrganizerEventExportDownload,
    serveOrganizerEventExportRevoke,
    serveOrganizerEventExportDelete,
  };
}

export { createEventRoutes };
