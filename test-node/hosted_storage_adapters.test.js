const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  createS3BoardArchiveStore,
} = require("../server/hosted_event/archive/s3_store.mjs");
const {
  createFileBrandAssetStore,
} = require("../server/hosted_event/assets/store.mjs");
const {
  createFileBoardExportStore,
} = require("../server/hosted_event/export/store.mjs");
const {
  createPostgresPersistence,
} = require("../server/hosted_event/storage/postgres.mjs");
const {
  createHostedServer,
  loginSession,
  registerAccount,
  verifyAccount,
  STRONG_PASSWORD,
} = require("./helpers/hosted_http.js");
const { closeServer } = require("./test_helpers.js");

class FakeS3Client {
  constructor() {
    /** @type {Map<string, Buffer>} */
    this.objects = new Map();
    this.heads = 0;
  }

  /** @param {{constructor: {name: string}, input: any}} command */
  async send(command) {
    const { input } = command;
    switch (command.constructor.name) {
      case "HeadBucketCommand":
        this.heads += 1;
        return {};
      case "PutObjectCommand": {
        const key = String(input.Key);
        if (input.IfNoneMatch === "*" && this.objects.has(key)) {
          throw httpError(412);
        }
        this.objects.set(key, Buffer.from(input.Body));
        return {};
      }
      case "GetObjectCommand": {
        const bytes = this.objects.get(String(input.Key));
        if (!bytes) throw httpError(404);
        return {
          Body: {
            async transformToByteArray() {
              return bytes;
            },
          },
        };
      }
      case "ListObjectsV2Command": {
        const keys = [...this.objects.keys()]
          .filter((key) => key.startsWith(String(input.Prefix || "")))
          .sort();
        return {
          Contents: keys.map((Key) => ({ Key })),
          IsTruncated: false,
        };
      }
      case "DeleteObjectCommand":
        this.objects.delete(String(input.Key));
        return {};
      default:
        throw new Error(`Unexpected S3 command: ${command.constructor.name}`);
    }
  }
}

/** @param {number} status */
function httpError(status) {
  return Object.assign(new Error(`S3 ${status}`), {
    $metadata: { httpStatusCode: status },
  });
}

function createFakeObjectStore(client = new FakeS3Client()) {
  return {
    client,
    store: createS3BoardArchiveStore({
      endpoint: "https://example.r2.cloudflarestorage.com",
      bucket: "sukimacanvas-test",
      region: "auto",
      prefix: "test-run",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      client: /** @type {any} */ (client),
    }),
  };
}

test("storage adapters reject unsafe deployment configuration before I/O", () => {
  assert.throws(
    () =>
      createPostgresPersistence({
        connectionString: "postgresql://example.invalid/database",
        ssl: false,
        maxConnections: 1,
      }),
    /at least 2/,
  );
  assert.throws(
    () =>
      createS3BoardArchiveStore({
        endpoint: "https://user:secret@example.invalid",
        bucket: "bucket",
        accessKeyId: "access",
        secretAccessKey: "secret",
      }),
    /without credentials/,
  );
  assert.throws(
    () =>
      createS3BoardArchiveStore({
        endpoint: "https://example.invalid",
        bucket: "bucket",
        prefix: "../production",
        accessKeyId: "access",
        secretAccessKey: "secret",
      }),
    /unsafe Board Archive key/,
  );
});

test("the S3 adapter preserves immutable archive semantics and private prefixes", async () => {
  const { client, store } = createFakeObjectStore();
  await store.initialize();
  assert.equal(client.heads, 1);
  assert.deepEqual(
    [...client.objects.keys()].filter((key) => key.includes("storage-probes/")),
    [],
  );

  await store.putArchive("board-archives/session/canvas.svg", "first");
  await store.putArchive("board-archives/session/canvas.svg", "first");
  await assert.rejects(
    store.putArchive("board-archives/session/canvas.svg", "changed"),
    { code: "WBO_ARCHIVE_OBJECT_EXISTS" },
  );
  assert.equal(
    (await store.readArchive("board-archives/session/canvas.svg"))?.toString(
      "utf8",
    ),
    "first",
  );
  assert.deepEqual(await store.listObjectKeys("board-archives/session"), [
    "board-archives/session/canvas.svg",
  ]);
  assert.ok(client.objects.has("test-run/board-archives/session/canvas.svg"));
  await store.deleteObject("board-archives/session/canvas.svg");
  assert.equal(
    await store.readArchive("board-archives/session/canvas.svg"),
    null,
  );
});

test("Brand Assets and PNG Exports put their bytes through object storage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-object-store-"));
  const { client, store } = createFakeObjectStore();

  const assets = createFileBrandAssetStore({
    dataDir: root,
    objectStore: store,
    randomId: () => "asset-one",
  });
  const assetBytes = Buffer.from("png-bytes");
  const asset = await assets.putAsset({
    kind: "organizer_logo",
    organizerId: "organizer-one",
    format: "png",
    contentType: "image/png",
    bytes: assetBytes,
  });
  assert.equal(asset.assetId, "asset-one");
  assert.deepEqual(await assets.readAssetBytes(asset.assetId), assetBytes);
  assert.ok(client.objects.has("test-run/brand-assets/asset-one.png"));
  await assets.deleteAsset(asset.assetId);
  assert.ok(!client.objects.has("test-run/brand-assets/asset-one.png"));

  const exports = createFileBoardExportStore({
    dataDir: root,
    objectStore: store,
    randomId: () => "export-one",
    linkTtlMs: 60_000,
    hmacKey: "test-hmac-key",
  });
  await exports.createExport({
    boardSessionId: "session-one",
    eventId: "event-one",
    organizerId: "organizer-one",
    requestedByAccountId: "account-one",
  });
  await exports.markExportProcessing("export-one");
  const exportBytes = Buffer.from("png-result");
  await exports.markExportSucceeded({
    exportId: "export-one",
    bytes: exportBytes,
    width: 10,
    height: 10,
    sha256: "abc",
  });
  assert.deepEqual(await exports.readExportBytes("export-one"), exportBytes);
  assert.ok(client.objects.has("test-run/image-exports/export-one.png"));
  await exports.deleteExport("export-one");
  assert.ok(!client.objects.has("test-run/image-exports/export-one.png"));
});

const postgresUrl = process.env.WBO_TEST_POSTGRES_URL;

test("PostgreSQL persists state documents and ordered mutation ledger entries", {
  skip: postgresUrl ? false : "set WBO_TEST_POSTGRES_URL",
}, async () => {
  const runId = crypto.randomBytes(6).toString("hex");
  const documentKey = `adapter-test-${runId}.json`;
  const sessionDocumentKey = `adapter-session-test-${runId}.json`;
  const boardName = `event-board-${runId}`;
  const options = {
    connectionString: /** @type {string} */ (postgresUrl),
    ssl: /** @type {false} */ (false),
  };
  const first = createPostgresPersistence(options);
  await first.initialize();
  try {
    await first.stateDocuments.writeMany([
      {
        key: documentKey,
        payload: { version: 1, accounts: [{ accountId: "a1" }] },
      },
      {
        key: sessionDocumentKey,
        payload: { version: 1, sessions: {} },
      },
    ]);
    const ledger = first.createBoardMutationLedger(boardName);
    await ledger.appendEntries([
      {
        seq: 1,
        acceptedAtMs: 1000,
        eventId: "event-one",
        boardSessionId: "session-one",
        accountId: "account-one",
        mutation: {
          type: 1,
          tool: 3,
          id: "item-one",
          color: "#000000",
          size: 10,
          x: 1,
          y: 2,
          x2: 3,
          y2: 4,
          clientMutationId: "mutation-one",
        },
      },
    ]);

    const competing = createPostgresPersistence(options);
    await assert.rejects(competing.initialize(), /already owns/);
  } finally {
    await first.close();
  }

  const restarted = createPostgresPersistence(options);
  await restarted.initialize();
  try {
    assert.deepEqual(restarted.stateDocuments.read(documentKey, null), {
      version: 1,
      accounts: [{ accountId: "a1" }],
    });
    const ledger = restarted.createBoardMutationLedger(boardName);
    assert.deepEqual(await ledger.readEntriesAfter(0), [
      {
        seq: 1,
        acceptedAtMs: 1000,
        eventId: "event-one",
        boardSessionId: "session-one",
        accountId: "account-one",
        mutation: {
          x: 1,
          y: 2,
          x2: 3,
          y2: 4,
          id: "item-one",
          size: 10,
          tool: 3,
          type: 1,
          color: "#000000",
          clientMutationId: "mutation-one",
        },
      },
    ]);
    await restarted.deleteBoardMutationLedger(boardName);
    assert.deepEqual(await ledger.readEntriesAfter(0), []);
  } finally {
    await restarted.close();
  }
});

test("the composed Hosted account flow survives a PostgreSQL-backed restart", {
  skip: postgresUrl ? false : "set WBO_TEST_POSTGRES_URL",
}, async () => {
  const runId = crypto.randomBytes(6).toString("hex");
  const databaseConfig = {
    HOSTED_STATE_STORE: "postgres",
    HOSTED_DATABASE_URL: postgresUrl,
    HOSTED_DATABASE_SSL: "disable",
    HOSTED_DATABASE_MAX_CONNECTIONS: 5,
  };
  const email = `postgres-restart-${runId}@example.com`;
  const first = await createHostedServer(databaseConfig);
  try {
    await registerAccount(first.app, email, STRONG_PASSWORD);
    await verifyAccount(first.app, first.outboxDir, email);
  } finally {
    await closeServer(first.app);
  }

  const restarted = await createHostedServer(databaseConfig);
  try {
    const session = await loginSession(restarted.app, email, STRONG_PASSWORD);
    assert.match(session.sessionCookie, /^hosted-session-v1=/);
  } finally {
    await closeServer(restarted.app);
  }
});
