import RateLimitCommon from "../../../client-data/js/rate_limit_common.js";
import {
  capToMaxSize,
  pruneStaleEntries,
  touchExisting,
} from "../../socket/bounded_state_map.mjs";

const { createRateLimitState, consumeFixedWindowRateLimit } = RateLimitCommon;

const MAX_ENTRIES = 4096;
const STALE_SCAN_LIMIT = 16;

/**
 * Fixed-window rate limiting for hosted account entries, keyed by arbitrary
 * strings (client IP or normalized email) and scoped per entry kind.
 * Reuses the shared client/server rate-limit math.
 *
 * @param {{clock?: () => number, maxEntries?: number}} [options]
 */
function createRateLimiter(options = {}) {
  const clock = options.clock || (() => Date.now());
  const maxEntries = options.maxEntries || MAX_ENTRIES;
  /** @type {Map<string, Map<string, import("../../../types/server-runtime.d.ts").RateLimitState>>} */
  const statesByKind = new Map();

  /**
   * @param {string} kind
   * @param {string} key
   * @param {number} limit
   * @param {number} windowMs
   * @returns {{allowed: true} | {allowed: false, retryAfterMs: number}}
   */
  function consume(kind, key, limit, windowMs) {
    let states = statesByKind.get(kind);
    if (!states) {
      states = new Map();
      statesByKind.set(kind, states);
    }
    const now = clock();
    if (windowMs > 0) {
      pruneStaleEntries(
        states,
        (state) => RateLimitCommon.isRateLimitStateStale(state, windowMs, now),
        STALE_SCAN_LIMIT,
      );
    }
    let state = touchExisting(states, key);
    if (!state) {
      state = createRateLimitState(now);
      states.set(key, state);
    }
    capToMaxSize(states, maxEntries);
    const next = consumeFixedWindowRateLimit(state, 1, windowMs, now);
    state.windowStart = next.windowStart;
    state.count = next.count;
    state.lastSeen = next.lastSeen;
    if (state.count <= limit) return { allowed: true };
    return {
      allowed: false,
      retryAfterMs: RateLimitCommon.getRateLimitRemainingMs(
        state,
        windowMs,
        now,
      ),
    };
  }

  return { consume };
}

export { createRateLimiter };
