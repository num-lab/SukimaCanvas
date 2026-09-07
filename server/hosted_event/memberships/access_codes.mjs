import crypto from "node:crypto";

/**
 * Shared Event Access Codes.
 *
 * An Access Code is the shared credential participants enter on the event
 * page. The raw code exists only twice: once at generation, where it is shown
 * to the managing Owner/Admin exactly once, and in the participant's own
 * copy. The server persists only a SHA-256 digest of the normalized code, so
 * a store leak never reveals a usable code. Codes use an unambiguous 31-digit
 * alphabet (no 0/O/1/I) and are compared case-insensitively with all
 * separators stripped, because they are retyped by hand.
 */

/** 31 unambiguous digits; ~99 bits of entropy at 20 digits. */
const ACCESS_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const ACCESS_CODE_GROUPS = 4;
const ACCESS_CODE_GROUP_LENGTH = 5;
const MAX_NORMALIZED_LENGTH = 64;

/**
 * Generates a new high-entropy Access Code, formatted as four hyphen-separated
 * groups for human transcription.
 *
 * @returns {string}
 */
function generateAccessCode() {
  /** @type {number[]} */
  const indexes = [];
  while (indexes.length < ACCESS_CODE_GROUPS * ACCESS_CODE_GROUP_LENGTH) {
    const byte = crypto.randomBytes(1)[0] || 0;
    // Reject bytes above the largest multiple of the alphabet size so the
    // modulo mapping stays unbiased.
    if (byte < 248) indexes.push(byte % ACCESS_CODE_ALPHABET.length);
  }
  /** @type {string[]} */
  const groups = [];
  for (let index = 0; index < ACCESS_CODE_GROUPS; index += 1) {
    groups.push(
      indexes
        .slice(
          index * ACCESS_CODE_GROUP_LENGTH,
          (index + 1) * ACCESS_CODE_GROUP_LENGTH,
        )
        .map((digit) => ACCESS_CODE_ALPHABET[digit])
        .join(""),
    );
  }
  return groups.join("-");
}

/**
 * Normalizes a submitted Access Code for comparison: uppercased, with every
 * non-alphanumeric character (spaces, hyphens, punctuation) stripped. The
 * alphabet already excludes look-alike glyphs, so no further substitutions
 * are made. Returns the empty string when nothing usable remains.
 *
 * @param {unknown} input
 * @returns {string}
 */
function normalizeAccessCode(input) {
  if (typeof input !== "string") return "";
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, MAX_NORMALIZED_LENGTH);
}

/**
 * SHA-256 hex digest of a normalized Access Code; the only form ever stored.
 *
 * @param {string} normalizedCode
 * @returns {string}
 */
function digestAccessCode(normalizedCode) {
  return crypto
    .createHash("sha256")
    .update(normalizedCode, "utf8")
    .digest("hex");
}

/**
 * Constant-time comparison of a submitted raw code against a stored digest.
 * Never throws; anything unusable simply does not match.
 *
 * @param {unknown} rawCode
 * @param {unknown} storedDigest
 * @returns {boolean}
 */
function accessCodeMatches(rawCode, storedDigest) {
  const normalized = normalizeAccessCode(rawCode);
  if (
    normalized === "" ||
    typeof storedDigest !== "string" ||
    storedDigest === ""
  ) {
    return false;
  }
  const digest = digestAccessCode(normalized);
  if (digest.length !== storedDigest.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(digest, "utf8"),
    Buffer.from(storedDigest, "utf8"),
  );
}

export {
  accessCodeMatches,
  digestAccessCode,
  generateAccessCode,
  normalizeAccessCode,
};
