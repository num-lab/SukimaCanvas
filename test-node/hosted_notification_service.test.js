const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

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
  createFileOrganizerStore,
} = require("../server/hosted_event/organizers/store.mjs");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A controllable mail adapter: records every accepted message and can take
 * the whole vendor down, exactly like the real vendor contract.
 *
 * @returns {{mail: {send: (message: any) => Promise<void>}, sent: {id: string | undefined, to: string, subject: string, body: string}[], setUp: () => void, setDown: () => void}}
 */
function createMailAdapter() {
  /** @type {{id: string | undefined, to: string, subject: string, body: string}[]} */
  const sent = [];
  let up = true;
  return {
    sent,
    setUp: () => {
      up = true;
    },
    setDown: () => {
      up = false;
    },
    mail: {
      /** @param {{id?: string, to: string, subject: string, body: string}} message */
      async send(message) {
        if (!up) throw new Error("vendor unavailable");
        sent.push({
          id: message.id,
          to: message.to,
          subject: message.subject,
          body: message.body,
        });
      },
    },
  };
}

/**
 * Composes the hosted stores and the notification service against one shared
 * controllable clock in a temporary data directory, with an organizer, an
 * approved future event, participants, and an outsider already in place.
 *
 * @param {{config?: Record<string, number>}} [options]
 */
async function createServiceFixture(options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-notice-svc-"));
  const holder = { now: 1_700_000_000_000 };
  const clock = () => holder.now;
  const adapter = createMailAdapter();
  const config = {
    HOSTED_MAIL_RETRY_MS: 1_000,
    HOSTED_NOTICE_UPCOMING_WINDOW_MS: DAY,
    HOSTED_SERVICE_UTC_OFFSET_MINUTES: 0,
    ...options.config,
  };

  const accountStore = createFileAccountStore({
    dataDir,
    clock,
    sessionMaxAgeMs: 1000 * DAY,
    sessionIdleMs: 1000 * DAY,
  });
  const organizerStore = createFileOrganizerStore({ dataDir, clock });
  const membershipStore = createFileEventMembershipStore({ dataDir, clock });
  const notificationStore = createFileNotificationStore({ dataDir, clock });
  const notifications = createNotificationService({
    store: notificationStore,
    mail: adapter.mail,
    accountStore,
    organizerStore,
    membershipStore,
    config,
    clock,
  });

  const provisionAccount = async (/** @type {string} */ email) => {
    const account = await accountStore.createAccount({
      email,
      passwordHash: "test-hash",
    });
    await accountStore.markAccountVerified(account.accountId, 0);
    return account;
  };

  const owner = await provisionAccount("owner@example.com");
  const application = await organizerStore.submitApplication({
    accountId: owner.accountId,
    organizerName: "Aurora Collective",
    contactName: "Mika Rin",
    contactEmail: "contact@example.com",
    description: "Jams.",
  });
  assert.ok(application.ok);
  const approved = await organizerStore.approveApplication({
    applicationId: application.application.applicationId,
    operatorAccountId: "operator",
  });
  assert.ok(approved.ok);
  const organizerId = approved.organizerId;

  const created = await organizerStore.createReservation({
    organizerId,
    createdByAccountId: owner.accountId,
    eventName: "Launch Party",
    visibility: "public",
    startsAtMs: holder.now + 3 * DAY,
    endsAtMs: holder.now + 3 * DAY + HOUR,
    requestedSeats: 30,
  });
  assert.ok(created.ok);
  await organizerStore.submitReservation({
    reservationId: created.reservation.reservationId,
    actorAccountId: owner.accountId,
    now: holder.now,
  });
  const operatorApproved = await organizerStore.approveReservation({
    reservationId: created.reservation.reservationId,
    operatorAccountId: "operator",
    now: holder.now,
    bufferMs: 15 * MINUTE,
    sessionLimit: 20,
    seatLimit: 1000,
  });
  assert.ok(operatorApproved.ok);
  const event = organizerStore.getEventById(operatorApproved.eventId);
  assert.ok(event);
  const boardSession = organizerStore.getBoardSessionForEvent(event.eventId);
  assert.ok(boardSession);

  const addParticipant = async (/** @type {string} */ email) => {
    const account = await provisionAccount(email);
    await membershipStore.admit({
      eventId: event.eventId,
      accountId: account.accountId,
      anonymity: "identified",
    });
    return account;
  };
  const participantOne = await addParticipant("p1@example.com");
  const participantTwo = await addParticipant("p2@example.com");
  // A registered account that never established a membership.
  const outsider = await provisionAccount("outsider@example.com");

  return {
    holder,
    dataDir,
    adapter,
    notifications,
    notificationStore,
    accountStore,
    organizerStore,
    membershipStore,
    owner,
    participantOne,
    participantTwo,
    outsider,
    organizerId,
    event,
    boardSession,
    reservation: created.reservation,
    clock,
  };
}

test("a reservation approval reaches exactly the organizer members, once", async () => {
  const fixture = await createServiceFixture();
  await fixture.notifications.onReservationApproved({
    reservationId: fixture.reservation.reservationId,
    organizerId: fixture.organizerId,
    eventName: fixture.reservation.eventName,
    startsAtMs: fixture.reservation.startsAtMs,
    seats: fixture.reservation.requestedSeats,
  });
  // The trigger kicks its own drain; the explicit pass coalesces with it.
  await fixture.notifications.runDueSends();
  assert.deepEqual(
    fixture.adapter.sent.map((message) => message.to),
    ["owner@example.com"],
  );
  const message = fixture.adapter.sent[0];
  assert.ok(message);
  // The notice carries both hosted languages and no access link.
  assert.match(message.subject, /已通过 · /);
  assert.match(message.body, /Launch Party/);
  assert.match(message.body, /has been approved/);
  assert.doesNotMatch(message.body, /https?:\/\//);

  // The same logical trigger again is a no-op.
  await fixture.notifications.onReservationApproved({
    reservationId: fixture.reservation.reservationId,
    organizerId: fixture.organizerId,
    eventName: fixture.reservation.eventName,
    startsAtMs: fixture.reservation.startsAtMs,
    seats: fixture.reservation.requestedSeats,
  });
  await fixture.notifications.runDueSends();
  assert.equal(fixture.adapter.sent.length, 1);
});

test("an event cancellation reaches participants with a membership, never outsiders", async () => {
  const fixture = await createServiceFixture();
  await fixture.notifications.onEventCancelled({
    eventId: fixture.event.eventId,
    organizerId: fixture.organizerId,
    eventName: fixture.reservation.eventName,
    startsAtMs: fixture.reservation.startsAtMs,
  });
  await fixture.notifications.runDueSends();
  assert.deepEqual(fixture.adapter.sent.map((message) => message.to).sort(), [
    "owner@example.com",
    "p1@example.com",
    "p2@example.com",
  ]);
  // The outsider is not reachable, and nobody received the organizer wording
  // by accident: the participant wording addresses "you joined".
  const participantMail = fixture.adapter.sent.find(
    (message) => message.to === "p1@example.com",
  );
  assert.ok(participantMail);
  assert.match(participantMail.body, /你已加入的活动/);
  const organizerMail = fixture.adapter.sent.find(
    (message) => message.to === "owner@example.com",
  );
  assert.ok(organizerMail);
  assert.match(organizerMail.body, /你组织的活动/);
});

test("a vendor outage keeps requests working and retries with backoff to exactly-once", async () => {
  const fixture = await createServiceFixture();
  fixture.adapter.setDown();
  await fixture.notifications.onReservationApproved({
    reservationId: fixture.reservation.reservationId,
    organizerId: fixture.organizerId,
    eventName: fixture.reservation.eventName,
    startsAtMs: fixture.reservation.startsAtMs,
    seats: fixture.reservation.requestedSeats,
  });
  const failedPass = await fixture.notifications.runDueSends();
  assert.deepEqual(failedPass, { sent: 0, failed: 0 });
  assert.equal(fixture.adapter.sent.length, 0);
  // The failure is observable as a retrying notice.
  const retrying = fixture.notificationStore.listRetrying();
  assert.equal(retrying.length, 1);
  assert.equal(retrying[0]?.attempts, 1);
  assert.match(retrying[0]?.lastError || "", /vendor unavailable/);

  // Inside the backoff window a new pass does not touch the vendor.
  fixture.holder.now += 500;
  assert.deepEqual(await fixture.notifications.runDueSends(), {
    sent: 0,
    failed: 0,
  });

  // Recovery: the vendor is back and the backoff has elapsed.
  fixture.adapter.setUp();
  fixture.holder.now += 1_000;
  assert.deepEqual(await fixture.notifications.runDueSends(), {
    sent: 1,
    failed: 0,
  });
  assert.deepEqual(
    fixture.adapter.sent.map((message) => message.to),
    ["owner@example.com"],
  );
  assert.equal(fixture.notificationStore.listRetrying().length, 0);
});

test("a process restart resumes pending work without re-sending delivered notices", async () => {
  const fixture = await createServiceFixture();
  // One delivered approval notice...
  await fixture.notifications.onReservationApproved({
    reservationId: fixture.reservation.reservationId,
    organizerId: fixture.organizerId,
    eventName: fixture.reservation.eventName,
    startsAtMs: fixture.reservation.startsAtMs,
    seats: fixture.reservation.requestedSeats,
  });
  await fixture.notifications.runDueSends();
  assert.equal(fixture.adapter.sent.length, 1);

  // ...and one cancellation stranded by a vendor outage.
  fixture.adapter.setDown();
  await fixture.notifications.onEventCancelled({
    eventId: fixture.event.eventId,
    organizerId: fixture.organizerId,
    eventName: fixture.reservation.eventName,
    startsAtMs: fixture.reservation.startsAtMs,
  });
  await fixture.notifications.runDueSends();

  // Restart: every store and the service recompose from the same data
  // directory, the vendor is healthy again.
  const recomposed = createFileNotificationStore({
    dataDir: fixture.dataDir,
    clock: fixture.clock,
  });
  const restarted = createNotificationService({
    store: recomposed,
    mail: fixture.adapter.mail,
    accountStore: fixture.accountStore,
    organizerStore: fixture.organizerStore,
    membershipStore: fixture.membershipStore,
    config: {
      HOSTED_MAIL_RETRY_MS: 1_000,
      HOSTED_NOTICE_UPCOMING_WINDOW_MS: DAY,
      HOSTED_SERVICE_UTC_OFFSET_MINUTES: 0,
    },
    clock: fixture.clock,
  });
  fixture.adapter.setUp();
  fixture.holder.now += 10 * MINUTE;
  const outcome = await restarted.runDueSends();
  assert.deepEqual(outcome, { sent: 3, failed: 0 });

  // The approval went out exactly once across both processes; the stranded
  // cancellation now reached all three recipients.
  assert.deepEqual(fixture.adapter.sent.map((message) => message.to).sort(), [
    "owner@example.com",
    "owner@example.com",
    "p1@example.com",
    "p2@example.com",
  ]);
});

test("the upcoming-start notice fires once per session inside the configured window", async () => {
  const fixture = await createServiceFixture();
  // Far outside the window: nothing.
  await fixture.notifications.noticeUpcomingSessions({
    now: fixture.holder.now,
  });
  await fixture.notifications.runDueSends();
  assert.equal(fixture.adapter.sent.length, 0);

  // Inside the window (start minus 12h < window): one notice per member.
  fixture.holder.now = fixture.reservation.startsAtMs - 12 * HOUR;
  await fixture.notifications.noticeUpcomingSessions({
    now: fixture.holder.now,
  });
  await fixture.notifications.runDueSends();
  assert.deepEqual(
    fixture.adapter.sent.map((message) => message.to),
    ["owner@example.com"],
  );
  // Participants do not get organizer heads-ups.
  assert.equal(
    fixture.adapter.sent.some((message) => message.to === "p1@example.com"),
    false,
  );

  // Repeated passes never re-send.
  await fixture.notifications.noticeUpcomingSessions({
    now: fixture.holder.now,
  });
  await fixture.notifications.noticeUpcomingSessions({
    now: fixture.holder.now + MINUTE,
  });
  await fixture.notifications.runDueSends();
  assert.equal(fixture.adapter.sent.length, 1);
});

test("archive outcomes notify the organizer, and close reaches participants", async () => {
  const fixture = await createServiceFixture();
  await fixture.notifications.onSessionArchived({
    boardSessionId: fixture.boardSession.boardSessionId,
    eventId: fixture.event.eventId,
    organizerId: fixture.organizerId,
    eventName: fixture.reservation.eventName,
  });
  await fixture.notifications.runDueSends();
  assert.deepEqual(fixture.adapter.sent.map((message) => message.to).sort(), [
    "owner@example.com",
    "p1@example.com",
    "p2@example.com",
  ]);

  await fixture.notifications.onSessionArchiveFailed({
    boardSessionId: fixture.boardSession.boardSessionId,
    eventId: fixture.event.eventId,
    organizerId: fixture.organizerId,
    eventName: fixture.reservation.eventName,
    failureCode: "storage_write_failed",
  });
  await fixture.notifications.runDueSends();
  // Organizer only, with the classified reason in both languages.
  const failureMails = fixture.adapter.sent.slice(3);
  assert.deepEqual(
    failureMails.map((message) => message.to),
    ["owner@example.com"],
  );
  assert.match(failureMails[0]?.body || "", /存储写入失败/);
  assert.match(
    failureMails[0]?.body || "",
    /archive storage could not be written/,
  );

  // A repeated failure pass (retry context refresh) stays silent.
  await fixture.notifications.onSessionArchiveFailed({
    boardSessionId: fixture.boardSession.boardSessionId,
    eventId: fixture.event.eventId,
    organizerId: fixture.organizerId,
    eventName: fixture.reservation.eventName,
    failureCode: "storage_write_failed",
  });
  await fixture.notifications.runDueSends();
  assert.equal(fixture.adapter.sent.length, 4);
});

test("account mail passes through composed content with a random id and no double delivery", async () => {
  const fixture = await createServiceFixture();
  await fixture.notifications.queueAccountMail({
    kind: "account_verification",
    to: "new-user@example.com",
    subject: "Verify your SukimaCanvas account",
    body: "Open https://board.test/verify?token=secret to verify.",
  });
  // The kick already drains; the explicit pass coalesces with it.
  await fixture.notifications.runDueSends();
  const verificationMails = fixture.adapter.sent.filter(
    (message) => message.to === "new-user@example.com",
  );
  assert.equal(verificationMails.length, 1);
  assert.match(verificationMails[0]?.body || "", /token=secret/);
  assert.match(verificationMails[0]?.id || "", /^account-/);
});
