/**
 * Wall-clock time handling for the fixed service timezone. Reservation and
 * event times are entered, stored, and displayed against a single UTC offset
 * (mainland China, UTC+8, no DST for the first release) so the datetime-local
 * edit fields and the read-only displays always agree on the absolute instant.
 */

/**
 * The `±HH:MM` ISO representation of a UTC offset in minutes.
 *
 * @param {number} offsetMinutes
 * @returns {string}
 */
export function offsetIso(offsetMinutes) {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/**
 * Parses an HTML datetime-local value (`YYYY-MM-DDTHH:MM`), interpreted as a
 * wall-clock time in the fixed service timezone, into a UTC epoch ms.
 *
 * @param {string | null} value
 * @param {number} offsetMinutes
 * @returns {number | null}
 */
export function parseDateTimeLocal(value, offsetMinutes) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?$/.exec(value.trim());
  if (!match) return null;
  const ms = Date.parse(
    `${match[1]}${match[2] || ":00"}.000${offsetIso(offsetMinutes)}`,
  );
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Renders a UTC epoch ms as a datetime-local form value in the service
 * timezone (so the edit field round-trips through parseDateTimeLocal).
 *
 * @param {number} ms
 * @param {number} offsetMinutes
 * @returns {string}
 */
export function toDateTimeLocal(ms, offsetMinutes) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms + offsetMinutes * 60000).toISOString().slice(0, 16);
}

/**
 * Renders a UTC epoch ms as a human-readable time in the service timezone,
 * consistent with the datetime-local edit fields.
 *
 * @param {number} ms
 * @param {number} offsetMinutes
 * @returns {string}
 */
export function formatServiceTime(ms, offsetMinutes) {
  if (!(Number.isFinite(ms) && ms > 0)) return "";
  const shifted = new Date(ms + offsetMinutes * 60000).toISOString();
  return `${shifted.slice(0, 10)} ${shifted.slice(11, 16)} (UTC${offsetIso(offsetMinutes)})`;
}
