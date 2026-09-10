const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { once } = require("node:events");
const http = require("node:http");
const { syncBuiltinESMExports } = require("node:module");
const {
  EXPORT_RENDER_TIMEOUT_MS,
  renderArchivePngInChildProcess,
} = require("../server/hosted_event/export/render_process.mjs");
const {
  createDefaultStoredSvgEnvelope,
  serializeStoredSvgEnvelope,
} = require("../server/persistence/svg_envelope.mjs");

/** @param {string[]} items */
function canvas(items = []) {
  const envelope = createDefaultStoredSvgEnvelope({ readonly: false }, 1, {
    width: 1000,
    height: 1000,
  });
  return serializeStoredSvgEnvelope(envelope.prefix, items, envelope.suffix);
}

/** Observe real children without changing the production renderer interface.
 * @param {import("node:test").TestContext} t
 */
function observeChildren(t) {
  const fork = childProcess.fork;
  /** @type {import("node:child_process").ChildProcess[]} */
  const children = [];
  /** @param {Parameters<typeof childProcess.fork>} args */
  const observedFork = (...args) => {
    const child = fork(...args);
    children.push(child);
    return child;
  };
  t.mock.method(childProcess, "fork", observedFork);
  syncBuiltinESMExports();
  t.after(() => {
    for (const child of children) child.kill("SIGKILL");
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return children;
}

test("render deadline kills the real child before rejecting and permits a later render", {
  timeout: 30_000,
}, async (t) => {
  const children = observeChildren(t);
  const exitListeners = process.listenerCount("exit");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const render = renderArchivePngInChildProcess({ canvasSvg: canvas() });
  const rejected = assert.rejects(render, { code: "render_timeout" });
  assert.ok(children[0]);
  await once(children[0], "spawn");
  t.mock.timers.tick(EXPORT_RENDER_TIMEOUT_MS);
  await rejected;
  assert.equal(children[0]?.signalCode, "SIGKILL");
  assert.equal(process.listenerCount("exit"), exitListeners);
  t.mock.timers.reset();
  const next = await renderArchivePngInChildProcess({ canvasSvg: canvas() });
  assert.ok(Buffer.isBuffer(next.png));
  assert.equal(children.length, 2);
  assert.equal(process.listenerCount("exit"), exitListeners);
});

test("unexpected child death is render_failed and leaves no exit hook", {
  timeout: 30_000,
}, async (t) => {
  const children = observeChildren(t);
  const exitListeners = process.listenerCount("exit");
  const render = renderArchivePngInChildProcess({ canvasSvg: canvas() });
  const rejected = assert.rejects(render, { code: "render_failed" });
  assert.ok(children[0]?.kill("SIGKILL"));
  await rejected;
  assert.equal(children[0]?.signalCode, "SIGKILL");
  assert.equal(process.listenerCount("exit"), exitListeners);
});

test("renderer validation failures retain their deterministic code across IPC", {
  timeout: 30_000,
}, async () => {
  const exitListeners = process.listenerCount("exit");
  await assert.rejects(
    renderArchivePngInChildProcess({ canvasSvg: "not an archived SVG" }),
    { code: "archive_invalid" },
  );
  assert.equal(process.listenerCount("exit"), exitListeners);
});

test("HTTP requests and timer heartbeats progress while a real export renders", {
  timeout: 30_000,
}, async (t) => {
  const server = http.createServer((_request, response) => response.end("ok"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const items = Array.from(
    { length: 512 },
    (_, i) =>
      `<text id="t${i}" x="${(i % 20) * 40}" y="${Math.floor(i / 20) * 25 + 25}" font-size="14">Export ${i}</text>`,
  );
  let rendering = true;
  let heartbeats = 0;
  let responsesDuringRender = 0;
  /** @type {Promise<void>[]} */
  const requests = [];
  /** @type {Error[]} */
  const requestErrors = [];
  const timer = setInterval(() => {
    heartbeats += 1;
    requests.push(
      new Promise((resolve) => {
        /** @param {Error} error */
        const fail = (error) => {
          requestErrors.push(error);
          resolve();
        };
        http
          .get(`http://127.0.0.1:${address.port}`, (response) => {
            response.resume();
            response.on("end", () => {
              if (rendering) responsesDuringRender += 1;
              resolve();
            });
            response.on("error", fail);
          })
          .on("error", fail);
      }),
    );
  }, 10);
  t.after(() => clearInterval(timer));
  try {
    const result = await renderArchivePngInChildProcess({
      canvasSvg: canvas(items),
    });
    assert.ok(Buffer.isBuffer(result.png));
  } finally {
    rendering = false;
    clearInterval(timer);
    await Promise.all(requests);
  }
  assert.deepEqual(requestErrors, []);
  assert.ok(heartbeats > 0, "parent timers ran before the export completed");
  assert.ok(
    responsesDuringRender > 0,
    "HTTP completed before the export completed",
  );
});
