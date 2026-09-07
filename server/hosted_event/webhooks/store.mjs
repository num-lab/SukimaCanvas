import crypto from "node:crypto";

import observability from "../../observability/index.mjs";
import { createFileStateDocuments } from "../storage/documents.mjs";

const { logger } = observability;

const STORE_FORMAT_VERSION = 1;
const WEBHOOK_SECRET_BYTES = 32;
const WEBHOOK_SECRET_PREFIX = "whsec_";
/** Longest subscription URL accepted; organizer endpoints are ordinary sites. */
const MAX_WEBHOOK_URL_LENGTH = 2048;
/** Longest failure detail kept on a delivery record. */
const MAX_LAST_ERROR_LENGTH = 300;

/**
 * @typedef {"active" | "suspended" | "revoked"} WebhookSubscriptionStatus
 */
/**
 * @typedef {{
 *   subscriptionId: string,
 *   organizerId: string,
 *   url: string,
 *   secret: string,
 *   status: WebhookSubscriptionStatus,
 *   createdByAccountId: string,
 *   createdAtMs: number,
 *   rotatedAtMs: number | null,
 *   suspendedAtMs: number | null,
 *   revokedAtMs: number | null,
 * }} StoredWebhookSubscription
 */
/**
 * One per-subscription delivery record inside an outbox entry. The entry is
 * the logical event; this is the at-least-once state toward one endpoint.
 *
 * @typedef {{
 *   subscriptionId: string,
 *   attempts: number,
 *   firstAttemptAtMs: number | null,
 *   nextAttemptAtMs: number,
 *   lastAttemptAtMs: number | null,
 *   lastStatusCode: number | null,
 *   lastError: string | null,
 *   deliveredAtMs: number | null,
 * }} StoredWebhookDeliveryState
 */
/**
 * One logical lifecycle event awaiting delivery, captured with the
 * subscriptions that existed when the event was derived — a subscription
 * created later starts with future events, not this one. `payload` carries
 * public identifiers only (Event Public ID, names, timestamps); it never
 * carries emails, board content, Access Codes, or internal object keys.
 *
 * @typedef {{
 *   entryId: string,
 *   kind: string,
 *   organizerId: string,
 *   eventId: string,
 *   boardSessionId: string,
 *   dedupeKey: string,
 *   stableEventId: string,
 *   payload: Record<string, unknown>,
 *   deliveries: StoredWebhookDeliveryState[],
 *   createdAtMs: number,
 *   deliveredAtMs?: number | null,
 * }} StoredWebhookOutboxEntry
 */

/**
 * How long a fully-delivered outbox entry keeps its payload and delivery
 * state before shrinking to an idempotency tombstone.
 */
const DELIVERED_ENTRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Validates an organizer-provided webhook endpoint URL deterministically:
 * it must parse, use HTTPS (HTTP is accepted only when the composition
 * explicitly allows it — isolated tests drive a local receiver), carry no
 * embedded credentials, and name a host. Invalid URLs are refused at
 * creation; the delivery worker additionally treats every delivery error as
 * data, so a hostile endpoint can never crash it.
 *
 * @param {string} url
 * @param {{allowInsecureHttp?: boolean}} [options]
 * @returns {boolean}
 */
function isValidWebhookUrl(url, options = {}) {
  if (
    typeof url !== "string" ||
    url === "" ||
    url.length > MAX_WEBHOOK_URL_LENGTH
  ) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "https:" &&
    !(options.allowInsecureHttp === true && parsed.protocol === "http:")
  ) {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.hostname === "") return false;
  // A localhost endpoint is a development convenience, never a production
  // subscription target.
  if (
    options.allowInsecureHttp !== true &&
    (parsed.hostname === "localhost" || parsed.hostname.endsWith(".localhost"))
  ) {
    return false;
  }
  return true;
}

/**
 * Durable storage for Organizer Webhook Subscriptions and the signed-event
 * outbox that drives their at-least-once delivery. Reads come from an in-memory
 * index loaded on first use, and every mutation replaces state documents
 * through the selected durable adapter.
 *
 * The subscription secret is stored raw because the platform itself needs it
 * to sign every delivery; it is revealed to the Owner exactly once (on
 * create and on rotate) through the route layer and never rendered again.
 * Outbox enqueue is idempotent on the caller-supplied dedupe key, so
 * duplicate derivation passes and process restarts never re-queue the same
 * logical event.
 *
 * @param {{
 *   dataDir: string,
 *   clock?: () => number,
 *   randomId?: () => string,
 *   allowInsecureHttp?: boolean,
 *   stateDocuments?: import("../storage/documents.mjs").StateDocuments,
 * }} options
 */
function createFileWebhookStore(options) {
  const dataDir = options.dataDir;
  const stateDocuments =
    options.stateDocuments || createFileStateDocuments({ dataDir });
  const clock = options.clock || (() => Date.now());
  const randomId = options.randomId || (() => crypto.randomUUID());
  const allowInsecureHttp = options.allowInsecureHttp === true;

  const SUBSCRIPTIONS_FILE = "webhooks.json";
  const OUTBOX_FILE = "webhook_outbox.json";

  /** @type {Map<string, StoredWebhookSubscription>} */
  const subscriptionsById = new Map();
  /** @type {Map<string, StoredWebhookOutboxEntry>} */
  const entriesById = new Map();
  /** @type {Set<string>} */
  const dedupeKeys = new Set();
  let loaded = false;
  let writeQueue = Promise.resolve();

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    const subscriptions = readStoreFile(SUBSCRIPTIONS_FILE, {
      subscriptions: [],
    });
    for (const subscription of /** @type {StoredWebhookSubscription[]} */ (
      subscriptions.subscriptions || []
    )) {
      subscriptionsById.set(subscription.subscriptionId, subscription);
    }
    const outbox = readStoreFile(OUTBOX_FILE, { entries: [] });
    for (const entry of /** @type {StoredWebhookOutboxEntry[]} */ (
      outbox.entries || []
    )) {
      entriesById.set(entry.entryId, entry);
      dedupeKeys.add(entry.dedupeKey);
    }
  }

  /**
   * @template T
   * @param {string} filePath
   * @param {T} fallback
   * @returns {T}
   */
  function readStoreFile(filePath, fallback) {
    const parsed = /** @type {any} */ (stateDocuments.read(filePath, fallback));
    if (parsed === fallback) return fallback;
    if (parsed.version !== STORE_FORMAT_VERSION) {
      throw new Error(`Unsupported hosted webhook store format in ${filePath}`);
    }
    return parsed;
  }

  /**
   * @template T
   * @param {() => T | Promise<T>} task
   * @returns {Promise<T>}
   */
  function enqueueWrite(task) {
    const pending = /** @type {Promise<void>} */ (
      writeQueue.then(
        () => {},
        () => {},
      )
    );
    const run = pending.then(task);
    writeQueue = run.then(
      () => {},
      (error) => {
        logger.error("hosted_webhook_store.write_failed", { error });
      },
    );
    return run;
  }

  /**
   * @returns {Promise<void>}
   */
  async function persistNow() {
    await stateDocuments.writeMany([
      {
        key: SUBSCRIPTIONS_FILE,
        payload: {
          version: STORE_FORMAT_VERSION,
          subscriptions: [...subscriptionsById.values()],
        },
      },
      {
        key: OUTBOX_FILE,
        payload: {
          version: STORE_FORMAT_VERSION,
          entries: [...entriesById.values()],
        },
      },
    ]);
  }

  /**
   * @param {string} organizerId
   * @param {string} subscriptionId
   * @returns {StoredWebhookSubscription | null}
   */
  function subscriptionOf(organizerId, subscriptionId) {
    const subscription = subscriptionsById.get(String(subscriptionId || ""));
    if (!subscription || subscription.organizerId !== organizerId) return null;
    return subscription;
  }

  /**
   * Creates a subscription and reveals its signing secret exactly once.
   * Invalid URLs are refused without side effects.
   *
   * @param {{organizerId: string, url: string, actorAccountId: string}} input
   * @returns {Promise<{ok: true, subscription: StoredWebhookSubscription, secret: string} | {ok: false, reason: "invalid_url"}>}
   */
  async function createSubscription(input) {
    ensureLoaded();
    const url = String(input.url || "").trim();
    if (!isValidWebhookUrl(url, { allowInsecureHttp })) {
      return { ok: false, reason: "invalid_url" };
    }
    const secret = `${WEBHOOK_SECRET_PREFIX}${crypto
      .randomBytes(WEBHOOK_SECRET_BYTES)
      .toString("base64url")}`;
    /** @type {StoredWebhookSubscription} */
    const subscription = {
      subscriptionId: randomId(),
      organizerId: String(input.organizerId || ""),
      url,
      secret,
      status: "active",
      createdByAccountId: String(input.actorAccountId || ""),
      createdAtMs: clock(),
      rotatedAtMs: null,
      suspendedAtMs: null,
      revokedAtMs: null,
    };
    subscriptionsById.set(subscription.subscriptionId, subscription);
    await enqueueWrite(persistNow);
    return { ok: true, subscription, secret };
  }

  /**
   * Rotates the signing secret: the previous secret stops verifying
   * immediately, the new one is revealed exactly once on this response.
   * Pending outbox entries are untouched — their next delivery simply signs
   * with the new secret. A suspended subscription may rotate too: a leaked
   * secret must be replaceable without resuming deliveries first.
   *
   * @param {{organizerId: string, subscriptionId: string}} input
   * @returns {Promise<{ok: true, subscription: StoredWebhookSubscription, secret: string} | {ok: false, reason: "not_found" | "not_active"}>}
   */
  async function rotateSubscriptionSecret(input) {
    ensureLoaded();
    const subscription = subscriptionOf(
      String(input.organizerId || ""),
      String(input.subscriptionId || ""),
    );
    if (!subscription) return { ok: false, reason: "not_found" };
    if (subscription.status === "revoked") {
      return { ok: false, reason: "not_active" };
    }
    subscription.secret = `${WEBHOOK_SECRET_PREFIX}${crypto
      .randomBytes(WEBHOOK_SECRET_BYTES)
      .toString("base64url")}`;
    subscription.rotatedAtMs = clock();
    await enqueueWrite(persistNow);
    return { ok: true, subscription, secret: subscription.secret };
  }

  /**
   * Revokes a subscription. Its pending outbox deliveries are dropped — the
   * organizer explicitly stopped wanting them — while already-delivered
   * history stays untouched.
   *
   * @param {{organizerId: string, subscriptionId: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found" | "not_active"}>}
   */
  async function revokeSubscription(input) {
    ensureLoaded();
    const subscription = subscriptionOf(
      String(input.organizerId || ""),
      String(input.subscriptionId || ""),
    );
    if (!subscription) return { ok: false, reason: "not_found" };
    if (subscription.status === "revoked") {
      return { ok: false, reason: "not_active" };
    }
    subscription.status = "revoked";
    subscription.revokedAtMs = clock();
    subscription.secret = "";
    for (const entry of entriesById.values()) {
      entry.deliveries = entry.deliveries.filter(
        (delivery) => delivery.subscriptionId !== subscription.subscriptionId,
      );
    }
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * Resumes a suspended subscription: every event record queued before or
   * during the suspension becomes deliverable again on the next pass.
   *
   * @param {{organizerId: string, subscriptionId: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found" | "not_suspended"}>}
   */
  async function resumeSubscription(input) {
    ensureLoaded();
    const subscription = subscriptionOf(
      String(input.organizerId || ""),
      String(input.subscriptionId || ""),
    );
    if (!subscription) return { ok: false, reason: "not_found" };
    if (subscription.status !== "suspended") {
      return { ok: false, reason: "not_suspended" };
    }
    subscription.status = "active";
    subscription.suspendedAtMs = null;
    // A recovery episode starts a fresh give-up window for every queued
    // record: the Owner just fixed the endpoint, so an old first-failure
    // timestamp must not re-suspend the subscription on the next pass.
    for (const entry of entriesById.values()) {
      for (const delivery of entry.deliveries) {
        if (
          delivery.subscriptionId === subscription.subscriptionId &&
          delivery.deliveredAtMs === null
        ) {
          delivery.firstAttemptAtMs = null;
        }
      }
    }
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * Suspends a subscription after its deliveries kept failing for the
   * give-up window. Queued event records are frozen, not dropped: resuming
   * delivers them.
   *
   * @param {{subscriptionId: string}} input
   * @returns {Promise<boolean>} whether this call performed the transition
   */
  async function suspendSubscription(input) {
    ensureLoaded();
    const subscription = subscriptionsById.get(
      String(input.subscriptionId || ""),
    );
    if (!subscription || subscription.status !== "active") return false;
    subscription.status = "suspended";
    subscription.suspendedAtMs = clock();
    logger.warn("hosted.webhook_subscription_suspended", {
      subscription_id: subscription.subscriptionId,
      organizer_id: subscription.organizerId,
    });
    await enqueueWrite(persistNow);
    return true;
  }

  /**
   * The Owner-console projection of an organizer's subscriptions: it never
   * carries the signing secret.
   *
   * @param {string} organizerId
   * @returns {StoredWebhookSubscription[]}
   */
  function listSubscriptionsForOrganizer(organizerId) {
    ensureLoaded();
    const normalized = String(organizerId || "");
    return [...subscriptionsById.values()]
      .filter((subscription) => subscription.organizerId === normalized)
      .sort((left, right) => left.createdAtMs - right.createdAtMs)
      .map((subscription) => ({ ...subscription, secret: "" }));
  }

  /**
   * Enqueues one logical lifecycle event for the subscriptions that are
   * active at derivation time. Idempotent on the dedupe key: duplicate
   * derivation passes and restarts enqueue nothing.
   *
   * @param {{
   *   kind: string,
   *   organizerId: string,
   *   eventId: string,
   *   boardSessionId: string,
   *   dedupeKey: string,
   *   payload: Record<string, unknown>,
   * }} input
   * @returns {Promise<boolean>} whether a new entry was created
   */
  async function enqueueIfAbsent(input) {
    ensureLoaded();
    const dedupeKey = String(input.dedupeKey || "");
    if (dedupeKey === "" || dedupeKeys.has(dedupeKey)) return false;
    const now = clock();
    const deliveries = [...subscriptionsById.values()]
      .filter(
        (subscription) =>
          subscription.organizerId === input.organizerId &&
          subscription.status === "active",
      )
      .map((subscription) => ({
        subscriptionId: subscription.subscriptionId,
        attempts: 0,
        firstAttemptAtMs: null,
        nextAttemptAtMs: now,
        lastAttemptAtMs: null,
        lastStatusCode: null,
        lastError: null,
        deliveredAtMs: null,
      }));
    /** @type {StoredWebhookOutboxEntry} */
    const entry = {
      entryId: randomId(),
      kind: String(input.kind || ""),
      organizerId: String(input.organizerId || ""),
      eventId: String(input.eventId || ""),
      boardSessionId: String(input.boardSessionId || ""),
      dedupeKey,
      stableEventId: crypto.randomUUID(),
      payload: input.payload,
      deliveries,
      createdAtMs: now,
    };
    entriesById.set(entry.entryId, entry);
    dedupeKeys.add(dedupeKey);
    await enqueueWrite(persistNow);
    return true;
  }

  /**
   * The delivery work queue: one flattened item per (pending entry, active
   * subscription) whose backoff has elapsed. Suspended and revoked
   * subscriptions are frozen — their records wait for a resume.
   *
   * @param {{now: number}} input
   * @returns {{entry: StoredWebhookOutboxEntry, subscription: StoredWebhookSubscription, delivery: StoredWebhookDeliveryState}[]}
   */
  function listDueDeliveries(input) {
    ensureLoaded();
    const now = input.now;
    /** @type {{entry: StoredWebhookOutboxEntry, subscription: StoredWebhookSubscription, delivery: StoredWebhookDeliveryState}[]} */
    const due = [];
    for (const entry of entriesById.values()) {
      for (const delivery of entry.deliveries) {
        if (delivery.deliveredAtMs !== null) continue;
        if (delivery.nextAttemptAtMs > now) continue;
        const subscription = subscriptionsById.get(delivery.subscriptionId);
        if (!subscription || subscription.status !== "active") continue;
        due.push({ entry, subscription, delivery });
      }
    }
    return due;
  }

  /**
   * Pending deliveries of one subscription that have been failing for longer
   * than the give-up window — the suspension trigger. The projection carries
   * the endpoint host only (never the full URL, whose path may hold private
   * material) for the Owner notice.
   *
   * @param {{now: number, giveUpMs: number}} input
   * @returns {{subscriptionId: string, organizerId: string, endpointHost: string}[]}
   */
  function listSuspendableSubscriptions(input) {
    ensureLoaded();
    const now = input.now;
    const giveUpMs = Math.max(0, input.giveUpMs);
    /** @type {Map<string, StoredWebhookSubscription>} */
    const suspendable = new Map();
    for (const entry of entriesById.values()) {
      for (const delivery of entry.deliveries) {
        if (delivery.deliveredAtMs !== null) continue;
        if (!delivery.firstAttemptAtMs) continue;
        if (delivery.firstAttemptAtMs + giveUpMs > now) continue;
        const subscription = subscriptionsById.get(delivery.subscriptionId);
        if (!subscription || subscription.status !== "active") continue;
        suspendable.set(subscription.subscriptionId, subscription);
      }
    }
    return [...suspendable.values()].map((subscription) => ({
      subscriptionId: subscription.subscriptionId,
      organizerId: subscription.organizerId,
      endpointHost: safeHost(subscription.url),
    }));
  }

  /**
   * @param {string} url
   * @returns {string}
   */
  function safeHost(url) {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  }

  /**
   * Marks one per-subscription delivery as delivered. A racing revoke or a
   * vanished record is a no-op.
   *
   * @param {{entryId: string, subscriptionId: string}} input
   * @returns {Promise<void>}
   */
  async function recordDeliverySuccess(input) {
    ensureLoaded();
    const entry = entriesById.get(String(input.entryId || ""));
    const delivery = entry?.deliveries.find(
      (candidate) => candidate.subscriptionId === input.subscriptionId,
    );
    if (!entry || !delivery || delivery.deliveredAtMs !== null) return;
    delivery.deliveredAtMs = clock();
    delivery.lastError = null;
    await enqueueWrite(persistNow);
  }

  /**
   * Records one failed delivery attempt with its next backoff. The failure
   * detail is bounded and never carries the URL or signing material.
   *
   * @param {{entryId: string, subscriptionId: string, statusCode?: number | null, error?: string | null, nextAttemptAtMs: number}} input
   * @returns {Promise<void>}
   */
  async function recordDeliveryFailure(input) {
    ensureLoaded();
    const entry = entriesById.get(String(input.entryId || ""));
    const delivery = entry?.deliveries.find(
      (candidate) => candidate.subscriptionId === input.subscriptionId,
    );
    if (!entry || !delivery || delivery.deliveredAtMs !== null) return;
    delivery.attempts += 1;
    delivery.firstAttemptAtMs ??= clock();
    delivery.lastAttemptAtMs = clock();
    delivery.lastStatusCode = input.statusCode ?? null;
    delivery.lastError = String(input.error || "")
      .slice(0, MAX_LAST_ERROR_LENGTH)
      .replace(/\s+/g, " ")
      .trim();
    delivery.nextAttemptAtMs = input.nextAttemptAtMs;
    await enqueueWrite(persistNow);
  }

  /**
   * Shrinks fully-delivered outbox entries older than the retention window
   * to idempotency tombstones: the dedupe key and stable event id stay, the
   * payload and per-subscription delivery state go. Pruning bounds the
   * outbox file without ever allowing a delivered logical event to re-enqueue.
   *
   * @param {{now: number, retentionMs?: number}} input
   * @returns {Promise<number>} the number of entries tombstoned
   */
  async function pruneDeliveredEntries(input) {
    ensureLoaded();
    const retentionMs =
      typeof input.retentionMs === "number" && input.retentionMs > 0
        ? input.retentionMs
        : DELIVERED_ENTRY_RETENTION_MS;
    const now = input.now;
    let pruned = 0;
    for (const entry of entriesById.values()) {
      if (entry.payload === null) continue;
      const fullyDelivered =
        entry.deliveries.length > 0 &&
        entry.deliveries.every((delivery) => delivery.deliveredAtMs !== null);
      if (!fullyDelivered || entry.createdAtMs + retentionMs > now) continue;
      entry.payload = /** @type {Record<string, unknown>} */ ({});
      entry.deliveries = [];
      entry.deliveredAtMs = now;
      pruned += 1;
    }
    if (pruned > 0) await enqueueWrite(persistNow);
    return pruned;
  }

  /**
   * Resolves once every scheduled write has landed on disk.
   *
   * @returns {Promise<void>}
   */
  async function flush() {
    ensureLoaded();
    await writeQueue;
  }

  return {
    createSubscription,
    rotateSubscriptionSecret,
    revokeSubscription,
    resumeSubscription,
    suspendSubscription,
    listSubscriptionsForOrganizer,
    enqueueIfAbsent,
    listDueDeliveries,
    listSuspendableSubscriptions,
    recordDeliverySuccess,
    recordDeliveryFailure,
    pruneDeliveredEntries,
    flush,
  };
}

export { createFileWebhookStore, isValidWebhookUrl, WEBHOOK_SECRET_PREFIX };
