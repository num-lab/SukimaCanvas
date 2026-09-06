const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  createFileNotificationStore,
} = require("../server/hosted_event/notifications/store.mjs");

/** @returns {Promise<string>} */
async function createDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "wbo-notices-"));
}

/**
 * @param {string} dataDir
 * @param {{now: number}} [state]
 */
function createStore(dataDir, state = { now: 1_700_000_000_000 }) {
  return createFileNotificationStore({ dataDir, clock: () => state.now });
}

/** @param {{now?: number}} state */
const notice = (state) => ({
  notificationId: `notice-${Math.random().toString(36).slice(2, 10)}`,
  kind: "event_cancelled",
  to: "user@example.com",
  subject: "Event cancelled",
  body: `The event was cancelled at ${state.now}.`,
});

test("enqueue is idempotent on the stable notification id", async () => {
  const dataDir = await createDataDir();
  const state = { now: 1_000 };
  const store = createStore(dataDir, state);
  const first = notice(state);
  assert.deepEqual(await store.enqueue(first), { created: true });
  // A duplicate trigger with different content must not touch the record.
  const again = await store.enqueue({ ...first, body: "rewritten" });
  assert.deepEqual(again, { created: false });
  const due = await store.listDue({ now: state.now });
  assert.equal(due.length, 1);
  assert.equal(due[0]?.body, first.body);
});

test("enqueueMany fans out in one pass and rejects invalid batches atomically", async () => {
  const dataDir = await createDataDir();
  const state = { now: 1_000 };
  const store = createStore(dataDir, state);
  const records = ["a@example.com", "b@example.com", "c@example.com"].map(
    (to, index) => ({ ...notice(state), notificationId: `fan-${index}`, to }),
  );
  assert.deepEqual(await store.enqueueMany(records), { created: 3 });
  // Re-running the trigger enqueues nothing new.
  assert.deepEqual(await store.enqueueMany(records), { created: 0 });
  assert.equal((await store.listDue({ now: state.now })).length, 3);

  const before = (await store.listDue({ now: state.now })).length;
  await assert.rejects(() =>
    store.enqueueMany([
      { ...notice(state), notificationId: "fan-ok" },
      { ...notice(state), notificationId: "fan-bad", to: "not-an-email" },
    ]),
  );
  assert.equal((await store.listDue({ now: state.now })).length, before);
});

test("listDue honors the retry backoff and marks failures", async () => {
  const dataDir = await createDataDir();
  const state = { now: 1_000 };
  const store = createStore(dataDir, state);
  const failed = { ...notice(state), notificationId: "backoff-1" };
  const ready = { ...notice(state), notificationId: "backoff-2" };
  await store.enqueueMany([failed, ready]);

  assert.equal((await store.listDue({ now: state.now })).length, 2);
  await store.markFailed({
    notificationId: failed.notificationId,
    message: "vendor unavailable",
    nextAttemptAtMs: state.now + 5_000,
  });
  assert.deepEqual(
    (await store.listDue({ now: state.now })).map((n) => n.notificationId),
    [ready.notificationId],
  );
  const afterBackoff = await store.listDue({ now: state.now + 5_000 });
  assert.equal(afterBackoff.length, 2);
  const record = afterBackoff.find(
    (n) => n.notificationId === failed.notificationId,
  );
  assert.equal(record?.attempts, 1);
  assert.equal(record?.lastError, "vendor unavailable");
  assert.equal(record?.status, "pending");
});

test("markSent redacts content and tombstones the id across reloads", async () => {
  const dataDir = await createDataDir();
  const state = { now: 1_000 };
  const store = createStore(dataDir, state);
  const record = notice(state);
  await store.enqueue(record);
  await store.markSent({
    notificationId: record.notificationId,
    sentAtMs: state.now + 50,
  });

  assert.equal((await store.listDue({ now: state.now })).length, 0);
  assert.equal((await store.listRetrying()).length, 0);
  // The tombstone survives a reload and still blocks re-enqueueing.
  const reloaded = createStore(dataDir, state);
  assert.deepEqual(await reloaded.enqueue(record), { created: false });
  const stored = JSON.parse(
    await fs.readFile(path.join(dataDir, "notifications.json"), "utf8"),
  );
  const tombstone = stored.notices.find(
    (/** @type {any} */ n) => n.notificationId === record.notificationId,
  );
  assert.equal(tombstone.status, "sent");
  assert.equal(tombstone.to, "");
  assert.equal(tombstone.subject, "");
  assert.equal(tombstone.body, "");
});

test("markSent and markFailed ignore records that are not pending", async () => {
  const dataDir = await createDataDir();
  const state = { now: 1_000 };
  const store = createStore(dataDir, state);
  const record = notice(state);
  await store.enqueue(record);
  await store.markSent({
    notificationId: record.notificationId,
    sentAtMs: state.now,
  });
  // A late failure report after a successful send changes nothing.
  await store.markFailed({
    notificationId: record.notificationId,
    message: "late",
    nextAttemptAtMs: state.now,
  });
  const due = await store.listDue({ now: state.now + 10_000 });
  assert.equal(due.length, 0);
});

test("failure details are clamped so one hostile error cannot grow the store", async () => {
  const dataDir = await createDataDir();
  const state = { now: 1_000 };
  const store = createStore(dataDir, state);
  const record = notice(state);
  await store.enqueue(record);
  await store.markFailed({
    notificationId: record.notificationId,
    message: "x".repeat(5_000),
    nextAttemptAtMs: state.now,
  });
  const [due] = await store.listDue({ now: state.now });
  assert.ok(due?.lastError && due.lastError.length <= 300);
});

test("queued state survives a process restart", async () => {
  const dataDir = await createDataDir();
  const state = { now: 1_000 };
  const store = createStore(dataDir, state);
  const record = notice(state);
  await store.enqueue(record);
  await store.markFailed({
    notificationId: record.notificationId,
    message: "boom",
    nextAttemptAtMs: state.now + 60_000,
  });

  const reloaded = createStore(dataDir, state);
  assert.equal((await reloaded.listDue({ now: state.now })).length, 0);
  const due = await reloaded.listDue({ now: state.now + 60_000 });
  assert.equal(due.length, 1);
  assert.equal(due[0]?.attempts, 1);
  assert.equal(due[0]?.body, record.body);
});

test("old sent tombstones are pruned so the durable file stays bounded", async () => {
  const dataDir = await createDataDir();
  const state = { now: 1_000 };
  const store = createStore(dataDir, state);
  const old = { ...notice(state), notificationId: "old-sent" };
  await store.enqueue(old);
  await store.markSent({
    notificationId: old.notificationId,
    sentAtMs: state.now,
  });

  state.now += 31 * 24 * 60 * 60 * 1000;
  const fresh = { ...notice(state), notificationId: "fresh" };
  await store.enqueue(fresh);

  const reloaded = createStore(dataDir, state);
  const due = await reloaded.listDue({ now: state.now });
  assert.deepEqual(
    due.map((n) => n.notificationId),
    [fresh.notificationId],
  );
});

test("enqueue rejects malformed notices deterministically", async () => {
  const dataDir = await createDataDir();
  const state = { now: 1_000 };
  const store = createStore(dataDir, state);
  await assert.rejects(() =>
    store.enqueue({ ...notice(state), notificationId: "../escape" }),
  );
  await assert.rejects(() =>
    store.enqueue({ ...notice(state), notificationId: "" }),
  );
  await assert.rejects(() => store.enqueue({ ...notice(state), kind: "" }));
  await assert.rejects(() =>
    store.enqueue({ ...notice(state), to: "not-an-email" }),
  );
  await assert.rejects(() => store.enqueue({ ...notice(state), body: "" }));
  assert.equal((await store.listDue({ now: state.now })).length, 0);
});
