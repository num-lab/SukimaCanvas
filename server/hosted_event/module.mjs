import { registerBoardMutationLedgerFactory } from "../board/ledger_registry.mjs";
import { localizedHref, Template } from "../http/templating.mjs";
import observability from "../observability/index.mjs";
import { createHostedCaptcha } from "./accounts/captcha.mjs";
import { createMailDelivery } from "./accounts/mail.mjs";
import { createRateLimiter } from "./accounts/rate_limits.mjs";
import {
  createHostedAccountRoutes,
  resolveSignedInAccountFromRequest,
} from "./accounts/routes.mjs";
import { createFileAccountStore } from "./accounts/store.mjs";
import { createEventAdmission } from "./admission/index.mjs";
import { createBoardArchivePipeline } from "./archive/close.mjs";
import { createFileBrandAssetStore } from "./assets/store.mjs";
import { createParticipantIdentifierResolver } from "./attribution.mjs";
import { createEventRoutes } from "./events/routes.mjs";
import { createBoardExportPipeline } from "./export/pipeline.mjs";
import { createFileBoardExportStore } from "./export/store.mjs";
import { createHistoricalImportRoutes } from "./history/routes.mjs";
import { createFileHistoricalArchiveStore } from "./history/store.mjs";
import { createIntegrationRoutes } from "./integrations/routes.mjs";
import { createFileIntegrationStore } from "./integrations/store.mjs";
import { createFileEventMembershipStore } from "./memberships/store.mjs";
import { createEventModeration } from "./moderation/index.mjs";
import { createFileModerationStore } from "./moderation/store.mjs";
import { createFileNotificationStore } from "./notifications/store.mjs";
import { createNotificationService } from "./notifications/service.mjs";
import { createOrganizerRoutes } from "./organizers/routes.mjs";
import { createFileWebhookStore } from "./webhooks/store.mjs";
import { createWebhookPipeline } from "./webhooks/pipeline.mjs";
import { createFileOrganizerStore } from "./organizers/store.mjs";
import { createOutcomeRetentionPipeline } from "./outcomes.mjs";
import { createFilePublicationStore } from "./publication/store.mjs";
import { createReservationRoutes } from "./reservations/routes.mjs";
import { createHostedStorage } from "./storage/index.mjs";

/** @import { HttpRequest, HttpResponse, ServerConfig } from "../../types/server-runtime.d.ts" */

const { logger, metrics } = observability;

const HOSTED_LANGUAGES = ["en", "zh-CN"];
const ROLLING_VERSION_LABELS = new Set([
  "current",
  "default",
  "develop",
  "development",
  "dev",
  "head",
  "latest",
  "main",
  "master",
  "release",
  "stable",
  "trunk",
]);

class HostedPageTemplate extends Template {
  /**
   * @param {string} templatePath
   * @param {ServerConfig} serverConfig
   * @param {{htmlHeadSnippet?: string, resolveAccount?: (request: HttpRequest) => {accountId: string, email: string, isOperator: boolean} | null}} [options]
   */
  constructor(templatePath, serverConfig, options) {
    super(templatePath, serverConfig, {
      ...options,
      supportedLanguages: HOSTED_LANGUAGES,
      languageMatching: "strict",
    });
    this.resolveAccount = options?.resolveAccount;
  }

  /**
   * @param {URL} parsedUrl
   * @param {HttpRequest} request
   * @param {boolean} isModerator
   * @param {{sourceAvailable?: boolean, sourceUrl?: string, deploymentVersion?: string, sourceBuildInstructions?: string}} [extraParams]
   * @returns {import("../http/templating.mjs").TemplateParameters}
   */
  parameters(parsedUrl, request, isModerator, extraParams = {}) {
    const params = super.parameters(
      parsedUrl,
      request,
      isModerator,
      extraParams,
    );
    const pagePath = parsedUrl.pathname === "/source" ? "source" : ".";
    const pageUrl = new URL(pagePath, params.baseHref).href;
    params.hostedLanguage = params.language;
    params.hostedDirection = params.direction;
    params.hostedTranslations = params.translations;
    params.hostedLanguageLinks = params.languages.map((language) => ({
      language,
      href: localizedHref(pageUrl, language),
    }));
    params.hostedCanonicalUrl = localizedHref(pageUrl, params.language);
    // Hosted pages render account state, so they must never be cached by
    // shared caches or stored by browsers.
    params.varyCookie = true;
    const account = this.resolveAccount ? this.resolveAccount(request) : null;
    params.hostedAccount = account
      ? { email: account.email, isOperator: account.isOperator }
      : null;
    return params;
  }

  /**
   * @returns {string}
   */
  cacheControl() {
    return "no-store";
  }

  /**
   * @param {HttpRequest} request
   * @param {HttpResponse} response
   * @param {number} statusCode
   * @param {object} [extraParams]
   * @returns {{encoding: import("../http/compression.mjs").CompressionEncoding | undefined}}
   */
  serveWithStatus(request, response, statusCode, extraParams) {
    // Verification links carry single-use tokens in the URL; hosted pages
    // must never propagate their URLs onward through Referer.
    response.setHeader("Referrer-Policy", "no-referrer");
    return this.serveStatus(request, response, statusCode, false, extraParams);
  }
}

/**
 * @param {ServerConfig} config
 * @param {{
 *   homeTemplatePath: string,
 *   sourceTemplatePath: string,
 *   registerTemplatePath: string,
 *   loginTemplatePath: string,
 *   verifyTemplatePath: string,
 *   logoutTemplatePath: string,
 *   forgotTemplatePath: string,
 *   resetTemplatePath: string,
 *   accountTemplatePath: string,
 *   organizerApplyTemplatePath: string,
 *   operatorTemplatePath: string,
 *   operatorApplicationTemplatePath: string,
 *   organizerConsoleTemplatePath: string,
 *   organizerManageTemplatePath: string,
 *   organizerReservationsTemplatePath: string,
 *   organizerReservationTemplatePath: string,
 *   operatorReservationsTemplatePath: string,
 *   operatorReservationTemplatePath: string,
 *   operatorChangesTemplatePath: string,
 *   operatorChangeTemplatePath: string,
 *   operatorHistoricalImportsTemplatePath: string,
 *   eventTemplatePath: string,
 *   organizerEventTemplatePath: string,
 *   organizerEventAuditTemplatePath: string,
 *   publishedCanvasTemplatePath: string,
 *   htmlHeadSnippet?: string,
 * }} paths
 * @returns {import("../../types/server-runtime.d.ts").HostedEventModule}
 */
function createHostedEventModule(config, paths) {
  // The clock is an injectable adapter: deployments use the Date.now
  // default, isolated tests override it through the composed config object
  // so expiry and revocation are exercised against server-authoritative
  // time without sleeps.
  const clock =
    typeof config.HOSTED_CLOCK === "function" ? config.HOSTED_CLOCK : undefined;
  const storage = createHostedStorage(config);
  const { archiveStore, stateDocuments } = storage;
  const store = createFileAccountStore({
    dataDir: config.HOSTED_DATA_DIR,
    stateDocuments,
    clock,
    sessionMaxAgeMs: config.HOSTED_SESSION_MAX_AGE_MS,
    sessionIdleMs: config.HOSTED_SESSION_IDLE_TIMEOUT_MS,
    verificationTokenTtlMs: config.HOSTED_VERIFICATION_TOKEN_TTL_MS,
    passwordResetTtlMs: config.HOSTED_PASSWORD_RESET_TTL_MS,
  });
  const organizerStore = createFileOrganizerStore({
    dataDir: config.HOSTED_DATA_DIR,
    stateDocuments,
    clock,
  });
  const assetStore = createFileBrandAssetStore({
    dataDir: config.HOSTED_DATA_DIR,
    stateDocuments,
    objectStore: config.HOSTED_OBJECT_STORE === "s3" ? archiveStore : undefined,
    clock,
  });
  const membershipStore = createFileEventMembershipStore({
    dataDir: config.HOSTED_DATA_DIR,
    stateDocuments,
    clock,
  });
  const moderationStore = createFileModerationStore({
    dataDir: config.HOSTED_DATA_DIR,
    stateDocuments,
    clock,
  });
  const integrationStore = createFileIntegrationStore({
    dataDir: config.HOSTED_DATA_DIR,
    stateDocuments,
    clock,
    grantTtlMs: config.HOSTED_ENTRY_GRANT_TTL_MS,
  });
  // Platform Operators are provisioned by deployment config rather than
  // self-service registration: an account whose verified email is listed is an
  // operator. Emails in the config are already normalized (trimmed, lowercased)
  // to match the store's normalized account emails.
  const operatorEmails = new Set(
    Array.isArray(config.HOSTED_OPERATOR_EMAILS)
      ? config.HOSTED_OPERATOR_EMAILS
      : [],
  );
  const limiter = createRateLimiter({ clock });
  // Lifecycle and account notices: one durable, idempotent queue drained by
  // the shared mail adapter. The queue is the notification service's store;
  // the outbox adapter remains the production delivery path.
  const notificationStore = createFileNotificationStore({
    dataDir: config.HOSTED_DATA_DIR,
    stateDocuments,
    clock,
  });
  const notifications = createNotificationService({
    store: notificationStore,
    mail: createMailDelivery(config),
    accountStore: store,
    organizerStore,
    membershipStore,
    config,
    clock,
  });
  // Signed webhooks: one durable outbox of lifecycle events per organizer,
  // derived idempotently from the durable Board Session state and delivered
  // at least once to every active subscription with HMAC signatures.
  const webhookStore = createFileWebhookStore({
    dataDir: config.HOSTED_DATA_DIR,
    stateDocuments,
    clock,
    allowInsecureHttp: config.IS_DEVELOPMENT === true,
  });
  const webhookPipeline = createWebhookPipeline({
    webhookStore,
    organizerStore,
    notificationService: notifications,
    config,
    clock,
  });
  // Every hosted page renders the session-aware header, including home and
  // source, so all hosted templates share the account resolver. It also reports
  // operator status so the shared header can offer the operator console link.
  /** @type {(request: HttpRequest) => {accountId: string, email: string, isOperator: boolean} | null} */
  const resolveAccount = (request) => {
    const account = resolveSignedInAccountFromRequest(store, request);
    if (!account) return null;
    return { ...account, isOperator: operatorEmails.has(account.email) };
  };
  const templateOptions = {
    htmlHeadSnippet: paths.htmlHeadSnippet,
    resolveAccount,
  };
  const homeTemplate = new HostedPageTemplate(
    paths.homeTemplatePath,
    config,
    templateOptions,
  );
  const sourceTemplate = new HostedPageTemplate(
    paths.sourceTemplatePath,
    config,
    templateOptions,
  );
  const sourceMapping = resolveSourceMapping(config);

  // Private objects use the selected file or S3-compatible adapter. The same
  // immutable object seam owns Board Archives, publications, Brand Assets,
  // Historical Archives, and successful PNG Image Exports.
  // Historical Archives: operator-imported legacy WBO results under their own
  // `historical-archives/` key namespace. They are not Board Sessions — no
  // lifecycle, publication, export, or retention surface ever touches them.
  const historyStore = createFileHistoricalArchiveStore({
    dataDir: config.HOSTED_DATA_DIR,
    stateDocuments,
    clock,
    archiveStore,
    organizerStore,
  });
  const publicationStore = createFilePublicationStore({
    dataDir: config.HOSTED_DATA_DIR,
    stateDocuments,
    clock,
    archiveStore,
  });
  const boardArchivePipeline = createBoardArchivePipeline({
    organizerStore,
    archiveStore,
    config,
    clock,
    notifications,
  });
  // Board Image Export jobs: durable job records plus rendered PNG results
  // under `<HOSTED_DATA_DIR>/board-exports/`. The download token is derived
  // from the deployment secret, never stored.
  const exportStore = createFileBoardExportStore({
    dataDir: config.HOSTED_DATA_DIR,
    stateDocuments,
    objectStore: config.HOSTED_OBJECT_STORE === "s3" ? archiveStore : undefined,
    clock,
    linkTtlMs: config.HOSTED_BOARD_EXPORT_LINK_TTL_MS,
    hmacKey: config.AUTH_SECRET_KEY,
  });
  const boardExportPipeline = createBoardExportPipeline({
    exportStore,
    archiveStore,
    organizerStore,
    config,
    clock,
  });
  // Outcome retention: Private Board Archive, Item Attribution, Change Audit,
  // Published Canvas, and Board Image Export objects are purged together when
  // their retention window elapses or an early deletion's recovery window
  // runs out. Failures stay durable, visible, and retryable.
  const outcomeRetentionPipeline = createOutcomeRetentionPipeline({
    organizerStore,
    archiveStore,
    publicationStore,
    exportStore,
    config,
    clock,
    deleteBoardMutationLedger: storage.deleteBoardMutationLedger,
  });
  const serviceClock = clock || (() => Date.now());
  const closeDrainMs = config.HOSTED_BOARD_SESSION_CLOSE_DRAIN_MS;
  /**
   * Lazily advances the durable Board Session lifecycle and then runs the
   * close pipeline for sessions whose drain window has elapsed, so admission
   * decisions and every console read see the authoritative status at the
   * current service clock. Both steps are idempotent, so calling this before
   * every admission is safe. Close failures are recorded by the pipeline and
   * retried by the next pass; they never fail the surrounding request.
   *
   * Due export jobs are kicked on the same cadence but detached: rendering a
   * PNG can take seconds, so no request path ever blocks on it. The in-flight
   * guard inside the pipeline keeps overlapping passes from double-claiming a
   * job, and the durable job records make any pass — this one, the lifecycle
   * poker's, or one after a restart — equivalent.
   */
  const refreshEventLifecycle = async () => {
    const now = serviceClock();
    await organizerStore.advanceLifecycle({ now, closeDrainMs });
    // The capacity signal rides the same durable pass: operators read live
    // sessions and committed seats directly against the platform limits.
    try {
      metrics.setHostedCapacityUsage(organizerStore.readCapacityUsage());
    } catch (error) {
      logger.error("hosted.capacity_signal_failed", { error });
    }
    await boardArchivePipeline.runDueCloses({ now, closeDrainMs });
    await outcomeRetentionPipeline.runDueOutcomePurges({ now });
    await webhookPipeline.deriveLifecycleEvents();
    // Signed-webhook delivery talks to organizer endpoints over the network:
    // it runs detached exactly like the export renders and notice drains.
    webhookPipeline.runDueDeliveries({ now }).catch((error) => {
      logger.error("hosted.webhook_delivery_pass_failed", { error });
    });
    // Upcoming-start notices enqueue durably inside the pass; delivery runs
    // detached so a slow or failing mail vendor never holds a request or the
    // close pipeline. The in-flight coalescing in the drain keeps overlapping
    // passes from racing, and the durable queue makes every pass equivalent.
    await notifications.noticeUpcomingSessions({ now });
    notifications.runDueSends({ now }).catch((error) => {
      logger.error("hosted.notice_drain_failed", { error });
    });
    boardExportPipeline.runDueExports({ now }).catch((error) => {
      logger.error("hosted.board_export_pass_failed", { error });
    });
  };

  const accountRoutes = createHostedAccountRoutes({
    config,
    clock,
    store,
    notifications,
    captcha: createHostedCaptcha(config),
    limiter,
    templates: {
      register: new HostedPageTemplate(
        paths.registerTemplatePath,
        config,
        templateOptions,
      ),
      login: new HostedPageTemplate(
        paths.loginTemplatePath,
        config,
        templateOptions,
      ),
      verify: new HostedPageTemplate(
        paths.verifyTemplatePath,
        config,
        templateOptions,
      ),
      logout: new HostedPageTemplate(
        paths.logoutTemplatePath,
        config,
        templateOptions,
      ),
      forgot: new HostedPageTemplate(
        paths.forgotTemplatePath,
        config,
        templateOptions,
      ),
      reset: new HostedPageTemplate(
        paths.resetTemplatePath,
        config,
        templateOptions,
      ),
      account: new HostedPageTemplate(
        paths.accountTemplatePath,
        config,
        templateOptions,
      ),
    },
  });

  const organizerRoutes = createOrganizerRoutes({
    config,
    accountStore: store,
    organizerStore,
    integrationStore,
    webhookStore,
    limiter,
    operatorEmails,
    notificationStore,
    advanceEventLifecycle: refreshEventLifecycle,
    templates: {
      organizerApply: new HostedPageTemplate(
        paths.organizerApplyTemplatePath,
        config,
        templateOptions,
      ),
      operator: new HostedPageTemplate(
        paths.operatorTemplatePath,
        config,
        templateOptions,
      ),
      operatorApplication: new HostedPageTemplate(
        paths.operatorApplicationTemplatePath,
        config,
        templateOptions,
      ),
      organizerConsole: new HostedPageTemplate(
        paths.organizerConsoleTemplatePath,
        config,
        templateOptions,
      ),
      organizerManage: new HostedPageTemplate(
        paths.organizerManageTemplatePath,
        config,
        templateOptions,
      ),
    },
  });

  const reservationRoutes = createReservationRoutes({
    config,
    clock,
    accountStore: store,
    organizerStore,
    limiter,
    operatorEmails,
    notifications,
    advanceEventLifecycle: refreshEventLifecycle,
    templates: {
      organizerReservations: new HostedPageTemplate(
        paths.organizerReservationsTemplatePath,
        config,
        templateOptions,
      ),
      organizerReservation: new HostedPageTemplate(
        paths.organizerReservationTemplatePath,
        config,
        templateOptions,
      ),
      operatorReservations: new HostedPageTemplate(
        paths.operatorReservationsTemplatePath,
        config,
        templateOptions,
      ),
      operatorReservation: new HostedPageTemplate(
        paths.operatorReservationTemplatePath,
        config,
        templateOptions,
      ),
      operatorChanges: new HostedPageTemplate(
        paths.operatorChangesTemplatePath,
        config,
        templateOptions,
      ),
      operatorChange: new HostedPageTemplate(
        paths.operatorChangeTemplatePath,
        config,
        templateOptions,
      ),
    },
  });

  const integrationRoutes = createIntegrationRoutes({
    config,
    clock,
    accountStore: store,
    organizerStore,
    membershipStore,
    integrationStore,
    limiter,
    advanceEventLifecycle: refreshEventLifecycle,
  });

  // The controlled Historical Archive import is an operator-console surface:
  // one explicit form, one source file, one target Organizer.
  const historyRoutes = createHistoricalImportRoutes({
    config,
    accountStore: store,
    organizerStore,
    historyStore,
    operatorEmails,
    templates: {
      operatorHistoricalImports: new HostedPageTemplate(
        paths.operatorHistoricalImportsTemplatePath,
        config,
        templateOptions,
      ),
    },
  });

  // Real-time admission for event Board Sessions: the single authority that
  // decides who may open the board, in which role, and with which seat. Both
  // the socket layer and the hosted board page route come through it.
  // Hosted mode fail-closes on a missing deployment secret: without it the
  // service cannot derive stable participant identifiers, so it cannot honor
  // the trusted-attribution contract and must not boot. Legacy mode never
  // resolves an operator, so its placeholder resolver must never be invoked.
  const participantIdentifierFor =
    config.HOSTED_MODE === true
      ? createParticipantIdentifierResolver(config.AUTH_SECRET_KEY)
      : function legacyAttributionDisabled() {
          throw new Error(
            "participant identifiers require WBO_HOSTED_MODE with AUTH_SECRET_KEY",
          );
        };
  const eventAdmission = createEventAdmission({
    seatGraceMs: config.HOSTED_SEAT_GRACE_MS,
    preparationWindowMs: config.HOSTED_CAPACITY_WINDOW_BUFFER_MS,
    clock,
    accountStore: store,
    organizerStore,
    membershipStore,
    participantIdentifierFor,
  });
  // Event-scoped governance: the moderation log plus the ban/unban and
  // report coordination shared by the socket handlers and the console
  // routes. Real-time consequences (evictions, access refreshes) are the
  // socket layer's job, applied through the moderation socket effects.
  const eventModeration = createEventModeration({
    organizerStore,
    membershipStore,
    moderationStore,
    participantIdentifierFor,
  });

  const eventRoutes = createEventRoutes({
    config,
    clock,
    accountStore: store,
    organizerStore,
    membershipStore,
    moderation: eventModeration,
    assetStore,
    publicationStore,
    archiveStore,
    participantIdentifierFor,
    createBoardMutationLedger: storage.createBoardMutationLedger,

    exportStore,
    exportPipeline: boardExportPipeline,
    limiter,
    advanceEventLifecycle: refreshEventLifecycle,
    templates: {
      home: homeTemplate,
      event: new HostedPageTemplate(
        paths.eventTemplatePath,
        config,
        templateOptions,
      ),
      organizerEvent: new HostedPageTemplate(
        paths.organizerEventTemplatePath,
        config,
        templateOptions,
      ),
      organizerEventAudit: new HostedPageTemplate(
        paths.organizerEventAuditTemplatePath,
        config,
        templateOptions,
      ),
      publishedCanvas: new HostedPageTemplate(
        paths.publishedCanvasTemplatePath,
        config,
        templateOptions,
      ),
    },
  });
  if (config.HOSTED_MODE === true) {
    registerBoardMutationLedgerFactory(storage.createBoardMutationLedger);
  }

  // Durable lifecycle poker: advances Board Sessions and seals drained ones
  // with no active reader so a headless event still opens, closes, and
  // archives on time. The persisted times plus the service clock are
  // authoritative — the interval only triggers an idempotent catch-up. It
  // stays off when a test injects a clock (advancement is driven through
  // requests) or when the poll interval is zero, and never keeps the process
  // alive on its own.
  const pollMs = config.HOSTED_LIFECYCLE_POLL_MS;
  /** @type {NodeJS.Timeout | undefined} */
  let lifecycleTimer;
  function startLifecycleTimer() {
    if (
      lifecycleTimer ||
      config.HOSTED_MODE !== true ||
      clock !== undefined ||
      typeof pollMs !== "number" ||
      pollMs <= 0
    ) {
      return;
    }
    lifecycleTimer = setInterval(() => {
      refreshEventLifecycle().catch((error) => {
        logger.error("hosted.lifecycle_poke_failed", { error });
      });
    }, pollMs);
    lifecycleTimer.unref();
  }

  async function initialize() {
    await storage.initialize();
    if (config.HOSTED_STATE_STORE === "postgres") {
      // Eagerly hydrate every in-memory index before the server listens. In
      // PostgreSQL mode a synchronous read before this point is rejected.
      await Promise.all([
        store.flush(),
        organizerStore.flush(),
        assetStore.flush(),
        membershipStore.flush(),
        moderationStore.flush(),
        integrationStore.flush(),
        notificationStore.flush(),
        webhookStore.flush(),
        historyStore.flush(),
        publicationStore.flush(),
        exportStore.flush(),
      ]);
    }
    startLifecycleTimer();
  }

  async function close() {
    if (lifecycleTimer) clearInterval(lifecycleTimer);
    await Promise.all([
      store.flush(),
      organizerStore.flush(),
      assetStore.flush(),
      membershipStore.flush(),
      moderationStore.flush(),
      integrationStore.flush(),
      notificationStore.flush(),
      webhookStore.flush(),
      historyStore.flush(),
      publicationStore.flush(),
      exportStore.flush(),
    ]);
    await storage.close();
  }

  return {
    enabled: config.HOSTED_MODE === true,
    initialize,
    close,
    serveHome: eventRoutes.serveHome,
    serveSource(ctx) {
      const statusCode = sourceMapping.available ? 200 : 503;
      sourceTemplate.serveWithStatus(ctx.request, ctx.response, statusCode, {
        sourceAvailable: sourceMapping.available,
        ...(sourceMapping.available
          ? {
              sourceUrl: sourceMapping.url,
              deploymentVersion: sourceMapping.version,
              sourceBuildInstructions: sourceMapping.buildInstructions,
            }
          : {}),
      });
    },
    ...accountRoutes,
    ...organizerRoutes,
    ...reservationRoutes,
    ...historyRoutes,
    serveEventPage: eventRoutes.serveEventPage,
    serveEventEnter: eventRoutes.serveEventEnter,
    serveEventEntryGrantRedeem: integrationRoutes.serveEventEntryGrantRedeem,
    serveIntegrationApiEvent: integrationRoutes.serveIntegrationApiEvent,
    serveIntegrationApiEntryGrantCreate:
      integrationRoutes.serveIntegrationApiEntryGrantCreate,
    refreshEventLifecycle,
    // Deterministic drain entry point for isolated tests: production drains
    // through the lifecycle pass; tests await this after queueing notices.
    runDueNoticeSends: notifications.runDueSends,
    ...eventAdmission,
    ...eventModeration,
    // Real-time close effects: the socket layer registers how connected
    // sockets reach their read-only completion state when a Board Session is
    // sealed. Compositions without sockets simply keep the no-op default.
    registerBoardCloseEffects: boardArchivePipeline.registerCloseEffects,
    serveEventAnonymity: eventRoutes.serveEventAnonymity,
    serveBrandAsset: eventRoutes.serveBrandAsset,
    serveOrganizerEvent: eventRoutes.serveOrganizerEvent,
    serveOrganizerEventAccessCode: eventRoutes.serveOrganizerEventAccessCode,
    serveOrganizerEventEntryLock: eventRoutes.serveOrganizerEventEntryLock,
    serveOrganizerEventModerators: eventRoutes.serveOrganizerEventModerators,
    serveOrganizerEventModeratorRevoke:
      eventRoutes.serveOrganizerEventModeratorRevoke,
    serveOrganizerEventCover: eventRoutes.serveOrganizerEventCover,
    serveOrganizerEventPublication: eventRoutes.serveOrganizerEventPublication,
    serveOrganizerEventPublicationRevoke:
      eventRoutes.serveOrganizerEventPublicationRevoke,
    serveOrganizerEventOutcomeDelete:
      eventRoutes.serveOrganizerEventOutcomeDelete,
    serveOrganizerEventOutcomeRestore:
      eventRoutes.serveOrganizerEventOutcomeRestore,
    serveOrganizerEventAudit: eventRoutes.serveOrganizerEventAudit,
    servePublishedCanvas: eventRoutes.servePublishedCanvas,

    serveOrganizerEventExports: eventRoutes.serveOrganizerEventExports,
    serveOrganizerEventExportDownload:
      eventRoutes.serveOrganizerEventExportDownload,
    serveOrganizerEventExportRevoke:
      eventRoutes.serveOrganizerEventExportRevoke,
    serveOrganizerEventExportDelete:
      eventRoutes.serveOrganizerEventExportDelete,
  };
}

/**
 * @param {ServerConfig} config
 * @returns {{available: true, url: string, version: string, buildInstructions: string} | {available: false}}
 */
function resolveSourceMapping(config) {
  const version =
    typeof config.DEPLOYMENT_VERSION === "string"
      ? config.DEPLOYMENT_VERSION.trim()
      : "";
  const sourceUrl =
    typeof config.CORRESPONDING_SOURCE_URL === "string"
      ? config.CORRESPONDING_SOURCE_URL.trim()
      : "";
  const buildInstructions =
    typeof config.CORRESPONDING_SOURCE_BUILD === "string"
      ? config.CORRESPONDING_SOURCE_BUILD.trim()
      : "";
  if (!version || !sourceUrl || !buildInstructions) {
    return { available: false };
  }
  if (ROLLING_VERSION_LABELS.has(version.toLowerCase())) {
    return { available: false };
  }
  if (!sourceUrl.includes("{version}")) return { available: false };

  try {
    const renderedSourceUrl = sourceUrl
      .split("{version}")
      .join(encodeURIComponent(version));
    const parsed = new URL(renderedSourceUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { available: false };
    }
    if (parsed.username || parsed.password) return { available: false };
    return { available: true, url: parsed.href, version, buildInstructions };
  } catch {
    return { available: false };
  }
}

export { createHostedEventModule };
