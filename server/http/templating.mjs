import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import handlebars from "handlebars";
import { MODERATION_RULES } from "../../client-data/js/moderation_rules.js";
import {
  boardStateGrantsCapability,
  TOOLBAR_TOOLS,
} from "../../client-data/tools/manifest.js";
import { createClientConfiguration } from "./client_configuration.mjs";
import { startCompressedResponse } from "./compression.mjs";
import { parseRequestUrl } from "./request_url.mjs";

/** @typedef {{[name: string]: string}} TranslationDictionary */
/** @typedef {{[language: string]: TranslationDictionary}} TranslationMap */
/** @typedef {{baseUrl: string, baseHref: string, languages: string[], language: string, direction: "ltr" | "rtl", translations: TranslationDictionary, configuration: object, moderator: boolean, htmlHeadSnippet: string, varyCookie?: boolean, [name: string]: any}} TemplateParameters */
/** @typedef {import("http").IncomingMessage} TemplateRequest */
/** @typedef {import("http").ServerResponse} TemplateResponse */
/** @typedef {string | string[] | undefined} HeaderValue */
/** @typedef {{blockedTools?: string[] | null}} RenderedToolOptions */
/** @typedef {NonNullable<typeof TOOLBAR_TOOLS[number]>} ToolbarTool */
/** @typedef {import("./client_configuration.mjs").ClientConfiguration} ClientConfig */
/** @typedef {"zstd" | "br" | "gzip"} CompressionEncoding */
/**
 * @typedef {{htmlHeadSnippet?: string, supportedLanguages?: string[], languageMatching?: "loose" | "strict", partials?: {[name: string]: string}}} TemplateOptions
 */
/** @import { ServerConfig } from "../../types/server-runtime.d.ts" */

const HTTP_DIR = path.dirname(fileURLToPath(import.meta.url));
const BOARD_PAGE_CACHE_HEADROOM_SECONDS = 5;

/**
 * Associations from language to translation dictionnaries
 * @const
 * @type {TranslationMap}
 */
const TRANSLATIONS = JSON.parse(
  fs.readFileSync(path.join(HTTP_DIR, "translations.json"), "utf8"),
);
const languages = Object.keys(TRANSLATIONS);

handlebars.registerHelper({
  json: JSON.stringify.bind(JSON),
});

/**
 * @param {ToolbarTool | undefined} tool
 * @returns {tool is ToolbarTool}
 */
function isToolbarTool(tool) {
  return tool !== undefined;
}

/**
 * @param {RenderedToolOptions} options
 * @returns {typeof TOOLBAR_TOOLS}
 */
function getRenderedTools(options) {
  const blockedTools = new Set(options.blockedTools || []);
  return TOOLBAR_TOOLS.filter(isToolbarTool).filter(
    (tool) => !blockedTools.has(tool.toolId),
  );
}

/**
 * @param {HeaderValue} value
 * @returns {string | undefined}
 */
function firstHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * @param {string} tag
 * @returns {string}
 */
function canonicalizeLocale(tag) {
  const trimmed = tag.trim();
  if (!trimmed || trimmed === "*") return trimmed;
  try {
    return new Intl.Locale(trimmed).toString();
  } catch {
    return trimmed;
  }
}

/**
 * @param {string} header
 * @returns {{tag: string, quality: number}[]}
 */
function parseAcceptLanguage(header) {
  return header
    .split(",")
    .map(function parsePart(part, index) {
      const [rawTag, ...rawParams] = part.split(";");
      const tag = canonicalizeLocale(rawTag || "");
      if (!tag) return null;
      let quality = 1;
      for (const rawParam of rawParams) {
        const [key, value] = rawParam.split("=");
        if (key && key.trim() === "q") {
          const parsed = Number.parseFloat((value || "").trim());
          quality = Number.isFinite(parsed) ? parsed : 0;
        }
      }
      return { tag, quality, index };
    })
    .filter(
      /**
       * @param {{tag: string, quality: number, index: number} | null} language
       * @returns {language is {tag: string, quality: number, index: number}}
       */
      function isSupported(language) {
        return language !== null && language.quality > 0;
      },
    )
    .sort(function compareLanguages(a, b) {
      if (b.quality !== a.quality) return b.quality - a.quality;
      return a.index - b.index;
    })
    .map(function stripIndex(language) {
      return { tag: language.tag, quality: language.quality };
    });
}

/**
 * @param {string} locale
 * @returns {string}
 */
function localeBase(locale) {
  return locale.split("-", 1)[0] || locale;
}

/**
 * @param {string[]} supportedLanguages
 * @param {{tag: string, quality: number}[]} acceptedLanguages
 * @returns {string | undefined}
 */
function pickLanguage(supportedLanguages, acceptedLanguages) {
  for (const accepted of acceptedLanguages) {
    const acceptedTag = accepted.tag;
    if (acceptedTag === "*") return supportedLanguages[0];
    const acceptedBase = localeBase(acceptedTag);
    for (const supportedLanguage of supportedLanguages) {
      if (localeBase(supportedLanguage) === acceptedBase) {
        return supportedLanguage;
      }
    }
  }
  return undefined;
}

/**
 * Match the small language set used by an independently branded shell. Exact
 * locale families are handled explicitly so an unsupported regional variant
 * (for example `zh-TW`) does not silently select `zh-CN`.
 *
 * @param {string[]} supportedLanguages
 * @param {{tag: string, quality: number}[]} acceptedLanguages
 * @returns {string | undefined}
 */
function pickStrictLanguage(supportedLanguages, acceptedLanguages) {
  for (const accepted of acceptedLanguages) {
    if (accepted.tag === "*") return supportedLanguages[0];
    if (supportedLanguages.includes(accepted.tag)) return accepted.tag;
    const base = localeBase(accepted.tag);
    if (base === "en" && supportedLanguages.includes("en")) return "en";
    if (accepted.tag === "zh" && supportedLanguages.includes("zh-CN")) {
      return "zh-CN";
    }
  }
  return undefined;
}

/**
 * @param {TemplateRequest} req
 * @returns {string}
 */
function findBaseUrl(req) {
  // The socket can already be detached when rendering an error page for an
  // aborted request, so treat it as optional.
  const socket = req.socket;
  const proto =
    firstHeaderValue(req.headers["x-forwarded-proto"]) ||
    (socket && "encrypted" in socket && socket.encrypted ? "https" : "http");
  const host =
    firstHeaderValue(req.headers["x-forwarded-host"]) ||
    firstHeaderValue(req.headers.host) ||
    "localhost";
  return `${proto}://${host}`;
}

/**
 * @param {string} pathname
 * @returns {string}
 */
function findPathPrefix(pathname) {
  const boardMarker = "/boards/";
  const boardMarkerIndex = pathname.indexOf(boardMarker);
  if (boardMarkerIndex <= 0) return "";
  return pathname
    .slice(0, boardMarkerIndex)
    .split("/")
    .filter((part) => part.length > 0)
    .join("/");
}

/**
 * @param {string} baseUrl
 * @param {string} language
 * @returns {string}
 */
function localizedHref(baseUrl, language) {
  const url = new URL(baseUrl);
  url.searchParams.set("lang", language);
  return url.href;
}

/**
 * @param {string} baseUrl
 * @param {string} language
 * @returns {handlebars.SafeString}
 */
function localizedUrl(baseUrl, language) {
  return new handlebars.SafeString(localizedHref(baseUrl, language));
}

/**
 * @param {string[]} supportedLanguages
 * @param {(language: string) => handlebars.SafeString} hrefForLanguage
 * @returns {{language: string, href: handlebars.SafeString}[]}
 */
function localizedLinks(supportedLanguages, hrefForLanguage) {
  return supportedLanguages.map((supportedLanguage) => ({
    language: supportedLanguage,
    href: hrefForLanguage(supportedLanguage),
  }));
}

/**
 * @param {boolean} isDevelopment
 * @param {string} prodValue
 * @returns {string}
 */
function cacheControl(isDevelopment, prodValue) {
  return isDevelopment ? "no-store" : prodValue;
}

/**
 * @param {URL} parsedUrl
 * @param {TemplateParameters} parameters
 * @returns {{Vary?: string}}
 */
function htmlVaryHeaders(parsedUrl, parameters) {
  const vary = [];
  if (!parsedUrl.searchParams.get("lang")) vary.push("Accept-Language");
  if (parameters.varyCookie) vary.push("Cookie");
  return vary.length === 0 ? {} : { Vary: vary.join(", ") };
}

const startHtmlResponse =
  /** @type {(response: TemplateResponse, request: TemplateRequest, parsedUrl: URL, parameters: TemplateParameters, cacheControlValue: string, contentLength?: number, statusCode?: number) => { stream: import("stream").Writable, encoding: import("./compression.mjs").CompressionEncoding | undefined }} */
  (
    response,
    request,
    parsedUrl,
    parameters,
    cacheControlValue,
    contentLength,
    statusCode = 200,
  ) =>
    startCompressedResponse(
      response,
      request.headers["accept-encoding"],
      {
        ...(contentLength === undefined
          ? {}
          : { "Content-Length": contentLength }),
        "Content-Type": "text/html",
        "Cache-Control": cacheControlValue,
        ...(typeof parameters.etag === "string"
          ? { ETag: parameters.etag }
          : {}),
        ...htmlVaryHeaders(parsedUrl, parameters),
      },
      statusCode,
    );

class StaticTemplate {
  /** @type {string} */
  templateContents;

  /** @type {string} */
  htmlHeadSnippet;

  /** @type {(parameters: {[name: string]: any}, options?: {partials?: {[name: string]: string}}) => string} */
  template;

  /** @type {{[name: string]: string}} */
  partials;

  /**
   * @param {string} templatePath
   * @param {TemplateOptions} [options]
   */
  constructor(templatePath, options) {
    const contents = fs.readFileSync(templatePath, { encoding: "utf8" });
    this.templateContents = contents;
    this.htmlHeadSnippet = options?.htmlHeadSnippet || "";
    this.template = handlebars.compile(contents);
    this.partials = options?.partials || {};
  }

  /**
   * @param {{[name: string]: any}} [parameters]
   * @returns {string}
   */
  render(parameters = {}) {
    return this.template(
      {
        htmlHeadSnippet: this.htmlHeadSnippet,
        ...parameters,
      },
      { partials: this.partials },
    );
  }
}

class Template extends StaticTemplate {
  /** @type {ServerConfig} */
  serverConfig;

  /** @type {ClientConfig} */
  clientConfig;

  /** @type {string[]} */
  supportedLanguages;

  /** @type {"loose" | "strict"} */
  languageMatching;

  /**
   * @param {string} templatePath
   * @param {ServerConfig} serverConfig
   * @param {TemplateOptions} [options]
   */
  constructor(templatePath, serverConfig, options) {
    super(templatePath, options);
    this.serverConfig = serverConfig;
    this.clientConfig = createClientConfiguration(serverConfig);
    this.supportedLanguages = options?.supportedLanguages || languages;
    this.languageMatching = options?.languageMatching || "loose";
  }

  /**
   * @param {URL} parsedUrl
   * @param {TemplateRequest} request
   * @param {boolean} isModerator
   * @param {object} [extraParams]
   * @returns {TemplateParameters}
   */
  parameters(parsedUrl, request, isModerator, extraParams) {
    const accept_language_str =
      parsedUrl.searchParams.get("lang") ||
      firstHeaderValue(request.headers["accept-language"]) ||
      "";
    const accept_languages = parseAcceptLanguage(accept_language_str);
    const selectedLanguage =
      this.languageMatching === "strict"
        ? pickStrictLanguage(this.supportedLanguages, accept_languages)
        : pickLanguage(this.supportedLanguages, accept_languages);
    let language =
      selectedLanguage ||
      (this.supportedLanguages.includes("en")
        ? "en"
        : this.supportedLanguages[0] || "en");
    // The loose matcher returns the first language that partially matches, so we need to
    // check if the preferred language is supported to return it
    if (accept_languages.length > 0) {
      const preferred = accept_languages[0];
      if (preferred) {
        const preferred_language = preferred.tag;
        if (this.supportedLanguages.includes(preferred_language)) {
          language = preferred_language;
        }
      }
    }
    const translations = TRANSLATIONS[language] || {};
    const configuration = this.clientConfig;
    const prefix =
      findPathPrefix(parsedUrl.pathname) ||
      this.serverConfig.BASE_PATH.slice(1);
    const baseUrl = findBaseUrl(request) + (prefix ? `/${prefix}/` : "");
    const baseHref = new URL(".", baseUrl).href;
    const moderator = isModerator;
    return {
      baseUrl,
      baseHref,
      languages: this.supportedLanguages,
      languageLinks: localizedLinks(this.supportedLanguages, (linkLanguage) =>
        localizedUrl(baseUrl, linkLanguage),
      ),
      language,
      direction: language === "ar" ? "rtl" : "ltr",
      canonicalUrl: localizedUrl(baseUrl, language),
      hostedSourceHref: new URL("source", baseHref).href,
      translations,
      configuration,
      moderator,
      hostedMode: this.serverConfig.HOSTED_MODE === true,
      htmlHeadSnippet: this.htmlHeadSnippet,
      ...extraParams,
    };
  }

  /**
   * @param {TemplateRequest} request
   * @param {TemplateResponse} response
   * @param {boolean} [isModerator]
   * @param {object} [extraParams]
   * @returns {{encoding: CompressionEncoding | undefined}}
   */
  serve(request, response, isModerator, extraParams) {
    return this.serveStatus(request, response, 200, isModerator, extraParams);
  }

  /**
   * @param {TemplateRequest} request
   * @param {TemplateResponse} response
   * @param {number} statusCode
   * @param {boolean} [isModerator]
   * @param {object} [extraParams]
   * @returns {{encoding: CompressionEncoding | undefined}}
   */
  serveStatus(request, response, statusCode, isModerator, extraParams) {
    const parsedUrl = parseRequestUrl(request.url);
    const parameters = this.parameters(
      parsedUrl,
      request,
      isModerator === true,
      extraParams,
    );
    const body = this.render(parameters);
    const { stream, encoding } = startHtmlResponse(
      response,
      request,
      parsedUrl,
      parameters,
      statusCode >= 500 ? "no-store" : this.cacheControl(),
      Buffer.byteLength(body),
      statusCode,
    );
    stream.end(body);
    return { encoding };
  }

  /**
   * @param {TemplateRequest} request
   * @param {object} [extraParams]
   * @returns {string}
   */
  renderForRequest(request, extraParams) {
    const parsedUrl = parseRequestUrl(request.url);
    return this.render(this.parameters(parsedUrl, request, false, extraParams));
  }

  /**
   * Resolves the negotiated language and its dictionary for a request without
   * rendering, so server-side flows (form errors, email copy) reuse the same
   * localization rules as templates.
   *
   * @param {TemplateRequest} request
   * @param {URL} parsedUrl
   * @returns {{language: string, translations: TranslationDictionary}}
   */
  translationsFor(request, parsedUrl) {
    const parameters = this.parameters(parsedUrl, request, false, {});
    return {
      language: parameters.language,
      translations: parameters.translations,
    };
  }

  /**
   * @returns {string}
   */
  cacheControl() {
    return cacheControl(
      this.serverConfig.IS_DEVELOPMENT,
      "public, max-age=3600",
    );
  }
}

class BoardTemplate extends Template {
  /**
   * @param {string} path
   * @param {ServerConfig} serverConfig
   * @param {TemplateOptions} [options]
   */
  constructor(path, serverConfig, options) {
    super(path, serverConfig, options);
    const contents = this.templateContents;
    const marker = "{{{inlineBoardSvg}}}";
    const markerIndex = contents.indexOf(marker);
    if (markerIndex === -1) {
      this.prefixTemplate = null;
      this.suffixTemplate = null;
      return;
    }
    this.prefixTemplate = handlebars.compile(contents.slice(0, markerIndex));
    this.suffixTemplate = handlebars.compile(
      contents.slice(markerIndex + marker.length),
    );
  }

  /**
   * @param {URL} parsedUrl
   * @param {TemplateRequest} request
   * @param {boolean} isModerator
   * @param {object} [extraParams]
   * @returns {TemplateParameters}
   */
  parameters(parsedUrl, request, isModerator, extraParams) {
    const params = super.parameters(
      parsedUrl,
      request,
      isModerator,
      extraParams,
    );
    const parts = parsedUrl.pathname.split("boards/", 2);
    const boardUriComponent = parts[1] || "";
    const boardBaseUrl = new URL(`boards/${boardUriComponent}`, params.baseUrl)
      .href;
    params.boardUriComponent = boardUriComponent;
    params.board = decodeURIComponent(boardUriComponent);
    // The browser may reach this shell through a URL that is not a /boards/
    // path (the Hosted Event board page), so the client boot prefers the
    // server-computed identity over deriving it from the location.
    params.socketIoPath = `${this.serverConfig?.BASE_PATH || ""}/socket.io`;
    const hostedEventPath = /** @type {string | undefined} */ (
      /** @type {Record<string, unknown>} */ (extraParams || {})[
        "hostedEventPath"
      ]
    );
    params.boardIdentity = {
      board: params.board,
      socketIoPath: params.socketIoPath,
      // Hosted Event boards embed the event page path so the client can
      // route admission refusals back to the event page. Absent on legacy.
      ...(hostedEventPath ? { hostedEventPath } : {}),
    };
    params.canonicalUrl = localizedUrl(boardBaseUrl, params.language);
    params.languageLinks = localizedLinks(params.languages, (linkLanguage) =>
      localizedUrl(boardBaseUrl, linkLanguage),
    );
    params.hideMenu =
      parsedUrl.searchParams.get("hideMenu") === "true" || false;
    const configuration = /** @type {{BLOCKED_TOOLS?: string[]}} */ (
      params.configuration || {}
    );
    const blockedTools = Array.isArray(configuration.BLOCKED_TOOLS)
      ? configuration.BLOCKED_TOOLS
      : [];
    const renderedTools = /** @type {ToolbarTool[]} */ (
      getRenderedTools({
        blockedTools: blockedTools,
      })
    );
    params.tools = renderedTools.map((tool) => {
      const visible = boardStateGrantsCapability(
        params.boardState,
        tool.requiredCapability,
      );
      const iconUrl = `../${tool.iconPath}`;
      return {
        id: tool.toolId,
        label: params.translations[tool.translationKey] || tool.label,
        iconUrl,
        initialIconUrl: visible ? iconUrl : "data:,",
        visible,
      };
    });
    return params;
  }

  /**
   * @param {TemplateRequest} request
   * @param {TemplateResponse} response
   * @param {NodeJS.ReadableStream} inlineBoardSvgStream
   * @param {boolean} [isModerator]
   * @param {object} [extraParams]
   * @returns {{encoding: CompressionEncoding | undefined}}
   */
  serveStream(
    request,
    response,
    inlineBoardSvgStream,
    isModerator,
    extraParams,
  ) {
    if (!this.prefixTemplate || !this.suffixTemplate) {
      throw new Error("Board template is not configured for streaming SVG.");
    }
    const parsedUrl = parseRequestUrl(request.url);
    const parameters = this.parameters(
      parsedUrl,
      request,
      isModerator === true,
      extraParams,
    );
    const prefix = this.prefixTemplate(parameters);
    const suffix = this.suffixTemplate(parameters);
    const { stream, encoding } = startHtmlResponse(
      response,
      request,
      parsedUrl,
      parameters,
      this.cacheControl(),
    );
    stream.write(prefix);
    inlineBoardSvgStream.pipe(stream, { end: false });
    inlineBoardSvgStream.on("end", () => {
      stream.end(suffix);
    });
    return { encoding };
  }

  /**
   * @returns {string}
   */
  cacheControl() {
    const maxAgeSeconds = Math.max(
      0,
      Math.floor(this.serverConfig.MAX_SAVE_DELAY / 1000) -
        BOARD_PAGE_CACHE_HEADROOM_SECONDS,
    );
    return cacheControl(
      this.serverConfig.IS_DEVELOPMENT,
      `public, max-age=${maxAgeSeconds}, must-revalidate`,
    );
  }
}

class RulesTemplate extends Template {
  /**
   * @param {URL} parsedUrl
   * @param {TemplateRequest} request
   * @param {boolean} isModerator
   * @param {object} [extraParams]
   * @returns {TemplateParameters}
   */
  parameters(parsedUrl, request, isModerator, extraParams) {
    const params = super.parameters(
      parsedUrl,
      request,
      isModerator,
      extraParams,
    );
    const rootUrl = params.baseHref;
    const rulesUrl = new URL("rules", rootUrl).href;
    params.baseUrl = rootUrl.endsWith("/") ? rootUrl.slice(0, -1) : rootUrl;
    params.baseHref = rootUrl;
    params.canonicalUrl = localizedUrl(rulesUrl, params.language);
    params.languageLinks = localizedLinks(params.languages, (linkLanguage) =>
      localizedUrl(rulesUrl, linkLanguage),
    );
    params.moderationRules = MODERATION_RULES.map((rule) => ({
      id: rule.id,
      iconPath: `rules/${rule.iconFile}`,
      title: params.translations[rule.titleKey] || rule.titleKey,
      paragraphs: rule.bodyKeys.map((key) => params.translations[key] || key),
      ...(rule.appealUrl
        ? {
            appealUrl: rule.appealUrl,
            appealLabel:
              params.translations[rule.appealLabelKey] || rule.appealLabelKey,
          }
        : {}),
    }));
    return params;
  }
}

export {
  BoardTemplate,
  localizedHref,
  RulesTemplate,
  StaticTemplate,
  Template,
};
