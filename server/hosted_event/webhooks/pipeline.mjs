import crypto from "node:crypto";

import observability from "../../observability/index.mjs";

const { logger, metrics } = observability;

/**
 * The signed-webhook delivery pipeline.
 *
 * Lifecycle events (`event.opened`, `event.closed`, `archive.ready`,
 * `archive.failed`) are derived idempotently from the organizer store's
 * durable Board Session state — never from in-memory triggers — so a restart
 * or a skipped pass re-derives exactly the same set, and the outbox's dedupe
 * keys keep it at one logical event per transition episode. Each event is
 * captured with the subscriptions that existed at derivation time and
 * delivered at least once per subscription: non-2xx responses, network
 * errors, and timeouts retry with capped exponential backoff. When a
 * subscription's deliveries keep failing for the give-up window the
 * subscription is suspended, its Organizer Owners are notified through the
 * durable notice queue, and its queued event records freeze — resuming
 * delivers them without losing anything.
 *
 * Every delivery is HMAC-SHA256-signed over `${timestamp}.${body}` with the
 * subscription's secret and carries the stable event id, the event type, and
 * the time, so a receiver can verify the origin and deduplicate the
 * at-least-once redeliveries. The worker treats every failure as data: a
 * hostile endpoint, an invalid URL, or a malicious response body can delay a
 * delivery but never crash the pass or the service, and secrets, signatures,
 * and endpoint URLs never reach the structured log.
 *
 * @typedef {{
 *   webhookStore: ReturnType<typeof import("./store.mjs").createFileWebhookStore>,
 *   organizerStore: ReturnType<typeof import("../organizers/store.mjs").createFileOrganizerStore>,
 *   notificationService: {
 *     onWebhookSubscriptionSuspended: (input: {
 *       organizerId: string,
 *       subscriptionId: string,
 *       endpointHost: string,
 *     }) => Promise<void>,
 *   },
 *   config: import("../../../types/server-runtime.d.ts").ServerConfig,
 *   clock?: () => number,
 *   fetchImpl?: typeof fetch,
 *   deliveryTimeoutMs?: number,
 * }} WebhookPipelineDependencies
 */

/** Delivery timeout per attempt; a slow endpoint is a failed attempt. */
const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000;
/** Backoff cap between failed delivery attempts. */
const MAX_RETRY_BACKOFF_MS = 60 * 60 * 1000;

/**
 * The only lifecycle event types a webhook ever carries.
 */
const WEBHOOK_EVENT_KINDS = {
  EVENT_OPENED: "event.opened",
  EVENT_CLOSED: "event.closed",
  ARCHIVE_READY: "archive.ready",
  ARCHIVE_FAILED: "archive.failed",
};

/**
 * HMAC-signs one delivery body. `timestampSeconds` is unix seconds, mirrored
 * into the signature header so receivers can reject stale signatures.
 *
 * @param {string} secret
 * @param {number} timestampSeconds
 * @param {string} body
 * @returns {string} hex-encoded HMAC-SHA256
 */
function signDelivery(secret, timestampSeconds, body) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestampSeconds}.${body}`)
    .digest("hex");
}

/**
 * @param {WebhookPipelineDependencies} dependencies
 * @returns {{
 *   deriveLifecycleEvents: (input?: {now?: number}) => Promise<void>,
 *   runDueDeliveries: (input?: {now?: number}) => Promise<{delivered: number, failed: number, suspended: number}>,
 * }}
 */
function createWebhookPipeline(dependencies) {
  const webhookStore = dependencies.webhookStore;
  const organizerStore = dependencies.organizerStore;
  const notificationService = dependencies.notificationService;
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const clock = dependencies.clock || (() => Date.now());
  const deliveryTimeoutMs =
    typeof dependencies.deliveryTimeoutMs === "number" &&
    dependencies.deliveryTimeoutMs > 0
      ? dependencies.deliveryTimeoutMs
      : WEBHOOK_DELIVERY_TIMEOUT_MS;
  // Captured once at composition, never re-read per delivery.
  const retryBaseMs = Math.max(
    0,
    Number(dependencies.config.HOSTED_WEBHOOK_RETRY_MS) || 0,
  );
  const giveUpMs = Math.max(
    0,
    Number(dependencies.config.HOSTED_WEBHOOK_GIVE_UP_MS) || 0,
  );

  /**
   * Builds the public payload of one lifecycle event: Event Public ID, event
   * name, and timestamps. No emails, no board content, no Access Code
   * material, no internal object keys or session identifiers.
   *
   * @param {import("../organizers/store.mjs").StoredEvent} event
   * @param {Record<string, unknown>} extras
   * @returns {Record<string, unknown>}
   */
  function buildPayload(event, extras) {
    return {
      eventPublicId: event.publicId,
      eventName: event.name,
      ...extras,
    };
  }

  /**
   * Derives webhook events from the durable Board Session state. Each kind
   * has a stable dedupe key (`event.opened:<session>`, `archive.failed:
   * <session>:<first-failure>`, …), so repeated passes and restarts enqueue
   * nothing new. Never throws: a derivation problem must not fail the
   * lifecycle pass that triggered it.
   *
   * @returns {Promise<void>}
   */
  async function deriveLifecycleEvents() {
    let sessions;
    try {
      sessions = organizerStore.listBoardSessions();
    } catch (error) {
      logger.error("hosted.webhook_derive_failed", { error });
      return;
    }
    for (const session of sessions) {
      try {
        const event = organizerStore.getEventById(session.eventId);
        if (!event) continue;
        const scope = {
          organizerId: session.organizerId,
          eventId: session.eventId,
          boardSessionId: session.boardSessionId,
        };
        if (session.openedAtMs !== null) {
          await webhookStore.enqueueIfAbsent({
            kind: WEBHOOK_EVENT_KINDS.EVENT_OPENED,
            ...scope,
            dedupeKey: `${WEBHOOK_EVENT_KINDS.EVENT_OPENED}:${session.boardSessionId}`,
            payload: buildPayload(event, {
              occurredAtMs: session.openedAtMs,
              startsAtMs: session.startsAtMs,
              endsAtMs: session.endsAtMs,
            }),
          });
        }
        if (session.closedAtMs !== null) {
          await webhookStore.enqueueIfAbsent({
            kind: WEBHOOK_EVENT_KINDS.EVENT_CLOSED,
            ...scope,
            dedupeKey: `${WEBHOOK_EVENT_KINDS.EVENT_CLOSED}:${session.boardSessionId}`,
            payload: buildPayload(event, {
              occurredAtMs: session.closedAtMs,
            }),
          });
        }
        if (session.archivedAtMs !== null) {
          await webhookStore.enqueueIfAbsent({
            kind: WEBHOOK_EVENT_KINDS.ARCHIVE_READY,
            ...scope,
            dedupeKey: `${WEBHOOK_EVENT_KINDS.ARCHIVE_READY}:${session.boardSessionId}`,
            payload: buildPayload(event, {
              occurredAtMs: session.archivedAtMs,
            }),
          });
        }
        if (session.archiveFailure !== null) {
          await webhookStore.enqueueIfAbsent({
            kind: WEBHOOK_EVENT_KINDS.ARCHIVE_FAILED,
            ...scope,
            dedupeKey: `${WEBHOOK_EVENT_KINDS.ARCHIVE_FAILED}:${session.boardSessionId}:${session.archiveFailure.firstFailedAtMs}`,
            payload: buildPayload(event, {
              occurredAtMs: session.archiveFailure.lastFailedAtMs,
              failureCode: session.archiveFailure.code,
            }),
          });
        }
      } catch (error) {
        logger.error("hosted.webhook_derive_session_failed", {
          board_session: session.boardSessionId,
          error,
        });
      }
    }
  }

  /**
   * The next backoff for a delivery with `failedAttempts` recorded failures:
   * doubling from the configured base, capped at one hour.
   *
   * @param {number} failedAttempts
   * @returns {number}
   */
  function nextBackoffMs(failedAttempts) {
    const exponential = retryBaseMs * 2 ** Math.max(0, failedAttempts - 1);
    return Math.min(Math.max(0, exponential), MAX_RETRY_BACKOFF_MS);
  }

  /**
   * Delivers one due item: signed body, bounded timeout, response body
   * discarded unread so a hostile endpoint cannot stall or crash the pass.
   *
   * @param {{entry: import("./store.mjs").StoredWebhookOutboxEntry, subscription: import("./store.mjs").StoredWebhookSubscription}} item
   * @param {number} now
   * @returns {Promise<{outcome: "delivered" | "http_status" | "network_error" | "timeout", statusCode: number | null}>}
   */
  async function deliverOne(item, now) {
    const body = JSON.stringify({
      id: item.entry.stableEventId,
      type: item.entry.kind,
      createdAtMs: item.entry.createdAtMs,
      data: item.entry.payload,
    });
    const timestampSeconds = Math.floor(now / 1000);
    const signature = signDelivery(
      item.subscription.secret,
      timestampSeconds,
      body,
    );
    let response;
    try {
      response = await fetchImpl(item.subscription.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-SukimaCanvas-Event": item.entry.kind,
          "X-SukimaCanvas-Delivery": item.entry.entryId,
          "X-SukimaCanvas-Signature": `t=${timestampSeconds},v1=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(deliveryTimeoutMs),
      });
    } catch (error) {
      const timedOut =
        /** @type {Error & {name?: string}} */ (error || {}).name ===
          "TimeoutError" ||
        /** @type {Error & {name?: string}} */ (error || {}).name ===
          "AbortError";
      return {
        outcome: timedOut ? "timeout" : "network_error",
        statusCode: null,
      };
    }
    // The response body is data from an external host: it is cancelled
    // unread, so an oversized or malicious body can never be parsed, logged,
    // or used to crash the worker.
    await response.body?.cancel().catch(() => {});
    if (response.status >= 200 && response.status < 300) {
      return { outcome: "delivered", statusCode: response.status };
    }
    return { outcome: "http_status", statusCode: response.status };
  }

  /**
   * One delivery pass: attempts every due (entry, subscription) pair,
   * records the outcome, and suspends subscriptions whose deliveries have
   * been failing for the give-up window — notifying their Owners through the
   * durable notice queue. Never throws; the caller may be a request path.
   *
   * @param {{now?: number}} [input]
   * @returns {Promise<{delivered: number, failed: number, suspended: number}>}
   */
  async function runDueDeliveries(input = {}) {
    const now = typeof input.now === "number" ? input.now : clock();
    let delivered = 0;
    let failed = 0;
    let suspended = 0;
    let due;
    try {
      due = webhookStore.listDueDeliveries({ now });
    } catch (error) {
      logger.error("hosted.webhook_delivery_scan_failed", { error });
      return { delivered, failed, suspended };
    }
    for (const item of due) {
      const attemptsBefore = item.delivery.attempts;
      const attempt = await deliverOne(item, now).catch(() => ({
        outcome: /** @type {"network_error"} */ ("network_error"),
        statusCode: null,
      }));
      try {
        if (attempt.outcome === "delivered") {
          delivered += 1;
          await webhookStore.recordDeliverySuccess({
            entryId: item.entry.entryId,
            subscriptionId: item.subscription.subscriptionId,
          });
        } else {
          failed += 1;
          await webhookStore.recordDeliveryFailure({
            entryId: item.entry.entryId,
            subscriptionId: item.subscription.subscriptionId,
            statusCode: attempt.statusCode,
            error: attempt.outcome,
            nextAttemptAtMs: now + nextBackoffMs(item.delivery.attempts + 1),
          });
        }
        metrics.recordWebhookDelivery(
          attempt.outcome === "delivered" ? "delivered" : "failed",
          attempt.outcome === "delivered" ? undefined : attempt.outcome,
        );
        logger.info("hosted.webhook_delivery_attempted", {
          outcome: attempt.outcome,
          event_type: item.entry.kind,
          subscription_id: item.subscription.subscriptionId,
          attempts: attemptsBefore + 1,
        });
      } catch (error) {
        logger.error("hosted.webhook_delivery_record_failed", { error });
      }
    }
    suspended += await suspendDueSubscriptions(now);
    try {
      await webhookStore.pruneDeliveredEntries({ now });
    } catch (error) {
      logger.error("hosted.webhook_outbox_prune_failed", { error });
    }
    return { delivered, failed, suspended };
  }

  /**
   * Suspends every subscription whose deliveries have been failing for the
   * give-up window, and notifies the Organizer Owners once per suspension
   * episode through the durable notice queue. Queued event records stay
   * frozen until an Owner fixes the endpoint and resumes.
   *
   * @param {number} now
   * @returns {Promise<number>}
   */
  async function suspendDueSubscriptions(now) {
    if (giveUpMs <= 0) return 0;
    let suspendedCount = 0;
    let suspendable;
    try {
      suspendable = webhookStore.listSuspendableSubscriptions({
        now,
        giveUpMs,
      });
    } catch (error) {
      logger.error("hosted.webhook_suspend_scan_failed", { error });
      return 0;
    }
    for (const item of suspendable) {
      try {
        const suspendedNow = await webhookStore.suspendSubscription({
          subscriptionId: item.subscriptionId,
        });
        if (!suspendedNow) continue;
        suspendedCount += 1;
        organizerStore.appendAudit({
          actorAccountId: "",
          actorKind: "system",
          action: "organizer_webhook.suspended",
          subjectType: "organizer_webhook",
          subjectId: item.subscriptionId,
          organizerId: item.organizerId,
        });
        await notificationService.onWebhookSubscriptionSuspended({
          organizerId: item.organizerId,
          subscriptionId: item.subscriptionId,
          endpointHost: item.endpointHost,
        });
      } catch (error) {
        logger.error("hosted.webhook_suspend_failed", { error });
      }
    }
    return suspendedCount;
  }

  return { deriveLifecycleEvents, runDueDeliveries };
}

export { createWebhookPipeline, WEBHOOK_EVENT_KINDS };
