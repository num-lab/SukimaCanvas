import { createHmac } from "node:crypto";

/**
 * Item attribution identifiers for the Hosted Event Service.
 *
 * Every board item created during an event carries an immutable `createdBy`
 * value. That value is the participant's Participant Identifier: an opaque,
 * event-scoped token derived from the Account and the Event with a deployment
 * secret. It is stable across devices and restarts, correlates an account's
 * items inside one event only, and cannot be reversed to an Account id or an
 * email without the secret. Internal Account identity is recorded solely in
 * the durable mutation ledger, never on items, broadcasts, or logs.
 */

const IDENTIFIER_PREFIX = "p";
const IDENTIFIER_HEX_LENGTH = 16;
/** Derivation domain so the same secret can safely serve other HMAC uses. */
const DERIVATION_CONTEXT = "sukimacanvas-participant-identifier:v1";

/**
 * @param {string} secret
 * @returns {(eventId: string, accountId: string) => string}
 */
function createParticipantIdentifierResolver(secret) {
  if (typeof secret !== "string" || secret === "") {
    throw new Error(
      "A non-empty AUTH_SECRET_KEY is required to derive participant identifiers",
    );
  }
  return function participantIdentifierFor(eventId, accountId) {
    const digest = createHmac("sha256", secret)
      .update(`${DERIVATION_CONTEXT}\n${eventId}\n${accountId}`)
      .digest("hex");
    return `${IDENTIFIER_PREFIX}${digest.slice(0, IDENTIFIER_HEX_LENGTH)}`;
  };
}

export { createParticipantIdentifierResolver };
