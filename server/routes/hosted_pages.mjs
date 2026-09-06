import { serveError } from "../http/observation.mjs";

/** @import { HttpRouteContext, HostedEventModule } from "../../types/server-runtime.d.ts" */

/**
 * Hosted account pages exist only in hosted mode. Legacy WBO has no account
 * concept, so each route rejects with a deterministic 404 instead of falling
 * through to static file resolution.
 *
 * @param {keyof Pick<HostedEventModule, "serveRegister" | "serveLogin" | "serveVerify" | "serveLogout" | "serveForgot" | "serveReset" | "serveAccount" | "serveAccountPassword" | "serveAccountSessionRevoke" | "serveAccountSessionsRevokeOthers" | "serveOrganizerApply" | "serveOperatorConsole" | "serveOperatorArchiveRetry" | "serveOperatorApplication" | "serveOperatorApproveApplication" | "serveOperatorRejectApplication" | "serveOrganizerConsole" | "serveOrganizerInvitationAccept" | "serveOrganizerInvitationDecline" | "serveOrganizerManage" | "serveOrganizerInvite" | "serveOrganizerInvitationRevoke" | "serveOrganizerMemberRole" | "serveOrganizerMemberRemove" | "serveOrganizerReservations" | "serveOrganizerReservation" | "serveSubmitReservation" | "serveCancelReservation" | "serveSubmitChangeRequest" | "serveOperatorReservations" | "serveOperatorReservation" | "serveOperatorApproveReservation" | "serveOperatorRejectReservation" | "serveOperatorChanges" | "serveOperatorChange" | "serveOperatorApproveChange" | "serveOperatorRejectChange" | "serveEventPage" | "serveEventEnter" | "serveEventAnonymity" | "serveBrandAsset" | "serveOrganizerEvent" | "serveOrganizerEventAccessCode" | "serveOrganizerEventEntryLock" | "serveOrganizerEventModerators" | "serveOrganizerEventModeratorRevoke" | "serveOrganizerEventCover" | "serveOrganizerEventExports" | "serveOrganizerEventExportDownload" | "serveOrganizerEventExportRevoke" | "serveOrganizerEventExportDelete" | "serveOrganizerCredentialCreate" | "serveOrganizerCredentialRotate" | "serveOrganizerCredentialRevoke" | "serveEventEntryGrantRedeem" | "serveIntegrationApiEvent" | "serveIntegrationApiEntryGrantCreate">} handlerName
 * @returns {import("../../types/server-runtime.d.ts").HttpRouteHandler}
 */
function serveHostedAccountPage(handlerName) {
  return (ctx) => {
    const hostedEventModule = ctx.runtime.hostedEventModule;
    if (!hostedEventModule.enabled) {
      serveError(
        ctx.request,
        ctx.response,
        ctx.runtime.errorPage,
        ctx.observed,
      )();
      return;
    }
    return hostedEventModule[handlerName](ctx);
  };
}

export const serveRegister = serveHostedAccountPage("serveRegister");
export const serveLogin = serveHostedAccountPage("serveLogin");
export const serveVerify = serveHostedAccountPage("serveVerify");
export const serveLogout = serveHostedAccountPage("serveLogout");
export const serveForgot = serveHostedAccountPage("serveForgot");
export const serveReset = serveHostedAccountPage("serveReset");
export const serveAccount = serveHostedAccountPage("serveAccount");
export const serveAccountPassword = serveHostedAccountPage(
  "serveAccountPassword",
);
export const serveAccountSessionRevoke = serveHostedAccountPage(
  "serveAccountSessionRevoke",
);
export const serveAccountSessionsRevokeOthers = serveHostedAccountPage(
  "serveAccountSessionsRevokeOthers",
);
export const serveOrganizerApply = serveHostedAccountPage(
  "serveOrganizerApply",
);
export const serveOperatorConsole = serveHostedAccountPage(
  "serveOperatorConsole",
);
export const serveOperatorArchiveRetry = serveHostedAccountPage(
  "serveOperatorArchiveRetry",
);
export const serveOperatorApplication = serveHostedAccountPage(
  "serveOperatorApplication",
);
export const serveOperatorApproveApplication = serveHostedAccountPage(
  "serveOperatorApproveApplication",
);
export const serveOperatorRejectApplication = serveHostedAccountPage(
  "serveOperatorRejectApplication",
);
export const serveOrganizerConsole = serveHostedAccountPage(
  "serveOrganizerConsole",
);
export const serveOrganizerInvitationAccept = serveHostedAccountPage(
  "serveOrganizerInvitationAccept",
);
export const serveOrganizerInvitationDecline = serveHostedAccountPage(
  "serveOrganizerInvitationDecline",
);
export const serveOrganizerManage = serveHostedAccountPage(
  "serveOrganizerManage",
);
export const serveOrganizerInvite = serveHostedAccountPage(
  "serveOrganizerInvite",
);
export const serveOrganizerInvitationRevoke = serveHostedAccountPage(
  "serveOrganizerInvitationRevoke",
);
export const serveOrganizerMemberRole = serveHostedAccountPage(
  "serveOrganizerMemberRole",
);
export const serveOrganizerMemberRemove = serveHostedAccountPage(
  "serveOrganizerMemberRemove",
);
export const serveOrganizerReservations = serveHostedAccountPage(
  "serveOrganizerReservations",
);
export const serveOrganizerReservation = serveHostedAccountPage(
  "serveOrganizerReservation",
);
export const serveSubmitReservation = serveHostedAccountPage(
  "serveSubmitReservation",
);
export const serveCancelReservation = serveHostedAccountPage(
  "serveCancelReservation",
);
export const serveOperatorReservations = serveHostedAccountPage(
  "serveOperatorReservations",
);
export const serveOperatorReservation = serveHostedAccountPage(
  "serveOperatorReservation",
);
export const serveOperatorApproveReservation = serveHostedAccountPage(
  "serveOperatorApproveReservation",
);
export const serveOperatorRejectReservation = serveHostedAccountPage(
  "serveOperatorRejectReservation",
);
export const serveSubmitChangeRequest = serveHostedAccountPage(
  "serveSubmitChangeRequest",
);
export const serveOperatorChanges = serveHostedAccountPage(
  "serveOperatorChanges",
);
export const serveOperatorChange = serveHostedAccountPage(
  "serveOperatorChange",
);
export const serveOperatorApproveChange = serveHostedAccountPage(
  "serveOperatorApproveChange",
);
export const serveOperatorRejectChange = serveHostedAccountPage(
  "serveOperatorRejectChange",
);
export const serveEventPage = serveHostedAccountPage("serveEventPage");
export const serveEventEnter = serveHostedAccountPage("serveEventEnter");
export const serveEventAnonymity = serveHostedAccountPage(
  "serveEventAnonymity",
);
export const serveBrandAsset = serveHostedAccountPage("serveBrandAsset");
export const serveOrganizerEvent = serveHostedAccountPage(
  "serveOrganizerEvent",
);
export const serveOrganizerEventAccessCode = serveHostedAccountPage(
  "serveOrganizerEventAccessCode",
);
export const serveOrganizerEventEntryLock = serveHostedAccountPage(
  "serveOrganizerEventEntryLock",
);
export const serveOrganizerEventModerators = serveHostedAccountPage(
  "serveOrganizerEventModerators",
);
export const serveOrganizerEventModeratorRevoke = serveHostedAccountPage(
  "serveOrganizerEventModeratorRevoke",
);
export const serveOrganizerEventCover = serveHostedAccountPage(
  "serveOrganizerEventCover",
);
export const serveOrganizerEventExports = serveHostedAccountPage(
  "serveOrganizerEventExports",
);
export const serveOrganizerEventExportDownload = serveHostedAccountPage(
  "serveOrganizerEventExportDownload",
);
export const serveOrganizerEventExportRevoke = serveHostedAccountPage(
  "serveOrganizerEventExportRevoke",
);
export const serveOrganizerEventExportDelete = serveHostedAccountPage(
  "serveOrganizerEventExportDelete",
);
export const serveOrganizerCredentialCreate = serveHostedAccountPage(
  "serveOrganizerCredentialCreate",
);
export const serveOrganizerCredentialRotate = serveHostedAccountPage(
  "serveOrganizerCredentialRotate",
);
export const serveOrganizerCredentialRevoke = serveHostedAccountPage(
  "serveOrganizerCredentialRevoke",
);
export const serveEventEntryGrantRedeem = serveHostedAccountPage(
  "serveEventEntryGrantRedeem",
);
export const serveIntegrationApiEvent = serveHostedAccountPage(
  "serveIntegrationApiEvent",
);
export const serveIntegrationApiEntryGrantCreate = serveHostedAccountPage(
  "serveIntegrationApiEntryGrantCreate",
);
