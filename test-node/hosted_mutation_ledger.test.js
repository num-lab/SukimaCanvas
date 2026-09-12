const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  createFileBoardMutationLedger,
  LEDGER_CORRUPT_ERROR_CODE,
} = require("../server/hosted_event/ledger/store.mjs");

const RECT_CREATE = {
  tool: 3,
  type: 1,
  id: "rtest1",
  color: "#1f2937",
  size: 10,
  x: 10,
  y: 10,
  x2: 60,
  y2: 40,
  clientMutationId: "cm-1",
  createdBy: "p0f2a7c9d1e3f4a5b",
};

/**
 * @param {string} boardName
 * @param {number} seq
 * @param {Partial<{acceptedAtMs: number, eventId: string, boardSessionId: string, accountId: string, mutation: any}>} [overrides]
 */
function ledgerEntry(boardName, seq, overrides = {}) {
  return {
    seq,
    acceptedAtMs: 1_700_000_000_000 + seq,
    eventId: "evt-1",
    boardSessionId: "bs-1",
    accountId: "acct-1",
    mutation: {
      ...RECT_CREATE,
      id: `r${boardName}${seq}`,
      clientMutationId: `cm-${seq}`,
      createdBy: "p0f2a7c9d1e3f4a5b",
    },
    ...overrides,
  };
}

/**
 * @param {string} [prefix]
 */
async function createDataDir(prefix = "wbo-ledger-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("appendEntries durably persists entries and readEntriesAfter returns them in order", async (t) => {
  const dataDir = await createDataDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const ledger = createFileBoardMutationLedger({
    boardName: "event-abc",
    dataDir,
  });
  t.after(() => ledger.close());

  await ledger.appendEntries([ledgerEntry("event-abc", 1)]);
  await ledger.appendEntries([
    ledgerEntry("event-abc", 2),
    ledgerEntry("event-abc", 3),
  ]);

  const all = await ledger.readEntriesAfter(0);
  assert.deepEqual(
    all.map((entry) => entry.seq),
    [1, 2, 3],
  );
  const afterOne = await ledger.readEntriesAfter(1);
  assert.deepEqual(
    afterOne.map((entry) => entry.seq),
    [2, 3],
  );
  assert.equal(all[0]?.mutation.createdBy, "p0f2a7c9d1e3f4a5b");
  assert.equal(all[0]?.accountId, "acct-1");
});

test("a torn final line from a crashed append is dropped on read", async (t) => {
  const dataDir = await createDataDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const ledgerPath = path.join(dataDir, "mutation-ledger", "event-torn.jsonl");
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  const first = JSON.stringify(ledgerEntry("event-torn", 1));
  const torn = JSON.stringify(ledgerEntry("event-torn", 2)).slice(0, 40);
  await fs.writeFile(ledgerPath, `${first}\n${torn}`);

  const ledger = createFileBoardMutationLedger({
    boardName: "event-torn",
    dataDir,
  });
  t.after(() => ledger.close());
  const entries = await ledger.readEntriesAfter(0);
  assert.deepEqual(
    entries.map((entry) => entry.seq),
    [1],
  );
});

test("a post-crash append stays on a clean boundary after a torn tail", async (t) => {
  const dataDir = await createDataDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const ledgerPath = path.join(dataDir, "mutation-ledger", "event-torn.jsonl");
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  const torn = JSON.stringify(ledgerEntry("event-torn", 2)).slice(0, 40);
  await fs.writeFile(
    ledgerPath,
    `${JSON.stringify(ledgerEntry("event-torn", 1))}\n${torn}`,
  );

  const ledger = createFileBoardMutationLedger({
    boardName: "event-torn",
    dataDir,
  });
  t.after(() => ledger.close());
  // The read drops the unconfirmed torn tail; the next append must repair
  // the boundary instead of writing after the torn bytes.
  assert.deepEqual(
    (await ledger.readEntriesAfter(0)).map((entry) => entry.seq),
    [1],
  );
  await ledger.appendEntries([ledgerEntry("event-torn", 2)]);
  assert.deepEqual(
    (await ledger.readEntriesAfter(0)).map((entry) => entry.seq),
    [1, 2],
  );

  await ledger.close();
  // A fresh adapter (simulating another reload) must not see corruption.
  const reloaded = createFileBoardMutationLedger({
    boardName: "event-torn",
    dataDir,
  });
  t.after(() => reloaded.close());
  assert.deepEqual(
    (await reloaded.readEntriesAfter(0)).map((entry) => entry.seq),
    [1, 2],
  );
});

test("a complete but unterminated final entry is sealed, not truncated", async (t) => {
  const dataDir = await createDataDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const ledgerPath = path.join(dataDir, "mutation-ledger", "event-seal.jsonl");
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  // The write reached the disk but the fsync (and the trailing newline) did
  // not complete before the crash.
  await fs.writeFile(
    ledgerPath,
    `${JSON.stringify(ledgerEntry("event-seal", 1))}\n${JSON.stringify(ledgerEntry("event-seal", 2))}`,
  );

  const ledger = createFileBoardMutationLedger({
    boardName: "event-seal",
    dataDir,
  });
  t.after(() => ledger.close());
  assert.deepEqual(
    (await ledger.readEntriesAfter(0)).map((entry) => entry.seq),
    [1, 2],
  );
  await ledger.appendEntries([ledgerEntry("event-seal", 3)]);
  assert.deepEqual(
    (await ledger.readEntriesAfter(0)).map((entry) => entry.seq),
    [1, 2, 3],
  );
});

test("corruption before the final line fails the read loudly", async (t) => {
  const dataDir = await createDataDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const ledgerPath = path.join(
    dataDir,
    "mutation-ledger",
    "event-corrupt.jsonl",
  );
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(
    ledgerPath,
    `${[
      JSON.stringify(ledgerEntry("event-corrupt", 1)),
      "{not json}",
      JSON.stringify(ledgerEntry("event-corrupt", 2)),
    ].join("\n")}\n`,
  );

  const ledger = createFileBoardMutationLedger({
    boardName: "event-corrupt",
    dataDir,
  });
  t.after(() => ledger.close());
  await assert.rejects(
    () => ledger.readEntriesAfter(0),
    (/** @type {any} */ error) => error.code === LEDGER_CORRUPT_ERROR_CODE,
  );
});

test("invalid entries and unsafe board names are refused", async (t) => {
  const dataDir = await createDataDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const ledger = createFileBoardMutationLedger({
    boardName: "event-ok",
    dataDir,
  });
  t.after(() => ledger.close());
  await assert.rejects(() =>
    ledger.appendEntries([
      /** @type {any} */ ({ seq: 1, acceptedAtMs: 1, mutation: {} }),
    ]),
  );
  assert.throws(
    () => createFileBoardMutationLedger({ boardName: "../escape", dataDir }),
    /unsafe board name/,
  );
});

test("an empty ledger reads as empty without creating files", async (t) => {
  const dataDir = await createDataDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const ledger = createFileBoardMutationLedger({
    boardName: "event-fresh",
    dataDir,
  });
  t.after(() => ledger.close());
  assert.deepEqual(await ledger.readEntriesAfter(0), []);
  await assert.rejects(
    () => fs.access(path.join(dataDir, "mutation-ledger", "event-fresh.jsonl")),
    { code: "ENOENT" },
  );
});

test("close drains queued appends, releases the handle, and preserves restart recovery", async (t) => {
  const dataDir = await createDataDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const boardName = "event-close";
  const ledger = createFileBoardMutationLedger({ boardName, dataDir });
  t.after(() => ledger.close());
  const open = fs.open;
  /** @type {import("node:fs/promises").FileHandle[]} */
  const handles = [];
  /** @type {() => void} */
  let releaseSync = () => {};
  /** @type {Promise<void>} */
  const syncBarrier = new Promise((resolve) => {
    releaseSync = resolve;
  });
  /** @type {() => void} */
  let notifySync = () => {};
  /** @type {Promise<void>} */
  const syncStarted = new Promise((resolve) => {
    notifySync = resolve;
  });
  t.mock.method(
    fs,
    "open",
    async (
      /** @type {Parameters<typeof fs.open>[0]} */ file,
      /** @type {Parameters<typeof fs.open>[1]} */ flags,
    ) => {
      const handle = await open(file, flags);
      handles.push(handle);
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, "sync", async () => {
        notifySync();
        await syncBarrier;
        await sync();
      });
      return handle;
    },
  );
  const first = ledger.appendEntries([ledgerEntry(boardName, 1)]);
  await syncStarted;
  const second = ledger.appendEntries([ledgerEntry(boardName, 2)]);
  const closing = ledger.close();
  try {
    assert.equal(ledger.close(), closing);
    assert.notEqual(handles[0]?.fd, -1);
    await assert.rejects(
      ledger.appendEntries([ledgerEntry(boardName, 3)]),
      /closed/,
    );
  } finally {
    releaseSync();
    await Promise.allSettled([first, second, closing]);
  }
  await Promise.all([first, second, closing]);
  assert.equal(handles[0]?.fd, -1);
  const expected = [ledgerEntry(boardName, 1), ledgerEntry(boardName, 2)];
  assert.deepEqual(await ledger.readEntriesAfter(0), expected);
  const recovered = createFileBoardMutationLedger({ boardName, dataDir });
  t.after(() => recovered.close());
  assert.deepEqual(await recovered.readEntriesAfter(0), expected);
  await recovered.appendEntries([ledgerEntry(boardName, 3)]);
  await recovered.close();
  assert.deepEqual(await recovered.readEntriesAfter(0), [
    ...expected,
    ledgerEntry(boardName, 3),
  ]);
});

test("close releases handles after fsync failure and across repeated board lifetimes", async (t) => {
  const dataDir = await createDataDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const open = fs.open;
  /** @type {import("node:fs/promises").FileHandle[]} */
  const handles = [];
  t.mock.method(
    fs,
    "open",
    async (
      /** @type {Parameters<typeof fs.open>[0]} */ file,
      /** @type {Parameters<typeof fs.open>[1]} */ flags,
    ) => {
      const handle = await open(file, flags);
      handles.push(handle);
      if (handles.length === 1) {
        t.mock.method(handle, "sync", async () => {
          throw new Error("injected fsync failure");
        });
      }
      return handle;
    },
  );
  for (let i = 0; i < 128; i++) {
    const boardName = `event-cycle-${i}`;
    const ledger = createFileBoardMutationLedger({ boardName, dataDir });
    t.after(() => ledger.close());
    const append = ledger.appendEntries([ledgerEntry(boardName, 1)]);
    if (i === 0) await assert.rejects(append, /injected fsync failure/);
    else await append;
    await ledger.close();
    assert.equal(handles[i]?.fd, -1);
  }
  assert.equal(handles.length, 128);
});

test("closing an unused ledger creates no file and refuses later writes", async (t) => {
  const dataDir = await createDataDir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const ledger = createFileBoardMutationLedger({
    boardName: "event-unused",
    dataDir,
  });
  await ledger.close();
  await assert.rejects(
    ledger.appendEntries([ledgerEntry("event-unused", 1)]),
    /closed/,
  );
  assert.deepEqual(await ledger.readEntriesAfter(0), []);
  assert.deepEqual(await fs.readdir(dataDir), []);
});
