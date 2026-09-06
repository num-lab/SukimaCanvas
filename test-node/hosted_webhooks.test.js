const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const {
  createFileWebhookStore,
  isValidWebhookUrl,
} = require("../server/hosted_event/webhooks/store.mjs");
const {
  createWebhookPipeline,
  WEBHOOK_EVENT_KINDS,
} = require("../server/hosted_event/webhooks/pipeline.mjs");
const {
  createFileOrganizerStore,
} = require("../server/hosted_event/organizers/store.mjs");
const {
  createFileAccountStore,
} = require("../server/hosted_event/accounts/store.mjs");
const {
  createFileEventMembershipStore,
} = require("../server/hosted_event/memberships/store.mjs");
const {
  createFileNotificationStore,
} = require("../server/hosted_event/notifications/store.mjs");
const {
  createNotificationService,
} = require("../server/hosted_event/notifications/service.mjs");
const {
  createFileBoardArchiveStore,
} = require("../server/hosted_event/archive/store.mjs");
const {
  createHostedServer,
  requestWithCookies,
  formValue,
  cookiePair,
  verifyAccount,
  registerAccount,
  loginSession,
  STRONG_PASSWORD,
} = require("./helpers/hosted_http.js");
const { closeServer } = require("./test_helpers.js");
const {
  createDefaultStoredSvgEnvelope,
  serializeStoredSvgEnvelope,
} = require("../server/persistence/svg_envelope.mjs");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const RETRY_BASE_MS = 50;
const GIVE_UP_MS = 200;

const PRODUCTION_CONFIG = require("../server/configuration.mjs");

/**
 * A controlled webhook receiver: records every request and lets each test
 * script the response (status, garbage bodies, connection aborts).
 */
async function createReceiver() {
  /** @type {{url: string, headers: import("http").IncomingHttpHeaders, body: string}[]} */
  const received = [];
  let respond = (/** @type {import("http").ServerResponse} */ res) => {
    res.statusCode = 200;
    res.end("ok");
  };
  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        url: req.url || "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      try {
        respond(res);
      } catch {
        res.destroy();
      }
    });
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = /** @type {import("net").AddressInfo} */ (
    /** @type {any} */ (server.address())
  );
  return {
    received,
    responder: (
      /** @type {(res: import("http").ServerResponse) => void} */ next,
    ) => {
      respond = next;
    },
    endpoint: (/** @type {string} */ suffix = "") =>
      `http://127.0.0.1:${address.port}/${suffix}`,
    close: () =>
      /** @type {Promise<void>} */ (
        new Promise((resolve) => {
          server.close(() => resolve());
        })
      ),
  };
}

/**
 * Verifies the signature header of a recorded delivery against a secret.
 * @param {string} secret
 * @param {string} body
 * @param {string | undefined} header
 */
function signatureMatches(secret, body, header) {
  if (typeof header !== "string") return false;
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!match) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${match[1]}.${body}`)
    .digest("hex");
  return expected === match[2];
}

/**
 * Composes the webhook surface over a temp data directory with a controllable
 * clock, an owner-seeded organizer, and a spy-mail notification service.
 */
/**
 * @param {number} now
 */
async function createWebhookFixture(now) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-webhook-"));
  const holder = { now };
  const clock = () => holder.now;
  const accountStore = createFileAccountStore({
    dataDir,
    clock,
    sessionMaxAgeMs: DAY,
    sessionIdleMs: DAY,
  });
  const organizerStore = createFileOrganizerStore({ dataDir, clock });
  const membershipStore = createFileEventMembershipStore({ dataDir, clock });
  const notificationStore = createFileNotificationStore({ dataDir, clock });
  /** @type {{sent: {to: string, subject: string, body: string}[]}} */
  const sentMail = { sent: [] };
  const notifications = createNotificationService({
    store: notificationStore,
    mail: {
      async send(message) {
        sentMail.sent.push({
          to: message.to,
          subject: message.subject,
          body: message.body,
        });
      },
    },
    accountStore,
    organizerStore,
    membershipStore,
    config: {
      ...PRODUCTION_CONFIG,
      HOSTED_MAIL_RETRY_MS: RETRY_BASE_MS,
      HOSTED_NOTICE_UPCOMING_WINDOW_MS: 24 * HOUR,
      HOSTED_SERVICE_UTC_OFFSET_MINUTES: 480,
    },
    clock,
  });
  const webhookStore = createFileWebhookStore({
    dataDir,
    clock,
    allowInsecureHttp: true,
  });
  const webhookPipeline = createWebhookPipeline({
    webhookStore,
    organizerStore,
    notificationService: notifications,
    config: {
      ...PRODUCTION_CONFIG,
      HOSTED_WEBHOOK_RETRY_MS: RETRY_BASE_MS,
      HOSTED_WEBHOOK_GIVE_UP_MS: GIVE_UP_MS,
    },
    clock,
  });

  const owner = await accountStore.createAccount({
    email: "webhook-owner@example.com",
    passwordHash: "test-hash",
  });
  await accountStore.markAccountVerified(owner.accountId, 0);
  const application = await organizerStore.submitApplication({
    accountId: owner.accountId,
    organizerName: "Webhook Collective",
    contactName: "Mika Rin",
    contactEmail: "owner@example.com",
  });
  assert.ok(application.ok);
  const approved = await organizerStore.approveApplication({
    applicationId: application.application.applicationId,
    operatorAccountId: "seed-operator",
  });
  assert.ok(approved.ok);
  const organizerId = /** @type {string} */ (approved.organizerId);

  return {
    holder,
    dataDir,
    clock,
    accountStore,
    organizerStore,
    membershipStore,
    notificationStore,
    sentMail,
    notifications,
    webhookStore,
    webhookPipeline,
    owner,
    ownerAccountId: owner.accountId,
    organizerId,
  };
}

/**
 * Seeds a second organizer owned by a different account — the scope-isolation
 * counterpart.
 */
/**
 * @param {any} fixture
 * @param {string} email
 */
async function seedSecondOrganizer(fixture, email) {
  const account = await fixture.accountStore.createAccount({
    email,
    passwordHash: "test-hash",
  });
  await fixture.accountStore.markAccountVerified(account.accountId, 0);
  const application = await fixture.organizerStore.submitApplication({
    accountId: account.accountId,
    organizerName: "Rival Collective",
    contactName: "Rival",
    contactEmail: email,
  });
  assert.ok(application.ok);
  const approved = await fixture.organizerStore.approveApplication({
    applicationId: application.application.applicationId,
    operatorAccountId: "seed-operator",
  });
  assert.ok(approved.ok);
  return {
    accountId: account.accountId,
    organizerId: /** @type {string} */ (approved.organizerId),
  };
}

/**
 * Creates an approved event with a sealed Board Session behind a real
 * Private Board Archive, exactly the state the close pipeline leaves.
 */
/**
 * @param {any} fixture
 * @param {{eventName: string, organizerId: string, actorAccountId: string}} options
 */
async function seedSealedSession(
  fixture,
  { eventName, organizerId, actorAccountId },
) {
  const { organizerStore, holder } = fixture;
  const created = await organizerStore.createReservation({
    organizerId,
    createdByAccountId: actorAccountId,
    eventName,
    visibility: "unlisted",
    startsAtMs: holder.now + HOUR,
    endsAtMs: holder.now + 2 * HOUR,
    requestedSeats: 2,
  });
  assert.ok(created.ok);
  await organizerStore.submitReservation({
    reservationId: created.reservation.reservationId,
    actorAccountId,
    now: holder.now,
  });
  const approvedReservation = await organizerStore.approveReservation({
    reservationId: created.reservation.reservationId,
    operatorAccountId: "seed-operator",
    now: holder.now,
    bufferMs: 15 * MINUTE,
    sessionLimit: 20,
    seatLimit: 1000,
  });
  assert.ok(approvedReservation.ok);
  const event = organizerStore.getEventById(
    /** @type {string} */ (approvedReservation.eventId),
  );
  assert.ok(event);
  const session = organizerStore.getBoardSessionForEvent(event.eventId);
  assert.ok(session);
  await organizerStore.advanceLifecycle({ now: session.startsAtMs });
  await organizerStore.advanceLifecycle({ now: session.endsAtMs + MINUTE });
  const archiveStore = createFileBoardArchiveStore({
    dataDir: fixture.dataDir,
  });
  const envelope = createDefaultStoredSvgEnvelope({ readonly: false }, 1);
  const canvas = serializeStoredSvgEnvelope(
    envelope.prefix,
    [],
    envelope.suffix,
  );
  const keyPrefix = `board-archives/${session.boardSessionId}`;
  await archiveStore.putArchive(`${keyPrefix}/canvas.svg`, canvas);
  await archiveStore.putArchive(`${keyPrefix}/manifest.json`, "{}");
  const sealed = await organizerStore.markBoardSessionClosed({
    boardSessionId: session.boardSessionId,
    archiveKey: `${keyPrefix}/manifest.json`,
    finalSeq: 1,
    archivedAtMs: holder.now,
  });
  assert.ok(sealed.ok);
  await organizerStore.flush();
  return { event, session };
}

test("the webhook store keeps the signing secret off every list projection and refuses invalid URLs", async () => {
  const fixture = await createWebhookFixture(1_000_000);
  try {
    for (const bad of [
      "not a url",
      "ftp://example.com/hook",
      "https://user:pass@example.com/hook",
    ]) {
      const refused = await fixture.webhookStore.createSubscription({
        organizerId: fixture.organizerId,
        url: bad,
        actorAccountId: fixture.ownerAccountId,
      });
      assert.equal(refused.ok, false, `expected refusal: ${bad}`);
      assert.equal(refused.reason, "invalid_url");
    }

    const created = await fixture.webhookStore.createSubscription({
      organizerId: fixture.organizerId,
      url: "https://hooks.example.com/sukima",
      actorAccountId: fixture.ownerAccountId,
    });
    assert.equal(created.ok, true);
    assert.ok(created.secret.startsWith("whsec_"));

    const listed = fixture.webhookStore.listSubscriptionsForOrganizer(
      fixture.organizerId,
    );
    assert.equal(listed.length, 1);
    assert.ok(listed[0]);
    assert.equal(
      listed[0].secret,
      "",
      "the projection never carries the secret",
    );
    assert.equal(listed[0].url, "https://hooks.example.com/sukima");

    // HTTP is a development-only convenience: the test composition allows it,
    // a production-shaped one refuses it.
    assert.equal(isValidWebhookUrl("http://127.0.0.1/hook"), false);
    assert.equal(
      isValidWebhookUrl("http://127.0.0.1/hook", { allowInsecureHttp: true }),
      true,
    );
  } finally {
    await fixture.webhookStore.flush();
  }
});

test("the subscription state machine refuses out-of-order transitions", async () => {
  const fixture = await createWebhookFixture(1_000_000);
  try {
    const created = await fixture.webhookStore.createSubscription({
      organizerId: fixture.organizerId,
      url: "https://hooks.example.com/sukima",
      actorAccountId: fixture.ownerAccountId,
    });
    assert.equal(created.ok, true);

    // Resume before any suspension is refused.
    const bogusResume = await fixture.webhookStore.resumeSubscription({
      organizerId: fixture.organizerId,
      subscriptionId: created.subscription.subscriptionId,
    });
    assert.equal(bogusResume.ok, false);
    assert.equal(bogusResume.reason, "not_suspended");

    // Rotation reveals a fresh secret each time.
    const rotated = await fixture.webhookStore.rotateSubscriptionSecret({
      organizerId: fixture.organizerId,
      subscriptionId: created.subscription.subscriptionId,
    });
    assert.equal(rotated.ok, true);
    assert.ok(rotated.secret.startsWith("whsec_"));

    // A suspended subscription can still rotate: a leaked secret must be
    // replaceable without resuming deliveries first.
    await fixture.webhookStore.suspendSubscription({
      subscriptionId: created.subscription.subscriptionId,
    });
    const rotatedSuspended =
      await fixture.webhookStore.rotateSubscriptionSecret({
        organizerId: fixture.organizerId,
        subscriptionId: created.subscription.subscriptionId,
      });
    assert.equal(rotatedSuspended.ok, true);
    assert.ok(rotatedSuspended.secret.startsWith("whsec_"));
    const stillSuspended = fixture.webhookStore
      .listSubscriptionsForOrganizer(fixture.organizerId)
      .find((subscription) => subscription.status === "suspended");
    assert.ok(stillSuspended, "rotation does not resume the subscription");

    // A foreign organizer cannot see or touch the subscription.
    const foreign = await seedSecondOrganizer(fixture, "rival@example.com");
    const foreignRotate = await fixture.webhookStore.rotateSubscriptionSecret({
      organizerId: foreign.organizerId,
      subscriptionId: created.subscription.subscriptionId,
    });
    assert.equal(foreignRotate.ok, false);
    assert.equal(foreignRotate.reason, "not_found");

    // Revocation is terminal.
    const revoked = await fixture.webhookStore.revokeSubscription({
      organizerId: fixture.organizerId,
      subscriptionId: created.subscription.subscriptionId,
    });
    assert.equal(revoked.ok, true);
    const rotateAfter = await fixture.webhookStore.rotateSubscriptionSecret({
      organizerId: fixture.organizerId,
      subscriptionId: created.subscription.subscriptionId,
    });
    assert.equal(rotateAfter.ok, false);
    assert.equal(rotateAfter.reason, "not_active");
  } finally {
    await fixture.webhookStore.flush();
  }
});

test("outbox enqueue is idempotent on the dedupe key", async () => {
  const fixture = await createWebhookFixture(1_000_000);
  try {
    await fixture.webhookStore.createSubscription({
      organizerId: fixture.organizerId,
      url: "https://hooks.example.com/sukima",
      actorAccountId: fixture.ownerAccountId,
    });
    const first = await fixture.webhookStore.enqueueIfAbsent({
      kind: WEBHOOK_EVENT_KINDS.EVENT_OPENED,
      organizerId: fixture.organizerId,
      eventId: "event-1",
      boardSessionId: "session-1",
      dedupeKey: `event.opened:session-1`,
      payload: { eventPublicId: "pub1" },
    });
    assert.equal(first, true);
    const duplicate = await fixture.webhookStore.enqueueIfAbsent({
      kind: WEBHOOK_EVENT_KINDS.EVENT_OPENED,
      organizerId: fixture.organizerId,
      eventId: "event-1",
      boardSessionId: "session-1",
      dedupeKey: `event.opened:session-1`,
      payload: { eventPublicId: "pub1" },
    });
    assert.equal(duplicate, false);
    const otherKind = await fixture.webhookStore.enqueueIfAbsent({
      kind: WEBHOOK_EVENT_KINDS.ARCHIVE_READY,
      organizerId: fixture.organizerId,
      eventId: "event-1",
      boardSessionId: "session-1",
      dedupeKey: `archive.ready:session-1`,
      payload: { eventPublicId: "pub1" },
    });
    assert.equal(otherKind, true);
    assert.equal(
      fixture.webhookStore.listDueDeliveries({ now: 1_000_000 }).length,
      2,
    );
  } finally {
    await fixture.webhookStore.flush();
  }
});

test("signed deliveries reach the receiver with verifiable signatures and public-only payloads", async () => {
  const fixture = await createWebhookFixture(1_000_000);
  const receiver = await createReceiver();
  try {
    const created = await fixture.webhookStore.createSubscription({
      organizerId: fixture.organizerId,
      url: receiver.endpoint("lifecycle"),
      actorAccountId: fixture.ownerAccountId,
    });
    assert.equal(created.ok, true);
    const secret = created.secret;
    await seedSealedSession(fixture, {
      eventName: "Signed Jam",
      organizerId: fixture.organizerId,
      actorAccountId: fixture.ownerAccountId,
    });

    await fixture.webhookPipeline.deriveLifecycleEvents({
      now: fixture.holder.now,
    });
    const pass = await fixture.webhookPipeline.runDueDeliveries({
      now: fixture.holder.now,
    });
    assert.ok(
      pass.delivered >= 3,
      "opened, closed, and archive.ready delivered",
    );
    assert.equal(pass.failed, 0);

    // Three logical events, each delivered once.
    assert.equal(receiver.received.length, 3);
    const kinds = new Set(
      receiver.received.map((item) => item.headers["x-sukimacanvas-event"]),
    );
    assert.deepEqual([...kinds].sort(), [
      "archive.ready",
      "event.closed",
      "event.opened",
    ]);

    for (const delivery of receiver.received) {
      assert.equal(delivery.url, "/lifecycle");
      const parsed = JSON.parse(delivery.body);
      assert.ok(typeof parsed.id === "string" && parsed.id.length > 0);
      assert.ok(typeof parsed.createdAtMs === "number");
      assert.ok(
        signatureMatches(
          secret,
          delivery.body,
          /** @type {string | undefined} */ (
            delivery.headers["x-sukimacanvas-signature"]
          ),
        ),
        "the signature verifies with the subscription secret",
      );
      // Payload hygiene: public identifiers only, in a stable shape.
      assert.deepEqual(Object.keys(parsed).sort(), [
        "createdAtMs",
        "data",
        "id",
        "type",
      ]);
      if (parsed.type === "event.opened") {
        assert.deepEqual(Object.keys(parsed.data).sort(), [
          "endsAtMs",
          "eventName",
          "eventPublicId",
          "occurredAtMs",
          "startsAtMs",
        ]);
      } else {
        assert.deepEqual(Object.keys(parsed.data).sort(), [
          "eventName",
          "eventPublicId",
          "occurredAtMs",
        ]);
      }
      assert.ok(!delivery.body.includes("example.com"), "no account emails");
      assert.ok(!delivery.body.includes("access"), "no access-code material");
      assert.ok(!delivery.body.includes("board-archives"), "no object keys");
    }

    // Idempotence: repeated derivation and delivery passes enqueue nothing
    // and re-send nothing.
    await fixture.webhookPipeline.deriveLifecycleEvents({
      now: fixture.holder.now,
    });
    await fixture.webhookPipeline.runDueDeliveries({ now: fixture.holder.now });
    assert.equal(receiver.received.length, 3);
  } finally {
    await receiver.close();
    await fixture.webhookStore.flush();
  }
});

test("failed deliveries retry with backoff and then deliver", async () => {
  const fixture = await createWebhookFixture(1_000_000);
  const receiver = await createReceiver();
  try {
    await fixture.webhookStore.createSubscription({
      organizerId: fixture.organizerId,
      url: receiver.endpoint(),
      actorAccountId: fixture.ownerAccountId,
    });
    await seedSealedSession(fixture, {
      eventName: "Retry Jam",
      organizerId: fixture.organizerId,
      actorAccountId: fixture.ownerAccountId,
    });
    await fixture.webhookPipeline.deriveLifecycleEvents({
      now: fixture.holder.now,
    });

    // Every attempt fails for now.
    receiver.responder((res) => {
      res.statusCode = 500;
      res.end("boom");
    });
    const firstPass = await fixture.webhookPipeline.runDueDeliveries({
      now: fixture.holder.now,
    });
    assert.equal(firstPass.failed, 3);
    assert.equal(firstPass.delivered, 0);
    assert.equal(receiver.received.length, 3);

    // Inside the backoff nothing is attempted again.
    const earlyPass = await fixture.webhookPipeline.runDueDeliveries({
      now: fixture.holder.now + RETRY_BASE_MS - 1,
    });
    assert.equal(earlyPass.failed, 0);
    assert.equal(receiver.received.length, 3);

    // After the backoff, with the receiver healthy, everything delivers.
    receiver.responder((res) => {
      res.statusCode = 200;
      res.end("ok");
    });
    const laterPass = await fixture.webhookPipeline.runDueDeliveries({
      now: fixture.holder.now + RETRY_BASE_MS,
    });
    assert.equal(laterPass.delivered, 3);
    assert.equal(receiver.received.length, 6);
  } finally {
    await receiver.close();
    await fixture.webhookStore.flush();
  }
});

test("24 hours of failures suspend the subscription, notify the Owner, and freeze records; resume delivers them", async () => {
  const fixture = await createWebhookFixture(1_000_000);
  const receiver = await createReceiver();
  try {
    await fixture.webhookStore.createSubscription({
      organizerId: fixture.organizerId,
      url: receiver.endpoint(),
      actorAccountId: fixture.ownerAccountId,
    });
    await seedSealedSession(fixture, {
      eventName: "Suspend Jam",
      organizerId: fixture.organizerId,
      actorAccountId: fixture.ownerAccountId,
    });
    await fixture.webhookPipeline.deriveLifecycleEvents({
      now: fixture.holder.now,
    });
    receiver.responder((res) => {
      res.statusCode = 500;
      res.end();
    });
    await fixture.webhookPipeline.runDueDeliveries({ now: fixture.holder.now });

    // Cross the give-up window with the receiver still failing.
    fixture.holder.now += GIVE_UP_MS + RETRY_BASE_MS;
    const pass = await fixture.webhookPipeline.runDueDeliveries({
      now: fixture.holder.now,
    });
    assert.ok(pass.suspended >= 1, "the subscription was suspended");
    const listed = fixture.webhookStore.listSubscriptionsForOrganizer(
      fixture.organizerId,
    );
    assert.ok(listed[0]);
    assert.equal(listed[0].status, "suspended");

    // The Owner received the suspension notice.
    assert.ok(
      fixture.sentMail.sent.some(
        (message) =>
          message.to === "webhook-owner@example.com" &&
          message.subject.includes("Webhook"),
      ),
      "the Organizer Owner was notified",
    );

    // The queued records are frozen, not lost: still pending, not delivering.
    const frozenPass = await fixture.webhookPipeline.runDueDeliveries({
      now: fixture.holder.now,
    });
    assert.equal(frozenPass.delivered, 0);
    const before = receiver.received.length;

    // Fixing the endpoint and resuming delivers the frozen records.
    receiver.responder((res) => {
      res.statusCode = 200;
      res.end("ok");
    });
    const resumed = await fixture.webhookStore.resumeSubscription({
      organizerId: fixture.organizerId,
      subscriptionId: listed[0].subscriptionId,
    });
    assert.equal(resumed.ok, true);
    // Clear the last attempt's backoff before the resume pass.
    fixture.holder.now += 60 * MINUTE;
    const resumedPass = await fixture.webhookPipeline.runDueDeliveries({
      now: fixture.holder.now,
    });
    assert.ok(resumedPass.delivered >= 3);
    assert.ok(receiver.received.length > before, "frozen records delivered");
  } finally {
    await receiver.close();
    await fixture.webhookStore.flush();
  }
});

test("a restart recomposes from the durable state without duplicating events", async () => {
  const fixture = await createWebhookFixture(1_000_000);
  const receiver = await createReceiver();
  try {
    await fixture.webhookStore.createSubscription({
      organizerId: fixture.organizerId,
      url: receiver.endpoint(),
      actorAccountId: fixture.ownerAccountId,
    });
    await seedSealedSession(fixture, {
      eventName: "Restart Jam",
      organizerId: fixture.organizerId,
      actorAccountId: fixture.ownerAccountId,
    });
    await fixture.webhookPipeline.deriveLifecycleEvents({
      now: fixture.holder.now,
    });
    await fixture.webhookPipeline.runDueDeliveries({ now: fixture.holder.now });
    const before = receiver.received.length;
    assert.ok(before >= 3);

    // A fresh composition over the same data directory: nothing in memory
    // survives, so the durable dedupe keys are the only guard.
    fixture.holder.now += 1;
    const restartedStore = createFileWebhookStore({
      dataDir: fixture.dataDir,
      clock: () => fixture.holder.now,
      allowInsecureHttp: true,
    });
    const restartedPipeline = createWebhookPipeline({
      webhookStore: restartedStore,
      organizerStore: fixture.organizerStore,
      notificationService: fixture.notifications,
      config: {
        ...PRODUCTION_CONFIG,
        HOSTED_WEBHOOK_RETRY_MS: RETRY_BASE_MS,
        HOSTED_WEBHOOK_GIVE_UP_MS: GIVE_UP_MS,
      },
      clock: () => fixture.holder.now,
    });
    await restartedPipeline.deriveLifecycleEvents({ now: fixture.holder.now });
    await restartedPipeline.runDueDeliveries({ now: fixture.holder.now });
    assert.equal(
      receiver.received.length,
      before,
      "the restart enqueued and delivered nothing new",
    );
  } finally {
    await receiver.close();
    await fixture.webhookStore.flush();
  }
});

test("webhooks are organizer-scoped: another organizer's events never reach foreign endpoints", async () => {
  const fixture = await createWebhookFixture(1_000_000);
  const receiverA = await createReceiver();
  const receiverB = await createReceiver();
  try {
    await fixture.webhookStore.createSubscription({
      organizerId: fixture.organizerId,
      url: receiverA.endpoint(),
      actorAccountId: fixture.ownerAccountId,
    });
    const rival = await seedSecondOrganizer(fixture, "rival-owner@example.com");
    await fixture.webhookStore.createSubscription({
      organizerId: rival.organizerId,
      url: receiverB.endpoint(),
      actorAccountId: rival.accountId,
    });
    await seedSealedSession(fixture, {
      eventName: "Scoped Jam",
      organizerId: fixture.organizerId,
      actorAccountId: fixture.ownerAccountId,
    });
    await fixture.webhookPipeline.deriveLifecycleEvents({
      now: fixture.holder.now,
    });
    await fixture.webhookPipeline.runDueDeliveries({ now: fixture.holder.now });
    assert.ok(
      receiverA.received.length >= 3,
      "organizer A receives its events",
    );
    assert.equal(
      receiverB.received.length,
      0,
      "organizer B receives nothing of organizer A",
    );
  } finally {
    await receiverA.close();
    await receiverB.close();
    await fixture.webhookStore.flush();
  }
});

test("rotating the secret invalidates the previous signing material immediately", async () => {
  const fixture = await createWebhookFixture(1_000_000);
  const receiver = await createReceiver();
  try {
    const created = await fixture.webhookStore.createSubscription({
      organizerId: fixture.organizerId,
      url: receiver.endpoint(),
      actorAccountId: fixture.ownerAccountId,
    });
    assert.ok(created.ok);
    const oldSecret = created.secret;
    const subscriptionId = created.subscription.subscriptionId;
    await seedSealedSession(fixture, {
      eventName: "Rotate Jam",
      organizerId: fixture.organizerId,
      actorAccountId: fixture.ownerAccountId,
    });
    const rotated = await fixture.webhookStore.rotateSubscriptionSecret({
      organizerId: fixture.organizerId,
      subscriptionId,
    });
    assert.ok(rotated.ok);
    const newSecret = rotated.secret;
    await fixture.webhookPipeline.deriveLifecycleEvents({
      now: fixture.holder.now,
    });
    await fixture.webhookPipeline.runDueDeliveries({ now: fixture.holder.now });
    assert.ok(receiver.received.length >= 3);
    for (const delivery of receiver.received) {
      const signature = /** @type {string | undefined} */ (
        delivery.headers["x-sukimacanvas-signature"]
      );
      assert.equal(
        signatureMatches(oldSecret, delivery.body, signature),
        false,
        "the old secret no longer verifies",
      );
      assert.equal(
        signatureMatches(newSecret, delivery.body, signature),
        true,
        "the new secret verifies",
      );
    }
  } finally {
    await receiver.close();
    await fixture.webhookStore.flush();
  }
});

test("hostile endpoints and duplicate deliveries never crash the worker", async () => {
  const fixture = await createWebhookFixture(1_000_000);
  const receiver = await createReceiver();
  try {
    await fixture.webhookStore.createSubscription({
      organizerId: fixture.organizerId,
      url: receiver.endpoint(),
      actorAccountId: fixture.ownerAccountId,
    });
    await seedSealedSession(fixture, {
      eventName: "Hostile Jam",
      organizerId: fixture.organizerId,
      actorAccountId: fixture.ownerAccountId,
    });
    await fixture.webhookStore.enqueueIfAbsent({
      kind: "archive.ready",
      organizerId: fixture.organizerId,
      eventId: "extra-event",
      boardSessionId: "extra-session",
      dedupeKey: "archive.ready:extra-session",
      payload: { eventPublicId: "pub-x" },
    });

    // The receiver answers with an enormous failure body, a truncated
    // garbage failure, and finally destroys the connection without
    // responding. None of these may crash the pass or parse anything.
    let call = 0;
    receiver.responder((res) => {
      call += 1;
      if (call % 3 === 1) {
        res.statusCode = 500;
        res.end(Buffer.alloc(5 * 1024 * 1024, "x").toString("latin1"));
      } else if (call % 3 === 2) {
        res.statusCode = 500;
        res.end('{"not":"even","close":');
      } else {
        res.destroy();
      }
    });
    const firstPass = await fixture.webhookPipeline.runDueDeliveries({
      now: fixture.holder.now,
    });
    assert.equal(firstPass.delivered, 0);
    assert.ok(firstPass.failed > 0);

    // The worker is alive: with a healthy receiver everything delivers.
    receiver.responder((res) => {
      res.statusCode = 204;
      res.end();
    });
    fixture.holder.now += RETRY_BASE_MS;
    const secondPass = await fixture.webhookPipeline.runDueDeliveries({
      now: fixture.holder.now,
    });
    assert.ok(secondPass.delivered > 0);
  } finally {
    await receiver.close();
    await fixture.webhookStore.flush();
  }
});

test("the organizer console manages webhooks Owner-only with the secret revealed exactly once", async () => {
  const holder = { now: Date.now() };
  const server = await createHostedServer({
    HOSTED_CLOCK: () => holder.now,
    HOSTED_SESSION_MAX_AGE_MS: 400 * DAY,
    HOSTED_SESSION_IDLE_TIMEOUT_MS: 400 * DAY,
  });
  try {
    const password = STRONG_PASSWORD;
    const ownerEmail = "webhook-console-owner@example.com";
    await registerAccount(server.app, ownerEmail, password);
    await verifyAccount(server.app, server.outboxDir, ownerEmail);
    const owner = await loginSession(server.app, ownerEmail, password);
    const dataDir = path.join(server.root, "hosted-data");
    const accountStore = createFileAccountStore({
      dataDir,
      clock: () => holder.now,
      sessionMaxAgeMs: DAY,
      sessionIdleMs: DAY,
    });
    const ownerAccount = accountStore.getAccountByEmail(ownerEmail);
    assert.ok(ownerAccount);
    const organizerStore = createFileOrganizerStore({
      dataDir,
      clock: () => holder.now,
    });
    const application = await organizerStore.submitApplication({
      accountId: ownerAccount.accountId,
      organizerName: "Console Collective",
      contactName: "Mika Rin",
      contactEmail: ownerEmail,
    });
    assert.ok(application.ok);
    const approved = await organizerStore.approveApplication({
      applicationId: application.application.applicationId,
      operatorAccountId: "seed-operator",
    });
    assert.ok(approved.ok);
    const organizerId = /** @type {string} */ (approved.organizerId);
    const managePath = `/organizers/${organizerId}?lang=en`;

    const page = await requestWithCookies(server.app, managePath, {
      cookie: owner.sessionCookie,
    });
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes("Webhook subscriptions"));

    // Creating a subscription reveals the signing secret exactly once.
    const securityPage = await requestWithCookies(server.app, managePath, {
      cookie: owner.sessionCookie,
    });
    const csrfToken = formValue(securityPage.body, "_csrf");
    const cookies = `${owner.sessionCookie}; ${cookiePair(securityPage.setCookie, "hosted-csrf-v1")}`;
    const created = await requestWithCookies(
      server.app,
      `/organizers/${organizerId}/webhooks`,
      {
        method: "POST",
        cookie: cookies,
        body: new URLSearchParams({
          _csrf: csrfToken,
          url: "https://hooks.example.com/console",
        }).toString(),
      },
    );
    assert.equal(created.statusCode, 200);
    const revealMatch = /whsec_[A-Za-z0-9_-]+/.exec(created.body);
    assert.ok(
      revealMatch,
      "the secret is revealed once on the create response",
    );

    // The secret never renders again.
    const afterPage = await requestWithCookies(server.app, managePath, {
      cookie: owner.sessionCookie,
    });
    assert.equal(afterPage.statusCode, 200);
    assert.equal(
      /whsec_[A-Za-z0-9_-]+/.exec(afterPage.body),
      null,
      "the secret is not rendered after the create response",
    );
    assert.ok(afterPage.body.includes("https://hooks.example.com/console"));
    const subscriptionMatch =
      /organizers\/[A-Za-z0-9-]+\/webhooks\/([A-Za-z0-9-]+)\/rotate/.exec(
        afterPage.body,
      );
    assert.ok(subscriptionMatch, "the subscription renders with its actions");
    const subscriptionId = subscriptionMatch[1];

    // An invalid URL is refused deterministically.
    const invalid = await requestWithCookies(
      server.app,
      `/organizers/${organizerId}/webhooks`,
      {
        method: "POST",
        cookie: cookies,
        body: new URLSearchParams({
          _csrf: csrfToken,
          url: "not a url",
        }).toString(),
      },
    );
    assert.equal(invalid.statusCode, 400);

    // CSRF is enforced.
    const noCsrf = await requestWithCookies(
      server.app,
      `/organizers/${organizerId}/webhooks`,
      { method: "POST", cookie: cookies, body: "url=https://x.example/hook" },
    );
    assert.equal(noCsrf.statusCode, 403);

    // An Organizer Admin is refused: only the Owner touches webhooks. The
    // membership is established through the real console flow so the running
    // server's own store observes it.
    const adminEmail = "webhook-console-admin@example.com";
    await registerAccount(server.app, adminEmail, password);
    await verifyAccount(server.app, server.outboxDir, adminEmail);
    const invited = await requestWithCookies(
      server.app,
      `/organizers/${organizerId}/invitations`,
      {
        method: "POST",
        cookie: cookies,
        body: new URLSearchParams({
          _csrf: csrfToken,
          email: adminEmail,
          role: "admin",
        }).toString(),
      },
    );
    assert.equal(invited.statusCode, 303);
    const adminSession = await loginSession(server.app, adminEmail, password);
    const consolePage = await requestWithCookies(
      server.app,
      "/organizer?lang=en",
      { cookie: adminSession.sessionCookie },
    );
    assert.equal(consolePage.statusCode, 200);
    const acceptMatch = /organizer\/invitations\/([A-Za-z0-9-]+)\/accept/.exec(
      consolePage.body,
    );
    assert.ok(acceptMatch, "the pending invitation renders for the invitee");
    const accepted = await requestWithCookies(
      server.app,
      `/organizer/invitations/${acceptMatch[1]}/accept`,
      {
        method: "POST",
        cookie: `${adminSession.sessionCookie}; ${cookiePair(consolePage.setCookie, "hosted-csrf-v1")}`,
        body: `_csrf=${formValue(consolePage.body, "_csrf")}`,
      },
    );
    assert.ok(
      [200, 303].includes(accepted.statusCode),
      "the admin accepts the invitation",
    );
    const adminPage = await requestWithCookies(server.app, managePath, {
      cookie: adminSession.sessionCookie,
    });
    assert.equal(adminPage.statusCode, 200);
    assert.ok(
      !adminPage.body.includes("https://hooks.example.com/console"),
      "an Admin sees no webhook list",
    );
    const adminRotate = await requestWithCookies(
      server.app,
      `/organizers/${organizerId}/webhooks/${subscriptionId}/rotate`,
      {
        method: "POST",
        cookie: `${adminSession.sessionCookie}; ${cookiePair(adminPage.setCookie, "hosted-csrf-v1")}`,
        body: `_csrf=${formValue(adminPage.body, "_csrf")}`,
      },
    );
    assert.equal(
      adminRotate.statusCode,
      403,
      "a non-Owner cannot rotate the signing secret",
    );

    // A signed-in non-member gets the uniform 404.
    const outsiderEmail = "webhook-console-outsider@example.com";
    await registerAccount(server.app, outsiderEmail, password);
    await verifyAccount(server.app, server.outboxDir, outsiderEmail);
    const outsider = await loginSession(server.app, outsiderEmail, password);
    const outsiderRotate = await requestWithCookies(
      server.app,
      `/organizers/${organizerId}/webhooks/${subscriptionId}/rotate`,
      { method: "POST", cookie: outsider.sessionCookie, body: "_csrf=x" },
    );
    assert.equal(outsiderRotate.statusCode, 404);
  } finally {
    await closeServer(server.app);
  }
});

test("a slow endpoint is classified as a timeout and retried", async () => {
  const fixture = await createWebhookFixture(1_000_000);
  const receiver = await createReceiver();
  try {
    await fixture.webhookStore.createSubscription({
      organizerId: fixture.organizerId,
      url: receiver.endpoint(),
      actorAccountId: fixture.ownerAccountId,
    });
    await seedSealedSession(fixture, {
      eventName: "Slow Jam",
      organizerId: fixture.organizerId,
      actorAccountId: fixture.ownerAccountId,
    });
    await fixture.webhookPipeline.deriveLifecycleEvents();
    // The receiver stalls past the injected delivery timeout.
    receiver.responder((res) => {
      setTimeout(() => {
        res.statusCode = 200;
        res.end("late");
      }, 250);
    });
    const slowPipeline = createWebhookPipeline({
      webhookStore: fixture.webhookStore,
      organizerStore: fixture.organizerStore,
      notificationService: fixture.notifications,
      config: {
        ...PRODUCTION_CONFIG,
        HOSTED_WEBHOOK_RETRY_MS: RETRY_BASE_MS,
        HOSTED_WEBHOOK_GIVE_UP_MS: GIVE_UP_MS,
      },
      clock: () => fixture.holder.now,
      deliveryTimeoutMs: 50,
    });
    const slowPass = await slowPipeline.runDueDeliveries({
      now: fixture.holder.now,
    });
    assert.equal(slowPass.delivered, 0);
    assert.ok(slowPass.failed >= 3, "every stalled attempt failed");

    // The receiver answers in time; the same records deliver.
    receiver.responder((res) => {
      res.statusCode = 200;
      res.end("ok");
    });
    fixture.holder.now += RETRY_BASE_MS;
    const fastPipeline = createWebhookPipeline({
      webhookStore: fixture.webhookStore,
      organizerStore: fixture.organizerStore,
      notificationService: fixture.notifications,
      config: {
        ...PRODUCTION_CONFIG,
        HOSTED_WEBHOOK_RETRY_MS: RETRY_BASE_MS,
        HOSTED_WEBHOOK_GIVE_UP_MS: GIVE_UP_MS,
      },
      clock: () => fixture.holder.now,
      deliveryTimeoutMs: 10_000,
    });
    const fastPass = await fastPipeline.runDueDeliveries({
      now: fixture.holder.now,
    });
    assert.ok(fastPass.delivered >= 3);
  } finally {
    await receiver.close();
    await fixture.webhookStore.flush();
  }
});

test("resuming starts a fresh give-up window for the frozen records", async () => {
  const fixture = await createWebhookFixture(1_000_000);
  const receiver = await createReceiver();
  try {
    await fixture.webhookStore.createSubscription({
      organizerId: fixture.organizerId,
      url: receiver.endpoint(),
      actorAccountId: fixture.ownerAccountId,
    });
    await seedSealedSession(fixture, {
      eventName: "Recovery Jam",
      organizerId: fixture.organizerId,
      actorAccountId: fixture.ownerAccountId,
    });
    await fixture.webhookPipeline.deriveLifecycleEvents();
    receiver.responder((res) => {
      res.statusCode = 500;
      res.end();
    });
    await fixture.webhookPipeline.runDueDeliveries({ now: fixture.holder.now });

    // Suspend at the end of the first window.
    fixture.holder.now += GIVE_UP_MS + RETRY_BASE_MS;
    await fixture.webhookPipeline.runDueDeliveries({ now: fixture.holder.now });
    const suspended = fixture.webhookStore
      .listSubscriptionsForOrganizer(fixture.organizerId)
      .find((subscription) => subscription.status === "suspended");
    assert.ok(suspended, "the subscription is suspended");

    // Resume while the endpoint is still unhealthy, and run the pass far
    // beyond the ORIGINAL first-failure timestamp: the fresh window must
    // keep the subscription active instead of oscillating back to suspended.
    await fixture.webhookStore.resumeSubscription({
      organizerId: fixture.organizerId,
      subscriptionId: suspended.subscriptionId,
    });
    fixture.holder.now += GIVE_UP_MS * 2;
    const pass = await fixture.webhookPipeline.runDueDeliveries({
      now: fixture.holder.now,
    });
    assert.equal(pass.suspended, 0, "no immediate re-suspension");
    const stillActive = fixture.webhookStore
      .listSubscriptionsForOrganizer(fixture.organizerId)
      .find(
        (subscription) =>
          subscription.subscriptionId === suspended.subscriptionId,
      );
    assert.ok(stillActive);
    assert.equal(stillActive.status, "active");
  } finally {
    await receiver.close();
    await fixture.webhookStore.flush();
  }
});
