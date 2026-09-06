import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import serveStatic from "serve-static";

import { createHostedEventModule } from "../hosted_event/module.mjs";
import { CSP, staticFileCacheControl } from "../http/cache_policy.mjs";
import { parseRequestUrl } from "../http/request_url.mjs";
import * as templating from "../http/templating.mjs";
import observability from "../observability/index.mjs";

const { logger } = observability;
const RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_WEBROOT = path.resolve(RUNTIME_DIR, "../../client-data");
// Hosted-only assets exist outside legacy WBO; raw hosted page templates are
// rendered exclusively through their routes in every mode.
const HOSTED_ASSET_PATHS = new Set(["/hosted.css"]);
const HOSTED_TEMPLATE_PATHS = new Set([
  "/hosted.html",
  "/source.html",
  "/register.html",
  "/login.html",
  "/verify.html",
  "/logout.html",
  "/forgot.html",
  "/reset.html",
  "/account.html",
  "/organizer-apply.html",
  "/operator.html",
  "/operator-application.html",
  "/organizer-console.html",
  "/organizer-manage.html",
  "/organizer-reservations.html",
  "/organizer-reservation.html",
  "/operator-reservations.html",
  "/operator-reservation.html",
  "/operator-changes.html",
  "/operator-change.html",
  "/operator-historical-imports.html",
  "/event.html",
  "/organizer-event.html",
]);

/** @import { HttpResponse, ServerConfig, ServerRuntime } from "../../types/server-runtime.d.ts" */

/**
 * Reads the trusted startup-only HTML snippet inserted into rendered pages.
 *
 * @param {ServerConfig} config
 * @returns {string}
 */
function readHtmlHeadSnippet(config) {
  const snippetPath = config.HTML_HEAD_SNIPPET_PATH;
  if (typeof snippetPath !== "string" || snippetPath === "") return "";
  try {
    return fs.readFileSync(snippetPath, "utf8");
  } catch (error) {
    logger.error("html_head_snippet.read_failed", {
      path: snippetPath,
      error,
    });
    return "";
  }
}

/**
 * @param {ServerConfig} config
 * @param {string} fileName
 * @returns {string}
 */
function configuredTemplatePath(config, fileName) {
  return path.join(config.WEBROOT, fileName);
}

/**
 * @param {ServerConfig} config
 * @param {string} fileName
 * @returns {string}
 */
function configuredTemplatePathWithBundledFallback(config, fileName) {
  const configuredPath = configuredTemplatePath(config, fileName);
  if (fs.existsSync(configuredPath)) return configuredPath;
  return path.join(BUNDLED_WEBROOT, fileName);
}

/**
 * @param {ServerConfig} config
 * @returns {import("../../types/server-runtime.d.ts").StaticFileServer}
 */
function createStaticFileServer(config) {
  /**
   * @param {import("../../types/server-runtime.d.ts").StaticFileServer} fileserver
   * @returns {import("../../types/server-runtime.d.ts").StaticFileServer}
   */
  const skipHostedTemplates = (fileserver) => (request, response, next) => {
    if (HOSTED_TEMPLATE_PATHS.has(parseRequestUrl(request.url).pathname)) {
      next();
      return;
    }
    fileserver(request, response, next);
  };

  const configuredFileserver = skipHostedTemplates(
    createSingleRootStaticFileServer(config, config.WEBROOT),
  );
  const configuredRoot = path.resolve(config.WEBROOT);
  const bundledRootIsConfigured = configuredRoot === BUNDLED_WEBROOT;
  if (bundledRootIsConfigured && config.HOSTED_MODE === true) {
    return configuredFileserver;
  }
  if (bundledRootIsConfigured) {
    return (request, response, next) => {
      const isHostedAsset = HOSTED_ASSET_PATHS.has(
        parseRequestUrl(request.url).pathname,
      );
      if (isHostedAsset) {
        next();
        return;
      }
      configuredFileserver(request, response, next);
    };
  }

  const bundledFileserver = skipHostedTemplates(
    createSingleRootStaticFileServer(config, BUNDLED_WEBROOT),
  );
  return (request, response, next) => {
    const isHostedAsset =
      config.HOSTED_MODE !== true &&
      HOSTED_ASSET_PATHS.has(parseRequestUrl(request.url).pathname);
    const originalUrl = request.url;
    configuredFileserver(request, response, (error) => {
      if (error !== undefined) {
        next(error);
        return;
      }
      if (isHostedAsset) {
        next();
        return;
      }
      request.url = originalUrl;
      bundledFileserver(request, response, next);
    });
  };
}

/**
 * @param {ServerConfig} config
 * @param {string} root
 * @returns {import("../../types/server-runtime.d.ts").StaticFileServer}
 */
function createSingleRootStaticFileServer(config, root) {
  return serveStatic(root, {
    maxAge: 0,
    /** @param {HttpResponse} res */
    setHeaders: (res, /** @type {string} */ filePath) => {
      res.setHeader("Content-Security-Policy", CSP);
      const cacheValue = staticFileCacheControl(config, filePath || "");
      if (cacheValue !== undefined) res.setHeader("Cache-Control", cacheValue);
    },
  });
}

/**
 * Builds the cold, request-independent dependencies shared by HTTP routes.
 *
 * @param {ServerConfig} config
 * @returns {ServerRuntime}
 */
function createServerRuntime(config) {
  const htmlHeadSnippet = readHtmlHeadSnippet(config);
  const fileserver = createStaticFileServer(config);
  const errorTemplate = new templating.Template(
    configuredTemplatePath(config, "error.html"),
    config,
    { htmlHeadSnippet },
  );
  const boardTemplate = new templating.BoardTemplate(
    configuredTemplatePath(config, "board.html"),
    config,
    { htmlHeadSnippet },
  );
  const indexTemplate = new templating.Template(
    configuredTemplatePath(config, "index.html"),
    config,
    { htmlHeadSnippet },
  );
  const rulesTemplate = new templating.RulesTemplate(
    configuredTemplatePathWithBundledFallback(config, "rules.html"),
    config,
    { htmlHeadSnippet },
  );
  const manifestTemplate = new templating.Template(
    configuredTemplatePath(config, "manifest.json"),
    config,
    { htmlHeadSnippet },
  );
  const hostedEventModule = createHostedEventModule(config, {
    homeTemplatePath: configuredTemplatePathWithBundledFallback(
      config,
      "hosted.html",
    ),
    sourceTemplatePath: configuredTemplatePathWithBundledFallback(
      config,
      "source.html",
    ),
    registerTemplatePath: configuredTemplatePathWithBundledFallback(
      config,
      "register.html",
    ),
    loginTemplatePath: configuredTemplatePathWithBundledFallback(
      config,
      "login.html",
    ),
    verifyTemplatePath: configuredTemplatePathWithBundledFallback(
      config,
      "verify.html",
    ),
    logoutTemplatePath: configuredTemplatePathWithBundledFallback(
      config,
      "logout.html",
    ),
    forgotTemplatePath: configuredTemplatePathWithBundledFallback(
      config,
      "forgot.html",
    ),
    resetTemplatePath: configuredTemplatePathWithBundledFallback(
      config,
      "reset.html",
    ),
    accountTemplatePath: configuredTemplatePathWithBundledFallback(
      config,
      "account.html",
    ),
    organizerApplyTemplatePath: configuredTemplatePathWithBundledFallback(
      config,
      "organizer-apply.html",
    ),
    operatorTemplatePath: configuredTemplatePathWithBundledFallback(
      config,
      "operator.html",
    ),
    operatorApplicationTemplatePath: configuredTemplatePathWithBundledFallback(
      config,
      "operator-application.html",
    ),
    organizerConsoleTemplatePath: configuredTemplatePathWithBundledFallback(
      config,
      "organizer-console.html",
    ),
    organizerManageTemplatePath: configuredTemplatePathWithBundledFallback(
      config,
      "organizer-manage.html",
    ),
    organizerReservationsTemplatePath:
      configuredTemplatePathWithBundledFallback(
        config,
        "organizer-reservations.html",
      ),
    organizerReservationTemplatePath: configuredTemplatePathWithBundledFallback(
      config,
      "organizer-reservation.html",
    ),
    operatorReservationsTemplatePath: configuredTemplatePathWithBundledFallback(
      config,
      "operator-reservations.html",
    ),
    operatorReservationTemplatePath: configuredTemplatePathWithBundledFallback(
      config,
      "operator-reservation.html",
    ),
    operatorChangesTemplatePath: configuredTemplatePathWithBundledFallback(
      config,
      "operator-changes.html",
    ),
    operatorChangeTemplatePath: configuredTemplatePathWithBundledFallback(
      config,
      "operator-change.html",
    ),
    operatorHistoricalImportsTemplatePath:
      configuredTemplatePathWithBundledFallback(
        config,
        "operator-historical-imports.html",
      ),
    eventTemplatePath: configuredTemplatePathWithBundledFallback(
      config,
      "event.html",
    ),
    organizerEventTemplatePath: configuredTemplatePathWithBundledFallback(
      config,
      "organizer-event.html",
    ),
    organizerEventAuditTemplatePath: configuredTemplatePathWithBundledFallback(
      config,
      "organizer-event-audit.html",
    ),
    publishedCanvasTemplatePath: configuredTemplatePathWithBundledFallback(
      config,
      "published-canvas.html",
    ),
    htmlHeadSnippet,
  });
  return {
    config,
    fileserver,
    errorPage: errorTemplate,
    boardTemplate,
    indexTemplate,
    rulesTemplate,
    manifestTemplate,
    hostedEventModule,
  };
}

export { createServerRuntime };
