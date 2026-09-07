const EMAIL_MAX_LENGTH = 254;
const LOCAL_PART_MAX_LENGTH = 64;
const LOCAL_PART_PATTERN = /^[a-z0-9]+(?:[._%+-][a-z0-9]+)*$/;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_PATTERN = /^[a-z]{2,63}$/;

/**
 * Deterministically normalizes an email for storage and uniqueness checks.
 * Normalization is intentionally conservative: trim surrounding whitespace and
 * lowercase. Provider-specific rules (such as Gmail dot removal) would change
 * who an address belongs to and are not applied.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeEmail(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

/**
 * @param {string} normalizedEmail
 * @returns {boolean}
 */
function isValidNormalizedEmail(normalizedEmail) {
  if (
    typeof normalizedEmail !== "string" ||
    normalizedEmail.length === 0 ||
    normalizedEmail.length > EMAIL_MAX_LENGTH
  ) {
    return false;
  }
  const separatorIndex = normalizedEmail.lastIndexOf("@");
  if (separatorIndex <= 0 || separatorIndex === normalizedEmail.length - 1) {
    return false;
  }
  const localPart = normalizedEmail.slice(0, separatorIndex);
  const domain = normalizedEmail.slice(separatorIndex + 1);
  if (localPart.length > LOCAL_PART_MAX_LENGTH) return false;
  if (!LOCAL_PART_PATTERN.test(localPart)) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1] || "";
  if (!TLD_PATTERN.test(tld)) return false;
  return labels.every((label) => DOMAIN_LABEL_PATTERN.test(label));
}

export { isValidNormalizedEmail, normalizeEmail };
