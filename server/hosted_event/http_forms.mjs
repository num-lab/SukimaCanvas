import { BoundaryError } from "../http/boundary_errors.mjs";
import {
  appendSetCookieHeader,
  parseCookieHeader,
} from "../auth/user_secret_cookie.mjs";
import {
  HOSTED_CSRF_COOKIE_MAX_AGE_SECONDS,
  HOSTED_CSRF_COOKIE_NAME,
  generateHostedToken,
  hostedCookiePath,
  readHostedCookie,
  serializeHostedCookie,
  timingSafeEqualStrings,
} from "../auth/hosted_cookies.mjs";

/** @import { HttpRequest, HttpRouteContext, ServerConfig } from "../../types/server-runtime.d.ts" */

const MAX_FORM_BODY_BYTES = 32 * 1024;

/**
 * @param {string | string[] | undefined} value
 * @returns {string | undefined}
 */
function firstHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Reads and size-bounds a urlencoded form body, rejecting the wrong media type
 * or an oversized payload with a deterministic boundary error rather than a
 * crash.
 *
 * @param {import("http").IncomingMessage} request
 * @returns {Promise<URLSearchParams>}
 */
async function readFormBody(request) {
  const contentType = firstHeaderValue(request.headers["content-type"]);
  if (
    typeof contentType !== "string" ||
    !contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")
  ) {
    throw new BoundaryError(415, "unsupported_form_media_type");
  }
  /** @type {Buffer[]} */
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_FORM_BODY_BYTES) {
      throw new BoundaryError(413, "form_body_too_large");
    }
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Resolves a translated string for the request's negotiated language, applying
 * `{name}` substitutions. Falls back to the key itself when it is missing.
 *
 * @param {import("../http/templating.mjs").Template} template
 * @param {HttpRouteContext} ctx
 * @param {string} key
 * @param {{[name: string]: string}} [substitutions]
 * @returns {string}
 */
function translate(template, ctx, key, substitutions) {
  const { translations } = template.translationsFor(ctx.request, ctx.url);
  let value = translations[key];
  if (typeof value !== "string" || value === "") value = key;
  for (const [name, replacement] of Object.entries(substitutions || {})) {
    value = value.split(`{${name}}`).join(replacement);
  }
  return value;
}

/**
 * @param {HttpRouteContext} ctx
 * @param {string} location
 * @returns {void}
 */
function seeOther(ctx, location) {
  ctx.response.writeHead(303, { Location: location });
  ctx.response.end();
}

/**
 * Shared CSRF and cookie plumbing for hosted browser forms. Cookie attributes
 * and double-submit CSRF validation live here once so account and organizer
 * flows cannot drift apart on security-relevant behavior.
 *
 * @param {ServerConfig} config
 */
function createFormSecurity(config) {
  const secureCookies = config.IS_DEVELOPMENT !== true;
  const cookieOptions = () => ({
    path: hostedCookiePath(config),
    secure: secureCookies,
  });

  /**
   * Returns the browser's CSRF token, issuing a fresh one (with its cookie)
   * when the request does not carry one yet.
   *
   * @param {HttpRouteContext} ctx
   * @returns {string}
   */
  function ensureCsrfToken(ctx) {
    const existing = readHostedCookie(
      ctx.request.headers.cookie,
      HOSTED_CSRF_COOKIE_NAME,
    );
    if (existing) return existing;
    const token = generateHostedToken();
    appendSetCookieHeader(
      ctx.response,
      serializeHostedCookie(HOSTED_CSRF_COOKIE_NAME, token, {
        ...cookieOptions(),
        maxAgeSeconds: HOSTED_CSRF_COOKIE_MAX_AGE_SECONDS,
      }),
    );
    return token;
  }

  /**
   * Issues a fresh CSRF token and cookie, invalidating every previously issued
   * token for this browser (used after a security-relevant session
   * transition).
   *
   * @param {HttpRouteContext} ctx
   * @returns {void}
   */
  function rotateCsrfToken(ctx) {
    appendSetCookieHeader(
      ctx.response,
      serializeHostedCookie(HOSTED_CSRF_COOKIE_NAME, generateHostedToken(), {
        ...cookieOptions(),
        maxAgeSeconds: HOSTED_CSRF_COOKIE_MAX_AGE_SECONDS,
      }),
    );
  }

  /**
   * @param {URLSearchParams} form
   * @param {{[name: string]: string}} cookies
   * @returns {boolean}
   */
  function hasValidCsrf(form, cookies) {
    const submitted = form.get("_csrf");
    const expected = cookies[HOSTED_CSRF_COOKIE_NAME];
    return (
      typeof submitted === "string" &&
      submitted.length >= 16 &&
      typeof expected === "string" &&
      expected.length >= 16 &&
      timingSafeEqualStrings(submitted, expected)
    );
  }

  /**
   * @param {HttpRequest} request
   * @param {URLSearchParams} form
   * @returns {boolean}
   */
  function requestHasValidCsrf(request, form) {
    return hasValidCsrf(form, parseCookieHeader(request.headers.cookie));
  }

  return {
    cookieOptions,
    ensureCsrfToken,
    rotateCsrfToken,
    hasValidCsrf,
    requestHasValidCsrf,
  };
}

export {
  MAX_FORM_BODY_BYTES,
  createFormSecurity,
  firstHeaderValue,
  readFormBody,
  seeOther,
  translate,
};
