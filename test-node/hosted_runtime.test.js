const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { closeServer, createConfig, request } = require("./test_helpers.js");
const { createServerApp } = require("../server/server.mjs");
const { parseBooleanEnv } = require("../server/configuration/helpers.mjs");

const CLIENT_WEBROOT = path.join(__dirname, "..", "client-data");

/**
 * @returns {Promise<string>}
 */
async function createHistoryDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), "wbo-hosted-runtime-"));
}

test("hosted mode configuration accepts explicit boolean values", () => {
  assert.equal(
    parseBooleanEnv("TEST_FLAG", false, { TEST_FLAG: "true" }),
    true,
  );
  assert.equal(
    parseBooleanEnv("TEST_FLAG", true, { TEST_FLAG: "disabled" }),
    false,
  );
  assert.equal(parseBooleanEnv("TEST_FLAG", true, {}), true);
  assert.throws(
    () => parseBooleanEnv("TEST_FLAG", false, { TEST_FLAG: "sometimes" }),
    /Invalid TEST_FLAG/,
  );
});

/**
 * @param {{runtime?: import("../types/server-runtime.d.ts").ServerRuntime}} capture
 * @returns {import("../types/server-runtime.d.ts").SocketServerModule}
 */
function createSocketModule(capture) {
  return {
    async start(_app, _config, runtime) {
      capture.runtime = runtime;
    },
    async shutdown() {},
  };
}

test("hosted mode serves localized home and versioned corresponding source", async () => {
  const historyDir = await createHistoryDirectory();
  /** @type {{runtime?: import("../types/server-runtime.d.ts").ServerRuntime}} */
  const capture = {};
  const app = await createServerApp(
    createConfig({
      HOST: "127.0.0.1",
      PORT: 0,
      HISTORY_DIR: historyDir,
      WEBROOT: CLIENT_WEBROOT,
      HOSTED_MODE: true,
      AUTH_SECRET_KEY: "hosted-test-secret",
      DEPLOYMENT_VERSION: "2026.09.02+abc123",
      CORRESPONDING_SOURCE_URL:
        "https://code.example.test/sukimacanvas/tree/{version}",
      CORRESPONDING_SOURCE_BUILD:
        "Use the pinned revision with the documented production build command.",
    }),
    {
      logStarted: false,
      socketsModule: createSocketModule(capture),
    },
  );

  try {
    assert.ok(capture.runtime);
    const hostedModule = capture.runtime.hostedEventModule;
    const originalServeHome = hostedModule.serveHome;
    let servedThroughSharedRuntime = false;
    hostedModule.serveHome = (ctx) => {
      servedThroughSharedRuntime = true;
      return originalServeHome(ctx);
    };

    const chinese = await request(app, "/?lang=zh-CN");
    const fallback = await request(app, "/?lang=fr");
    const regionalFallback = await request(app, "/?lang=zh-TW");
    const source = await request(app, "/source?lang=en");
    const stylesheet = await request(app, "/hosted.css");

    assert.equal(chinese.statusCode, 200);
    assert.match(chinese.body, /<html lang="zh-CN" dir="ltr">/);
    assert.match(chinese.body, /SukimaCanvas/);
    assert.match(chinese.body, /对应源代码/);
    assert.match(chinese.body, /href="source"/);

    assert.equal(fallback.statusCode, 200);
    assert.match(fallback.body, /<html lang="en" dir="ltr">/);

    assert.equal(regionalFallback.statusCode, 200);
    assert.match(regionalFallback.body, /<html lang="en" dir="ltr">/);

    assert.equal(source.statusCode, 200);
    assert.match(source.body, /2026\.09\.02\+abc123/);
    assert.match(
      source.body,
      /https:\/\/code\.example\.test\/sukimacanvas\/tree\/2026\.09\.02%2Babc123/,
    );
    assert.match(source.body, /documented production build command/);
    assert.match(source.body, /<a[^>]+href="\."/);

    assert.equal(stylesheet.statusCode, 200);
    assert.match(stylesheet.headers["content-type"] || "", /text\/css/);
    assert.match(stylesheet.body, /--hosted-background/);

    assert.equal(servedThroughSharedRuntime, true);
    assert.equal(typeof hostedModule.serveHome, "function");
    assert.equal(typeof hostedModule.serveSource, "function");
  } finally {
    await closeServer(app);
  }
});

test("source page clearly reports an unavailable deployment mapping", async () => {
  const historyDir = await createHistoryDirectory();
  const app = await createServerApp(
    createConfig({
      HOST: "127.0.0.1",
      PORT: 0,
      HISTORY_DIR: historyDir,
      WEBROOT: CLIENT_WEBROOT,
      HOSTED_MODE: true,
      AUTH_SECRET_KEY: "hosted-test-secret",
      DEPLOYMENT_VERSION: "",
      CORRESPONDING_SOURCE_URL: "",
    }),
    {
      logStarted: false,
      socketsModule: createSocketModule({}),
    },
  );

  try {
    const response = await request(app, "/source?lang=zh-CN");

    assert.equal(response.statusCode, 503);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.match(response.body, /对应源代码/);
    assert.match(response.body, /不可用|映射/);
    assert.doesNotMatch(response.body, /undefined|null/);
  } finally {
    await closeServer(app);
  }
});

test("source page rejects rolling source URLs", async () => {
  const historyDir = await createHistoryDirectory();
  const app = await createServerApp(
    createConfig({
      HOST: "127.0.0.1",
      PORT: 0,
      HISTORY_DIR: historyDir,
      WEBROOT: CLIENT_WEBROOT,
      HOSTED_MODE: true,
      AUTH_SECRET_KEY: "hosted-test-secret",
      DEPLOYMENT_VERSION: "main",
      CORRESPONDING_SOURCE_URL:
        "https://code.example.test/sukimacanvas/tree/{version}",
      CORRESPONDING_SOURCE_BUILD: "Build from the pinned revision.",
    }),
    {
      logStarted: false,
      socketsModule: createSocketModule({}),
    },
  );

  try {
    const response = await request(app, "/source?lang=en");

    assert.equal(response.statusCode, 503);
    assert.match(response.body, /Corresponding Source unavailable/);
    assert.doesNotMatch(response.body, /\/tree\/main/);
  } finally {
    await closeServer(app);
  }
});

test("legacy mode keeps the configured default-board redirect", async () => {
  const historyDir = await createHistoryDirectory();
  const app = await createServerApp(
    createConfig({
      HOST: "127.0.0.1",
      PORT: 0,
      HISTORY_DIR: historyDir,
      WEBROOT: CLIENT_WEBROOT,
      HOSTED_MODE: false,
      DEFAULT_BOARD: "Legacy Board",
    }),
    {
      logStarted: false,
      socketsModule: createSocketModule({}),
    },
  );

  try {
    const response = await request(app, "/");

    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, "/boards/legacy-board");
    assert.equal(response.body, "legacy-board");

    const source = await request(app, "/source");
    assert.equal(source.statusCode, 404);
    for (const asset of ["/hosted.css", "/hosted.html", "/source.html"]) {
      const assetResponse = await request(app, asset);
      assert.equal(assetResponse.statusCode, 404);
    }
    const boardAsset = await request(app, "/boards/hosted.css");
    assert.equal(boardAsset.statusCode, 404);
  } finally {
    await closeServer(app);
  }
});

test("a fail-closed startup reports its reason before exiting", async () => {
  // The entry point's structured log record does not survive its own
  // `process.exit`, so an operator deploying a misconfigured instance would
  // otherwise see status 1 and an empty log. The reason must reach stderr even
  // when the structured logger is silenced.
  const historyDir = await createHistoryDirectory();
  const hostedDir = await createHistoryDirectory();
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "..", "server", "server.mjs")],
    {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        WBO_SILENT: "true",
        WBO_HOSTED_MODE: "true",
        WBO_HOSTED_DATA_DIR: hostedDir,
        WBO_HISTORY_DIR: historyDir,
        PORT: "0",
        // Hosted mode fail-closes without it: participant identifiers, the
        // webhook signature, and the export download token all derive from it.
        AUTH_SECRET_KEY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(exitCode, 1, `expected a refused start, got ${exitCode}`);
  assert.match(stderr, /server\.start_failed/);
  assert.match(stderr, /AUTH_SECRET_KEY/);
});
