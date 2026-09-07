const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  createFileBoardArchiveStore,
} = require("../server/hosted_event/archive/store.mjs");
const {
  createFilePublicationStore,
} = require("../server/hosted_event/publication/store.mjs");

/**
 * The minted share token of a link-audience publish.
 *
 * @param {{ok: boolean, shareToken?: string | null}} result
 * @returns {string}
 */
function tokenOf(result) {
  assert.ok(result.ok);
  assert.ok(
    typeof result.shareToken === "string" && result.shareToken.length > 0,
  );
  return /** @type {string} */ (result.shareToken);
}

/**
 * Composes a publication store over a real archive store with a controllable
 * clock in a temporary directory.
 *
 * @param {{clock?: () => number}} [options]
 */
async function createStore(options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-pub-store-"));
  const holder = { now: 1_000_000_000_000 };
  const clock = options.clock || (() => holder.now);
  const archiveStore = createFileBoardArchiveStore({ dataDir });
  const store = createFilePublicationStore({
    dataDir,
    clock,
    archiveStore,
  });
  return {
    holder,
    dataDir,
    archiveStore,
    store,
    boardSessionId: "board-session-1",
    publishInput(overrides = {}) {
      return {
        boardSessionId: "board-session-1",
        eventId: "event-1",
        organizerId: "organizer-1",
        audience: "members",
        showAttribution: true,
        canvasContent: '<svg id="canvas"></svg>',
        archivedFinalSeq: 7,
        itemCount: 2,
        actorAccountId: "actor-1",
        ...overrides,
      };
    },
  };
}

test("publish derives an audience-gated record and stores the sanitized object immutably", async () => {
  const harness = await createStore();
  const first = await harness.store.publish(
    harness.publishInput({ audience: "organizer" }),
  );
  assert.ok(first.ok);
  assert.equal(first.ok ? first.publication.generation : -1, 1);
  assert.equal(first.ok ? first.shareToken : "x", null);
  const objectKey = first.ok ? first.publication.canvasKey : "";
  assert.equal(objectKey, "published-canvases/board-session-1/1.svg");
  const stored = await harness.archiveStore.readArchive(objectKey);
  assert.equal(stored?.toString("utf8"), harness.publishInput().canvasContent);

  // A policy edit that leaves the derived content unchanged reuses the
  // current generation's object instead of duplicating storage.
  const sameContent = await harness.store.publish(
    harness.publishInput({ audience: "link", showAttribution: false }),
  );
  assert.ok(sameContent);
  assert.equal(
    sameContent.ok ? sameContent.publication.generation : -1,
    1,
    "unchanged content keeps the current generation",
  );
  assert.equal(
    sameContent.ok ? sameContent.publication.canvasKey : "",
    objectKey,
  );
  assert.equal(
    sameContent.ok ? sameContent.publication.publishedAtMs : -1,
    first.ok ? first.publication.publishedAtMs : -1,
    "the original publish time survives policy updates",
  );

  // New content lands under the next monotonic generation.
  const changedContent = await harness.store.publish(
    harness.publishInput({
      showAttribution: false,
      canvasContent: '<svg id="canvas" data-x="1"></svg>',
    }),
  );
  assert.ok(changedContent);
  assert.equal(
    changedContent.ok ? changedContent.publication.generation : -1,
    2,
  );
  assert.ok(
    await harness.archiveStore.readArchive(
      changedContent.ok ? changedContent.publication.canvasKey : "",
    ),
  );
});

test("a link audience publishes a digest-stored token that is revealed exactly once", async () => {
  const harness = await createStore();
  const published = await harness.store.publish(
    harness.publishInput({ audience: "link" }),
  );
  assert.ok(published);
  const token = tokenOf(published);
  const publication = published.ok ? published.publication : null;
  assert.match(publication?.shareTokenDigest || "", /^[0-9a-f]{64}$/);
  const persisted = await fs.readFile(
    path.join(harness.dataDir, "publications.json"),
    "utf8",
  );
  assert.ok(!persisted.includes(token), "the raw token is never stored");
  assert.ok(
    harness.store.getPublicationByShareToken(token),
    "the live token resolves to the publication",
  );
  assert.equal(harness.store.getPublicationByShareToken("wrong-token"), null);
  assert.equal(harness.store.getPublicationByShareToken(""), null);
  assert.equal(
    harness.store.getPublicationByShareToken(/** @type {any} */ (null)),
    null,
  );
});

test("every link publish rotates the token; revocation kills all capabilities immediately", async () => {
  const harness = await createStore();
  const first = await harness.store.publish(
    harness.publishInput({ audience: "link" }),
  );
  assert.ok(first);
  const firstToken = tokenOf(first);
  const rotated = await harness.store.publish(
    harness.publishInput({ audience: "link" }),
  );
  assert.ok(rotated);
  const secondToken = tokenOf(rotated);
  assert.notEqual(firstToken, secondToken);
  assert.equal(
    harness.store.getPublicationByShareToken(firstToken),
    null,
    "the previous share link stops working after a republish",
  );
  assert.ok(harness.store.getPublicationByShareToken(secondToken));

  const revoked = await harness.store.revoke({
    boardSessionId: "board-session-1",
    actorAccountId: "actor-1",
  });
  assert.deepEqual(revoked, { ok: true });
  assert.equal(
    harness.store.getPublicationByShareToken(secondToken),
    null,
    "revocation invalidates the share link immediately",
  );
  const record = harness.store.getPublicationForBoardSession("board-session-1");
  assert.equal(record?.status, "revoked");
  assert.equal(record?.shareTokenDigest, null);
  assert.ok(record?.revokedAtMs);
  assert.equal(record?.revokedByAccountId, "actor-1");

  // Revoking again, or revoking nothing, is refused without side effects.
  assert.deepEqual(
    await harness.store.revoke({
      boardSessionId: "board-session-1",
      actorAccountId: "actor-1",
    }),
    { ok: false, reason: "not_published" },
  );
  assert.deepEqual(
    await harness.store.revoke({
      boardSessionId: "missing",
      actorAccountId: "actor-1",
    }),
    { ok: false, reason: "not_found" },
  );

  // Republishing after revocation mints fresh capabilities.
  const republished = await harness.store.publish(
    harness.publishInput({ audience: "link" }),
  );
  assert.ok(republished);
  assert.equal(
    republished.ok ? republished.publication.status : "",
    "published",
  );
  assert.equal(
    harness.store.getPublicationByShareToken(secondToken),
    null,
    "a revoked publication's capabilities are never reused",
  );
  assert.ok(harness.store.getPublicationByShareToken(tokenOf(republished)));
  assert.equal(
    republished.ok ? republished.publication.generation : -1,
    2,
    "the generation stays monotonic across revocations",
  );
});

test("invalid publish input is refused without touching storage", async () => {
  const harness = await createStore();
  for (const overrides of [
    { audience: "everyone" },
    { boardSessionId: "" },
    { eventId: "" },
    { canvasContent: "" },
    { archivedFinalSeq: -1 },
    { itemCount: 1.5 },
  ]) {
    const result = await harness.store.publish(harness.publishInput(overrides));
    assert.deepEqual(result, { ok: false, reason: "invalid_input" });
  }
  assert.equal(
    await harness.archiveStore.readArchive(
      "published-canvases/board-session-1/1.svg",
    ),
    null,
  );
});

test("records survive a reload and a crashed publish retries idempotently", async () => {
  const harness = await createStore();
  await harness.store.publish(harness.publishInput({ audience: "members" }));
  await harness.store.flush();

  const reopened = createFilePublicationStore({
    dataDir: harness.dataDir,
    clock: () => harness.holder.now,
    archiveStore: harness.archiveStore,
  });
  const reloaded = reopened.getPublicationForBoardSession("board-session-1");
  assert.equal(reloaded?.status, "published");
  assert.equal(reloaded?.audience, "members");
  assert.equal(reloaded?.archivedFinalSeq, 7);
  assert.equal(
    await reopened
      .publish(harness.publishInput({ audience: "members" }))
      .then((result) => (result.ok ? result.publication.generation : -1)),
    1,
    "a retry against the persisted record keeps the generation",
  );

  // The crash window between the object write and the record persist: a
  // fresh store re-derives byte-identical content and the immutable put
  // accepts it as the no-op it is.
  const crashDir = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-pub-crash-"));
  const crashArchive = createFileBoardArchiveStore({ dataDir: crashDir });
  const crashClock = () => 1_000_000_000_000;
  const crashed = createFilePublicationStore({
    dataDir: crashDir,
    clock: crashClock,
    archiveStore: crashArchive,
  });
  const input = harness.publishInput();
  await crashed.publish(input);
  await fs.rm(path.join(crashDir, "publications.json"));
  const retry = createFilePublicationStore({
    dataDir: crashDir,
    clock: crashClock,
    archiveStore: crashArchive,
  });
  const retryResult = await retry.publish(input);
  assert.ok(retryResult);
  assert.equal(retryResult.ok ? retryResult.publication.generation : -1, 1);
  const persisted = await fs.readFile(
    path.join(crashDir, "publications.json"),
    "utf8",
  );
  assert.ok(persisted.includes("board-session-1"));
});
