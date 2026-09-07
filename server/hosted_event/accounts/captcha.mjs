import observability from "../../observability/index.mjs";
import {
  normalizeTurnstileHostname,
  verifyTurnstileToken,
} from "../../socket/turnstile.mjs";

const { metrics } = observability;

/** @import { ServerConfig } from "../../../types/server-runtime.d.ts" */

/**
 * Configurable CAPTCHA contract for hosted account entries.
 *
 * The contract is intentionally vendor-shaped (`required`, `siteKey`,
 * `fieldName`, `verify`) so the CAPTCHA provider can change without touching
 * the account flows. The first release implements it with the existing
 * Cloudflare Turnstile configuration shared with socket admission: when
 * `TURNSTILE_SECRET_KEY` is configured, registration and login submissions
 * must carry a Turnstile token; when it is absent the contract is disabled.
 *
 * @param {ServerConfig} config
 */
function createHostedCaptcha(config) {
  const required = Boolean(config.TURNSTILE_SECRET_KEY);
  const fieldName = "cf-turnstile-response";

  /**
   * @param {unknown} token
   * @param {string} clientIp
   * @param {string | undefined} requestHost
   * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
   */
  async function verify(token, clientIp, requestHost) {
    if (!required) return { ok: true };
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      token.length > 2048
    ) {
      return { ok: false, reason: "invalid_token" };
    }
    try {
      const result = await verifyTurnstileToken(
        config.TURNSTILE_VERIFY_URL,
        /** @type {string} */ (config.TURNSTILE_SECRET_KEY),
        token,
        clientIp,
      );
      if (!result || result.success !== true) {
        metrics.recordTurnstileVerification("hosted_siteverify_failed");
        return { ok: false, reason: "siteverify_failed" };
      }
      const expectedHostname = normalizeTurnstileHostname(requestHost);
      const actualHostname = normalizeTurnstileHostname(result.hostname);
      if (
        actualHostname &&
        expectedHostname &&
        actualHostname !== expectedHostname &&
        !(actualHostname === "example.com" && expectedHostname === "localhost")
      ) {
        metrics.recordTurnstileVerification("hosted_hostname_mismatch");
        return { ok: false, reason: "hostname_mismatch" };
      }
      metrics.recordTurnstileVerification();
      return { ok: true };
    } catch (error) {
      // A CAPTCHA provider outage must fail closed deterministically instead
      // of crashing the process or letting submissions through.
      metrics.recordTurnstileVerification(error);
      return { ok: false, reason: "captcha_unavailable" };
    }
  }

  return {
    required,
    siteKey: config.TURNSTILE_SITE_KEY || "",
    fieldName,
    verify,
  };
}

export { createHostedCaptcha };
