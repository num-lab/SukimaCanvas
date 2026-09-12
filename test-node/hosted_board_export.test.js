const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const {
  createFixture,
  connectSocket,
  cookieFor,
  rectangleCreate,
  ownAcceptance,
  createSocketScenario,
} = require("./helpers/hosted_board_fixture.js");
const {
  createFileBoardExportStore,
  MAX_EXPORT_ATTEMPTS,
} = require("../server/hosted_event/export/store.mjs");
const {
  createBoardExportPipeline,
} = require("../server/hosted_event/export/pipeline.mjs");
const {
  computeArchiveContentBounds,
  renderArchivePng,
  EXPORT_FAILURE_CODES,
  EXPORT_MAX_EDGE_PX,
  EXPORT_PADDING_PX,
} = require("../server/hosted_event/export/render.mjs");
const {
  createFileBoardArchiveStore,
} = require("../server/hosted_event/archive/store.mjs");
const {
  createFileOrganizerStore,
} = require("../server/hosted_event/organizers/store.mjs");
const {
  createFileAccountStore,
} = require("../server/hosted_event/accounts/store.mjs");
const {
  createDefaultStoredSvgEnvelope,
  parseStoredSvgEnvelope,
  serializeStoredSvgEnvelope,
} = require("../server/persistence/svg_envelope.mjs");
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

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** PNG signature every produced export must start with. */
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Chunk types a sanitized export PNG may carry — strictly no metadata chunks. */
const ALLOWED_PNG_CHUNKS = new Set([
  "IHDR",
  "PLTE",
  "tRNS",
  "gAMA",
  "cHRM",
  "sRGB",
  "sBIT",
  "bKGD",
  "pHYs",
  "IDAT",
  "IEND",
]);

/**
 * Minimal 8-bit RGB/RGBA PNG pixel decoder for pixel-boundary assertions:
 * inflates the IDAT stream and reverses the per-row PNG filters.
 *
 * @param {Buffer} buffer
 */
function decodePngPixels(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  /** @type {Buffer[]} */
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  assert.equal(bitDepth, 8, "expected an 8-bit PNG");
  assert.ok(colorType === 6 || colorType === 2, "expected a truecolor PNG");
  const channels = colorType === 6 ? 4 : 3;
  const raw = new Uint8Array(zlib.inflateSync(Buffer.concat(idat)));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  let position = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = at(raw, position);
    position += 1;
    const rowStart = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? at(pixels, rowStart + x - channels) : 0;
      const up = y > 0 ? at(pixels, rowStart - stride + x) : 0;
      const upLeft =
        y > 0 && x >= channels
          ? at(pixels, rowStart - stride + x - channels)
          : 0;
      let value = at(raw, position + x);
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const predictor = left + up - upLeft;
        const pa = Math.abs(predictor - left);
        const pb = Math.abs(predictor - up);
        const pc = Math.abs(predictor - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      pixels[rowStart + x] = value & 0xff;
    }
    position += stride;
  }
  return { width, height, channels, pixels };
}

/**
 * @param {{width: number, height: number, channels: number, pixels: Uint8Array}} image
 * @param {number} x
 * @param {number} y
 * @returns {[number, number, number]}
 */
function rgbAt(image, x, y) {
  const index = (y * image.width + x) * image.channels;
  return [
    at(image.pixels, index),
    at(image.pixels, index + 1),
    at(image.pixels, index + 2),
  ];
}

/** @param {Uint8Array} arr @param {number} index @returns {number} */
const at = (arr, index) => arr[index] ?? 0;

/** @param {[number, number, number]} rgb */
const isWhite = (rgb) => rgb[0] > 250 && rgb[1] > 250 && rgb[2] > 250;

/** @param {Buffer} png */
function assertSanitizedPng(png) {
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE));
  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    assert.ok(
      ALLOWED_PNG_CHUNKS.has(type),
      `no non-allowlisted ${type} chunk in the output`,
    );
    offset += 12 + length;
    if (type === "IEND") break;
  }
}

/**
 * Builds a stored-SVG canvas exactly like the close pipeline archives.
 *
 * @param {string[]} items
 * @param {{width?: number, height?: number, seq?: number}} [options]
 */
function archivedCanvas(items, options = {}) {
  const envelope = createDefaultStoredSvgEnvelope(
    { readonly: false },
    options.seq ?? 1,
    { width: options.width ?? 1000, height: options.height ?? 800 },
  );
  return serializeStoredSvgEnvelope(envelope.prefix, items, envelope.suffix);
}

const RECT_ITEM =
  '<rect id="r1" x="120" y="80" width="120" height="80" stroke="#1f2937" ' +
  'stroke-width="10" fill="none" opacity="0.85"></rect>';

test("the export render produces a white PNG at the content bounds plus margin", () => {
  const canvas = archivedCanvas([RECT_ITEM]);
  const bounds = computeArchiveContentBounds(
    parseStoredSvgEnvelope(canvas).drawingAreaContent,
  );
  assert.ok(bounds);
  assert.equal(bounds.itemCount, 1);

  const rendered = renderArchivePng({ canvasSvg: canvas });
  // The rect spans 120..240 x 80..160 with stroke-width 10, so the content
  // bounds grow by the 5px half-stroke spill; the output adds the margin.
  assert.equal(
    rendered.width,
    bounds.maxX - bounds.minX + 2 * EXPORT_PADDING_PX,
  );
  assert.equal(
    rendered.height,
    bounds.maxY - bounds.minY + 2 * EXPORT_PADDING_PX,
  );

  const image = decodePngPixels(rendered.png);
  assert.equal(image.width, rendered.width);
  assert.equal(image.height, rendered.height);
  // Corners are white background.
  assert.ok(isWhite(rgbAt(image, 1, 1)), "top-left corner is white");
  assert.ok(
    isWhite(rgbAt(image, image.width - 2, image.height - 2)),
    "bottom-right corner is white",
  );
  // A content coordinate at (cx, cy) lands at output
  // (cx - minX + padding, cy - minY + padding). The rect's left stroke edge
  // is at cx = 120, vertically centered on the rect.
  const strokeX = Math.round(120 - bounds.minX) + EXPORT_PADDING_PX;
  const strokeY =
    Math.round((bounds.maxY + bounds.minY) / 2 - bounds.minY) +
    EXPORT_PADDING_PX;
  const stroke = rgbAt(image, strokeX, strokeY);
  assert.ok(
    stroke[0] < 120 && stroke[1] < 120 && stroke[2] < 120,
    `rect stroke renders dark at (${strokeX}, ${strokeY}): ${stroke.join(",")}`,
  );
  assert.ok(
    isWhite(rgbAt(image, strokeX + 15, strokeY)),
    "the rect interior is unfilled",
  );
});

test("PNG export renders the smoothed Pencil curve", () => {
  const frame =
    '<rect id="frame" x="0" y="0" width="200" height="200" stroke="#ffffff" ' +
    'stroke-width="4" fill="#ffffff"></rect>';
  const pencil =
    '<path id="pencil-turn" d="M 40 40 l 80 0 l 0 80" stroke="#000000" ' +
    'stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"></path>';

  const rendered = renderArchivePng({
    canvasSvg: archivedCanvas([frame, pencil], {
      width: 200,
      height: 200,
    }),
  });
  assert.equal(rendered.width, 268);
  assert.equal(rendered.height, 268);

  const image = decodePngPixels(rendered.png);
  const curvePixel = rgbAt(image, 125, 66);
  assert.ok(
    curvePixel.every((channel) => channel < 120),
    `the smoothed curve covers (125, 66): ${curvePixel.join(",")}`,
  );
});

test("Pencil bounds include transformed stroke scale and shear", () => {
  const pencil =
    '<path id="transformed-pencil" d="M 10 20 l 20 0" stroke="#000000" ' +
    'stroke-width="10" fill="none" stroke-linecap="round" stroke-linejoin="round" ' +
    'transform="matrix(3 0 4 5 0 0)"></path>';

  assert.deepEqual(computeArchiveContentBounds(pencil), {
    minX: 85,
    minY: 75,
    maxX: 195,
    maxY: 125,
    itemCount: 1,
  });
});

test("item attribution and internal metadata never reach the rendered output", () => {
  const attributed =
    '<rect id="r1" x="120" y="80" width="120" height="80" stroke="#1f2937" ' +
    'stroke-width="10" fill="none" data-wbo-created-by="participant-secret-4f2a"></rect>';
  const plain =
    '<rect id="r1" x="120" y="80" width="120" height="80" stroke="#1f2937" ' +
    'stroke-width="10" fill="none"></rect>';
  const withAttribution = renderArchivePng({
    canvasSvg: archivedCanvas([attributed]),
  });
  const withoutAttribution = renderArchivePng({
    canvasSvg: archivedCanvas([plain]),
  });
  assert.deepEqual(
    [...withAttribution.png],
    [...withoutAttribution.png],
    "attribution attributes cannot influence the rendered bytes",
  );
  assertSanitizedPng(withAttribution.png);
  assert.ok(
    !withAttribution.png.includes("participant-secret-4f2a"),
    "the participant identifier never appears in the output bytes",
  );
});

test("content is scaled down to the 8192px edge cap and empty boards export blank", () => {
  const bigRect =
    '<rect id="big" x="0" y="0" width="30000" height="20000" stroke="#111111" ' +
    'stroke-width="4" fill="none"></rect>';
  const scaled = renderArchivePng({
    canvasSvg: archivedCanvas([bigRect], { width: 5000, height: 5000 }),
  });
  assert.equal(
    scaled.width,
    EXPORT_MAX_EDGE_PX,
    "the longest edge hits the cap",
  );
  assert.ok(scaled.height <= EXPORT_MAX_EDGE_PX);
  assert.ok(
    scaled.height > EXPORT_MAX_EDGE_PX / 2,
    "the shorter edge scales proportionally",
  );

  const empty = renderArchivePng({ canvasSvg: archivedCanvas([]) });
  assert.equal(empty.width, 1000 + 2 * EXPORT_PADDING_PX);
  assert.equal(empty.height, 800 + 2 * EXPORT_PADDING_PX);
  const emptyImage = decodePngPixels(empty.png);
  assert.ok(
    isWhite(rgbAt(emptyImage, 400, 300)),
    "an empty export is blank white",
  );

  // Content with negative coordinates is fully covered by the viewport.
  const negative =
    '<rect id="neg" x="-500" y="-400" width="120" height="80" stroke="#111111" ' +
    'stroke-width="4" fill="none"></rect>';
  const negativeRender = renderArchivePng({
    canvasSvg: archivedCanvas([negative]),
  });
  const negativeImage = decodePngPixels(negativeRender.png);
  // The rect's top-left stroke corner sits at the content origin offset by
  // the padding.
  const corner = rgbAt(
    negativeImage,
    EXPORT_PADDING_PX + 1,
    EXPORT_PADDING_PX + 1,
  );
  assert.ok(
    corner.some((channel) => channel < 120),
    `the stroke reaches into the image: ${corner.join(",")}`,
  );
});

test("unrenderable archives fail with deterministic codes", () => {
  const cases = /** @type {[string, string][]} */ ([
    ["", EXPORT_FAILURE_CODES.ARCHIVE_INVALID],
    ['<svg><g id="drawingArea">oops', EXPORT_FAILURE_CODES.ARCHIVE_INVALID],
  ]);
  for (const [canvas, code] of cases) {
    assert.throws(() => renderArchivePng({ canvasSvg: canvas }), { code });
  }
  assert.throws(
    () =>
      renderArchivePng({
        canvasSvg: archivedCanvas([RECT_ITEM]),
        maxEdgePx: 40,
        paddingPx: 24,
      }),
    { code: EXPORT_FAILURE_CODES.OUTPUT_LIMIT },
    "padding larger than the cap fails deterministically",
  );
});

test("export jobs are durable, token-gated, revocable, and deletable", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-export-store-"));
  const holder = { now: 1_000_000 };
  const store = createFileBoardExportStore({
    dataDir,
    clock: () => holder.now,
    linkTtlMs: DAY,
    hmacKey: "export-test-secret",
  });

  // Pending jobs are idempotent; the pending job is returned, not duplicated.
  const first = await store.createExport({
    boardSessionId: "bs-1",
    eventId: "ev-1",
    organizerId: "org-1",
    requestedByAccountId: "acc-1",
  });
  assert.ok(first.created);
  const duplicate = await store.createExport({
    boardSessionId: "bs-1",
    eventId: "ev-1",
    organizerId: "org-1",
    requestedByAccountId: "acc-1",
  });
  assert.ok(!duplicate.created);
  assert.equal(duplicate.export.exportId, first.export.exportId);
  assert.equal(first.export.status, "queued");

  // A restart sees the same records: the store is durable.
  const reopened = createFileBoardExportStore({
    dataDir,
    clock: () => holder.now,
    linkTtlMs: DAY,
    hmacKey: "export-test-secret",
  });
  assert.ok(reopened.getExport(first.export.exportId));
  assert.equal(reopened.listExportsForEvent("ev-1").length, 1);

  const claimed = await reopened.markExportProcessing(first.export.exportId);
  assert.ok(claimed.ok);
  assert.equal(reopened.getExport(first.export.exportId)?.status, "processing");
  assert.equal(reopened.getExport(first.export.exportId)?.attempts, 1);

  const fakePng = Buffer.concat([PNG_SIGNATURE, Buffer.from("fake-pixels")]);
  const succeeded = await reopened.markExportSucceeded({
    exportId: first.export.exportId,
    bytes: fakePng,
    width: 320,
    height: 240,
    sha256: "ab".repeat(32),
  });
  assert.ok(succeeded.ok);
  const stored = reopened.getExport(first.export.exportId);
  assert.equal(stored?.status, "succeeded");
  assert.equal(stored?.result?.width, 320);
  assert.ok(stored?.finishedAtMs);
  const readBack = await reopened.readExportBytes(first.export.exportId);
  assert.ok(readBack?.equals(fakePng));

  // The derived download token verifies, expires, revokes, and dies.
  const token = reopened.downloadHrefToken(first.export.exportId);
  assert.ok(token);
  assert.ok(
    reopened.verifyExportDownloadToken({
      exportId: first.export.exportId,
      token,
    }).ok,
  );
  assert.equal(
    reopened.verifyExportDownloadToken({
      exportId: first.export.exportId,
      token: `${token}x`,
    }).ok,
    false,
  );
  const expiry = reopened.downloadLinkExpiry(first.export.exportId);
  assert.equal(expiry?.expiresAtMs, (stored?.finishedAtMs ?? 0) + DAY);
  holder.now += DAY + MINUTE;
  const expiredVerdict = reopened.verifyExportDownloadToken({
    exportId: first.export.exportId,
    token,
  });
  assert.equal(
    expiredVerdict.ok === false ? expiredVerdict.reason : "",
    "expired",
  );
  assert.equal(reopened.downloadHrefToken(first.export.exportId), null);
  holder.now = 1_000_000;
  const revoked = await reopened.revokeExportDownload(first.export.exportId);
  assert.ok(revoked.ok);
  const revokedVerdict = reopened.verifyExportDownloadToken({
    exportId: first.export.exportId,
    token,
  });
  assert.equal(
    revokedVerdict.ok === false ? revokedVerdict.reason : "",
    "revoked",
  );
  assert.equal((await reopened.deleteExport(first.export.exportId)).ok, true);
  assert.equal(reopened.getExport(first.export.exportId), null);
  assert.equal(await reopened.readExportBytes(first.export.exportId), null);
  await reopened.flush();
});

test("an orphaned processing job is recovered by the next runner pass", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-export-crash-"));
  const holder = { now: 2_000_000 };
  const store = createFileBoardExportStore({
    dataDir,
    clock: () => holder.now,
    linkTtlMs: DAY,
    hmacKey: "export-test-secret",
  });
  const created = await store.createExport({
    boardSessionId: "bs-1",
    eventId: "ev-1",
    organizerId: "org-1",
    requestedByAccountId: "acc-1",
  });
  await store.markExportProcessing(created.export.exportId);
  // Simulated crash: the job stays `processing` while no runner exists — and
  // the next pass still finds it instead of losing the work.
  const orphans = store.listDueExports({ now: holder.now });
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0]?.status, "processing");
  await store.requeueOrphanedExport(created.export.exportId);
  const requeued = store.listDueExports({ now: holder.now })[0];
  assert.equal(requeued?.status, "queued");
  assert.equal(
    (await store.markExportProcessing(created.export.exportId)).ok,
    true,
    "the re-queued job is claimable again",
  );
});

test("the export pipeline renders the sealed archive exactly once and never re-runs settled jobs", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-export-pipeline-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now(), {
        config: scenario.sockets.__config,
      });
      const holder = fixture.holder;
      const exportStore = createFileBoardExportStore({
        dataDir: fixture.dataDir,
        clock: () => holder.now,
        linkTtlMs: DAY,
        hmacKey: "export-test-secret",
      });
      const exportPipeline = createBoardExportPipeline({
        exportStore,
        archiveStore: fixture.archiveStore,
        organizerStore: fixture.organizerStore,
        config: scenario.sockets.__config,
        clock: () => holder.now,
      });

      // A session that is not archived cannot be exported.
      const early = await exportPipeline.requestExport({
        boardSessionId: fixture.boardSession.boardSessionId,
        eventId: fixture.event.eventId,
        organizerId: fixture.event.organizerId,
        requestedByAccountId: fixture.owner.accountId,
      });
      assert.ok(early.ok === false);
      assert.equal(
        early.ok === false ? early.reason : "",
        "session_not_archived",
      );

      // Draw one rectangle, then let the session drain and seal.
      holder.now = fixture.boardSession.startsAtMs;
      await fixture.organizerStore.advanceLifecycle({ now: holder.now });
      const alice = await connectSocket(
        scenario,
        fixture.hostedModule,
        fixture.event.boardName,
        cookieFor(fixture.owner.rawSessionId),
        "socket-alice",
      );
      assert.ok(alice.ok && alice.created);
      await scenario.invoke(
        alice.created,
        "broadcast",
        rectangleCreate("rect-1", "cm-1"),
      );
      ownAcceptance(alice.created, "cm-1");
      holder.now = fixture.boardSession.endsAtMs + MINUTE;
      await fixture.hostedModule.refreshEventLifecycle();
      assert.equal(
        fixture.organizerStore.getBoardSessionForEvent(fixture.event.eventId)
          ?.status,
        "closed",
      );

      const requested = await exportPipeline.requestExport({
        boardSessionId: fixture.boardSession.boardSessionId,
        eventId: fixture.event.eventId,
        organizerId: fixture.event.organizerId,
        requestedByAccountId: fixture.owner.accountId,
      });
      assert.ok(requested.ok);
      const pending = await exportPipeline.requestExport({
        boardSessionId: fixture.boardSession.boardSessionId,
        eventId: fixture.event.eventId,
        organizerId: fixture.event.organizerId,
        requestedByAccountId: fixture.owner.accountId,
      });
      assert.ok(pending.ok);
      assert.equal(pending.ok === true ? pending.created : true, false);

      const pass = await exportPipeline.runDueExports({ now: holder.now });
      assert.equal(pass.succeeded.length, 1);
      assert.deepEqual(pass.failed, []);
      const exportId = /** @type {string} */ (pass.succeeded[0]);
      const record = exportStore.getExport(exportId);
      assert.equal(record?.status, "succeeded");
      assert.ok((record?.result?.width ?? 0) > 0);
      const bytes = await exportStore.readExportBytes(exportId);
      assert.ok(bytes);
      assertSanitizedPng(bytes);
      assert.equal(
        crypto.createHash("sha256").update(bytes).digest("hex"),
        record?.result?.sha256,
      );
      // The rendered image is the archived canvas projection: the drawn rect
      // produced visible content.
      const image = decodePngPixels(bytes);
      assert.ok(
        image.pixels.some((channel) => channel < 120),
        "the exported image contains drawn content",
      );

      // Repeated passes never re-run a settled job.
      const secondPass = await exportPipeline.runDueExports({
        now: holder.now + HOUR,
      });
      assert.deepEqual(secondPass.succeeded, []);
      assert.equal(exportStore.getExport(exportId)?.attempts, 1);
      assert.ok(
        /** @type {Buffer} */ (
          await exportStore.readExportBytes(exportId)
        ).equals(/** @type {Buffer} */ (bytes)),
      );
    },
  );
});

test("overlapping export passes share one renderer and recover from async failure", {
  timeout: 30_000,
}, async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-export-overlap-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now(), {
        config: scenario.sockets.__config,
      });
      const holder = fixture.holder;
      holder.now = fixture.boardSession.endsAtMs + MINUTE;
      await fixture.hostedModule.refreshEventLifecycle();
      const exportStore = createFileBoardExportStore({
        dataDir: fixture.dataDir,
        clock: () => holder.now,
        linkTtlMs: DAY,
        hmacKey: "export-test-secret",
      });
      let signalStarted = () => {};
      const started = new Promise((resolve) => {
        signalStarted = () => resolve(undefined);
      });
      /** @type {(error: Error) => void} */
      let rejectRender = () => {};
      const rendering = new Promise((_resolve, reject) => {
        rejectRender = reject;
      });
      let renderCalls = 0;
      const pipeline = createBoardExportPipeline({
        exportStore,
        archiveStore: fixture.archiveStore,
        organizerStore: fixture.organizerStore,
        config: scenario.sockets.__config,
        clock: () => holder.now,
        renderArchivePng: async (input) => {
          renderCalls += 1;
          if (renderCalls === 1) {
            signalStarted();
            await rendering;
          }
          return renderArchivePng(input);
        },
      });
      const requested = await pipeline.requestExport({
        boardSessionId: fixture.boardSession.boardSessionId,
        eventId: fixture.event.eventId,
        organizerId: fixture.event.organizerId,
        requestedByAccountId: fixture.owner.accountId,
      });
      assert.ok(requested.ok);
      const first = pipeline.runDueExports();
      await started;
      const overlapping = pipeline.runDueExports();
      assert.equal(overlapping, first, "lifecycle kicks join the active pass");
      assert.equal(renderCalls, 1);
      rejectRender(
        Object.assign(new Error("renderer timed out"), {
          code: "render_timeout",
        }),
      );
      const failed = await first;
      assert.deepEqual(failed.failed, [
        { exportId: requested.export.exportId, code: "render_timeout" },
      ]);
      const record = exportStore.getExport(requested.export.exportId);
      assert.equal(record?.status, "failed");
      assert.equal(record?.attempts, 1);
      assert.equal(record?.failure?.code, "render_timeout");
      holder.now += MINUTE;
      const retried = await pipeline.runDueExports({ retryMs: 0 });
      assert.deepEqual(retried.succeeded, [requested.export.exportId]);
      assert.equal(renderCalls, 2);
      assert.equal(
        exportStore.getExport(requested.export.exportId)?.attempts,
        2,
      );
    },
  );
});

test("failed exports retry inside the attempt budget and then stay settled", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-export-retry-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now(), {
        config: scenario.sockets.__config,
      });
      const holder = fixture.holder;
      holder.now = fixture.boardSession.endsAtMs + MINUTE;
      await fixture.hostedModule.refreshEventLifecycle();

      const exportStore = createFileBoardExportStore({
        dataDir: fixture.dataDir,
        clock: () => holder.now,
        linkTtlMs: DAY,
        hmacKey: "export-test-secret",
      });
      /**
       * @param {(input: {canvasSvg: string}) => {png: Buffer, width: number, height: number}} render
       */
      const buildPipeline = (render) =>
        createBoardExportPipeline({
          exportStore,
          archiveStore: fixture.archiveStore,
          organizerStore: fixture.organizerStore,
          config: scenario.sockets.__config,
          clock: () => holder.now,
          renderArchivePng: render,
        });
      const request = () =>
        buildPipeline(renderArchivePng).requestExport({
          boardSessionId: fixture.boardSession.boardSessionId,
          eventId: fixture.event.eventId,
          organizerId: fixture.event.organizerId,
          requestedByAccountId: fixture.owner.accountId,
        });

      assert.ok((await request()).ok);

      const failingRender = () => {
        const error = /** @type {Error & {code: string}} */ (
          new Error("fontconfig exploded")
        );
        error.code = EXPORT_FAILURE_CODES.RENDER_FAILED;
        throw error;
      };
      const failingPipeline = buildPipeline(failingRender);
      for (let attempt = 1; attempt <= MAX_EXPORT_ATTEMPTS; attempt += 1) {
        const pass = await failingPipeline.runDueExports({
          now: holder.now,
          retryMs: 0,
        });
        assert.deepEqual(pass.succeeded, []);
        assert.equal(pass.failed.length, 1);
        assert.equal(pass.failed[0]?.code, "render_failed");
        const record = exportStore.getExport(
          /** @type {string} */ (pass.failed[0]?.exportId),
        );
        assert.equal(record?.status, "failed");
        assert.equal(record?.attempts, attempt);
        assert.equal(record?.failure?.code, "render_failed");
        if (attempt === 1) {
          // Inside the retry budget the failed job still holds the session's
          // export slot: a new request joins it instead of duplicating work.
          const joined = await request();
          assert.ok(joined.ok);
          assert.equal(joined.ok === true ? joined.created : true, false);
        }
        holder.now += MINUTE;
      }
      // Past the attempt budget the job is terminal: further passes do
      // nothing, so no task repeats forever.
      const extraPass = await failingPipeline.runDueExports({
        now: holder.now + DAY,
        retryMs: 0,
      });
      assert.deepEqual(extraPass.succeeded, []);
      assert.deepEqual(extraPass.failed, []);
      assert.equal(
        exportStore.listDueExports({ now: holder.now, retryMs: 0 }).length,
        0,
      );

      // A fresh request creates a new job that can succeed.
      const retried = await request();
      assert.ok(retried.ok);
      assert.equal(retried.ok === true ? retried.created : true, true);
      const retryPass = await buildPipeline(renderArchivePng).runDueExports({
        now: holder.now,
      });
      assert.equal(retryPass.succeeded.length, 1);
    },
  );
});

test("export creation, download, revocation, and deletion are authorized end to end", async () => {
  const holder = { now: Date.now() };
  const clock = () => holder.now;
  const server = await createHostedServer({
    HOSTED_CLOCK: clock,
    HOSTED_BOARD_EXPORT_LINK_TTL_MS: DAY,
  });
  try {
    await runAuthorizedExportFlow(server, holder);
  } finally {
    await closeServer(server.app);
  }
});

/**
 * The whole seeded organizer flow against the real HTTP surface.
 *
 * @param {any} server
 * @param {{now: number}} holder
 */
async function runAuthorizedExportFlow(server, holder) {
  const clock = () => holder.now;
  const dataDir = path.join(server.root, "hosted-data");
  const password = STRONG_PASSWORD;
  const ownerEmail = "export-owner@example.com";

  // The owner registers through the real HTTP surface first, so the seeded
  // organizer can be owned by exactly that account.
  await registerAccount(server.app, ownerEmail, password);
  await verifyAccount(server.app, server.outboxDir, ownerEmail);
  const owner = await loginSession(server.app, ownerEmail, password);
  const accountStore = createFileAccountStore({
    dataDir,
    clock,
    sessionMaxAgeMs: DAY,
    sessionIdleMs: DAY,
  });
  const ownerAccount = accountStore.getAccountByEmail(ownerEmail);
  assert.ok(ownerAccount);

  // Seed the organizer, event, and a sealed Board Session with a real
  // Private Board Archive directly through the durable stores, exactly like
  // the close pipeline leaves them.
  const organizerStore = createFileOrganizerStore({ dataDir, clock });
  const application = await organizerStore.submitApplication({
    accountId: ownerAccount.accountId,
    organizerName: "Export Collective",
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
  const created = await organizerStore.createReservation({
    organizerId,
    createdByAccountId: ownerAccount.accountId,
    eventName: "Export Jam",
    visibility: "unlisted",
    startsAtMs: holder.now + HOUR,
    endsAtMs: holder.now + 2 * HOUR,
    requestedSeats: 2,
  });
  assert.ok(created.ok);
  await organizerStore.submitReservation({
    reservationId: created.reservation.reservationId,
    actorAccountId: ownerAccount.accountId,
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
  const boardSession = organizerStore.getBoardSessionForEvent(event.eventId);
  assert.ok(boardSession);

  await organizerStore.advanceLifecycle({ now: boardSession.startsAtMs });
  await organizerStore.advanceLifecycle({
    now: boardSession.endsAtMs + MINUTE,
  });
  const archiveStore = createFileBoardArchiveStore({ dataDir });
  const canvas = archivedCanvas([RECT_ITEM]);
  const manifest = {
    format: "sukimacanvas-board-archive-v1",
    boardSessionId: boardSession.boardSessionId,
    eventId: event.eventId,
    organizerId,
    finalSeq: 1,
    itemCount: 1,
    acceptedMutationCount: 1,
    integrity: {
      "canvas.svg": crypto.createHash("sha256").update(canvas).digest("hex"),
      "ledger.jsonl": crypto.createHash("sha256").update("").digest("hex"),
    },
  };
  await archiveStore.putArchive(
    `board-archives/${boardSession.boardSessionId}/canvas.svg`,
    canvas,
  );
  await archiveStore.putArchive(
    `board-archives/${boardSession.boardSessionId}/manifest.json`,
    JSON.stringify(manifest),
  );
  const sealed = await organizerStore.markBoardSessionClosed({
    boardSessionId: boardSession.boardSessionId,
    archiveKey: `board-archives/${boardSession.boardSessionId}/manifest.json`,
    finalSeq: 1,
    archivedAtMs: holder.now,
  });
  assert.ok(sealed.ok);
  await organizerStore.flush();

  const consolePath = `/organizers/${organizerId}/events/${event.eventId}?lang=en`;
  const consolePage = await requestWithCookies(server.app, consolePath, {
    cookie: owner.sessionCookie,
  });
  assert.equal(consolePage.statusCode, 200);
  assert.ok(consolePage.body.includes("Request export"));
  assert.ok(!consolePage.body.includes("/download?token="));
  // The CSRF token rendered on this page pairs with this page's CSRF cookie.
  const csrfToken = formValue(consolePage.body, "_csrf");
  const csrfCookie = cookiePair(consolePage.setCookie, "hosted-csrf-v1");
  const ownerCookies = `${owner.sessionCookie}; ${csrfCookie}`;

  // Requesting the export enqueues a job; the pipeline runs it on the next
  // lifecycle pass and the console then exposes the authorized link.
  const requested = await requestWithCookies(
    server.app,
    `/organizers/${organizerId}/events/${event.eventId}/exports`,
    {
      method: "POST",
      cookie: ownerCookies,
      body: new URLSearchParams({ _csrf: csrfToken }).toString(),
    },
  );
  assert.equal(requested.statusCode, 303);
  // The export pass runs detached so requests never block on rendering: poll
  // until the runner settles the job and the console shows the result.
  let readyPage = null;
  for (let attempt = 0; attempt < 100 && readyPage === null; attempt += 1) {
    await server.hostedEventModule.refreshEventLifecycle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const candidate = await requestWithCookies(server.app, consolePath, {
      cookie: owner.sessionCookie,
    });
    if (candidate.statusCode === 200 && candidate.body.includes("Ready")) {
      readyPage = candidate;
    }
  }
  assert.ok(readyPage, "the export job reached its success state");
  assert.ok(
    readyPage.body.includes("Ready"),
    "the job reached its success state",
  );
  const linkMatch =
    /href="(organizers\/[^"]+\/exports\/[^"]+\/download\?[^"]+)"/.exec(
      readyPage.body,
    );
  assert.ok(linkMatch, "the console renders the download link");
  // Handlebars escapes the href attribute; the browser decodes it before
  // requesting, so the test does the same.
  const downloadPath = `/${/** @type {RegExpExecArray} */ (linkMatch)[1] ?? ""}`
    .replace(/&#x3D;/g, "=")
    .replace(/&amp;/g, "&");

  const download = await requestWithCookies(server.app, downloadPath, {
    cookie: owner.sessionCookie,
    binary: true,
  });
  assert.equal(download.statusCode, 200);
  const png = Buffer.from(download.body, "latin1");
  assertSanitizedPng(png);
  assert.equal(download.headers["content-type"], "image/png");
  assert.equal(download.headers["cache-control"], "no-store");
  assert.ok(
    /** @type {string} */ (download.headers["content-disposition"]).startsWith(
      "attachment; filename=",
    ),
  );

  // Authorization: the link dies without a session, a member session, or the
  // exact token.
  const anonymous = await requestWithCookies(server.app, downloadPath);
  assert.equal(anonymous.statusCode, 303, "signed-out requests go to login");
  const tampered = await requestWithCookies(server.app, `${downloadPath}x`, {
    cookie: owner.sessionCookie,
  });
  assert.equal(tampered.statusCode, 404);

  const outsiderEmail = "export-outsider@example.com";
  await registerAccount(server.app, outsiderEmail, password);
  await verifyAccount(server.app, server.outboxDir, outsiderEmail);
  const outsider = await loginSession(server.app, outsiderEmail, password);
  const outsiderDownload = await requestWithCookies(server.app, downloadPath, {
    cookie: outsider.sessionCookie,
  });
  assert.equal(
    outsiderDownload.statusCode,
    404,
    "a signed-in non-member cannot download",
  );
  const outsiderRequest = await requestWithCookies(
    server.app,
    `/organizers/${organizerId}/events/${event.eventId}/exports`,
    {
      method: "POST",
      cookie: `${outsider.sessionCookie}; ${outsider.csrfCookie}`,
      body: `_csrf=${csrfToken}`,
    },
  );
  assert.equal(outsiderRequest.statusCode, 404);

  // Revoking the link kills it immediately; deleting the export removes it.
  const exportId =
    new URL(downloadPath, "http://x").pathname.split("/")[6] ?? "";
  const revoked = await requestWithCookies(
    server.app,
    `/organizers/${organizerId}/events/${event.eventId}/exports/${exportId}/revoke`,
    {
      method: "POST",
      cookie: ownerCookies,
      body: `_csrf=${csrfToken}`,
    },
  );
  assert.equal(revoked.statusCode, 303);
  const afterRevoke = await requestWithCookies(server.app, downloadPath, {
    cookie: owner.sessionCookie,
  });
  assert.equal(
    afterRevoke.statusCode,
    404,
    "the revoked link stops working immediately",
  );
  const afterRevokePage = await requestWithCookies(server.app, consolePath, {
    cookie: owner.sessionCookie,
  });
  assert.ok(
    !afterRevokePage.body.includes("/download?token="),
    "the console stops offering the revoked link",
  );
  const deleted = await requestWithCookies(
    server.app,
    `/organizers/${organizerId}/events/${event.eventId}/exports/${exportId}/delete`,
    {
      method: "POST",
      cookie: ownerCookies,
      body: `_csrf=${csrfToken}`,
    },
  );
  assert.equal(deleted.statusCode, 303);
  const afterDelete = await requestWithCookies(server.app, consolePath, {
    cookie: owner.sessionCookie,
  });
  assert.equal(afterDelete.statusCode, 200);
  assert.ok(
    !afterDelete.body.includes(exportId),
    "the deleted export disappears from the console",
  );
}
