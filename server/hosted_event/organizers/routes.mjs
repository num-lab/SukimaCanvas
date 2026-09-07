import { BoundaryError } from "../../http/boundary_errors.mjs";
import { publicPath } from "../../http/request_url.mjs";
import observability from "../../observability/index.mjs";
import { resolveRequestClientIpSafe } from "../../socket/policy.mjs";
import { isValidNormalizedEmail, normalizeEmail } from "../accounts/emails.mjs";
import { resolveSignedInAccountFromRequest } from "../accounts/routes.mjs";
import { NOTICE_KINDS } from "../notifications/notices.mjs";
import {
  createFormSecurity,
  readFormBody,
  seeOther,
  translate,
} from "../http_forms.mjs";
import { resolveOutcomePurgeFailureLabel } from "../outcomes.mjs";

const { logger } = observability;

/** @import { HttpRequest, HttpResponse, HttpRouteContext, ServerConfig } from "../../../types/server-runtime.d.ts" */

/**
 * @typedef {import("../../http/templating.mjs").Template & {
 *   serveWithStatus: (request: HttpRequest, response: HttpResponse, statusCode: number, extraParams?: object) => {encoding?: unknown},
 * }} HostedTemplate
 */

const MAX_ORGANIZER_NAME_LENGTH = 120;
const MAX_CONTACT_NAME_LENGTH = 120;
const MAX_CONTACT_EMAIL_LENGTH = 254;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_OPERATOR_NOTE_LENGTH = 2000;

/** Audit action -> template translation key for the operator activity log. */
const AUDIT_ACTION_KEYS = {
  "organizer_application.submitted": "hosted_operator_audit_submitted",
  "organizer_application.approved": "hosted_operator_audit_approved",
  "organizer_application.rejected": "hosted_operator_audit_rejected",
};

/** Audit action -> translation key for the organizer console activity log. */
const ORG_AUDIT_ACTION_KEYS = {
  "organizer_application.approved": "hosted_org_audit_created",
  "organizer_invitation.created": "hosted_org_audit_invitation_created",
  "organizer_invitation.accepted": "hosted_org_audit_invitation_accepted",
  "organizer_invitation.declined": "hosted_org_audit_invitation_declined",
  "organizer_invitation.revoked": "hosted_org_audit_invitation_revoked",
  "organizer_member.role_changed": "hosted_org_audit_role_changed",
  "organizer_member.removed": "hosted_org_audit_member_removed",
  "organizer_credential.created": "hosted_org_audit_credential_created",
  "organizer_credential.rotated": "hosted_org_audit_credential_rotated",
  "organizer_credential.revoked": "hosted_org_audit_credential_revoked",
};

/** Member role -> translation key for display labels. */
const ROLE_LABEL_KEYS = {
  owner: "hosted_role_owner",
  admin: "hosted_role_admin",
};

/** Archive failure code -> translation key for the operator console. */
const ARCHIVE_FAILURE_LABEL_KEYS = {
  final_sequence_mismatch: "hosted_archive_failure_final_sequence_mismatch",
  snapshot_save_failed: "hosted_archive_failure_snapshot_save_failed",
  ledger_unavailable: "hosted_archive_failure_ledger_unavailable",
  storage_write_failed: "hosted_archive_failure_storage_write_failed",
  archive_conflict: "hosted_archive_failure_archive_conflict",
  seal_failed: "hosted_archive_failure_seal_failed",
  internal: "hosted_archive_failure_internal",
};

/** Notice kind -> translation key for the operator console retry list. */
const NOTICE_KIND_LABEL_KEYS = {
  [NOTICE_KINDS.ACCOUNT_VERIFICATION]:
    "hosted_notice_kind_account_verification",
  [NOTICE_KINDS.ACCOUNT_PASSWORD_RESET]:
    "hosted_notice_kind_account_password_reset",
  [NOTICE_KINDS.RESERVATION_APPROVED]:
    "hosted_notice_kind_reservation_approved",
  [NOTICE_KINDS.RESERVATION_REJECTED]:
    "hosted_notice_kind_reservation_rejected",
  [NOTICE_KINDS.CHANGE_REQUEST_APPLIED]:
    "hosted_notice_kind_change_request_applied",
  [NOTICE_KINDS.CHANGE_REQUEST_REJECTED]:
    "hosted_notice_kind_change_request_rejected",
  [NOTICE_KINDS.EVENT_CANCELLED]: "hosted_notice_kind_event_cancelled",
  [NOTICE_KINDS.SESSION_UPCOMING]: "hosted_notice_kind_session_upcoming",
  [NOTICE_KINDS.SESSION_ARCHIVED]: "hosted_notice_kind_session_archived",
  [NOTICE_KINDS.SESSION_ARCHIVE_FAILED]:
    "hosted_notice_kind_session_archive_failed",
  [NOTICE_KINDS.WEBHOOK_SUSPENDED]: "hosted_notice_kind_webhook_suspended",
};

/**
 * HTTP flows for Organizer Applications and the Platform Operator console.
 *
 * A verified account submits one application at a time and sees its status; a
 * Platform Operator (an account whose email is provisioned in
 * `HOSTED_OPERATOR_EMAILS`) reviews the pending queue and approves or rejects
 * each application, and reviews Board Sessions whose archive failed and
 * retries their close. Approval atomically creates the Organizer and grants
 * the applicant Organizer Owner. Every input is hostile until validated, and
 * no response ever exposes the operator-only rejection note to the applicant.
 *
 * @param {{
 *   config: ServerConfig,
 *   accountStore: ReturnType<typeof import("../accounts/store.mjs").createFileAccountStore>,
 *   organizerStore: ReturnType<typeof import("./store.mjs").createFileOrganizerStore>,
 *   integrationStore: ReturnType<typeof import("../integrations/store.mjs").createFileIntegrationStore>,
 *   webhookStore: ReturnType<typeof import("../webhooks/store.mjs").createFileWebhookStore>,
 *   limiter: ReturnType<typeof import("../accounts/rate_limits.mjs").createRateLimiter>,
 *   operatorEmails: Set<string>,
 *   notificationStore?: ReturnType<typeof import("../notifications/store.mjs").createFileNotificationStore>,
 *   advanceEventLifecycle?: () => Promise<void>,
 *   templates: {
 *     organizerApply: HostedTemplate,
 *     operator: HostedTemplate,
 *     operatorApplication: HostedTemplate,
 *     organizerConsole: HostedTemplate,
 *     organizerManage: HostedTemplate,
 *   },
 * }} dependencies
 */
function createOrganizerRoutes(dependencies) {
  const {
    config,
    accountStore,
    organizerStore,
    integrationStore,
    webhookStore,
    limiter,
    operatorEmails,
    notificationStore,
    advanceEventLifecycle,
    templates,
  } = dependencies;
  const { ensureCsrfToken, requestHasValidCsrf } = createFormSecurity(config);

  /**
   * @param {HttpRouteContext} ctx
   * @returns {{accountId: string, email: string, publicId: string} | null}
   */
  function signedInAccount(ctx) {
    return resolveSignedInAccountFromRequest(accountStore, ctx.request);
  }

  /**
   * @param {{email: string} | null} account
   * @returns {boolean}
   */
  function isOperator(account) {
    return account !== null && operatorEmails.has(account.email);
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void}
   */
  function redirectToLogin(ctx) {
    seeOther(ctx, publicPath(config, "/login"));
  }

  /**
   * @param {string} language
   * @param {number} ms
   * @returns {string}
   */
  function formatTimestamp(language, ms) {
    return new Date(ms).toLocaleString(language);
  }

  // --- applicant: organizer application ------------------------------------

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void | Promise<void>}
   */
  function serveOrganizerApply(ctx) {
    if (ctx.request.method === "POST") return handleApplySubmission(ctx);
    if (ctx.request.method === "GET") {
      if (!signedInAccount(ctx)) {
        redirectToLogin(ctx);
        return;
      }
      renderApplyPage(ctx, 200, {});
      return;
    }
    throw new BoundaryError(405, "method_not_allowed");
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {number} statusCode
   * @param {{
   *   errorKey?: string,
   *   values?: {organizerName?: string, contactName?: string, contactEmail?: string, description?: string},
   *   submitted?: boolean,
   * }} state
   * @returns {void}
   */
  function renderApplyPage(ctx, statusCode, state) {
    const signedIn = signedInAccount(ctx);
    if (!signedIn) {
      redirectToLogin(ctx);
      return;
    }
    const { language } = templates.organizerApply.translationsFor(
      ctx.request,
      ctx.url,
    );
    const view = organizerStore.getApplicantView(signedIn.accountId);
    // The form is offered when there is no application yet, or the most recent
    // one was rejected (the applicant may re-apply). A pending or approved
    // application shows status only.
    const showForm = !view || view.status === "rejected";
    const values = state.values || {};
    const csrfToken = ensureCsrfToken(ctx);
    templates.organizerApply.serveWithStatus(
      ctx.request,
      ctx.response,
      statusCode,
      {
        hostedOrganizerHasApplication: Boolean(view),
        hostedOrganizerStatus: view
          ? {
              variant: view.status,
              title: translate(
                templates.organizerApply,
                ctx,
                `hosted_organizer_status_${view.status}`,
              ),
              body: translate(
                templates.organizerApply,
                ctx,
                `hosted_organizer_status_${view.status}_body`,
                { name: view.organizerName },
              ),
              organizerName: view.organizerName,
              submittedAt: formatTimestamp(language, view.createdAtMs),
            }
          : undefined,
        hostedOrganizerShowForm: showForm,
        hostedOrganizerApplyError: state.errorKey
          ? translate(templates.organizerApply, ctx, state.errorKey)
          : undefined,
        hostedOrganizerApplySuccess: state.submitted
          ? translate(
              templates.organizerApply,
              ctx,
              "hosted_organizer_apply_success",
            )
          : undefined,
        hostedOrganizerNameValue: values.organizerName || "",
        hostedOrganizerContactNameValue: values.contactName || "",
        hostedOrganizerContactEmailValue:
          values.contactEmail || signedIn.email || "",
        hostedOrganizerDescriptionValue: values.description || "",
        csrfToken,
      },
    );
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleApplySubmission(ctx) {
    const signedIn = signedInAccount(ctx);
    if (!signedIn) {
      redirectToLogin(ctx);
      return;
    }
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderApplyPage(ctx, 403, { errorKey: "hosted_error_csrf" });
      return;
    }
    const address = resolveRequestClientIpSafe(config, ctx.request);
    const limit = config.HOSTED_ORGANIZER_APPLY_ATTEMPTS_LIMIT;
    const windowMs = config.HOSTED_ORGANIZER_APPLY_ATTEMPTS_WINDOW_MS;
    const allowed =
      limiter.consume(
        "organizer_apply",
        `account:${signedIn.accountId}`,
        limit,
        windowMs,
      ).allowed &&
      limiter.consume("organizer_apply", `ip:${address}`, limit, windowMs)
        .allowed;
    if (!allowed) {
      renderApplyPage(ctx, 429, { errorKey: "hosted_error_rate_limited" });
      return;
    }

    const organizerName = (form.get("organizerName") || "").trim();
    const contactName = (form.get("contactName") || "").trim();
    const contactEmailRaw = form.get("contactEmail") || "";
    const contactEmail = normalizeEmail(contactEmailRaw);
    const description = (form.get("description") || "").trim();
    /** @type {{organizerName: string, contactName: string, contactEmail: string, description: string}} */
    const values = {
      organizerName,
      contactName,
      contactEmail: contactEmailRaw.trim(),
      description,
    };
    if (
      organizerName.length < 1 ||
      organizerName.length > MAX_ORGANIZER_NAME_LENGTH
    ) {
      renderApplyPage(ctx, 400, {
        errorKey: "hosted_organizer_apply_error_name",
        values,
      });
      return;
    }
    if (
      contactName.length < 1 ||
      contactName.length > MAX_CONTACT_NAME_LENGTH
    ) {
      renderApplyPage(ctx, 400, {
        errorKey: "hosted_organizer_apply_error_contact_name",
        values,
      });
      return;
    }
    if (
      contactEmail.length > MAX_CONTACT_EMAIL_LENGTH ||
      !isValidNormalizedEmail(contactEmail)
    ) {
      renderApplyPage(ctx, 400, {
        errorKey: "hosted_organizer_apply_error_contact_email",
        values,
      });
      return;
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      renderApplyPage(ctx, 400, {
        errorKey: "hosted_organizer_apply_error_description",
        values,
      });
      return;
    }

    const result = await organizerStore.submitApplication({
      accountId: signedIn.accountId,
      organizerName,
      contactName,
      contactEmail,
      description,
    });
    if (!result.ok) {
      // A non-rejected application already exists: refuse deterministically and
      // re-render the current status rather than creating a conflicting
      // application or a duplicate Organizer. The pending case gets an explicit
      // message; the approved case is shown by its status card alone (this path
      // is only reachable by a direct POST, since the form is hidden then).
      renderApplyPage(ctx, 409, {
        errorKey:
          result.reason === "already_pending"
            ? "hosted_organizer_apply_error_exists"
            : undefined,
      });
      return;
    }
    logger.info("hosted.organizer_application_submitted", {
      account_id: signedIn.accountId,
      application_id: result.application.applicationId,
    });
    seeOther(ctx, `${publicPath(config, "/organizer/apply")}?submitted=1`);
  }

  // --- operator console ----------------------------------------------------

  /**
   * Resolves the request to a Platform Operator, or renders the appropriate
   * gate (login redirect for signed-out visitors, 403 for signed-in
   * non-operators) and returns null.
   *
   * @param {HttpRouteContext} ctx
   * @returns {{accountId: string, email: string, publicId: string} | null}
   */
  function requireOperator(ctx) {
    const account = signedInAccount(ctx);
    if (!account) {
      redirectToLogin(ctx);
      return null;
    }
    if (!isOperator(account)) {
      renderOperatorForbidden(ctx);
      return null;
    }
    return account;
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void}
   */
  function renderOperatorForbidden(ctx) {
    templates.operator.serveWithStatus(ctx.request, ctx.response, 403, {
      hostedOperatorForbidden: translate(
        templates.operator,
        ctx,
        "hosted_operator_forbidden",
      ),
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {number} statusCode
   * @param {{noticeKey?: string}} state
   * @returns {void}
   */
  function renderOperatorConsole(ctx, statusCode, state) {
    const template = templates.operator;
    const { language } = template.translationsFor(ctx.request, ctx.url);
    const pending = organizerStore
      .listPendingApplications()
      .map((application) => {
        const applicant = accountStore.getAccountById(application.accountId);
        return {
          applicationId: application.applicationId,
          organizerName: application.organizerName,
          applicantEmail: applicant ? applicant.email : "",
          submittedAt: formatTimestamp(language, application.createdAtMs),
        };
      });
    // The archive-failure work list: Board Sessions waiting in
    // ARCHIVE_FAILED. The failure detail (code, message, attempts) is the
    // operator's recovery context and renders only on this authorized
    // console — organizer and participant surfaces show no internal errors.
    const archiveFailures = organizerStore
      .listArchiveFailedBoardSessions()
      .map((session) => {
        const event = organizerStore.getEventById(session.eventId);
        const organizer = organizerStore.getOrganizerById(session.organizerId);
        const failure = session.archiveFailure;
        const labelKey = failure
          ? ARCHIVE_FAILURE_LABEL_KEYS[
              /** @type {keyof typeof ARCHIVE_FAILURE_LABEL_KEYS} */ (
                failure.code
              )
            ]
          : undefined;
        return {
          boardSessionId: session.boardSessionId,
          eventName: event ? event.name : "",
          organizerName: organizer ? organizer.name : "",
          failureCode: failure
            ? labelKey
              ? translate(template, ctx, labelKey)
              : failure.code
            : "",
          failureMessage: failure ? failure.message : "",
          failureAttempts: failure ? failure.attempts : 0,
          lastFailedAt: failure
            ? formatTimestamp(language, failure.lastFailedAtMs)
            : "",
        };
      });
    // The outcome-purge work list: events with a pending early deletion or a
    // failed retention purge. The failure detail is operator-console material
    // and never renders on organizer or participant surfaces.
    const outcomePurges = organizerStore.listOutcomePurgeWork().map((item) => {
      const failure = item.event.outcomePurgeFailure;
      const failureCode = failure
        ? resolveOutcomePurgeFailureLabel(failure, translate, template, ctx)
        : "";
      const organizer = organizerStore.getOrganizerById(item.event.organizerId);
      return {
        eventId: item.event.eventId,
        eventName: item.event.name,
        organizerName: organizer ? organizer.name : "",
        deletionPending:
          item.deletion !== null && item.deletion.purgedAtMs === null,
        purgeAt: item.deletion
          ? formatTimestamp(language, item.deletion.purgeAtMs)
          : "",
        failureCode,
        failureMessage: failure ? failure.message : "",
        failureAttempts: failure ? failure.attempts : 0,
        lastFailedAt: failure
          ? formatTimestamp(language, failure.lastFailedAtMs)
          : "",
      };
    });

    // The mail delivery retry list: notices the mail vendor has not accepted
    // yet. Only authorized operators see recipients and errors; the queue
    // itself keeps retrying with backoff in the background.
    const noticeRetries = notificationStore
      ? notificationStore.listRetrying().map((notice) => {
          const labelKey =
            NOTICE_KIND_LABEL_KEYS[
              /** @type {keyof typeof NOTICE_KIND_LABEL_KEYS} */ (notice.kind)
            ];
          return {
            kindLabel: labelKey
              ? translate(template, ctx, labelKey)
              : notice.kind,
            recipient: notice.to,
            attempts: notice.attempts,
            lastAttempt: notice.lastAttemptAtMs
              ? formatTimestamp(language, notice.lastAttemptAtMs)
              : "",
            nextAttempt: formatTimestamp(language, notice.nextAttemptAtMs),
            lastError: notice.lastError || "",
          };
        })
      : [];
    template.serveWithStatus(ctx.request, ctx.response, statusCode, {
      hostedOperatorPending: pending,
      hostedOperatorPendingCount: pending.length,
      hostedOperatorHasPending: pending.length > 0,
      hostedOperatorArchiveFailures: archiveFailures,
      hostedOperatorHasArchiveFailures: archiveFailures.length > 0,
      hostedOperatorOutcomePurges: outcomePurges,
      hostedOperatorHasOutcomePurges: outcomePurges.length > 0,
      hostedOperatorNoticeRetries: noticeRetries,
      hostedOperatorHasNoticeRetries: noticeRetries.length > 0,
      hostedOperatorArchiveNotice: state.noticeKey
        ? translate(template, ctx, state.noticeKey)
        : undefined,
      csrfToken: ensureCsrfToken(ctx),
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void}
   */
  function serveOperatorConsole(ctx) {
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const operator = requireOperator(ctx);
    if (!operator) return;
    renderOperatorConsole(ctx, 200, {});
  }

  /**
   * A Platform Operator's authorized archive retry: moves the failed Board
   * Session back into the close pipeline and runs one lifecycle pass now, so
   * the re-rendered console shows the outcome immediately. The retry is
   * idempotent at the store (guarded by the session's status) and at the
   * pipeline (deterministic archive objects, immutable store), so double
   * submissions and racing operators are deterministic notices, never
   * duplicate archives.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOperatorArchiveRetry(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const operator = requireOperator(ctx);
    if (!operator) return;
    const boardSessionId = ctx.params.boardSessionId || "";
    const session = organizerStore.getBoardSessionById(boardSessionId);
    if (!session) throw new BoundaryError(404, "board_session_not_found");
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderOperatorConsole(ctx, 403, { noticeKey: "hosted_error_csrf" });
      return;
    }
    const retry = await organizerStore.retryBoardSessionArchive({
      boardSessionId,
      operatorAccountId: operator.accountId,
    });
    if (!retry.ok) {
      // Already sealed, cancelled, or retried by a concurrent operator: the
      // console re-renders the current state with a deterministic notice.
      renderOperatorConsole(ctx, 409, {
        noticeKey: "hosted_operator_archive_retry_error_state",
      });
      return;
    }
    logger.info("hosted.board_session_archive_retry_requested", {
      operator_account_id: operator.accountId,
      board_session: boardSessionId,
    });
    if (typeof advanceEventLifecycle === "function") {
      // Run the close pipeline now: the retried session is due immediately,
      // and the console's failure list reflects the attempt's outcome.
      await advanceEventLifecycle();
    }
    const outcome = organizerStore.getBoardSessionById(boardSessionId);
    renderOperatorConsole(ctx, 200, {
      noticeKey:
        outcome && outcome.status === "closed"
          ? "hosted_operator_archive_retry_completed"
          : "hosted_operator_archive_retry_failed",
    });
  }

  /**
   * A Platform Operator's authorized outcome-purge retry: clears the event's
   * durable purge-failure context so the very next retention pass attempts
   * the purge again, and runs one lifecycle pass now so the re-rendered
   * console shows the outcome. Guarded by the store (an event without a
   * failure context is refused), so double submissions and racing operators
   * are deterministic notices, never duplicate purges.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOperatorOutcomePurgeRetry(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const operator = requireOperator(ctx);
    if (!operator) return;
    const eventId = ctx.params.eventId || "";
    if (!organizerStore.getEventById(eventId)) {
      throw new BoundaryError(404, "event_not_found");
    }
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderOperatorConsole(ctx, 403, { noticeKey: "hosted_error_csrf" });
      return;
    }
    const retry = await organizerStore.retryEventOutcomePurge({
      eventId,
      operatorAccountId: operator.accountId,
    });
    if (!retry.ok) {
      renderOperatorConsole(ctx, 409, {
        noticeKey: "hosted_operator_outcome_purge_retry_error_state",
      });
      return;
    }
    logger.info("hosted.event_outcome_purge_retry_requested", {
      operator_account_id: operator.accountId,
      event: eventId,
    });
    if (typeof advanceEventLifecycle === "function") {
      // Run the retention pass now: the retried event is due immediately, and
      // the console's work list reflects the attempt's outcome.
      await advanceEventLifecycle();
    }
    const event = organizerStore.getEventById(eventId);
    renderOperatorConsole(ctx, 200, {
      noticeKey:
        event && event.outcomeDeletion && event.outcomeDeletion.purgedAtMs
          ? "hosted_operator_outcome_purge_completed"
          : "hosted_operator_outcome_purge_failed",
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void}
   */
  function serveOperatorApplication(ctx) {
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const operator = requireOperator(ctx);
    if (!operator) return;
    const application = organizerStore.getApplicationById(
      ctx.params.applicationId || "",
    );
    if (!application) throw new BoundaryError(404, "application_not_found");
    renderOperatorApplication(ctx, 200, application, {});
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {number} statusCode
   * @param {import("./store.mjs").StoredApplication} application
   * @param {{noticeKey?: string}} state
   * @returns {void}
   */
  function renderOperatorApplication(ctx, statusCode, application, state) {
    const { language } = templates.operatorApplication.translationsFor(
      ctx.request,
      ctx.url,
    );
    const applicant = accountStore.getAccountById(application.accountId);
    const decidedBy = application.decidedByAccountId
      ? accountStore.getAccountById(application.decidedByAccountId)
      : null;
    const auditView = organizerStore
      .listAuditForApplication(application.applicationId)
      .map((record) => {
        const actor = accountStore.getAccountById(record.actorAccountId);
        const actionKey =
          AUDIT_ACTION_KEYS[
            /** @type {keyof typeof AUDIT_ACTION_KEYS} */ (record.action)
          ];
        return {
          action: actionKey
            ? translate(templates.operatorApplication, ctx, actionKey)
            : record.action,
          actorEmail: actor ? actor.email : "",
          at: formatTimestamp(language, record.createdAtMs),
        };
      });
    const csrfToken = ensureCsrfToken(ctx);
    templates.operatorApplication.serveWithStatus(
      ctx.request,
      ctx.response,
      statusCode,
      {
        hostedOperatorApplicationId: application.applicationId,
        hostedOperatorApplicantEmail: applicant ? applicant.email : "",
        hostedOperatorOrganizerName: application.organizerName,
        hostedOperatorContactName: application.contactName,
        hostedOperatorContactEmail: application.contactEmail,
        hostedOperatorDescription: application.description || undefined,
        hostedOperatorStatusPending: application.status === "pending",
        hostedOperatorStatusApproved: application.status === "approved",
        hostedOperatorStatusRejected: application.status === "rejected",
        hostedOperatorDecidedBy: decidedBy ? decidedBy.email : undefined,
        hostedOperatorDecidedAt: application.decidedAtMs
          ? formatTimestamp(language, application.decidedAtMs)
          : undefined,
        // The operator-only note is shown here but never on the applicant view.
        hostedOperatorNote: application.operatorNote || undefined,
        hostedOperatorAudit: auditView,
        hostedOperatorNotice: state.noticeKey
          ? translate(templates.operatorApplication, ctx, state.noticeKey)
          : undefined,
        csrfToken,
      },
    );
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
    const form = await readFormBody(ctx.request);
    const applicationId = ctx.params.applicationId || "";
    const application = organizerStore.getApplicationById(applicationId);
    if (!application) throw new BoundaryError(404, "application_not_found");
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderOperatorApplication(ctx, 403, application, {
        noticeKey: "hosted_error_csrf",
      });
      return;
    }

    const result =
      decision === "approve"
        ? await organizerStore.approveApplication({
            applicationId,
            operatorAccountId: operator.accountId,
          })
        : await organizerStore.rejectApplication({
            applicationId,
            operatorAccountId: operator.accountId,
            note: (form.get("note") || "").slice(0, MAX_OPERATOR_NOTE_LENGTH),
          });
    if (!result.ok) {
      // The application was already decided (possibly by a concurrent
      // operator): re-render its current state with a deterministic notice.
      const current =
        organizerStore.getApplicationById(applicationId) || application;
      renderOperatorApplication(ctx, 409, current, {
        noticeKey: "hosted_operator_decision_error_state",
      });
      return;
    }
    logger.info(
      `hosted.organizer_application_${decision === "approve" ? "approved" : "rejected"}`,
      {
        operator_account_id: operator.accountId,
        application_id: applicationId,
        ...("organizerId" in result
          ? { organizer_id: result.organizerId }
          : {}),
      },
    );
    seeOther(
      ctx,
      publicPath(config, `/operator/applications/${applicationId}`),
    );
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  function serveOperatorApproveApplication(ctx) {
    return handleDecision(ctx, "approve");
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  function serveOperatorRejectApplication(ctx) {
    return handleDecision(ctx, "reject");
  }

  // --- organizer console: memberships & invitations ------------------------

  /**
   * @param {HttpRouteContext} ctx
   * @param {string} key
   * @param {import("../../http/templating.mjs").Template} template
   * @returns {string}
   */
  function roleLabel(ctx, key, template) {
    const labelKey =
      ROLE_LABEL_KEYS[/** @type {keyof typeof ROLE_LABEL_KEYS} */ (key)];
    return labelKey ? translate(template, ctx, labelKey) : key;
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void | Promise<void>}
   */
  function serveOrganizerConsole(ctx) {
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    if (!signedInAccount(ctx)) {
      redirectToLogin(ctx);
      return;
    }
    renderConsole(ctx, 200, {});
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {number} statusCode
   * @param {{errorKey?: string}} state
   * @returns {void}
   */
  function renderConsole(ctx, statusCode, state) {
    const account = signedInAccount(ctx);
    if (!account) {
      redirectToLogin(ctx);
      return;
    }
    const memberships = organizerStore
      .listOrganizersForAccount(account.accountId)
      .map((membership) => ({
        organizerId: membership.organizerId,
        name: membership.name,
        roleLabel: roleLabel(ctx, membership.role, templates.organizerConsole),
      }));
    const invitations = organizerStore
      .listPendingInvitationsForEmail(account.email)
      .map((invitation) => ({
        invitationId: invitation.invitationId,
        organizerName: invitation.organizerName,
        roleLabel: roleLabel(ctx, invitation.role, templates.organizerConsole),
      }));
    templates.organizerConsole.serveWithStatus(
      ctx.request,
      ctx.response,
      statusCode,
      {
        hostedOrganizerMemberships: memberships,
        hostedOrganizerHasMemberships: memberships.length > 0,
        hostedOrganizerInvitations: invitations,
        hostedOrganizerHasInvitations: invitations.length > 0,
        hostedOrganizerConsoleError: state.errorKey
          ? translate(templates.organizerConsole, ctx, state.errorKey)
          : undefined,
        csrfToken: ensureCsrfToken(ctx),
      },
    );
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {"accept" | "decline"} decision
   * @returns {Promise<void>}
   */
  async function handleInvitationResponse(ctx, decision) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const account = signedInAccount(ctx);
    if (!account) {
      redirectToLogin(ctx);
      return;
    }
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderConsole(ctx, 403, { errorKey: "hosted_error_csrf" });
      return;
    }
    const invitationId = ctx.params.invitationId || "";
    const result =
      decision === "accept"
        ? await organizerStore.acceptInvitation({
            invitationId,
            accountId: account.accountId,
            accountEmail: account.email,
          })
        : await organizerStore.declineInvitation({
            invitationId,
            accountId: account.accountId,
            accountEmail: account.email,
          });
    if (!result.ok) {
      // Invalid, expired, revoked, used, and wrong-recipient invitations all
      // fail identically so nothing about other organizers leaks.
      renderConsole(ctx, 409, {
        errorKey: "hosted_organizer_invitation_unavailable",
      });
      return;
    }
    logger.info(
      `hosted.organizer_invitation_${decision === "accept" ? "accepted" : "declined"}`,
      { account_id: account.accountId },
    );
    if (decision === "accept" && "organizerId" in result) {
      seeOther(ctx, publicPath(config, `/organizers/${result.organizerId}`));
      return;
    }
    seeOther(ctx, publicPath(config, "/organizer"));
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  function serveOrganizerInvitationAccept(ctx) {
    return handleInvitationResponse(ctx, "accept");
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  function serveOrganizerInvitationDecline(ctx) {
    return handleInvitationResponse(ctx, "decline");
  }

  // --- organizer management (member/invitation admin) ----------------------

  /**
   * Resolves the signed-in account's membership in an organizer. Redirects
   * signed-out visitors to login and returns null; a signed-in non-member gets a
   * 404 so the organizer's existence is not disclosed.
   *
   * @param {HttpRouteContext} ctx
   * @param {string} organizerId
   * @returns {{account: {accountId: string, email: string}, role: "owner" | "admin"} | null}
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
    return { account, role };
  }

  /**
   * Like requireMember, but additionally requires the Owner role for the
   * Owner-only management actions; an Admin member gets a 403.
   *
   * @param {HttpRouteContext} ctx
   * @param {string} organizerId
   * @returns {{account: {accountId: string, email: string}, role: "owner"} | null}
   */
  function requireOwner(ctx, organizerId) {
    const membership = requireMember(ctx, organizerId);
    if (!membership) return null;
    if (membership.role !== "owner") {
      throw new BoundaryError(403, "organizer_owner_required");
    }
    return { account: membership.account, role: "owner" };
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void}
   */
  function serveOrganizerManage(ctx) {
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const membership = requireMember(ctx, organizerId);
    if (!membership) return;
    renderManage(ctx, 200, organizerId, membership, {});
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {number} statusCode
   * @param {string} organizerId
   * @param {{account: {accountId: string, email: string}, role: "owner" | "admin"}} membership
   * @param {{errorKey?: string, credentialReveal?: string, credentialCreated?: boolean, webhookReveal?: string, webhookCreated?: boolean, noticeKey?: string}} state
   * @returns {void}
   */
  function renderManage(ctx, statusCode, organizerId, membership, state) {
    const template = templates.organizerManage;
    const { language } = template.translationsFor(ctx.request, ctx.url);
    const organizer = organizerStore.getOrganizerById(organizerId);
    if (!organizer) throw new BoundaryError(404, "organizer_not_found");
    const isOwner = membership.role === "owner";
    const members = organizerStore.listMembers(organizerId).map((member) => {
      const account = accountStore.getAccountById(member.accountId);
      return {
        accountId: member.accountId,
        email: account ? account.email : "",
        roleLabel: roleLabel(ctx, member.role, template),
        isOwner: member.role === "owner",
        isSelf: member.accountId === membership.account.accountId,
        // The role toggle offers the opposite role.
        toggleRole: member.role === "owner" ? "admin" : "owner",
        toggleLabel: translate(
          template,
          ctx,
          member.role === "owner"
            ? "hosted_org_member_make_admin"
            : "hosted_org_member_make_owner",
        ),
      };
    });
    const invitations = organizerStore
      .listInvitationsForOrganizer(organizerId)
      .map((invitation) => ({
        invitationId: invitation.invitationId,
        email: invitation.email,
        roleLabel: roleLabel(ctx, invitation.role, template),
        expiresAt: formatTimestamp(language, invitation.expiresAtMs),
      }));
    // The change-audit trail is an Owner-only view. Operator-performed records
    // (organizer creation) are shown with a generic label so a platform
    // operator's personal email is never disclosed to organizer members.
    const audit = isOwner
      ? organizerStore.listAuditForOrganizer(organizerId).map((record) => {
          const actionKey =
            ORG_AUDIT_ACTION_KEYS[
              /** @type {keyof typeof ORG_AUDIT_ACTION_KEYS} */ (record.action)
            ];
          const actor =
            record.actorKind === "operator"
              ? translate(template, ctx, "hosted_org_audit_actor_platform")
              : accountStore.getAccountById(record.actorAccountId)?.email || "";
          return {
            action: actionKey
              ? translate(template, ctx, actionKey)
              : record.action,
            actorEmail: actor,
            at: formatTimestamp(language, record.createdAtMs),
          };
        })
      : [];
    // API credential metadata is an Owner-only view. Only digests are stored,
    // so the list can never expose a bearer value; the raw secret appears
    // exactly once through `credentialReveal` right after create or rotate.
    const credentials = isOwner
      ? integrationStore
          .listCredentialsForOrganizer(organizerId)
          .map((credential) => ({
            credentialId: credential.credentialId,
            isActive: credential.status === "active",
            isRevoked: credential.status === "revoked",
            createdAt: formatTimestamp(language, credential.createdAtMs),
            rotatedAt: credential.rotatedAtMs
              ? formatTimestamp(language, credential.rotatedAtMs)
              : undefined,
            revokedAt: credential.revokedAtMs
              ? formatTimestamp(language, credential.revokedAtMs)
              : undefined,
          }))
      : [];
    // Webhook subscriptions are an Owner-only view; the projection never
    // carries the signing secret — it is revealed exactly once through
    // `webhookReveal` right after create or rotate.
    const webhooks = isOwner
      ? webhookStore
          .listSubscriptionsForOrganizer(organizerId)
          .map((subscription) => ({
            subscriptionId: subscription.subscriptionId,
            url: subscription.url,
            isActive: subscription.status === "active",
            isSuspended: subscription.status === "suspended",
            isRevoked: subscription.status === "revoked",
            createdAt: formatTimestamp(language, subscription.createdAtMs),
            rotatedAt: subscription.rotatedAtMs
              ? formatTimestamp(language, subscription.rotatedAtMs)
              : undefined,
            suspendedAt: subscription.suspendedAtMs
              ? formatTimestamp(language, subscription.suspendedAtMs)
              : undefined,
            revokedAt: subscription.revokedAtMs
              ? formatTimestamp(language, subscription.revokedAtMs)
              : undefined,
          }))
      : [];
    template.serveWithStatus(ctx.request, ctx.response, statusCode, {
      hostedOrganizerId: organizerId,
      hostedOrganizerName: organizer.name,
      hostedOrganizerRoleLabel: roleLabel(ctx, membership.role, template),
      hostedOrganizerIsOwner: isOwner,
      hostedOrganizerMembers: members,
      hostedOrganizerInvites: invitations,
      hostedOrganizerHasInvites: invitations.length > 0,
      hostedOrganizerCredentials: credentials,
      hostedOrganizerHasCredentials: credentials.length > 0,
      hostedOrganizerCredentialReveal: state.credentialReveal,
      hostedOrganizerCredentialCreated: state.credentialCreated === true,
      hostedOrganizerWebhooks: webhooks,
      hostedOrganizerHasWebhooks: webhooks.length > 0,
      hostedOrganizerWebhookReveal: state.webhookReveal,
      hostedOrganizerWebhookCreated: state.webhookCreated === true,
      hostedOrganizerWebhookResumed: state.noticeKey
        ? translate(template, ctx, state.noticeKey)
        : undefined,
      hostedOrganizerAudit: audit,
      hostedOrganizerManageError: state.errorKey
        ? translate(template, ctx, state.errorKey)
        : undefined,
      csrfToken: ensureCsrfToken(ctx),
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerInvite(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const owner = requireOwner(ctx, organizerId);
    if (!owner) return;
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderManage(ctx, 403, organizerId, owner, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    const address = resolveRequestClientIpSafe(config, ctx.request);
    const limit = config.HOSTED_ORGANIZER_INVITE_ATTEMPTS_LIMIT;
    const windowMs = config.HOSTED_ORGANIZER_INVITE_ATTEMPTS_WINDOW_MS;
    if (
      !limiter.consume(
        "organizer_invite",
        `account:${owner.account.accountId}`,
        limit,
        windowMs,
      ).allowed ||
      !limiter.consume("organizer_invite", `ip:${address}`, limit, windowMs)
        .allowed
    ) {
      renderManage(ctx, 429, organizerId, owner, {
        errorKey: "hosted_error_rate_limited",
      });
      return;
    }
    const email = normalizeEmail(form.get("email") || "");
    const role = form.get("role") === "owner" ? "owner" : "admin";
    if (
      email.length > MAX_CONTACT_EMAIL_LENGTH ||
      !isValidNormalizedEmail(email)
    ) {
      renderManage(ctx, 400, organizerId, owner, {
        errorKey: "hosted_org_invite_error_email",
      });
      return;
    }
    const invitee = accountStore.getAccountByEmail(email);
    const result = await organizerStore.createInvitation({
      organizerId,
      email,
      role,
      invitedByAccountId: owner.account.accountId,
      memberAccountId: invitee ? invitee.accountId : null,
    });
    if (!result.ok) {
      renderManage(ctx, 409, organizerId, owner, {
        errorKey:
          result.reason === "already_member"
            ? "hosted_org_invite_error_member"
            : "hosted_org_invite_error_pending",
      });
      return;
    }
    logger.info("hosted.organizer_invitation_created", {
      organizer_id: organizerId,
      invited_by: owner.account.accountId,
      invitation_id: result.invitation.invitationId,
    });
    seeOther(ctx, publicPath(config, `/organizers/${organizerId}`));
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerInvitationRevoke(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const owner = requireOwner(ctx, organizerId);
    if (!owner) return;
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderManage(ctx, 403, organizerId, owner, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    const invitationId = ctx.params.invitationId || "";
    const invitation = organizerStore.getInvitationById(invitationId);
    // The invitation must belong to this organizer; otherwise treat it as
    // absent so nothing about another organizer's invitations leaks.
    if (!invitation || invitation.organizerId !== organizerId) {
      throw new BoundaryError(404, "invitation_not_found");
    }
    await organizerStore.revokeInvitation({
      invitationId,
      actorAccountId: owner.account.accountId,
    });
    seeOther(ctx, publicPath(config, `/organizers/${organizerId}`));
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerMemberRole(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const owner = requireOwner(ctx, organizerId);
    if (!owner) return;
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderManage(ctx, 403, organizerId, owner, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    const newRole = form.get("role") === "owner" ? "owner" : "admin";
    const result = await organizerStore.changeMemberRole({
      organizerId,
      targetAccountId: ctx.params.accountId || "",
      newRole,
      actorAccountId: owner.account.accountId,
    });
    if (!result.ok) {
      if (result.reason === "not_member") {
        throw new BoundaryError(404, "member_not_found");
      }
      renderManage(ctx, 409, organizerId, owner, {
        errorKey: "hosted_org_member_error_last_owner",
      });
      return;
    }
    logger.info("hosted.organizer_member_role_changed", {
      organizer_id: organizerId,
      actor: owner.account.accountId,
    });
    seeOther(ctx, publicPath(config, `/organizers/${organizerId}`));
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerMemberRemove(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const owner = requireOwner(ctx, organizerId);
    if (!owner) return;
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderManage(ctx, 403, organizerId, owner, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    const result = await organizerStore.removeMember({
      organizerId,
      targetAccountId: ctx.params.accountId || "",
      actorAccountId: owner.account.accountId,
    });
    if (!result.ok) {
      if (result.reason === "not_member") {
        throw new BoundaryError(404, "member_not_found");
      }
      renderManage(ctx, 409, organizerId, owner, {
        errorKey: "hosted_org_member_error_last_owner",
      });
      return;
    }
    logger.info("hosted.organizer_member_removed", {
      organizer_id: organizerId,
      actor: owner.account.accountId,
    });
    seeOther(ctx, publicPath(config, `/organizers/${organizerId}`));
  }

  // --- API credential administration (Owner-only) ---------------------------

  /**
   * Consumes the Owner's credential-management rate budget (create and rotate
   * mint secrets; revoke is deliberately unlimited so a leaked credential can
   * always be killed immediately).
   *
   * @param {HttpRouteContext} ctx
   * @param {string} organizerId
   * @param {{account: {accountId: string, email: string}, role: "owner"}} owner
   * @returns {Promise<boolean>} false when the budget is exhausted (response rendered)
   */
  async function consumeCredentialBudget(ctx, organizerId, owner) {
    const address = resolveRequestClientIpSafe(config, ctx.request);
    const limit = config.HOSTED_CREDENTIAL_ATTEMPTS_LIMIT;
    const windowMs = config.HOSTED_CREDENTIAL_ATTEMPTS_WINDOW_MS;
    if (
      !limiter.consume(
        "organizer_credential",
        `account:${owner.account.accountId}`,
        limit,
        windowMs,
      ).allowed ||
      !limiter.consume("organizer_credential", `ip:${address}`, limit, windowMs)
        .allowed
    ) {
      renderManage(ctx, 429, organizerId, owner, {
        errorKey: "hosted_error_rate_limited",
      });
      return false;
    }
    return true;
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerCredentialCreate(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const owner = requireOwner(ctx, organizerId);
    if (!owner) return;
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderManage(ctx, 403, organizerId, owner, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    if (!(await consumeCredentialBudget(ctx, organizerId, owner))) return;
    const result = await integrationStore.createCredential({
      organizerId,
      createdByAccountId: owner.account.accountId,
    });
    organizerStore.appendAudit({
      actorAccountId: owner.account.accountId,
      actorKind: "account",
      action: "organizer_credential.created",
      subjectType: "organizer_credential",
      subjectId: result.credential.credentialId,
      organizerId,
    });
    logger.info("hosted.organizer_credential_created", {
      organizer_id: organizerId,
      credential_id: result.credential.credentialId,
    });
    renderManage(ctx, 200, organizerId, owner, {
      credentialReveal: result.token,
      credentialCreated: true,
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerCredentialRotate(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const owner = requireOwner(ctx, organizerId);
    if (!owner) return;
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderManage(ctx, 403, organizerId, owner, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    if (!(await consumeCredentialBudget(ctx, organizerId, owner))) return;
    const result = await integrationStore.rotateCredential({
      organizerId,
      credentialId: ctx.params.credentialId || "",
    });
    if (!result.ok) {
      if (result.reason === "not_found") {
        throw new BoundaryError(404, "credential_not_found");
      }
      renderManage(ctx, 409, organizerId, owner, {
        errorKey: "hosted_org_credentials_error_revoked",
      });
      return;
    }
    organizerStore.appendAudit({
      actorAccountId: owner.account.accountId,
      actorKind: "account",
      action: "organizer_credential.rotated",
      subjectType: "organizer_credential",
      subjectId: ctx.params.credentialId || "",
      organizerId,
    });
    logger.info("hosted.organizer_credential_rotated", {
      organizer_id: organizerId,
      credential_id: ctx.params.credentialId || "",
    });
    renderManage(ctx, 200, organizerId, owner, {
      credentialReveal: result.token,
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerCredentialRevoke(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const owner = requireOwner(ctx, organizerId);
    if (!owner) return;
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderManage(ctx, 403, organizerId, owner, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    const result = await integrationStore.revokeCredential({
      organizerId,
      credentialId: ctx.params.credentialId || "",
    });
    if (!result.ok) {
      throw new BoundaryError(404, "credential_not_found");
    }
    organizerStore.appendAudit({
      actorAccountId: owner.account.accountId,
      actorKind: "account",
      action: "organizer_credential.revoked",
      subjectType: "organizer_credential",
      subjectId: ctx.params.credentialId || "",
      organizerId,
    });
    logger.info("hosted.organizer_credential_revoked", {
      organizer_id: organizerId,
      credential_id: ctx.params.credentialId || "",
    });
    seeOther(ctx, publicPath(config, `/organizers/${organizerId}`));
  }

  // --- organizer webhook subscriptions (Owner-only) -------------------------

  /**
   * Creates a Webhook Subscription and reveals its signing secret exactly
   * once, on this response. Only an Organizer Owner may create one or ever
   * see a secret.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerWebhookCreate(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const owner = requireOwner(ctx, organizerId);
    if (!owner) return;
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderManage(ctx, 403, organizerId, owner, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    const url = String(form.get("url") || "");
    const result = await webhookStore.createSubscription({
      organizerId,
      url,
      actorAccountId: owner.account.accountId,
    });
    if (!result.ok) {
      renderManage(ctx, 400, organizerId, owner, {
        errorKey: "hosted_org_webhook_error_invalid_url",
      });
      return;
    }
    organizerStore.appendAudit({
      actorAccountId: owner.account.accountId,
      actorKind: "account",
      action: "organizer_webhook.created",
      subjectType: "organizer_webhook",
      subjectId: result.subscription.subscriptionId,
      organizerId,
    });
    logger.info("hosted.organizer_webhook_created", {
      organizer_id: organizerId,
      subscription_id: result.subscription.subscriptionId,
    });
    renderManage(ctx, 200, organizerId, owner, {
      webhookReveal: result.secret,
      webhookCreated: true,
    });
  }

  /**
   * Rotates a subscription's signing secret: the previous secret stops
   * verifying immediately and the new one is revealed exactly once.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerWebhookRotate(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const owner = requireOwner(ctx, organizerId);
    if (!owner) return;
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderManage(ctx, 403, organizerId, owner, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    const result = await webhookStore.rotateSubscriptionSecret({
      organizerId,
      subscriptionId: ctx.params.subscriptionId || "",
    });
    if (!result.ok) {
      if (result.reason === "not_found") {
        throw new BoundaryError(404, "webhook_not_found");
      }
      renderManage(ctx, 409, organizerId, owner, {
        errorKey: "hosted_org_webhook_error_state",
      });
      return;
    }
    organizerStore.appendAudit({
      actorAccountId: owner.account.accountId,
      actorKind: "account",
      action: "organizer_webhook.rotated",
      subjectType: "organizer_webhook",
      subjectId: result.subscription.subscriptionId,
      organizerId,
    });
    logger.info("hosted.organizer_webhook_rotated", {
      organizer_id: organizerId,
      subscription_id: result.subscription.subscriptionId,
    });
    renderManage(ctx, 200, organizerId, owner, {
      webhookReveal: result.secret,
    });
  }

  /**
   * Revokes a subscription. Pending queued events for it are dropped with
   * the Owner's explicit opt-out; delivered history is untouched.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerWebhookRevoke(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const owner = requireOwner(ctx, organizerId);
    if (!owner) return;
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderManage(ctx, 403, organizerId, owner, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    const result = await webhookStore.revokeSubscription({
      organizerId,
      subscriptionId: ctx.params.subscriptionId || "",
    });
    if (!result.ok) {
      if (result.reason === "not_found") {
        throw new BoundaryError(404, "webhook_not_found");
      }
      renderManage(ctx, 409, organizerId, owner, {
        errorKey: "hosted_org_webhook_error_state",
      });
      return;
    }
    organizerStore.appendAudit({
      actorAccountId: owner.account.accountId,
      actorKind: "account",
      action: "organizer_webhook.revoked",
      subjectType: "organizer_webhook",
      subjectId: ctx.params.subscriptionId || "",
      organizerId,
    });
    logger.info("hosted.organizer_webhook_revoked", {
      organizer_id: organizerId,
      subscription_id: ctx.params.subscriptionId || "",
    });
    renderManage(ctx, 200, organizerId, owner, {});
  }

  /**
   * Resumes a suspended subscription: every event record queued before or
   * during the suspension becomes deliverable again.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerWebhookResume(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const owner = requireOwner(ctx, organizerId);
    if (!owner) return;
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderManage(ctx, 403, organizerId, owner, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    const result = await webhookStore.resumeSubscription({
      organizerId,
      subscriptionId: ctx.params.subscriptionId || "",
    });
    if (!result.ok) {
      if (result.reason === "not_found") {
        throw new BoundaryError(404, "webhook_not_found");
      }
      renderManage(ctx, 409, organizerId, owner, {
        errorKey: "hosted_org_webhook_error_state",
      });
      return;
    }
    organizerStore.appendAudit({
      actorAccountId: owner.account.accountId,
      actorKind: "account",
      action: "organizer_webhook.resumed",
      subjectType: "organizer_webhook",
      subjectId: ctx.params.subscriptionId || "",
      organizerId,
    });
    logger.info("hosted.organizer_webhook_resumed", {
      organizer_id: organizerId,
      subscription_id: ctx.params.subscriptionId || "",
    });
    renderManage(ctx, 200, organizerId, owner, {
      noticeKey: "hosted_org_webhook_resumed",
    });
  }

  return {
    serveOrganizerApply,
    serveOperatorConsole,
    serveOperatorArchiveRetry,
    serveOperatorOutcomePurgeRetry,
    serveOperatorApplication,
    serveOperatorApproveApplication,
    serveOperatorRejectApplication,
    serveOrganizerConsole,
    serveOrganizerInvitationAccept,
    serveOrganizerInvitationDecline,
    serveOrganizerManage,
    serveOrganizerInvite,
    serveOrganizerInvitationRevoke,
    serveOrganizerMemberRole,
    serveOrganizerMemberRemove,
    serveOrganizerCredentialCreate,
    serveOrganizerCredentialRotate,
    serveOrganizerCredentialRevoke,
    serveOrganizerWebhookCreate,
    serveOrganizerWebhookRotate,
    serveOrganizerWebhookRevoke,
    serveOrganizerWebhookResume,
  };
}

export { createOrganizerRoutes };
