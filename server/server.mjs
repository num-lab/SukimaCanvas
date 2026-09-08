import { writeSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as productionConfig from "./configuration.mjs";
import { BoundaryError } from "./http/boundary_errors.mjs";
import { route, routeHttpRequests } from "./http/dispatch.mjs";
import observability from "./observability/index.mjs";
import {
  downloadBoard,
  rejectMissingBoardName,
  serveBoardPreview,
  serveBoardSvg,
} from "./routes/board_assets.mjs";
import { redirectBoardQuery, serveBoardPage } from "./routes/board_page.mjs";
import {
  serveEventBoardPage,
  serveEventBoardSvg,
} from "./routes/hosted_board_page.mjs";
import {
  serveAccount,
  serveAccountDelete,
  serveAccountPassword,
  serveAccountSessionRevoke,
  serveAccountSessionsRevokeOthers,
  serveBrandAsset,
  serveCancelReservation,
  serveEventAnonymity,
  serveEventEnter,
  serveEventEntryGrantRedeem,
  serveEventPage,
  serveForgot,
  serveIntegrationApiEntryGrantCreate,
  serveIntegrationApiEvent,
  serveLogin,
  serveLogout,
  serveOperatorApplication,
  serveOperatorApproveApplication,
  serveOperatorApproveChange,
  serveOperatorApproveReservation,
  serveOperatorArchiveRetry,
  serveOperatorChange,
  serveOperatorChanges,
  serveOperatorConsole,
  serveOperatorHistoricalImports,
  serveOperatorOutcomePurgeRetry,
  serveOperatorRejectApplication,
  serveOperatorRejectChange,
  serveOperatorRejectReservation,
  serveOperatorReservation,
  serveOperatorReservations,
  serveOrganizerApply,
  serveOrganizerConsole,
  serveOrganizerCredentialCreate,
  serveOrganizerCredentialRevoke,
  serveOrganizerCredentialRotate,
  serveOrganizerEvent,
  serveOrganizerEventAccessCode,
  serveOrganizerEventAudit,
  serveOrganizerEventCover,
  serveOrganizerEventEntryLock,
  serveOrganizerEventExportDelete,
  serveOrganizerEventExportDownload,
  serveOrganizerEventExportRevoke,
  serveOrganizerEventExports,
  serveOrganizerEventModeratorRevoke,
  serveOrganizerEventModerators,
  serveOrganizerEventOutcomeDelete,
  serveOrganizerEventOutcomeRestore,
  serveOrganizerEventPublication,
  serveOrganizerEventPublicationRevoke,
  serveOrganizerInvitationAccept,
  serveOrganizerInvitationDecline,
  serveOrganizerInvitationRevoke,
  serveOrganizerInvite,
  serveOrganizerManage,
  serveOrganizerMemberRemove,
  serveOrganizerMemberRole,
  serveOrganizerReservation,
  serveOrganizerReservations,
  serveOrganizerWebhookCreate,
  serveOrganizerWebhookResume,
  serveOrganizerWebhookRevoke,
  serveOrganizerWebhookRotate,
  servePublishedCanvas,
  serveRegister,
  serveReset,
  serveSubmitChangeRequest,
  serveSubmitReservation,
  serveVerify,
} from "./routes/hosted_pages.mjs";
import {
  redirectToRandomBoard,
  serveBoardStaticAsset,
  serveManifest,
  serveRoot,
  serveRulesPage,
  serveStaticAsset,
} from "./routes/static.mjs";
import { startWhiteboardServer } from "./runtime/boot.mjs";
import { createServerRuntime } from "./runtime/create_runtime.mjs";
import * as sockets from "./socket/index.mjs";

const { logger } = observability;

/** @import { ServerConfig, SocketServerModule } from "../types/server-runtime.d.ts" */

/** @param {string | undefined} value */
const hasDot = (value) => typeof value === "string" && value.includes(".");

/**
 * @returns {import("../types/server-runtime.d.ts").HttpRequestHandler}
 */
function createWhiteboardHttpHandler() {
  return routeHttpRequests([
    // Hosted mode closes every pre-Event WBO entry surface: no arbitrary
    // boards, no random board allocation, no raw SVG, preview, export, or
    // download. Each legacy handler is wrapped so hosted mode deterministically
    // rejects with a plain 404 — never a redirect — leaving no compatibility
    // path around admission. Legacy mode delegates unchanged.
    route(
      "/boards",
      withHostedRejection(redirectBoardQuery),
      "boards_redirect",
    ),
    route(
      "/boards/",
      withHostedRejection(rejectMissingBoardName),
      "board_page",
    ),
    route(
      "/boards/{board}.svg",
      withHostedRejection(serveBoardSvg),
      "board_svg",
    ),
    route(
      "/boards/{asset}",
      withHostedRejection(serveBoardStaticAsset),
      "static_file",
      {
        where: (params) => hasDot(params.asset),
      },
    ),
    route(
      "/boards/{board}",
      withHostedRejection(serveBoardPage),
      "board_page",
      {
        where: (params) => !hasDot(params.board),
      },
    ),
    ...boardNameRouteGroup(
      "/download",
      withHostedRejection(downloadBoard),
      "download_board",
    ),
    ...boardNameRouteGroup(
      "/preview",
      withHostedRejection(serveBoardPreview),
      "preview_board",
    ),
    ...boardNameRouteGroup(
      "/export",
      withHostedRejection(serveBoardPreview),
      "preview_board",
      {
        access: "user",
        // Hosted mode rejects these surfaces with a deterministic 404 before
        // any auth decision, keeping the legacy entry contract uniform.
        hostedOpenAccess: true,
      },
    ),
    route(
      "/random",
      withHostedRejection(redirectToRandomBoard),
      "random_board",
      {
        access: "user",
        hostedOpenAccess: true,
      },
    ),
    route("/rules", serveRulesPage, "rules"),
    route("/register", serveRegister, "hosted_register"),
    route("/login", serveLogin, "hosted_login"),
    route("/verify", serveVerify, "hosted_verify"),
    route("/logout", serveLogout, "hosted_logout"),
    route("/forgot", serveForgot, "hosted_forgot"),
    route("/reset", serveReset, "hosted_reset"),
    route("/account", serveAccount, "hosted_account"),
    route("/account/password", serveAccountPassword, "hosted_account_password"),
    route(
      "/account/sessions/revoke",
      serveAccountSessionRevoke,
      "hosted_account_session_revoke",
    ),
    route(
      "/account/sessions/revoke-others",
      serveAccountSessionsRevokeOthers,
      "hosted_account_sessions_revoke_others",
    ),
    route("/account/delete", serveAccountDelete, "hosted_account_delete"),
    route("/organizer", serveOrganizerConsole, "hosted_organizer_console"),
    route("/organizer/apply", serveOrganizerApply, "hosted_organizer_apply"),
    route(
      "/organizer/invitations/{invitationId}/accept",
      serveOrganizerInvitationAccept,
      "hosted_organizer_invitation_accept",
    ),
    route(
      "/organizer/invitations/{invitationId}/decline",
      serveOrganizerInvitationDecline,
      "hosted_organizer_invitation_decline",
    ),
    route(
      "/organizers/{organizerId}",
      serveOrganizerManage,
      "hosted_organizer_manage",
    ),
    route(
      "/organizers/{organizerId}/invitations",
      serveOrganizerInvite,
      "hosted_organizer_invite",
    ),
    route(
      "/organizers/{organizerId}/invitations/{invitationId}/revoke",
      serveOrganizerInvitationRevoke,
      "hosted_organizer_invitation_revoke",
    ),
    route(
      "/organizers/{organizerId}/members/{accountId}/role",
      serveOrganizerMemberRole,
      "hosted_organizer_member_role",
    ),
    route(
      "/organizers/{organizerId}/members/{accountId}/remove",
      serveOrganizerMemberRemove,
      "hosted_organizer_member_remove",
    ),
    route(
      "/organizers/{organizerId}/reservations",
      serveOrganizerReservations,
      "hosted_organizer_reservations",
    ),
    route(
      "/organizers/{organizerId}/reservations/{reservationId}",
      serveOrganizerReservation,
      "hosted_organizer_reservation",
    ),
    route(
      "/organizers/{organizerId}/reservations/{reservationId}/submit",
      serveSubmitReservation,
      "hosted_organizer_reservation_submit",
    ),
    route(
      "/organizers/{organizerId}/reservations/{reservationId}/cancel",
      serveCancelReservation,
      "hosted_organizer_reservation_cancel",
    ),
    route(
      "/organizers/{organizerId}/reservations/{reservationId}/change",
      serveSubmitChangeRequest,
      "hosted_organizer_reservation_change",
    ),
    route(
      "/organizers/{organizerId}/events/{eventId}",
      serveOrganizerEvent,
      "hosted_organizer_event",
    ),
    route(
      "/organizers/{organizerId}/events/{eventId}/access-code",
      serveOrganizerEventAccessCode,
      "hosted_organizer_event_access_code",
    ),
    route(
      "/organizers/{organizerId}/events/{eventId}/entry-lock",
      serveOrganizerEventEntryLock,
      "hosted_organizer_event_entry_lock",
    ),
    route(
      "/organizers/{organizerId}/events/{eventId}/moderators",
      serveOrganizerEventModerators,
      "hosted_organizer_event_moderators",
    ),
    route(
      "/organizers/{organizerId}/events/{eventId}/moderators/{accountId}/revoke",
      serveOrganizerEventModeratorRevoke,
      "hosted_organizer_event_moderator_revoke",
    ),
    route(
      "/organizers/{organizerId}/events/{eventId}/cover",
      serveOrganizerEventCover,
      "hosted_organizer_event_cover",
    ),
    route(
      "/organizers/{organizerId}/events/{eventId}/publication",
      serveOrganizerEventPublication,
      "hosted_organizer_event_publication",
    ),
    route(
      "/organizers/{organizerId}/events/{eventId}/publication/revoke",
      serveOrganizerEventPublicationRevoke,
      "hosted_organizer_event_publication_revoke",
    ),
    route(
      "/organizers/{organizerId}/events/{eventId}/outcomes/delete",
      serveOrganizerEventOutcomeDelete,
      "hosted_organizer_event_outcome_delete",
    ),
    route(
      "/organizers/{organizerId}/events/{eventId}/outcomes/restore",
      serveOrganizerEventOutcomeRestore,
      "hosted_organizer_event_outcome_restore",
    ),
    route(
      "/organizers/{organizerId}/events/{eventId}/audit",
      serveOrganizerEventAudit,
      "hosted_organizer_event_audit",
    ),
    route(
      "/organizers/{organizerId}/events/{eventId}/exports",
      serveOrganizerEventExports,
      "hosted_organizer_event_exports",
    ),
    route(
      "/organizers/{organizerId}/events/{eventId}/exports/{exportId}/download",
      serveOrganizerEventExportDownload,
      "hosted_organizer_event_export_download",
    ),
    route(
      "/organizers/{organizerId}/events/{eventId}/exports/{exportId}/revoke",
      serveOrganizerEventExportRevoke,
      "hosted_organizer_event_export_revoke",
    ),
    route(
      "/organizers/{organizerId}/events/{eventId}/exports/{exportId}/delete",
      serveOrganizerEventExportDelete,
      "hosted_organizer_event_export_delete",
    ),
    route(
      "/organizers/{organizerId}/credentials",
      serveOrganizerCredentialCreate,
      "hosted_organizer_credential_create",
    ),
    route(
      "/organizers/{organizerId}/credentials/{credentialId}/rotate",
      serveOrganizerCredentialRotate,
      "hosted_organizer_credential_rotate",
    ),
    route(
      "/organizers/{organizerId}/credentials/{credentialId}/revoke",
      serveOrganizerCredentialRevoke,
      "hosted_organizer_credential_revoke",
    ),
    route(
      "/organizers/{organizerId}/webhooks",
      serveOrganizerWebhookCreate,
      "hosted_organizer_webhook_create",
    ),
    route(
      "/organizers/{organizerId}/webhooks/{subscriptionId}/rotate",
      serveOrganizerWebhookRotate,
      "hosted_organizer_webhook_rotate",
    ),
    route(
      "/organizers/{organizerId}/webhooks/{subscriptionId}/revoke",
      serveOrganizerWebhookRevoke,
      "hosted_organizer_webhook_revoke",
    ),
    route(
      "/organizers/{organizerId}/webhooks/{subscriptionId}/resume",
      serveOrganizerWebhookResume,
      "hosted_organizer_webhook_resume",
    ),
    // The versioned integration API for organizer backends: credential-
    // authenticated, organizer-scoped. Browser Entry Grant redemption sits
    // with the other event-page flows below.
    route(
      "/api/v1/events/{publicId}",
      serveIntegrationApiEvent,
      "hosted_integration_event",
    ),
    route(
      "/api/v1/events/{publicId}/entry-grants",
      serveIntegrationApiEntryGrantCreate,
      "hosted_integration_entry_grant_create",
    ),
    route("/operator", serveOperatorConsole, "hosted_operator"),
    route(
      "/operator/board-sessions/{boardSessionId}/archive-retry",
      serveOperatorArchiveRetry,
      "hosted_operator_archive_retry",
    ),
    route(
      "/operator/events/{eventId}/outcome-purge-retry",
      serveOperatorOutcomePurgeRetry,
      "hosted_operator_outcome_purge_retry",
    ),
    route(
      "/operator/historical-imports",
      serveOperatorHistoricalImports,
      "hosted_operator_historical_imports",
    ),
    route(
      "/operator/reservations",
      serveOperatorReservations,
      "hosted_operator_reservations",
    ),
    route(
      "/operator/reservations/{reservationId}",
      serveOperatorReservation,
      "hosted_operator_reservation",
    ),
    route(
      "/operator/reservations/{reservationId}/approve",
      serveOperatorApproveReservation,
      "hosted_operator_reservation_approve",
    ),
    route(
      "/operator/reservations/{reservationId}/reject",
      serveOperatorRejectReservation,
      "hosted_operator_reservation_reject",
    ),
    route("/operator/changes", serveOperatorChanges, "hosted_operator_changes"),
    route(
      "/operator/changes/{changeRequestId}",
      serveOperatorChange,
      "hosted_operator_change",
    ),
    route(
      "/operator/changes/{changeRequestId}/approve",
      serveOperatorApproveChange,
      "hosted_operator_change_approve",
    ),
    route(
      "/operator/changes/{changeRequestId}/reject",
      serveOperatorRejectChange,
      "hosted_operator_change_reject",
    ),
    route(
      "/operator/applications/{applicationId}",
      serveOperatorApplication,
      "hosted_operator_application",
    ),
    route(
      "/operator/applications/{applicationId}/approve",
      serveOperatorApproveApplication,
      "hosted_operator_application_approve",
    ),
    route(
      "/operator/applications/{applicationId}/reject",
      serveOperatorRejectApplication,
      "hosted_operator_application_reject",
    ),
    // The SVG baseline route must precede the page route: a greedy
    // {boardName} segment would otherwise swallow the `.svg` suffix.
    route("/b/{boardName}.svg", serveEventBoardSvg, "hosted_event_board_svg"),
    route("/b/{boardName}", serveEventBoardPage, "hosted_event_board_page"),
    route("/events/{publicId}", serveEventPage, "hosted_event_page"),
    route("/events/{publicId}/enter", serveEventEnter, "hosted_event_enter"),
    route(
      "/events/{publicId}/entry-grant",
      serveEventEntryGrantRedeem,
      "hosted_event_entry_grant_redeem",
    ),
    route(
      "/events/{publicId}/anonymity",
      serveEventAnonymity,
      "hosted_event_anonymity",
    ),
    // The Published Canvas read routes: the bare URL serves the organizer and
    // members audiences, the token URL carries the link audience's share
    // token. Both are audience-checked on every read inside the handler.
    route(
      "/events/{publicId}/canvas",
      servePublishedCanvas,
      "hosted_published_canvas",
    ),
    route(
      "/events/{publicId}/canvas/{token}",
      servePublishedCanvas,
      "hosted_published_canvas_link",
    ),
    route("/assets/{assetId}", serveBrandAsset, "hosted_brand_asset"),
    route("/manifest.json", serveManifest, "manifest"),
    route("/", serveRoot, "index"),
    route("*", serveStaticAsset, "static_file"),
  ]);
}

/**
 * @param {string} prefix
 * @param {import("../types/server-runtime.d.ts").HttpRouteHandler} handler
 * @param {string} routeName
 * @param {{access?: "none" | "user", hostedOpenAccess?: boolean}=} options
 */
function boardNameRouteGroup(prefix, handler, routeName, options) {
  return [
    route(`${prefix}/{board}`, handler, routeName, options),
    ...missingBoardNameRoutes(prefix, routeName, options),
  ];
}

/**
 * Wraps a pre-Event WBO route handler so the Hosted Event Service
 * deterministically rejects it with a plain 404 — never a redirect — leaving
 * no compatibility path around admission. Legacy mode delegates unchanged.
 *
 * @param {import("../types/server-runtime.d.ts").HttpRouteHandler} handler
 * @returns {import("../types/server-runtime.d.ts").HttpRouteHandler}
 */
function withHostedRejection(handler) {
  return (ctx) => {
    if (ctx.runtime.hostedEventModule.enabled) {
      throw new BoundaryError(404, "hosted_legacy_entry_rejected");
    }
    return handler(ctx);
  };
}

/**
 * @param {string} prefix
 * @param {string} routeName
 * @param {{access?: "none" | "user", hostedOpenAccess?: boolean}=} options
 */
function missingBoardNameRoutes(prefix, routeName, options) {
  return [
    route(prefix, rejectMissingBoardName, routeName, options),
    route(`${prefix}/`, rejectMissingBoardName, routeName, options),
  ];
}

/**
 * @param {ServerConfig} config
 * @param {{
 *   runtime?: typeof createServerRuntime,
 *   installShutdownHandlers?: boolean,
 *   logStarted?: boolean,
 *   socketsModule?: SocketServerModule,
 * }} [options]
 * @returns {Promise<import("../types/server-runtime.d.ts").ServerApp>}
 */
async function createServerApp(config, options = {}) {
  return startWhiteboardServer(config, {
    runtime: options.runtime || createServerRuntime,
    http: createWhiteboardHttpHandler(),
    sockets: options.socketsModule || sockets,
    installShutdownHandlers: options.installShutdownHandlers,
    logStarted: options.logStarted,
  });
}

const entryArg = process.argv[1];
if (entryArg && path.resolve(entryArg) === fileURLToPath(import.meta.url)) {
  void createServerApp(productionConfig, {
    installShutdownHandlers: true,
  }).catch((error) => {
    logger.error("server.start_failed", {
      error,
    });
    // The structured record above travels through the observability pipeline,
    // which does not survive the immediate exit below: a misconfigured
    // deployment would terminate with status 1 and no diagnostic at all, and
    // fail-closed startup checks (a missing AUTH_SECRET_KEY, an unusable data
    // directory) are exactly the failures an operator must be able to read.
    // `writeSync` on the stderr descriptor is synchronous whether stderr is a
    // TTY, a file, or a pipe, so the reason is always on the way out first.
    writeSync(
      2,
      `server.start_failed: ${
        error instanceof Error ? error.stack || error.message : String(error)
      }\n`,
    );
    process.exit(1);
  });
}

export { createServerApp };
