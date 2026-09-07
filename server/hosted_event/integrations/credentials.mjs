import crypto from "node:crypto";

/**
 * Shared API Credential and Entry Grant token primitives.
 *
 * An API Credential authenticates an organizer's *server* against the
 * versioned integration API. Its bearer value is `<credentialId>.<secret>`:
 * the public credential id selects the stored record, and the secret — 256
 * bits of base64url entropy — is verified against a SHA-256 digest of the
 * full bearer value, so a store leak never reveals a usable credential. The
 * raw secret exists exactly twice: once at creation or rotation, where it is
 * shown to the managing Owner exactly once, and in the organizer's own
 * backend. It cannot be recovered afterwards.
 *
 * An Entry Grant is the short-lived, single-use token an organizer's server
 * obtains through the integration API and hands to one participant's browser
 * in a URL fragment. Like credential secrets it is persisted only as a
 * SHA-256 digest; redemption looks the grant up by digest, so the token
 * itself never has to be stored or logged.
 */

const CREDENTIAL_SECRET_BYTES = 32;
const ENTRY_GRANT_TOKEN_BYTES = 32;

/** Shape of the public credential id embedded in the bearer value. */
const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
/** Shape of the credential secret; anything else is rejected before hashing. */
const CREDENTIAL_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
/** Shape of an Entry Grant token submitted for redemption. */
const ENTRY_GRANT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

/** External Participant Reference bounds; the value stays opaque. */
const MAX_EXTERNAL_REFERENCE_LENGTH = 256;

/**
 * Creates a new API Credential bearer value. The secret is returned only by
 * this function; callers persist `digestCredentialToken(token)` and render
 * the token exactly once.
 *
 * @param {string} credentialId
 * @returns {{credentialId: string, secret: string, token: string}}
 */
function generateCredentialToken(credentialId) {
  const secret = crypto
    .randomBytes(CREDENTIAL_SECRET_BYTES)
    .toString("base64url");
  return { credentialId, secret, token: `${credentialId}.${secret}` };
}

/**
 * Parses an `Authorization: Bearer` value into its credential id and secret.
 * Returns null for anything that does not have the exact issued shape, so
 * malformed input is rejected before any store lookup.
 *
 * @param {unknown} value
 * @returns {{credentialId: string, secret: string} | null}
 */
function parseCredentialToken(value) {
  if (typeof value !== "string") return null;
  const separator = value.indexOf(".");
  if (separator <= 0 || separator === value.length - 1) return null;
  const credentialId = value.slice(0, separator);
  const secret = value.slice(separator + 1);
  if (
    !CREDENTIAL_ID_PATTERN.test(credentialId) ||
    !CREDENTIAL_SECRET_PATTERN.test(secret)
  ) {
    return null;
  }
  return { credentialId, secret };
}

/**
 * SHA-256 hex digest of a full credential bearer value; the only form stored.
 *
 * @param {string} token
 * @returns {string}
 */
function digestCredentialToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time comparison of a presented bearer value against a stored
 * digest. Never throws; anything unusable simply does not match.
 *
 * @param {string} token
 * @param {unknown} storedDigest
 * @returns {boolean}
 */
function credentialTokenMatches(token, storedDigest) {
  if (typeof storedDigest !== "string" || storedDigest === "") return false;
  const digest = digestCredentialToken(token);
  if (digest.length !== storedDigest.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(digest, "utf8"),
    Buffer.from(storedDigest, "utf8"),
  );
}

/**
 * Generates a new Entry Grant token for one participant's browser.
 *
 * @returns {string}
 */
function generateEntryGrantToken() {
  return crypto.randomBytes(ENTRY_GRANT_TOKEN_BYTES).toString("base64url");
}

/**
 * @param {string} token
 * @returns {string}
 */
function digestEntryGrantToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Whether a submitted grant token has the issued shape. Malformed values are
 * rejected before hashing so hostile input stays deterministic and cheap.
 *
 * @param {unknown} token
 * @returns {boolean}
 */
function isValidEntryGrantToken(token) {
  return typeof token === "string" && ENTRY_GRANT_TOKEN_PATTERN.test(token);
}

/**
 * Validates an External Participant Reference. The value is opaque: it is
 * never interpreted, only length-capped, and it must be free of control
 * characters — a reference carrying them is malformed and fails
 * deterministically instead of being silently rewritten.
 *
 * @param {unknown} input
 * @returns {string | null} the trimmed reference, or null when invalid
 */
function normalizeExternalReference(input) {
  if (typeof input !== "string") return null;
  const cleaned = input.trim();
  if (cleaned === "" || cleaned.length > MAX_EXTERNAL_REFERENCE_LENGTH) {
    return null;
  }
  for (const character of cleaned) {
    const code = /** @type {number | undefined} */ (character.codePointAt(0));
    if (code === undefined || code < 0x20 || code === 0x7f) return null;
  }
  return cleaned;
}

export {
  credentialTokenMatches,
  digestCredentialToken,
  digestEntryGrantToken,
  generateCredentialToken,
  generateEntryGrantToken,
  isValidEntryGrantToken,
  MAX_EXTERNAL_REFERENCE_LENGTH,
  normalizeExternalReference,
  parseCredentialToken,
};
