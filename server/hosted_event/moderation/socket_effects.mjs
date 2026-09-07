/**
 * Composition seam for moderation socket effects.
 *
 * Moderation decisions live in the Hosted Event Module (stores, admission,
 * participant identity), but their real-time consequences — evicting a banned
 * participant's live sockets, refreshing a revoked moderator's connection —
 * belong to the Socket.IO layer, which owns the live socket table. The socket
 * layer registers its implementation here at startup; hosted routes call
 * through this registry. Before registration (unit tests, headless store
 * flows) the effects are simply absent and state changes persist without
 * socket side effects.
 */

/**
 * @typedef {{
 *   evictEventAccount: (eventId: string, accountId: string, notice: {banDurationMs: number, source: string}) => void,
 *   refreshEventAccountAccess: (eventId: string, accountId: string) => Promise<void>,
 * }} ModerationSocketEffects
 */

/** @type {ModerationSocketEffects | null} */
let effects = null;

/**
 * @param {ModerationSocketEffects | null} implementation
 * @returns {void}
 */
function registerModerationSocketEffects(implementation) {
  effects = implementation;
}

/**
 * @returns {ModerationSocketEffects | null}
 */
function moderationSocketEffects() {
  return effects;
}

export { moderationSocketEffects, registerModerationSocketEffects };
