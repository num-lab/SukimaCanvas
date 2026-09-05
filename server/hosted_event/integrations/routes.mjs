import { BoundaryError } from "../../http/boundary_errors.mjs";
import { publicPath } from "../../http/request_url.mjs";
import observability from "../../observability/index.mjs";
import { resolveRequestClientIpSafe } from "../../socket/policy.mjs";
import { resolveSignedInAccountFromRequest } from "../accounts/routes.mjs";
import { createFormSecurity, readFormBody } from "../http_forms.mjs";
import { eventLifecycleState } from "../organizers/store.mjs";
import { normalizeExternalReference } from "./credentials.mjs";

const { logger } = observability;

/** @import { HttpRequest, HttpRouteContext, ServerConfig } from "../../../types/server-runtime.d.ts" */

const MAX_JSON_BODY_BYTES = 16 * 1024;

/**
 * HTTP flows for the versioned integration API and Entry Grant redemption.
 *
 * An organizer's backend authenticates with an API Credential
 * (`Authorization: Bearer <credentialId>.<secret>`) against exactly two
 * endpoints: an event lifecycle query and an Entry Grant creation. Both are
 * scoped to the credential's own organizer — another organizer's event is
 * indistinguishable from a missing one. The created grant travels to the
 * participant's browser only in the redirect URL's fragment; the browser
 * redeems it here with an authenticated HTTPS POST and clears the fragment,
 * so the grant never appears in query strings, paths, referrers, or ordinary
 * access logs. Redemption is single-use, expires after its TTL, dies with
 * its credential, and still defers to Event Ban, Event Lock, the Board
 * Session lifecycle, and seat capacity — those rules precede the grant, and
 * every failure mode is one deterministic, indistinguishable response.
 *
 * @param {{
 *   config: ServerConfig,
 *   clock?: () => number,
 *   accountStore: ReturnType<typeof import("../accounts/store.mjs").createFileAccountStore>,
 *   organizerStore: ReturnType<typeof import("../organizers/store.mjs").createFileOrganizerStore>,
 *   membershipStore: ReturnType<typeof import("../memberships/store.mjs").createFileEventMembershipStore>,
 *   integrationStore: ReturnType<typeof import("./store.mjs").createFileIntegrationStore>,
 *   limiter: ReturnType<typeof import("../accounts/rate_limits.mjs").createRateLimiter>,
 *   advanceEventLifecycle?: () => Promise<void>,
 * }} dependencies
 */
function createIntegrationRoutes(dependencies) {
  const {
    config,
    accountStore,
    organizerStore,
    membershipStore,
    integrationStore,
    limiter,
  } = dependencies;
  const clock = dependencies.clock || (() => Date.now());
  const { requestHasValidCsrf } = createFormSecurity(config);

  /**
   * Writes a JSON response with the hosted pages' no-referrer, no-store
   * hygiene: machine responses must never be cached and never propagate
   * request URLs onward.
   *
   * @param {HttpRouteContext} ctx
   * @param {number} statusCode
   * @param {unknown} payload
   * @returns {void}
   */
  function writeJson(ctx, statusCode, payload) {
    ctx.response.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    ctx.response.end(JSON.stringify(payload));
  }

  /**
   * Reads a size-capped JSON request body. An empty body is an empty object;
   * anything unparsable, oversized, or of the wrong media type is a
   * deterministic machine-readable failure, never a crash.
   *
   * @param {HttpRequest} request
   * @returns {Promise<{ok: true, body: {[key: string]: unknown}} | {ok: false, statusCode: number, error: string}>}
   */
  async function readJsonBody(request) {
    /** @type {Buffer[]} */
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of request) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        return { ok: false, statusCode: 413, error: "request_too_large" };
      }
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.trim() === "") return { ok: true, body: {} };
    const contentType = request.headers["content-type"];
    const declared =
      typeof contentType === "string" ? contentType.toLowerCase() : "";
    if (!declared.startsWith("application/json")) {
      return { ok: false, statusCode: 415, error: "unsupported_media_type" };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, statusCode: 400, error: "invalid_json" };
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { ok: false, statusCode: 400, error: "invalid_json" };
    }
    return { ok: true, body: /** @type {{[key: string]: unknown}} */ (parsed) };
  }

  /**
   * Authenticates the request's API Credential, writing the uniform 401 and
   * returning null on any failure. Invalid shape, unknown credential, wrong
   * secret, and revoked status are indistinguishable.
   *
   * @param {HttpRouteContext} ctx
   * @returns {import("./store.mjs").StoredApiCredential | null}
   */
  function requireCredential(ctx) {
    const verdict = integrationStore.authenticateCredential(
      ctx.request.headers.authorization,
    );
    if (!verdict.ok) {
      writeJson(ctx, 401, { error: "credential_required" });
      return null;
    }
    return verdict.credential;
  }

  /**
   * Resolves the event a credential may act on. An unknown Public ID and one
   * belonging to another organizer are the same response, so the API cannot
   * probe other organizers' events.
   *
   * @param {HttpRouteContext} ctx
   * @param {{organizerId: string}} credential
   * @returns {import("../organizers/store.mjs").StoredEvent | null}
   */
  function requireScopedEvent(ctx, credential) {
    const event = organizerStore.getEventByPublicId(ctx.params.publicId || "");
    if (!event || event.organizerId !== credential.organizerId) {
      return null;
    }
    return event;
  }

  /**
   * Lazily advances the durable Board Session lifecycle and runs the close
   * pipeline, so the API reports and admission decide on the authoritative
   * status. The composed module injects the full refresh (including closes);
   * the standalone default only advances the lifecycle.
   *
   * @returns {Promise<void>}
   */
  const advanceLifecycleNow =
    dependencies.advanceEventLifecycle ||
    (async () => {
      await organizerStore.advanceLifecycle({
        now: clock(),
        closeDrainMs: config.HOSTED_BOARD_SESSION_CLOSE_DRAIN_MS,
      });
    });

  // --- organizer backend API ------------------------------------------------

  /**
   * `GET /api/v1/events/{publicId}` — the event lifecycle state an organizer's
   * backend needs to mirror the event on its own site.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveIntegrationApiEvent(ctx) {
    if (ctx.request.method !== "GET") {
      writeJson(ctx, 405, { error: "method_not_allowed" });
      return;
    }
    const credential = requireCredential(ctx);
    if (!credential) return;
    const event = requireScopedEvent(ctx, credential);
    if (!event) {
      writeJson(ctx, 404, { error: "event_not_found" });
      return;
    }
    await advanceLifecycleNow();
    writeJson(ctx, 200, {
      event: {
        publicId: event.publicId,
        name: event.name,
        status:
          event.status === "cancelled"
            ? "cancelled"
            : eventLifecycleState(event, clock()),
        startsAtMs: event.startsAtMs,
        endsAtMs: event.endsAtMs,
      },
    });
  }

  /**
   * `POST /api/v1/events/{publicId}/entry-grants` — exchanges a valid API
   * Credential for a short-lived, single-use Entry Grant. The response hands
   * back a root-relative URL whose fragment carries the grant token; the
   * token itself is never logged.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveIntegrationApiEntryGrantCreate(ctx) {
    if (ctx.request.method !== "POST") {
      writeJson(ctx, 405, { error: "method_not_allowed" });
      return;
    }
    const credential = requireCredential(ctx);
    if (!credential) return;
    const event = requireScopedEvent(ctx, credential);
    if (!event) {
      writeJson(ctx, 404, { error: "event_not_found" });
      return;
    }
    const limit = config.HOSTED_API_ENTRY_GRANT_LIMIT;
    const windowMs = config.HOSTED_API_ENTRY_GRANT_WINDOW_MS;
    if (
      !limiter.consume(
        "api_entry_grant",
        `credential:${credential.credentialId}`,
        limit,
        windowMs,
      ).allowed
    ) {
      writeJson(ctx, 429, { error: "rate_limited" });
      return;
    }
    const body = await readJsonBody(ctx.request);
    if (!body.ok) {
      writeJson(ctx, body.statusCode, { error: body.error });
      return;
    }
    let externalReference = null;
    if (body.body.externalReference !== undefined) {
      externalReference = normalizeExternalReference(
        body.body.externalReference,
      );
      if (externalReference === null) {
        writeJson(ctx, 400, { error: "invalid_external_reference" });
        return;
      }
    }
    if (event.status === "cancelled") {
      // A cancelled event can never admit anyone; refuse deterministically
      // instead of minting grants that must all fail.
      writeJson(ctx, 409, { error: "event_not_available" });
      return;
    }
    const created = await integrationStore.createEntryGrant({
      organizerId: credential.organizerId,
      eventId: event.eventId,
      credentialId: credential.credentialId,
      externalReference,
    });
    logger.info("hosted.integration_entry_grant_created", {
      organizer_id: credential.organizerId,
      event_id: event.eventId,
      credential_id: credential.credentialId,
    });
    writeJson(ctx, 201, {
      entryGrant: {
        // Root-relative: the organizer prefixes the service origin it already
        // configured for API calls. The fragment is the only place the grant
        // token ever travels.
        entryGrantPath: `${publicPath(
          config,
          `/events/${event.publicId}`,
        )}#entryGrant=${created.token}`,
        expiresAtMs: created.grant.expiresAtMs,
        externalReference,
      },
    });
  }

  // --- browser redemption ---------------------------------------------------

  /**
   * Whether fresh admission may admit anyone to the event right now: the
   * session must be open, and the event neither locked nor cancelled. Event
   * Ban, the Entry Lock, the lifecycle, and seat capacity all take precedence
   * over a valid grant.
   *
   * @param {import("../organizers/store.mjs").StoredEvent} event
   * @returns {boolean}
   */
  function eventEnterable(event) {
    if (event.status === "cancelled" || event.entryLocked) return false;
    const session = organizerStore.getBoardSessionForEvent(event.eventId);
    return session !== null && session.status === "open";
  }

  /**
   * `POST /events/{publicId}/entry-grant` — the browser-side exchange. The
   * participant must be signed in; the grant token arrives in the POST body
   * (never in the URL) with the hosted CSRF pair. Every terminal failure —
   * expired, already redeemed, revoked credential, foreign event, malformed
   * token, banned account, or an event that cannot admit right now — is one
   * uniform deterministic response, so the endpoint cannot be probed. A
   * successful redemption yields Event Membership, not a Participant Seat;
   * seat capacity still governs Board Session entry.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveEventEntryGrantRedeem(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const event = organizerStore.getEventByPublicId(ctx.params.publicId || "");
    if (!event) throw new BoundaryError(404, "event_not_found");
    const form = await readFormBody(ctx.request);
    // The participant must be signed in before anything else is judged: the
    // browser only redeems after login, and a mid-flow session expiry tells
    // the client to re-authenticate rather than burn the grant.
    const account = resolveSignedInAccountFromRequest(
      accountStore,
      ctx.request,
    );
    if (!account) {
      writeJson(ctx, 401, { error: "account_required" });
      return;
    }
    if (!requestHasValidCsrf(ctx.request, form)) {
      writeJson(ctx, 403, { error: "csrf" });
      return;
    }
    const address = resolveRequestClientIpSafe(config, ctx.request);
    const limit = config.HOSTED_ENTRY_GRANT_ATTEMPTS_LIMIT;
    const windowMs = config.HOSTED_ENTRY_GRANT_ATTEMPTS_WINDOW_MS;
    if (
      !limiter.consume("entry_grant_redeem", `ip:${address}`, limit, windowMs)
        .allowed ||
      !limiter.consume(
        "entry_grant_redeem",
        `account:${account.accountId}`,
        limit,
        windowMs,
      ).allowed
    ) {
      writeJson(ctx, 429, { error: "rate_limited" });
      return;
    }
    // Advance the durable lifecycle so admission sees the authoritative
    // session status at the current service clock.
    await advanceLifecycleNow();
    /**
     * One uniform, non-consuming failure. Expired, reused, revoked-
     * credential, foreign-event, malformed, banned, and not-enterable grants
     * are indistinguishable here and in the log-free response body.
     *
     * @param {string} reason
     * @returns {void}
     */
    const redeemFailure = (reason) => {
      logger.info("hosted.event_entry_grant_rejected", {
        event_id: event.eventId,
        reason,
      });
      writeJson(ctx, 400, { error: "entry_grant_invalid" });
    };
    const existingMembership = membershipStore.getMembership(
      event.eventId,
      account.accountId,
    );
    if (
      membershipStore.isEventBanned(event.eventId, account.accountId) ||
      (!existingMembership && !eventEnterable(event))
    ) {
      redeemFailure("admission_blocked");
      return;
    }
    const redeemed = await integrationStore.redeemEntryGrant({
      token: form.get("entryGrant"),
      eventId: event.eventId,
      accountId: account.accountId,
    });
    if (!redeemed.ok) {
      redeemFailure("invalid");
      return;
    }
    if (!existingMembership) {
      // Grant admission defaults to identified attribution; the participant
      // can still switch to anonymous on the event page while the session
      // remains changeable.
      await membershipStore.admit({
        eventId: event.eventId,
        accountId: account.accountId,
        anonymity: "identified",
      });
      logger.info("hosted.event_entry_grant_redeemed", {
        event_id: event.eventId,
      });
    }
    writeJson(ctx, 200, { ok: true });
  }

  return {
    serveIntegrationApiEvent,
    serveIntegrationApiEntryGrantCreate,
    serveEventEntryGrantRedeem,
  };
}

export { createIntegrationRoutes };
