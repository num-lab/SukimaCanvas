import { registerBoardMutationLedgerFactory } from "../board/ledger_registry.mjs";
import { localizedHref, Template } from "../http/templating.mjs";
import observability from "../observability/index.mjs";
import { createHostedCaptcha } from "./accounts/captcha.mjs";
import { createOutboxMailDelivery } from "./accounts/mail.mjs";
import { createRateLimiter } from "./accounts/rate_limits.mjs";
import {
  createHostedAccountRoutes,
  resolveSignedInAccountFromRequest,
} from "./accounts/routes.mjs";
import { createFileAccountStore } from "./accounts/store.mjs";
import { createEventAdmission } from "./admission/index.mjs";
import { createBoardArchivePipeline } from "./archive/close.mjs";
import { createFileBoardArchiveStore } from "./archive/store.mjs";
import { createFileBrandAssetStore } from "./assets/store.mjs";
import { createParticipantIdentifierResolver } from "./attribution.mjs";
import { createEventRoutes } from "./events/routes.mjs";
import { createIntegrationRoutes } from "./integrations/routes.mjs";
import { createFileIntegrationStore } from "./integrations/store.mjs";
import { createFileBoardMutationLedger } from "./ledger/store.mjs";
import { createFileEventMembershipStore } from "./memberships/store.mjs";
import { createEventModeration } from "./moderation/index.mjs";
import { createFileModerationStore } from "./moderation/store.mjs";
import { createOrganizerRoutes } from "./organizers/routes.mjs";
import { createFileOrganizerStore } from "./organizers/store.mjs";
import { createReservationRoutes } from "./reservations/routes.mjs";

/** @import { HttpRequest, HttpResponse, ServerConfig } from "../../types/server-runtime.d.ts" */

const { logger } = observability;

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
 *   eventTemplatePath: string,
 *   organizerEventTemplatePath: string,
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
  const store = createFileAccountStore({
    dataDir: config.HOSTED_DATA_DIR,
    clock,
    sessionMaxAgeMs: config.HOSTED_SESSION_MAX_AGE_MS,
    sessionIdleMs: config.HOSTED_SESSION_IDLE_TIMEOUT_MS,
    verificationTokenTtlMs: config.HOSTED_VERIFICATION_TOKEN_TTL_MS,
    passwordResetTtlMs: config.HOSTED_PASSWORD_RESET_TTL_MS,
  });
  const organizerStore = createFileOrganizerStore({
    dataDir: config.HOSTED_DATA_DIR,
    clock,
  });
  const assetStore = createFileBrandAssetStore({
    dataDir: config.HOSTED_DATA_DIR,
    clock,
  });
  const membershipStore = createFileEventMembershipStore({
    dataDir: config.HOSTED_DATA_DIR,
    clock,
  });
  const moderationStore = createFileModerationStore({
    dataDir: config.HOSTED_DATA_DIR,
    clock,
  });
  const integrationStore = createFileIntegrationStore({
    dataDir: config.HOSTED_DATA_DIR,
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

  // Private Board Archive storage: write-once objects under
  // `<HOSTED_DATA_DIR>/board-archives/`, addressed by internal keys that are
  // never public access credentials. The close pipeline below is the only
  // writer.
  const archiveStore = createFileBoardArchiveStore({
    dataDir: config.HOSTED_DATA_DIR,
  });
  const boardArchivePipeline = createBoardArchivePipeline({
    organizerStore,
    archiveStore,
    config,
    clock,
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
   */
  const refreshEventLifecycle = async () => {
    const now = serviceClock();
    await organizerStore.advanceLifecycle({ now, closeDrainMs });
    await boardArchivePipeline.runDueCloses({ now, closeDrainMs });
  };

  const accountRoutes = createHostedAccountRoutes({
    config,
    clock,
    store,
    mail: createOutboxMailDelivery(config),
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
    limiter,
    operatorEmails,
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
    },
  });
  if (config.HOSTED_MODE === true) {
    // Durable mutation ledger: every accepted persistent write on a hosted
    // board is fsynced into `<HOSTED_DATA_DIR>/mutation-ledger/<board>.jsonl`
    // before its sender is confirmed. The stored SVG stays a rebuildable
    // projection; loads replay ledger entries past the snapshot sequence.
    registerBoardMutationLedgerFactory((boardName) =>
      createFileBoardMutationLedger({
        boardName,
        dataDir: config.HOSTED_DATA_DIR,
      }),
    );
  }

  // Durable lifecycle poker: advances Board Sessions and seals drained ones
  // with no active reader so a headless event still opens, closes, and
  // archives on time. The persisted times plus the service clock are
  // authoritative — the interval only triggers an idempotent catch-up. It
  // stays off when a test injects a clock (advancement is driven through
  // requests) or when the poll interval is zero, and never keeps the process
  // alive on its own.
  const pollMs = config.HOSTED_LIFECYCLE_POLL_MS;
  if (
    config.HOSTED_MODE === true &&
    clock === undefined &&
    typeof pollMs === "number" &&
    pollMs > 0
  ) {
    const timer = setInterval(() => {
      refreshEventLifecycle().catch((error) => {
        logger.error("hosted.lifecycle_poke_failed", { error });
      });
    }, pollMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  return {
    enabled: config.HOSTED_MODE === true,
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
    serveEventPage: eventRoutes.serveEventPage,
    serveEventEnter: eventRoutes.serveEventEnter,
    serveEventEntryGrantRedeem: integrationRoutes.serveEventEntryGrantRedeem,
    serveIntegrationApiEvent: integrationRoutes.serveIntegrationApiEvent,
    serveIntegrationApiEntryGrantCreate:
      integrationRoutes.serveIntegrationApiEntryGrantCreate,
    refreshEventLifecycle,
    ...eventAdmission,
    ...eventModeration,
    // Real-time close effects: the socket layer registers how connected
    // sockets reach their read-only completion state when a Board Session is
    // sealed. Compositions without sockets simply keep the no-op default.
    registerBoardCloseEffects: boardArchivePipeline.registerCloseEffects,
    runBoardSessionCloses: boardArchivePipeline.runDueCloses,
    serveEventAnonymity: eventRoutes.serveEventAnonymity,
    serveBrandAsset: eventRoutes.serveBrandAsset,
    serveOrganizerEvent: eventRoutes.serveOrganizerEvent,
    serveOrganizerEventAccessCode: eventRoutes.serveOrganizerEventAccessCode,
    serveOrganizerEventEntryLock: eventRoutes.serveOrganizerEventEntryLock,
    serveOrganizerEventModerators: eventRoutes.serveOrganizerEventModerators,
    serveOrganizerEventModeratorRevoke:
      eventRoutes.serveOrganizerEventModeratorRevoke,
    serveOrganizerEventCover: eventRoutes.serveOrganizerEventCover,
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
