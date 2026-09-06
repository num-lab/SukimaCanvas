import path from "node:path";

import {
  parseBasePathEnv,
  parseBoardModeratorsEnv,
  parseBooleanEnv,
  parseCommaSeparatedEnv,
  parseDisabledFlagEnv,
  parseEmailListEnv,
  parseEnumEnv,
  parseIntegerEnv,
  parseIpConfigurationEnv,
  parseRateLimitProfileEnv,
  parseStringEnv,
} from "./configuration/helpers.mjs";

const APP_ROOT = process.cwd();
const LOG_LEVELS = ["debug", "info", "warn", "error"];
const DEFAULT_WEBROOT = path.join(APP_ROOT, "client-data");
const IP_CONFIGURATION = parseIpConfigurationEnv(
  "WBO_IP_SOURCE",
  "WBO_TRUST_PROXY_HOPS",
  "remoteAddress",
  0,
);

/** True outside production. */
export const IS_DEVELOPMENT = process.env.NODE_ENV !== "production";

/** Listen port for the HTTP server. */
export const PORT = parseIntegerEnv("PORT", 8080);

/** Listen host for the HTTP server. Empty means all interfaces. */
export const HOST = parseStringEnv("HOST", undefined);

/** Directory where board history and persisted SVG files are stored. */
export const HISTORY_DIR = parseStringEnv(
  "WBO_HISTORY_DIR",
  path.join(APP_ROOT, "server-data"),
);

/** Minimum emitted server log level. Accepted values: `debug`, `info`, `warn`, `error`. */
export const LOG_LEVEL = parseEnumEnv("LOG_LEVEL", LOG_LEVELS, "info");

/** Static web root used to serve the client application files. */
export const WEBROOT = parseStringEnv("WBO_WEBROOT", DEFAULT_WEBROOT);

/** Whether the Hosted Event Service shell is enabled for this deployment. */
export const HOSTED_MODE = parseBooleanEnv("WBO_HOSTED_MODE", false);

/** Directory where Hosted Event Service business state (accounts, sessions, verification tokens) is stored. */
export const HOSTED_DATA_DIR = parseStringEnv(
  "WBO_HOSTED_DATA_DIR",
  path.join(APP_ROOT, "hosted-data"),
);

/** Directory where outgoing Hosted Event Service mail is queued as JSON files until a mail vendor is selected. */
export const HOSTED_MAIL_OUTBOX_DIR = parseStringEnv(
  "WBO_HOSTED_MAIL_OUTBOX_DIR",
  undefined,
);

/** Maximum age of a hosted account session, measured from its creation. */
export const HOSTED_SESSION_MAX_AGE_MS = parseIntegerEnv(
  "WBO_HOSTED_SESSION_MAX_AGE_MS",
  30 * 24 * 60 * 60 * 1000,
);

/** Idle timeout after which a hosted account session requires a new login. */
export const HOSTED_SESSION_IDLE_TIMEOUT_MS = parseIntegerEnv(
  "WBO_HOSTED_SESSION_IDLE_TIMEOUT_MS",
  12 * 60 * 60 * 1000,
);

/** How long a hosted account email verification link stays valid. */
export const HOSTED_VERIFICATION_TOKEN_TTL_MS = parseIntegerEnv(
  "WBO_HOSTED_VERIFICATION_TOKEN_TTL_MS",
  24 * 60 * 60 * 1000,
);

/** How long a hosted account password reset link stays valid. */
export const HOSTED_PASSWORD_RESET_TTL_MS = parseIntegerEnv(
  "WBO_HOSTED_PASSWORD_RESET_TTL_MS",
  60 * 60 * 1000,
);

/** Maximum forgot-password submissions per client IP or email within the forgot window. */
export const HOSTED_FORGOT_ATTEMPTS_LIMIT = parseIntegerEnv(
  "WBO_HOSTED_FORGOT_ATTEMPTS_LIMIT",
  5,
);

/** Window for hosted forgot-password attempt limits. */
export const HOSTED_FORGOT_ATTEMPTS_WINDOW_MS = parseIntegerEnv(
  "WBO_HOSTED_FORGOT_ATTEMPTS_WINDOW_MS",
  15 * 60 * 1000,
);

/**
 * Injectable server-authoritative clock for hosted account flows. Never read
 * from the environment; deployments keep this undefined (meaning `Date.now`)
 * and isolated tests override the composed config object with a controlled
 * clock adapter.
 *
 * @type {(() => number) | undefined}
 */
export const HOSTED_CLOCK = undefined;

/** Maximum registration submissions per client IP or email within the register window. */
export const HOSTED_REGISTER_ATTEMPTS_LIMIT = parseIntegerEnv(
  "WBO_HOSTED_REGISTER_ATTEMPTS_LIMIT",
  20,
);

/** Window for hosted registration attempt limits. */
export const HOSTED_REGISTER_ATTEMPTS_WINDOW_MS = parseIntegerEnv(
  "WBO_HOSTED_REGISTER_ATTEMPTS_WINDOW_MS",
  15 * 60 * 1000,
);

/** Maximum login submissions per client IP or email within the login window. */
export const HOSTED_LOGIN_ATTEMPTS_LIMIT = parseIntegerEnv(
  "WBO_HOSTED_LOGIN_ATTEMPTS_LIMIT",
  10,
);

/** Window for hosted login attempt limits. */
export const HOSTED_LOGIN_ATTEMPTS_WINDOW_MS = parseIntegerEnv(
  "WBO_HOSTED_LOGIN_ATTEMPTS_WINDOW_MS",
  15 * 60 * 1000,
);

/**
 * Normalized email addresses provisioned as Platform Operators. Operators are
 * granted by deployment config rather than self-service registration: a
 * signed-in, verified, active Account whose email is in this list may use the
 * operator console to review Organizer Applications.
 */
export const HOSTED_OPERATOR_EMAILS = parseEmailListEnv(
  "WBO_HOSTED_OPERATOR_EMAILS",
);

/** Maximum organizer-application submissions per account or IP within the window. */
export const HOSTED_ORGANIZER_APPLY_ATTEMPTS_LIMIT = parseIntegerEnv(
  "WBO_HOSTED_ORGANIZER_APPLY_ATTEMPTS_LIMIT",
  10,
);

/** Window for hosted organizer-application attempt limits. */
export const HOSTED_ORGANIZER_APPLY_ATTEMPTS_WINDOW_MS = parseIntegerEnv(
  "WBO_HOSTED_ORGANIZER_APPLY_ATTEMPTS_WINDOW_MS",
  15 * 60 * 1000,
);

/** Maximum organizer-invitation sends per owner account or IP within the window. */
export const HOSTED_ORGANIZER_INVITE_ATTEMPTS_LIMIT = parseIntegerEnv(
  "WBO_HOSTED_ORGANIZER_INVITE_ATTEMPTS_LIMIT",
  30,
);

/** Window for hosted organizer-invitation attempt limits. */
export const HOSTED_ORGANIZER_INVITE_ATTEMPTS_WINDOW_MS = parseIntegerEnv(
  "WBO_HOSTED_ORGANIZER_INVITE_ATTEMPTS_WINDOW_MS",
  15 * 60 * 1000,
);

/** Maximum reservation create/submit actions per account or IP within the window. */
export const HOSTED_RESERVATION_ATTEMPTS_LIMIT = parseIntegerEnv(
  "WBO_HOSTED_RESERVATION_ATTEMPTS_LIMIT",
  30,
);

/** Window for hosted reservation attempt limits. */
export const HOSTED_RESERVATION_ATTEMPTS_WINDOW_MS = parseIntegerEnv(
  "WBO_HOSTED_RESERVATION_ATTEMPTS_WINDOW_MS",
  15 * 60 * 1000,
);

/** Maximum Brand Asset uploads per account or IP within the window. */
export const HOSTED_BRAND_ASSET_ATTEMPTS_LIMIT = parseIntegerEnv(
  "WBO_HOSTED_BRAND_ASSET_ATTEMPTS_LIMIT",
  20,
);

/** Window for hosted Brand Asset upload attempt limits. */
export const HOSTED_BRAND_ASSET_ATTEMPTS_WINDOW_MS = parseIntegerEnv(
  "WBO_HOSTED_BRAND_ASSET_ATTEMPTS_WINDOW_MS",
  15 * 60 * 1000,
);

/** Maximum Access Code submissions per account or IP within the window. */
export const HOSTED_ACCESS_CODE_ATTEMPTS_LIMIT = parseIntegerEnv(
  "WBO_HOSTED_ACCESS_CODE_ATTEMPTS_LIMIT",
  10,
);

/** Window for hosted Access Code submission attempt limits. */
export const HOSTED_ACCESS_CODE_ATTEMPTS_WINDOW_MS = parseIntegerEnv(
  "WBO_HOSTED_ACCESS_CODE_ATTEMPTS_WINDOW_MS",
  15 * 60 * 1000,
);

/**
 * How long an Entry Grant stays redeemable after its organizer backend
 * requested it. The integration contract is 10 minutes.
 */
export const HOSTED_ENTRY_GRANT_TTL_MS = parseIntegerEnv(
  "WBO_HOSTED_ENTRY_GRANT_TTL_MS",
  10 * 60 * 1000,
);

/** Maximum Entry Grant redemption attempts per account or IP within the window. */
export const HOSTED_ENTRY_GRANT_ATTEMPTS_LIMIT = parseIntegerEnv(
  "WBO_HOSTED_ENTRY_GRANT_ATTEMPTS_LIMIT",
  10,
);

/** Window for hosted Entry Grant redemption attempt limits. */
export const HOSTED_ENTRY_GRANT_ATTEMPTS_WINDOW_MS = parseIntegerEnv(
  "WBO_HOSTED_ENTRY_GRANT_ATTEMPTS_WINDOW_MS",
  15 * 60 * 1000,
);

/** Maximum Entry Grant creations per API credential within the window. */
export const HOSTED_API_ENTRY_GRANT_LIMIT = parseIntegerEnv(
  "WBO_HOSTED_API_ENTRY_GRANT_LIMIT",
  60,
);

/** Window for the per-credential Entry Grant creation limit. */
export const HOSTED_API_ENTRY_GRANT_WINDOW_MS = parseIntegerEnv(
  "WBO_HOSTED_API_ENTRY_GRANT_WINDOW_MS",
  60 * 1000,
);

/** Maximum API credential mint/rotation attempts per account or IP within the window. */
export const HOSTED_CREDENTIAL_ATTEMPTS_LIMIT = parseIntegerEnv(
  "WBO_HOSTED_CREDENTIAL_ATTEMPTS_LIMIT",
  10,
);

/** Window for hosted API credential management attempt limits. */
export const HOSTED_CREDENTIAL_ATTEMPTS_WINDOW_MS = parseIntegerEnv(
  "WBO_HOSTED_CREDENTIAL_ATTEMPTS_WINDOW_MS",
  15 * 60 * 1000,
);

/**
 * How long a Participant Seat stays reserved for its Account after the
 * Account's last live connection drops. Reconnecting inside the window
 * restores the seat without contending for capacity; after it expires the
 * seat is released and must be re-acquired while capacity remains.
 */
export const HOSTED_SEAT_GRACE_MS = parseIntegerEnv(
  "WBO_HOSTED_SEAT_GRACE_MS",
  10 * 60 * 1000,
);

/**
 * Drain window between a Board Session entering CLOSING and being sealed CLOSED,
 * during which accepted writes are flushed before the archive is produced.
 */
export const HOSTED_BOARD_SESSION_CLOSE_DRAIN_MS = parseIntegerEnv(
  "WBO_HOSTED_BOARD_SESSION_CLOSE_DRAIN_MS",
  60 * 1000,
);

/**
 * Backoff between automatic retries of a Board Session whose archive close
 * failed (`ARCHIVE_FAILED`). The failure stays observable the whole time and a
 * Platform Operator can retry immediately from the operator console; the
 * backoff only paces the durable background recovery. `0` disables automatic
 * retries (manual operator retries still work).
 */
export const HOSTED_BOARD_SESSION_ARCHIVE_RETRY_MS = parseIntegerEnv(
  "WBO_HOSTED_BOARD_SESSION_ARCHIVE_RETRY_MS",
  15 * 60 * 1000,
);

/**
 * How often the durable lifecycle poker advances Board Sessions with no active
 * reader. The persisted times plus the service clock are the source of truth;
 * the poke only triggers a catch-up. `0` disables the background poke (e.g. in
 * tests, which drive advancement through requests against an injected clock).
 */
export const HOSTED_LIFECYCLE_POLL_MS = parseIntegerEnv(
  "WBO_HOSTED_LIFECYCLE_POLL_MS",
  30 * 1000,
);

/**
 * How long an export's authorized download link stays valid after the job
 * succeeded. Revoking the link or deleting the export invalidates it earlier.
 */
export const HOSTED_BOARD_EXPORT_LINK_TTL_MS = parseIntegerEnv(
  "WBO_HOSTED_BOARD_EXPORT_LINK_TTL_MS",
  24 * 60 * 60 * 1000,
);

/**
 * Backoff between automatic retries of a failed Board Image Export job. A job
 * past its attempt budget stays failed; recovery is a fresh export request.
 * `0` retries on the next lifecycle pass.
 */
export const HOSTED_BOARD_EXPORT_RETRY_MS = parseIntegerEnv(
  "WBO_HOSTED_BOARD_EXPORT_RETRY_MS",
  15 * 60 * 1000,
);

/** Capacity window buffer added before a reservation's start and after its end. */
export const HOSTED_CAPACITY_WINDOW_BUFFER_MS = parseIntegerEnv(
  "WBO_HOSTED_CAPACITY_WINDOW_BUFFER_MS",
  15 * 60 * 1000,
);

/** Maximum Board Sessions confirmed across any overlapping capacity window. */
export const HOSTED_MAX_CONCURRENT_BOARD_SESSIONS = parseIntegerEnv(
  "WBO_HOSTED_MAX_CONCURRENT_BOARD_SESSIONS",
  20,
);

/** Maximum Participant Seats confirmed across any overlapping capacity window. */
export const HOSTED_MAX_CONCURRENT_SEATS = parseIntegerEnv(
  "WBO_HOSTED_MAX_CONCURRENT_SEATS",
  1000,
);

/** Maximum requested Participant Seats for a single reservation. */
export const HOSTED_MAX_RESERVATION_SEATS = parseIntegerEnv(
  "WBO_HOSTED_MAX_RESERVATION_SEATS",
  50,
);

/** Maximum planned duration (start to end) of a single reservation. */
export const HOSTED_MAX_EVENT_DURATION_MS = parseIntegerEnv(
  "WBO_HOSTED_MAX_EVENT_DURATION_MS",
  12 * 60 * 60 * 1000,
);

/**
 * Fixed service timezone, as an offset from UTC in minutes, used to interpret
 * and display reservation wall-clock times. The first release operates in
 * mainland China (UTC+8, no daylight saving), so the default is 480.
 */
export const HOSTED_SERVICE_UTC_OFFSET_MINUTES = parseIntegerEnv(
  "WBO_HOSTED_SERVICE_UTC_OFFSET_MINUTES",
  480,
);

/** Immutable version identifier shown by the Corresponding Source page. */
export const DEPLOYMENT_VERSION = parseStringEnv(
  "WBO_DEPLOYMENT_VERSION",
  undefined,
);

/** URL template for the Corresponding Source; it must contain `{version}`. */
export const CORRESPONDING_SOURCE_URL = parseStringEnv(
  "WBO_CORRESPONDING_SOURCE_URL",
  undefined,
);

/** Build instructions paired with the Corresponding Source mapping. */
export const CORRESPONDING_SOURCE_BUILD = parseStringEnv(
  "WBO_CORRESPONDING_SOURCE_BUILD",
  undefined,
);

/** External URL path prefix used when WBO is mounted behind a reverse proxy. */
export const BASE_PATH = parseBasePathEnv("WBO_BASE_PATH");

/** Optional HTML snippet inserted before `</head>` in rendered HTML pages. */
export const HTML_HEAD_SNIPPET_PATH = parseStringEnv(
  "WBO_HTML_HEAD_SNIPPET_PATH",
  undefined,
);

/** Idle delay before a dirty board is saved. */
export const SAVE_INTERVAL = parseIntegerEnv("WBO_SAVE_INTERVAL", 2000);

/** Maximum save delay while a board keeps receiving writes. */
export const MAX_SAVE_DELAY = parseIntegerEnv("WBO_MAX_SAVE_DELAY", 60 * 1000);

if (MAX_SAVE_DELAY < SAVE_INTERVAL) {
  throw new Error(
    `Invalid save timing config: WBO_MAX_SAVE_DELAY (${MAX_SAVE_DELAY}) must be greater than or equal to WBO_SAVE_INTERVAL (${SAVE_INTERVAL}).`,
  );
}

/** How long persisted replay entries stay available after a save. */
export const SEQ_REPLAY_RETENTION_MS = parseIntegerEnv(
  "WBO_SEQ_REPLAY_RETENTION_MS",
  60 * 1000,
);

/** Hard cap on authoritative persisted items per board. */
export const MAX_ITEM_COUNT = parseIntegerEnv("WBO_MAX_ITEM_COUNT", 32768);

/** Hard cap on child payload entries inside one message or stored item. */
export const MAX_CHILDREN = parseIntegerEnv("WBO_MAX_CHILDREN", 500);

/** Maximum absolute board coordinate accepted by the server. */
export const MAX_BOARD_SIZE = parseIntegerEnv("WBO_MAX_BOARD_SIZE", 655360);

/** Per-IP general write rate limits. Example: `*:250/5s anonymous:125/5s`. */
export const GENERAL_RATE_LIMITS = parseRateLimitProfileEnv(
  "WBO_MAX_EMIT_COUNT",
  "*:250/5s",
);

/** Per-IP constructive write rate limits. Example: `*:40/10s anonymous:20/10s`. */
export const CONSTRUCTIVE_ACTION_RATE_LIMITS = parseRateLimitProfileEnv(
  "WBO_MAX_CONSTRUCTIVE_ACTIONS_PER_IP",
  "*:40/10s anonymous:20/10s",
);

/** Per-IP destructive write rate limits. Example: `*:190/60s anonymous:95/60s`. */
export const DESTRUCTIVE_ACTION_RATE_LIMITS = parseRateLimitProfileEnv(
  "WBO_MAX_DESTRUCTIVE_ACTIONS_PER_IP",
  "*:190/60s anonymous:95/60s",
);

/** Per-IP text creation rate limits. Example: `*:2/1s anonymous:30/60s`. */
export const TEXT_CREATION_RATE_LIMITS = parseRateLimitProfileEnv(
  "WBO_MAX_TEXT_CREATIONS_PER_IP",
  "*:2/1s anonymous:30/60s",
);

/** Source used to resolve the client IP. Accepted values: `remoteAddress`, `Forwarded`, `X-Forwarded-For`, or a header name. */
export const IP_SOURCE = IP_CONFIGURATION.IP_SOURCE;

/** Number of trusted proxy hops when `WBO_IP_SOURCE` uses forwarded headers. */
export const TRUST_PROXY_HOPS = IP_CONFIGURATION.TRUST_PROXY_HOPS;

/**
 * Comma-separated blocked tool ids. Hosted mode always blocks the Download
 * tool: participants never get raw SVG downloads, and the hosted board page
 * plus socket admission enforce the same list server-side.
 */
const PARSED_BLOCKED_TOOLS = parseCommaSeparatedEnv("WBO_BLOCKED_TOOLS").filter(
  (tool) => tool !== "",
);
export const BLOCKED_TOOLS =
  HOSTED_MODE === true && !PARSED_BLOCKED_TOOLS.includes("download")
    ? [...PARSED_BLOCKED_TOOLS, "download"]
    : PARSED_BLOCKED_TOOLS;

/** Comma-separated blocked selection button ids. */
export const BLOCKED_SELECTION_BUTTONS = parseCommaSeparatedEnv(
  "WBO_BLOCKED_SELECTION_BUTTONS",
);

/** Finger whiteout stays enabled unless this env var is explicitly set to `disabled`. */
export const AUTO_FINGER_WHITEOUT = parseDisabledFlagEnv(
  "AUTO_FINGER_WHITEOUT",
);

/** Board-scoped moderator user secrets, in the form: `boardname:usersecret1 boardname2:usersecret2`.
 * The user secret is their wbo secret cookie.
 */
export const BOARD_MODERATORS = parseBoardModeratorsEnv("WBO_BOARD_MODERATORS");

/** Shared JWT secret used by board auth helpers. Empty disables JWT auth. */
export const AUTH_SECRET_KEY = parseStringEnv("AUTH_SECRET_KEY", "");

/** Cloudflare Turnstile secret key (used on the server)
 *
 * For tests, use:
 * - always pass: TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
 * - always fail: TURNSTILE_SECRET_KEY=2x0000000000000000000000000000000AA
 *
 */
export const TURNSTILE_SECRET_KEY = parseStringEnv(
  "TURNSTILE_SECRET_KEY",
  undefined,
);

/** Cloudflare Turnstile site key (used on the client)
 *
 * For tests, use:
 * - always pass,   visible: TURNSTILE_SITE_KEY=1x00000000000000000000AA
 * - always pass, invisible: TURNSTILE_SITE_KEY=1x00000000000000000000BB
 * - always fail, invisible: TURNSTILE_SITE_KEY=2x00000000000000000000BB
 * - interactive challenge : TURNSTILE_SITE_KEY=3x00000000000000000000FF
 */
export const TURNSTILE_SITE_KEY = parseStringEnv(
  "TURNSTILE_SITE_KEY",
  undefined,
);

/** Turnstile verification endpoint override. */
export const TURNSTILE_VERIFY_URL = parseStringEnv(
  "TURNSTILE_VERIFY_URL",
  "https://challenges.cloudflare.com/turnstile/v0/siteverify",
);

/** How long a successful Turnstile validation remains valid for a socket. */
export const TURNSTILE_VALIDATION_WINDOW_MS = parseIntegerEnv(
  "TURNSTILE_VALIDATION_WINDOW_MS",
  15 * 60 * 1000,
);

/** Optional board name used by the root route redirect. */
export const DEFAULT_BOARD = parseStringEnv("WBO_DEFAULT_BOARD", undefined);
