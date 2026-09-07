const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  createFileEventMembershipStore,
} = require("../server/hosted_event/memberships/store.mjs");

/**
 * @returns {Promise<string>}
 */
async function createDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "wbo-hosted-memberships-"));
}

test("admission creates exactly one membership and restores it afterwards", async () => {
  const store = createFileEventMembershipStore({
    dataDir: await createDataDir(),
  });
  const first = await store.admit({
    eventId: "event-1",
    accountId: "account-1",
    anonymity: "identified",
  });
  assert.equal(first.created, true);
  assert.equal(first.membership.anonymity, "identified");

  // Re-admission restores the existing record and never overwrites the
  // original anonymity choice, no matter what the second submission says.
  const second = await store.admit({
    eventId: "event-1",
    accountId: "account-1",
    anonymity: "anonymous",
  });
  assert.equal(second.created, false);
  assert.equal(second.membership, first.membership);
  assert.equal(second.membership.anonymity, "identified");

  // A different account in the same event gets its own membership.
  const other = await store.admit({
    eventId: "event-1",
    accountId: "account-2",
    anonymity: "anonymous",
  });
  assert.equal(other.created, true);
  assert.equal(other.membership.anonymity, "anonymous");

  assert.equal(
    store.getMembership("event-1", "account-1")?.anonymity,
    "identified",
  );
  assert.equal(
    store.getMembership("event-1", "account-2")?.anonymity,
    "anonymous",
  );
  assert.equal(store.getMembership("event-1", "account-3"), null);
  assert.equal(store.getMembership("event-2", "account-1"), null);
});

test("the anonymity choice can be switched to anonymous for members only", async () => {
  const store = createFileEventMembershipStore({
    dataDir: await createDataDir(),
  });
  await store.admit({
    eventId: "event-1",
    accountId: "account-1",
    anonymity: "identified",
  });

  const changed = await store.setAnonymity({
    eventId: "event-1",
    accountId: "account-1",
    anonymity: "anonymous",
  });
  assert.deepEqual(changed, { ok: true });
  assert.equal(
    store.getMembership("event-1", "account-1")?.anonymity,
    "anonymous",
  );

  // Switching requires an existing membership; it never creates one.
  const stranger = await store.setAnonymity({
    eventId: "event-1",
    accountId: "account-9",
    anonymity: "anonymous",
  });
  assert.deepEqual(stranger, { ok: false, reason: "not_member" });
  assert.equal(store.getMembership("event-1", "account-9"), null);
});

test("memberships persist across a store reload", async () => {
  const dataDir = await createDataDir();
  let clockMs = 1_000;
  const first = createFileEventMembershipStore({
    dataDir,
    clock: () => clockMs,
  });
  await first.admit({
    eventId: "event-1",
    accountId: "account-1",
    anonymity: "identified",
  });
  await first.setAnonymity({
    eventId: "event-1",
    accountId: "account-1",
    anonymity: "anonymous",
  });
  await first.flush();

  clockMs = 2_000;
  const reloaded = createFileEventMembershipStore({
    dataDir,
    clock: () => clockMs,
  });
  const membership = reloaded.getMembership("event-1", "account-1");
  assert.ok(membership);
  assert.equal(membership.anonymity, "anonymous");
  assert.equal(membership.joinedAtMs, 1_000);
});

test("hostile identifiers are rejected instead of creating records", async () => {
  const store = createFileEventMembershipStore({
    dataDir: await createDataDir(),
  });
  await assert.rejects(() =>
    store.admit({
      eventId: "",
      accountId: "account-1",
      anonymity: "identified",
    }),
  );
  await assert.rejects(() =>
    store.admit({ eventId: "event-1", accountId: "", anonymity: "anonymous" }),
  );
});
