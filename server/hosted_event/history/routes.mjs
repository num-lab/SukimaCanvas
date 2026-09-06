import { BoundaryError } from "../../http/boundary_errors.mjs";
import { publicPath } from "../../http/request_url.mjs";
import { resolveSignedInAccountFromRequest } from "../accounts/routes.mjs";
import { readMultipartFormData } from "../assets/upload.mjs";
import { createFormSecurity, seeOther, translate } from "../http_forms.mjs";
import {
  IMPORT_FAILURE_CODES,
  MAX_HISTORICAL_IMPORT_BYTES,
} from "./legacy_svg_import.mjs";

/** @import { HttpRequest, HttpResponse, HttpRouteContext, ServerConfig } from "../../../types/server-runtime.d.ts" */

/**
 * @typedef {import("../../http/templating.mjs").Template & {
 *   serveWithStatus: (request: HttpRequest, response: HttpResponse, statusCode: number, extraParams?: object) => {encoding?: unknown},
 * }} HostedTemplate
 */

/** Headroom over the source cap for multipart boundaries, headers, and fields. */
const MULTIPART_BODY_HEADROOM_BYTES = 64 * 1024;

/** Deterministic import failure code -> operator console label key. */
const IMPORT_REASON_LABEL_KEYS = {
  [IMPORT_FAILURE_CODES.EMPTY]: "hosted_operator_history_reason_empty",
  [IMPORT_FAILURE_CODES.TOO_LARGE]: "hosted_operator_history_reason_too_large",
  [IMPORT_FAILURE_CODES.ENCODING]: "hosted_operator_history_reason_encoding",
  [IMPORT_FAILURE_CODES.STRUCTURE]: "hosted_operator_history_reason_structure",
  [IMPORT_FAILURE_CODES.ITEM_INVALID]: "hosted_operator_history_reason_item",
  WBO_HISTORY_IMPORT_STORAGE_FAILED: "hosted_operator_history_reason_storage",
};

/** How many audit-trail entries the console page lists, newest first. */
const AUDIT_LIST_LIMIT = 20;

/**
 * HTTP flows for the Platform Operator's controlled Historical Archive
 * import: an explicit form that uploads one legacy WBO SVG for one explicitly
 * selected Organizer. The page is operator-only in every mode, and every
 * outcome — imported, refused as a duplicate, rejected for its content, or
 * failed at storage — re-renders this page with a deterministic notice while
 * the durable import record keeps the audit trail.
 *
 * @param {{
 *   config: ServerConfig,
 *   accountStore: ReturnType<typeof import("../accounts/store.mjs").createFileAccountStore>,
 *   organizerStore: ReturnType<typeof import("../organizers/store.mjs").createFileOrganizerStore>,
 *   historyStore: ReturnType<typeof import("./store.mjs").createFileHistoricalArchiveStore>,
 *   operatorEmails: Set<string>,
 *   templates: {
 *     operatorHistoricalImports: HostedTemplate,
 *   },
 * }} dependencies
 */
function createHistoricalImportRoutes(dependencies) {
  const {
    config,
    accountStore,
    organizerStore,
    historyStore,
    operatorEmails,
    templates,
  } = dependencies;
  const { ensureCsrfToken, requestHasValidCsrf } = createFormSecurity(config);

  /**
   * Resolves the request to a Platform Operator, or renders the appropriate
   * gate (login redirect for signed-out visitors, 403 for signed-in
   * non-operators) and returns null.
   *
   * @param {HttpRouteContext} ctx
   * @returns {{accountId: string, email: string} | null}
   */
  function requireOperator(ctx) {
    const account = resolveSignedInAccountFromRequest(
      accountStore,
      ctx.request,
    );
    if (!account) {
      seeOther(ctx, publicPath(config, "/login"));
      return null;
    }
    if (!operatorEmails.has(account.email)) {
      templates.operatorHistoricalImports.serveWithStatus(
        ctx.request,
        ctx.response,
        403,
        {
          hostedOperatorForbidden: translate(
            templates.operatorHistoricalImports,
            ctx,
            "hosted_operator_forbidden",
          ),
        },
      );
      return null;
    }
    return account;
  }

  /**
   * @param {string} language
   * @param {number} ms
   * @returns {string}
   */
  function formatTimestamp(language, ms) {
    return new Date(ms).toLocaleString(language || "en");
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {number} statusCode
   * @param {{noticeKey?: string, noticeSubstitutions?: {[name: string]: string}}} state
   * @returns {void}
   */
  function renderImportPage(ctx, statusCode, state) {
    const template = templates.operatorHistoricalImports;
    const { language } = template.translationsFor(ctx.request, ctx.url);
    const organizers = organizerStore.listOrganizers();
    const audit = historyStore
      .listImports()
      .slice(0, AUDIT_LIST_LIMIT)
      .map((record) => {
        const organizer = organizerStore.getOrganizerById(record.organizerId);
        const labelKey = record.failure
          ? IMPORT_REASON_LABEL_KEYS[record.failure.code]
          : undefined;
        return {
          statusImported: record.status === "imported",
          statusLabel:
            record.status === "imported"
              ? translate(
                  template,
                  ctx,
                  "hosted_operator_history_status_imported",
                )
              : translate(
                  template,
                  ctx,
                  "hosted_operator_history_status_failed",
                ),
          organizerName: organizer ? organizer.name : "",
          sourceLabel: record.sourceLabel,
          itemCount: record.itemCount === null ? "" : String(record.itemCount),
          attemptedAt: formatTimestamp(language, record.attemptedAtMs),
          failureLabel:
            record.failure && labelKey
              ? translate(template, ctx, labelKey)
              : record.failure
                ? record.failure.code
                : "",
          failureDetail: record.failure ? record.failure.message : "",
        };
      });
    template.serveWithStatus(ctx.request, ctx.response, statusCode, {
      hostedOperatorHistoryOrganizers: organizers,
      hostedOperatorHistoryHasOrganizers: organizers.length > 0,
      hostedOperatorHistoryImports: audit,
      hostedOperatorHistoryHasImports: audit.length > 0,
      hostedOperatorHistoryNotice: state.noticeKey
        ? translate(template, ctx, state.noticeKey, state.noticeSubstitutions)
        : undefined,
      csrfToken: ensureCsrfToken(ctx),
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void | Promise<void>}
   */
  function serveOperatorHistoricalImports(ctx) {
    if (ctx.request.method === "POST") return handleImportSubmission(ctx);
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    if (!requireOperator(ctx)) return;
    renderImportPage(ctx, 200, {});
  }

  /**
   * One controlled import submission. The multipart body is bounded, the
   * target Organizer and the source are both explicit form inputs, and every
   * outcome re-renders the page — the operator never depends on redirects to
   * learn what happened to the file they chose.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleImportSubmission(ctx) {
    const operator = requireOperator(ctx);
    if (!operator) return;
    const upload = await readMultipartFormData(ctx.request, {
      maxBytes: MAX_HISTORICAL_IMPORT_BYTES + MULTIPART_BODY_HEADROOM_BYTES,
    });
    const csrfForm = new URLSearchParams({
      _csrf: upload.fields._csrf || "",
    });
    if (!requestHasValidCsrf(ctx.request, csrfForm)) {
      renderImportPage(ctx, 403, { noticeKey: "hosted_error_csrf" });
      return;
    }
    const organizerId = upload.fields.organizerId || "";
    if (!organizerStore.getOrganizerById(organizerId)) {
      renderImportPage(ctx, 400, {
        noticeKey: "hosted_operator_history_notice_unknown_organizer",
      });
      return;
    }
    if (!upload.file || upload.file.bytes.length === 0) {
      renderImportPage(ctx, 400, {
        noticeKey: "hosted_operator_history_notice_missing_file",
      });
      return;
    }
    const result = await historyStore.importLegacySvg({
      organizerId,
      bytes: upload.file.bytes,
      sourceLabel: upload.file.filename,
      operatorAccountId: operator.accountId,
    });
    if (result.ok) {
      renderImportPage(ctx, 200, {
        noticeKey: "hosted_operator_history_notice_imported",
        noticeSubstitutions: { items: String(result.record.itemCount ?? 0) },
      });
      return;
    }
    if (result.reason === "duplicate") {
      const { language: submissionLanguage } =
        templates.operatorHistoricalImports.translationsFor(
          ctx.request,
          ctx.url,
        );
      renderImportPage(ctx, 409, {
        noticeKey: "hosted_operator_history_notice_duplicate",
        noticeSubstitutions: {
          importId: result.record.importId,
          attemptedAt: formatTimestamp(
            submissionLanguage,
            result.record.attemptedAtMs,
          ),
        },
      });
      return;
    }
    if (result.reason === "unknown_organizer") {
      renderImportPage(ctx, 400, {
        noticeKey: "hosted_operator_history_notice_unknown_organizer",
      });
      return;
    }
    const labelKey =
      IMPORT_REASON_LABEL_KEYS[
        /** @type {keyof typeof IMPORT_REASON_LABEL_KEYS} */ (
          result.failure.code
        )
      ];
    renderImportPage(ctx, result.reason === "rejected" ? 422 : 500, {
      noticeKey: labelKey || "hosted_operator_history_reason_unspecified",
      noticeSubstitutions: labelKey ? undefined : { code: result.failure.code },
    });
  }

  return { serveOperatorHistoricalImports };
}

export { createHistoricalImportRoutes };
