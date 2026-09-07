import crypto from "node:crypto";

import { parseCookieHeader } from "./user_secret_cookie.mjs";

/** @import { ServerConfig } from "../../types/server-runtime.d.ts" */

const HOSTED_SESSION_COOKIE_NAME = "hosted-session-v1";
const HOSTED_CSRF_COOKIE_NAME = "hosted-csrf-v1";
const HOSTED_CSRF_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;
const HOSTED_COOKIE_VALUE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * @param {string} name
 * @param {string} value
 * @param {{path: string, secure: boolean, maxAgeSeconds: number}} options
 * @returns {string}
 */
function serializeHostedCookie(name, value, options) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${options.maxAgeSeconds}`,
    `Path=${options.path}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * @param {string} name
 * @param {{path: string, secure: boolean}} options
 * @returns {string}
 */
function clearHostedCookie(name, options) {
  return serializeHostedCookie(name, "", {
    ...options,
    maxAgeSeconds: 0,
  });
}

/**
 * @param {string | string[] | undefined} cookieHeader
 * @param {string} name
 * @returns {string}
 */
function readHostedCookie(cookieHeader, name) {
  const value = parseCookieHeader(cookieHeader)[name];
  if (typeof value !== "string") return "";
  // Cookie values are server-issued opaque tokens; anything outside the
  // issued shape is treated as absent rather than trusted.
  return HOSTED_COOKIE_VALUE_PATTERN.test(value) ? value : "";
}

/**
 * @returns {string}
 */
function generateHostedToken() {
  return crypto.randomBytes(24).toString("base64url");
}

/**
 * Cookie path covering every hosted page for the configured public base path.
 *
 * @param {ServerConfig} config
 * @returns {string}
 */
function hostedCookiePath(config) {
  return config.BASE_PATH ? `${config.BASE_PATH}/` : "/";
}

/**
 * Constant-time comparison for same-length-ish secrets; both sides are
 * hashed first so length differences do not leak through early exit.
 *
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
function timingSafeEqualStrings(left, right) {
  const leftDigest = crypto.createHash("sha256").update(left, "utf8").digest();
  const rightDigest = crypto
    .createHash("sha256")
    .update(right, "utf8")
    .digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

export {
  HOSTED_CSRF_COOKIE_MAX_AGE_SECONDS,
  HOSTED_CSRF_COOKIE_NAME,
  HOSTED_SESSION_COOKIE_NAME,
  clearHostedCookie,
  generateHostedToken,
  hostedCookiePath,
  readHostedCookie,
  serializeHostedCookie,
  timingSafeEqualStrings,
};
