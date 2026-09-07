const test = require("node:test");
const assert = require("node:assert/strict");
const {
  importLegacySvgCanvas,
  MAX_HISTORICAL_IMPORT_BYTES,
} = require("../server/hosted_event/history/legacy_svg_import.mjs");

/** A structurally valid legacy WBO board with one item per stored tag. */
const VALID_LEGACY_SVG = [
  '<svg id="canvas" xmlns="http://www.w3.org/2000/svg" version="1.1"',
  ' width="1000" height="800" data-wbo-format="whitebophir-svg-v2"',
  ' data-wbo-seq="42" data-wbo-readonly="false">',
  '<defs id="defs"></defs>',
  '<g id="drawingArea">',
  '<rect id="r1" x="120" y="80" width="120" height="80" stroke="#1f2937" stroke-width="10" fill="none" opacity="0.85"></rect>',
  '<line id="s1" x1="0" y1="0" x2="50" y2="50" stroke="#000000" stroke-width="5" fill="none"></line>',
  '<ellipse id="e1" cx="300" cy="300" rx="40" ry="20" stroke="#000000" stroke-width="5" fill="none"></ellipse>',
  '<path id="l1" d="M 120 80 l 20 10" stroke="#1f2937" stroke-width="10" fill="none" stroke-linecap="round" stroke-linejoin="round"></path>',
  '<text id="t1" x="120" y="220" font-size="24" fill="#1f2937">Hello WBO</text>',
  "</g>",
  '<g id="cursors"></g>',
  "</svg>",
].join("\n");

/**
 * @param {unknown} error
 * @param {string} code
 * @returns {boolean}
 */
function assertFailureCode(error, code) {
  const coded = /** @type {{code?: string, message?: string}} */ (error);
  assert.equal(coded.code, code, `expected ${code}, got: ${coded.message}`);
  return true;
}

test("a structurally valid legacy SVG imports as a canonical read-only canvas", () => {
  const result = importLegacySvgCanvas({
    bytes: Buffer.from(VALID_LEGACY_SVG, "utf8"),
  });
  assert.equal(result.itemCount, 5);
  assert.ok(result.sourceSha256, "the source digest is reported");
  assert.equal(result.strippedAttributionCount, 0);
  assert.ok(result.canvas.startsWith('<svg id="canvas"'));
  assert.ok(result.canvas.includes('data-wbo-readonly="true"'));
  assert.ok(result.canvas.includes('data-wbo-seq="0"'));
  assert.ok(result.canvas.includes('data-wbo-format="whitebophir-svg-v2"'));
  // Every source item survives as its canonical stored tag with its fields.
  assert.ok(result.canvas.includes('<rect id="r1" x="120" y="80"'));
  assert.ok(result.canvas.includes('width="120" height="80"'));
  assert.ok(
    result.canvas.includes('<line id="s1" x1="0" y1="0" x2="50" y2="50"'),
  );
  assert.ok(result.canvas.includes("<ellipse"));
  assert.ok(result.canvas.includes('<path id="l1" d="M 120 80 l 20 10"'));
  assert.ok(result.canvas.includes("<text"));
  assert.ok(result.canvas.includes("Hello WBO"));
  assert.ok(result.canvas.includes('<g id="drawingArea">'));
  assert.ok(result.canvas.includes('<g id="cursors"></g>'));
});

test("a valid legacy SVG without a UTF-8 BOM marker imports after BOM stripping", () => {
  const bytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(VALID_LEGACY_SVG, "utf8"),
  ]);
  const result = importLegacySvgCanvas({ bytes });
  assert.equal(result.itemCount, 5);
});

test("an empty drawing area is a valid, empty historical canvas", () => {
  const empty = [
    '<svg id="canvas" xmlns="http://www.w3.org/2000/svg" version="1.1"',
    ' width="1000" height="800" data-wbo-format="whitebophir-svg-v2"',
    ' data-wbo-seq="42" data-wbo-readonly="false">',
    '<defs id="defs"></defs>',
    '<g id="drawingArea"></g>',
    '<g id="cursors"></g>',
    "</svg>",
  ].join("\n");
  const result = importLegacySvgCanvas({ bytes: Buffer.from(empty, "utf8") });
  assert.equal(result.itemCount, 0);
  assert.ok(result.canvas.includes('<g id="drawingArea"></g>'));
});

test("forged item attribution is stripped, never imported", () => {
  const forged = VALID_LEGACY_SVG.replace(
    '<rect id="r1"',
    '<rect id="r1" data-wbo-created-by="participant-forged"',
  ).replace('<text id="t1"', '<text id="t1" data-wbo-created-by="x"');
  const result = importLegacySvgCanvas({ bytes: Buffer.from(forged, "utf8") });
  assert.equal(result.itemCount, 5);
  assert.equal(result.strippedAttributionCount, 2);
  assert.ok(
    !result.canvas.includes("data-wbo-created-by"),
    "no forged creator attribute survives the import",
  );
});

test("hostile attributes and markup around the drawing area never reach the stored canvas", () => {
  const hostile = [
    '<svg id="canvas" xmlns="http://www.w3.org/2000/svg" version="1.1" width="1000" height="800"',
    ' onload="alert(1)" data-wbo-format="whitebophir-svg-v2" data-wbo-seq="7" data-wbo-readonly="false">',
    "<script>alert('prefix-junk')</script>",
    '<defs id="defs"><foreignObject><iframe src="https://evil.example"></iframe></foreignObject></defs>',
    '<g id="drawingArea">',
    '<rect id="r1" x="10" y="10" width="20" height="20" stroke="#000" stroke-width="3" fill="none" onmouseover="alert(1)" filter="url(#x)"></rect>',
    "</g>",
    "<script>alert('tail-junk')</script>",
    '<g id="cursors"></g>',
    "</svg>",
  ].join("");
  const result = importLegacySvgCanvas({ bytes: Buffer.from(hostile, "utf8") });
  assert.equal(result.itemCount, 1);
  assert.equal(
    (result.canvas.match(/<script/g) || []).length,
    0,
    "no script tag survives",
  );
  assert.ok(!result.canvas.includes("onload="));
  assert.ok(!result.canvas.includes("onmouseover="));
  assert.ok(!result.canvas.includes("foreignObject"));
  assert.ok(!result.canvas.includes("evil.example"));
  assert.ok(!result.canvas.includes("filter="));
  assert.ok(result.canvas.includes('<rect id="r1" x="10" y="10"'));
});

test("escaped text content round-trips through the canonical canvas", () => {
  const source = VALID_LEGACY_SVG.replace(
    ">Hello WBO</text>",
    ">1 &lt; 2 &amp; 3</text>",
  );
  const result = importLegacySvgCanvas({ bytes: Buffer.from(source, "utf8") });
  // Stored SVG escapes with numeric entities; the decoded text must be equal.
  assert.ok(result.canvas.includes("1 &#60; 2 &#38; 3</text>"));
  assert.ok(
    !/&lt;|&amp;/.test(result.canvas.slice(result.canvas.indexOf("<text"))),
    "the stored form uses the canonical numeric escaping",
  );
});

test("empty, oversized, and undecodable uploads are deterministic rejections", () => {
  assert.throws(
    () => importLegacySvgCanvas({ bytes: Buffer.alloc(0) }),
    (error) => assertFailureCode(error, "WBO_HISTORY_IMPORT_EMPTY"),
  );
  assert.throws(
    () =>
      importLegacySvgCanvas({
        bytes: Buffer.alloc(1000),
        maxBytes: 10,
      }),
    (error) => assertFailureCode(error, "WBO_HISTORY_IMPORT_TOO_LARGE"),
  );
  assert.throws(
    () =>
      importLegacySvgCanvas({
        bytes: Buffer.from(VALID_LEGACY_SVG, "utf8"),
        maxBytes: 10,
      }),
    (error) => assertFailureCode(error, "WBO_HISTORY_IMPORT_TOO_LARGE"),
  );
  assert.throws(
    () =>
      importLegacySvgCanvas({
        bytes: Buffer.from([0xff, 0xfe, 0x3c, 0x73, 0x76, 0x67]),
      }),
    (error) => assertFailureCode(error, "WBO_HISTORY_IMPORT_ENCODING"),
  );
});

test("structurally broken SVGs are rejected, not silently repaired", () => {
  /** @type {[string, string][]} */
  const cases = [
    ["no drawing area", "<svg><g id='other'></g></svg>"],
    [
      "unterminated drawing area",
      '<svg><g id="drawingArea"><rect id="r1" x="0" y="0" width="1" height="1" stroke="#000" stroke-width="1"></svg>',
    ],
    [
      "unknown child element",
      VALID_LEGACY_SVG.replace(
        '<rect id="r1"',
        '<image id="i1" href="https://evil.example/x.png"',
      ).replace("</rect>", "></image>"),
    ],
    [
      "script element inside the drawing area",
      VALID_LEGACY_SVG.replace(
        '<rect id="r1"',
        '<script>alert(1)</script><rect id="r1"',
      ),
    ],
    [
      "nested group",
      VALID_LEGACY_SVG.replace(
        '<rect id="r1"',
        '<g id="nested"><rect id="r1"',
      ).replace("</rect>", "></rect></g>"),
    ],
    [
      "duplicate item id",
      VALID_LEGACY_SVG.replace('<line id="s1"', '<line id="r1"'),
    ],
    [
      "item without required geometry",
      VALID_LEGACY_SVG.replace(
        '<rect id="r1" x="120" y="80" width="120" height="80" stroke="#1f2937" stroke-width="10" fill="none" opacity="0.85"></rect>',
        '<rect id="r1" x="120" y="80" stroke="#1f2937"></rect>',
      ),
    ],
    [
      "text item without position",
      VALID_LEGACY_SVG.replace(
        '<text id="t1" x="120" y="220" font-size="24" fill="#1f2937">Hello WBO</text>',
        '<text id="t1">Hello WBO</text>',
      ),
    ],
    [
      "pencil path without points",
      VALID_LEGACY_SVG.replace(
        '<path id="l1" d="M 120 80 l 20 10" stroke="#1f2937" stroke-width="10" fill="none" stroke-linecap="round" stroke-linejoin="round"></path>',
        '<path id="l1" d="" stroke="#1f2937" stroke-width="10"></path>',
      ),
    ],
    [
      "unparsable root width",
      VALID_LEGACY_SVG.replace(
        'width="1000" height="800"',
        'width="not-a-number" height="800"',
      ),
    ],
  ];
  for (const [label, source] of cases) {
    assert.throws(
      () => importLegacySvgCanvas({ bytes: Buffer.from(source, "utf8") }),
      (error) => {
        const coded = /** @type {{code?: string, message?: string}} */ (error);
        assert.ok(
          coded.code === "WBO_HISTORY_IMPORT_STRUCTURE" ||
            coded.code === "WBO_HISTORY_IMPORT_ITEM_INVALID",
          `${label}: unexpected ${coded.code}: ${coded.message}`,
        );
        assert.ok((coded.message || "").length > 0);
        return true;
      },
      `expected rejection: ${label}`,
    );
  }
});

test("the default size cap is a bounded, finite byte limit", () => {
  assert.ok(Number.isSafeInteger(MAX_HISTORICAL_IMPORT_BYTES));
  assert.ok(MAX_HISTORICAL_IMPORT_BYTES > 1024);
  assert.ok(MAX_HISTORICAL_IMPORT_BYTES <= 64 * 1024 * 1024);
});

const os = require("node:os");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  createFileHistoricalArchiveStore,
} = require("../server/hosted_event/history/store.mjs");
const {
  createFileBoardArchiveStore,
} = require("../server/hosted_event/archive/store.mjs");
const {
  createFileOrganizerStore,
} = require("../server/hosted_event/organizers/store.mjs");

/**
 * Provisions one approved Organizer plus the historical archive store against
 * an isolated data directory.
 *
 * @returns {Promise<{root: string, dataDir: string, organizerId: string, organizerStore: any, archiveStore: any, historyStore: any, holder: {now: number}}>}
 */
async function createHistoryFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-history-"));
  const dataDir = path.join(root, "hosted-data");
  const holder = { now: 1750000000000 };
  const organizerStore = createFileOrganizerStore({
    dataDir,
    clock: () => holder.now,
  });
  const application = await organizerStore.submitApplication({
    accountId: "account-1",
    organizerName: "Aurora Collective",
    contactName: "Mika Rin",
    contactEmail: "contact@example.com",
    description: "Jams.",
  });
  assert.ok(application.ok, "application accepted");
  const approved = await organizerStore.approveApplication({
    applicationId: application.application.applicationId,
    operatorAccountId: "operator-1",
  });
  assert.ok(approved.ok, "application approved");
  const organizerId = approved.organizerId;
  const archiveStore = createFileBoardArchiveStore({ dataDir });
  const historyStore = createFileHistoricalArchiveStore({
    dataDir,
    clock: () => holder.now,
    archiveStore,
    organizerStore,
  });
  return {
    root,
    dataDir,
    organizerId,
    organizerStore,
    archiveStore,
    historyStore,
    holder,
  };
}

test("a controlled import produces a private immutable archive with unknown authorship and no change audit", async () => {
  const fixture = await createHistoryFixture();
  try {
    const result = await fixture.historyStore.importLegacySvg({
      organizerId: fixture.organizerId,
      bytes: Buffer.from(VALID_LEGACY_SVG, "utf8"),
      sourceLabel: "workshop-2019.svg",
      operatorAccountId: "operator-1",
    });
    assert.ok(result.ok);
    const record = result.record;
    assert.equal(record.status, "imported");
    assert.equal(record.itemCount, 5);
    assert.equal(record.organizerId, fixture.organizerId);
    assert.equal(record.importedByAccountId, "operator-1");
    assert.ok(record.importId.startsWith("ha-"));
    assert.equal(record.failure, null);

    // The archive objects: canvas plus manifest, no ledger — the absence of a
    // Change Audit boundary is itself part of the artifact's contract.
    const manifest = JSON.parse(
      (await fixture.archiveStore.readArchive(record.manifestKey))?.toString(
        "utf8",
      ) || "{}",
    );
    assert.equal(manifest.format, "sukimacanvas-historical-archive-v1");
    assert.equal(manifest.authorship, "unknown");
    assert.equal(manifest.changeAudit, "none");
    assert.equal(manifest.organizerId, fixture.organizerId);
    assert.equal(manifest.itemCount, 5);
    const canvas = (
      await fixture.archiveStore.readArchive(record.canvasKey)
    )?.toString("utf8");
    assert.ok(canvas);
    assert.equal(
      manifest.integrity["canvas.svg"],
      crypto
        .createHash("sha256")
        .update(Buffer.from(canvas, "utf8"))
        .digest("hex"),
      "the manifest binds the stored canvas bytes",
    );
    assert.ok(canvas.includes('data-wbo-readonly="true"'));
    assert.ok(!canvas.includes("data-wbo-created-by"));
    const keys = await fixture.archiveStore.listObjectKeys(
      `historical-archives/${record.importId}`,
    );
    assert.deepEqual(
      keys.map((/** @type {string} */ key) => key.split("/").pop()),
      ["canvas.svg", "manifest.json"],
    );
    await fixture.historyStore.flush();
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("re-importing the same source for the same organizer is a deterministic refusal, never a second artifact", async () => {
  const fixture = await createHistoryFixture();
  try {
    const first = await fixture.historyStore.importLegacySvg({
      organizerId: fixture.organizerId,
      bytes: Buffer.from(VALID_LEGACY_SVG, "utf8"),
      sourceLabel: "workshop-2019.svg",
      operatorAccountId: "operator-1",
    });
    assert.ok(first.ok);
    const second = await fixture.historyStore.importLegacySvg({
      organizerId: fixture.organizerId,
      bytes: Buffer.from(VALID_LEGACY_SVG, "utf8"),
      sourceLabel: "workshop-2019.svg",
      operatorAccountId: "operator-1",
    });
    assert.equal(second.ok, false);
    assert.equal(second.reason, "duplicate");
    assert.equal(second.record.importId, first.record.importId);
    const imports = fixture.historyStore.listImports();
    assert.equal(
      imports.filter(
        (/** @type {any} */ record) => record.status === "imported",
      ).length,
      1,
    );
    // The same source under a different organizer is a distinct archive.
    const application = await fixture.organizerStore.submitApplication({
      accountId: "account-2",
      organizerName: "Other Collective",
      contactName: "Rin",
      contactEmail: "contact2@example.com",
      description: "More jams.",
    });
    const otherApproval = await fixture.organizerStore.approveApplication({
      applicationId: application.application.applicationId,
      operatorAccountId: "operator-1",
    });
    assert.ok(otherApproval.ok);
    const otherOrganizerId = otherApproval.organizerId;
    const third = await fixture.historyStore.importLegacySvg({
      organizerId: otherOrganizerId,
      bytes: Buffer.from(VALID_LEGACY_SVG, "utf8"),
      sourceLabel: "workshop-2019.svg",
      operatorAccountId: "operator-1",
    });
    assert.ok(third.ok);
    assert.notEqual(third.record.importId, first.record.importId);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("a rejected import leaves no archive and records the deterministic failure reason", async () => {
  const fixture = await createHistoryFixture();
  try {
    const broken = Buffer.from(
      '<svg><g id="drawingArea"><script>alert(1)</script></g></svg>',
      "utf8",
    );
    const result = await fixture.historyStore.importLegacySvg({
      organizerId: fixture.organizerId,
      bytes: broken,
      sourceLabel: "hostile.svg",
      operatorAccountId: "operator-1",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "rejected");
    assert.equal(result.failure.code, "WBO_HISTORY_IMPORT_STRUCTURE");
    assert.ok(result.failure.message.length > 0);
    // No archive objects at all.
    assert.deepEqual(
      await fixture.archiveStore.listObjectKeys("historical-archives"),
      [],
    );
    const imports = fixture.historyStore.listImports();
    assert.equal(imports.length, 1);
    assert.equal(imports[0].status, "failed");
    assert.equal(imports[0].failure.code, "WBO_HISTORY_IMPORT_STRUCTURE");
    assert.equal(imports[0].sourceLabel, "hostile.svg");
    // A failed import leaves nothing behind: a valid re-import succeeds.
    const retried = await fixture.historyStore.importLegacySvg({
      organizerId: fixture.organizerId,
      bytes: Buffer.from(VALID_LEGACY_SVG, "utf8"),
      sourceLabel: "fixed.svg",
      operatorAccountId: "operator-1",
    });
    assert.ok(retried.ok);
    assert.equal(
      fixture.historyStore
        .listImports()
        .filter((/** @type {any} */ r) => r.status === "imported").length,
      1,
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("an interrupted import recovers idempotently: the retry completes the same archive under the same import id", async () => {
  const fixture = await createHistoryFixture();
  try {
    // The commit marker cannot be written: the import fails after the canvas
    // object is in place, exactly like a crash between puts.
    const realPut = fixture.archiveStore.putArchive.bind(fixture.archiveStore);
    fixture.archiveStore.putArchive = async (
      /** @type {string} */ key,
      /** @type {string | Uint8Array} */ content,
    ) => {
      if (key.endsWith("/manifest.json")) {
        const error = /** @type {Error & {code: string}} */ (
          new Error("EACCES: permission denied")
        );
        error.code = "EACCES";
        throw error;
      }
      return realPut(key, content);
    };
    const failed = await fixture.historyStore.importLegacySvg({
      organizerId: fixture.organizerId,
      bytes: Buffer.from(VALID_LEGACY_SVG, "utf8"),
      sourceLabel: "workshop-2019.svg",
      operatorAccountId: "operator-1",
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, "storage_write_failed");
    fixture.archiveStore.putArchive = realPut;

    // A fresh store instance (a restarted process) finishes the import: the
    // deterministic import id makes the canvas put the byte-identical no-op
    // it must be, the manifest lands, and exactly one imported record exists.
    const restarted = createFileHistoricalArchiveStore({
      dataDir: fixture.dataDir,
      clock: () => fixture.holder.now,
      archiveStore: createFileBoardArchiveStore({ dataDir: fixture.dataDir }),
      organizerStore: createFileOrganizerStore({
        dataDir: fixture.dataDir,
        clock: () => fixture.holder.now,
      }),
    });
    const recovered = await restarted.importLegacySvg({
      organizerId: fixture.organizerId,
      bytes: Buffer.from(VALID_LEGACY_SVG, "utf8"),
      sourceLabel: "workshop-2019.svg",
      operatorAccountId: "operator-2",
    });
    assert.ok(recovered.ok);
    const imports = restarted.listImports();
    assert.equal(
      imports.filter((record) => record.status === "imported").length,
      1,
    );
    assert.equal(
      imports.filter((record) => record.status === "failed").length,
      1,
      "the failed attempt stays in the audit trail",
    );
    // And the recovered archive is the one the failed attempt started.
    assert.equal(recovered.record.importId, failed.record.importId);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("an import for an unknown organizer is refused without a record", async () => {
  const fixture = await createHistoryFixture();
  try {
    const result = await fixture.historyStore.importLegacySvg({
      organizerId: "no-such-organizer",
      bytes: Buffer.from(VALID_LEGACY_SVG, "utf8"),
      sourceLabel: "x.svg",
      operatorAccountId: "operator-1",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unknown_organizer");
    assert.equal(fixture.historyStore.listImports().length, 0);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

// --- operator console HTTP integration -------------------------------------

const {
  STRONG_PASSWORD,
  createHostedServer,
  requestWithCookies,
  formValue,
  signUpAndLogin,
} = require("./helpers/hosted_http.js");
const { closeServer } = require("./test_helpers.js");

const OPERATOR_EMAIL = "operator@example.com";
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/**
 * Builds a multipart/form-data body with text fields and an optional file
 * part, matching the bounded parser the upload route uses.
 *
 * @param {{[name: string]: string}} fields
 * @param {{name: string, filename: string, content: Buffer | string} | null} file
 * @returns {{body: Buffer, contentType: string}}
 */
function multipartForm(fields, file) {
  const boundary = `----wboboundary${Date.now().toString(36)}`;
  /** @type {Buffer[]} */
  const chunks = [];
  /**
   * @param {string} value
   * @returns {void}
   */
  const push = (value) => {
    chunks.push(Buffer.from(value, "utf8"));
  };
  for (const [name, value] of Object.entries(fields)) {
    push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    );
  }
  if (file) {
    push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: image/svg+xml\r\n\r\n`,
    );
    chunks.push(Buffer.from(file.content));
    push("\r\n");
  }
  push(`--${boundary}--\r\n`);
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** @param {{csrfCookie: string}} jar */
const csrfOf = (jar) => jar.csrfCookie.split("=")[1] || "";
/** @param {{sessionCookie: string, csrfCookie: string}} jar */
const jarCookie = (jar) => `${jar.sessionCookie}; ${jar.csrfCookie}`;

/**
 * Provisions the operator and one approved organizer through the real HTTP
 * flows, returning the shared session jars and the organizer id.
 */
/** @param {import("http").Server} app @param {string} outboxDir */
async function provisionOperatorAndOrganizer(app, outboxDir) {
  const operator = await signUpAndLogin(
    app,
    outboxDir,
    OPERATOR_EMAIL,
    STRONG_PASSWORD,
  );
  const owner = await signUpAndLogin(
    app,
    outboxDir,
    `owner-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    STRONG_PASSWORD,
  );
  const applied = await requestWithCookies(app, "/organizer/apply?lang=en", {
    method: "POST",
    cookie: jarCookie(owner),
    body: new URLSearchParams({
      _csrf: csrfOf(owner),
      organizerName: "Aurora Collective",
      contactName: "Mika Rin",
      contactEmail: "contact@example.com",
      description: "Jams.",
    }).toString(),
  });
  assert.equal(applied.statusCode, 303);
  const queue = await requestWithCookies(app, "/operator?lang=en", {
    cookie: jarCookie(operator),
  });
  const applicationId = /operator\/applications\/([^"]+)"/.exec(
    queue.body,
  )?.[1];
  assert.ok(applicationId);
  await requestWithCookies(
    app,
    `/operator/applications/${applicationId}/approve`,
    {
      method: "POST",
      cookie: jarCookie(operator),
      body: new URLSearchParams({ _csrf: csrfOf(operator) }).toString(),
    },
  );
  const consolePage = await requestWithCookies(app, "/organizer?lang=en", {
    cookie: jarCookie(owner),
  });
  const organizerId = /organizers\/([^"/]+)"/.exec(consolePage.body)?.[1];
  assert.ok(organizerId);
  return { operator, owner, organizerId };
}

test("only a Platform Operator can open the historical import console or submit an import", async () => {
  const { app, root, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
    HOSTED_SESSION_MAX_AGE_MS: 1000 * DAY,
    HOSTED_SESSION_IDLE_TIMEOUT_MS: 1000 * DAY,
  });
  try {
    const { operator, owner, organizerId } =
      await provisionOperatorAndOrganizer(app, outboxDir);

    // Signed-out visitors are sent to login, not shown the surface.
    const anonymous = await requestWithCookies(
      app,
      "/operator/historical-imports",
    );
    assert.equal(anonymous.statusCode, 303);

    // A signed-in non-operator gets the deterministic 403 gate, for the page
    // and for submissions alike.
    const forbiddenPage = await requestWithCookies(
      app,
      "/operator/historical-imports?lang=en",
      { cookie: jarCookie(owner) },
    );
    assert.equal(forbiddenPage.statusCode, 403);
    const ownerForm = multipartForm(
      { _csrf: csrfOf(owner), organizerId },
      { name: "source", filename: "x.svg", content: VALID_LEGACY_SVG },
    );
    const forbiddenPost = await requestWithCookies(
      app,
      "/operator/historical-imports?lang=en",
      {
        method: "POST",
        cookie: jarCookie(owner),
        headers: { "content-type": ownerForm.contentType },
        body: ownerForm.body,
      },
    );
    assert.equal(forbiddenPost.statusCode, 403);

    // The operator sees the form with the organizer selector.
    const page = await requestWithCookies(
      app,
      "/operator/historical-imports?lang=en",
      { cookie: jarCookie(operator) },
    );
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes("Aurora Collective"));
    assert.ok(
      page.body.includes(`value="${organizerId}"`),
      "the organizer selector carries the organizer id",
    );

    // A submission without a valid CSRF token is refused deterministically.
    const badCsrfForm = multipartForm(
      { _csrf: "0".repeat(32), organizerId },
      { name: "source", filename: "x.svg", content: VALID_LEGACY_SVG },
    );
    const badCsrf = await requestWithCookies(
      app,
      "/operator/historical-imports?lang=en",
      {
        method: "POST",
        cookie: jarCookie(operator),
        headers: { "content-type": badCsrfForm.contentType },
        body: badCsrfForm.body,
      },
    );
    assert.equal(badCsrf.statusCode, 403);
  } finally {
    await closeServer(app);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an operator imports a legacy SVG once: the archive is private, unknown-author, and duplicates are refused", async () => {
  const { app, root, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
    HOSTED_SESSION_MAX_AGE_MS: 1000 * DAY,
    HOSTED_SESSION_IDLE_TIMEOUT_MS: 1000 * DAY,
  });
  try {
    const { operator, organizerId } = await provisionOperatorAndOrganizer(
      app,
      outboxDir,
    );
    const importPage = await requestWithCookies(
      app,
      "/operator/historical-imports?lang=en",
      { cookie: jarCookie(operator) },
    );
    const csrfToken = formValue(importPage.body, "_csrf");
    assert.ok(csrfToken);

    // The uploaded file forges attribution on every item; the import must
    // strip it rather than trust it.
    const forged = VALID_LEGACY_SVG.replace(
      '<rect id="r1"',
      '<rect id="r1" data-wbo-created-by="participant-forged"',
    );
    const form = multipartForm(
      { _csrf: csrfToken, organizerId },
      { name: "source", filename: "workshop-2019.svg", content: forged },
    );
    const imported = await requestWithCookies(
      app,
      "/operator/historical-imports?lang=en",
      {
        method: "POST",
        cookie: jarCookie(operator),
        headers: { "content-type": form.contentType },
        body: form.body,
      },
    );
    assert.equal(imported.statusCode, 200);
    assert.ok(
      imported.body.includes("imported as a private Historical Archive"),
      "the success notice renders",
    );
    assert.ok(imported.body.includes("workshop-2019.svg"));
    assert.ok(imported.body.includes("Imported"));

    // The durable artifact: one immutable archive, unknown authorship, no
    // change audit boundary, no ledger object.
    const hostedDataDir = path.join(root, "hosted-data");
    const freshStore = () =>
      createFileHistoricalArchiveStore({
        dataDir: hostedDataDir,
        archiveStore: createFileBoardArchiveStore({ dataDir: hostedDataDir }),
        organizerStore: createFileOrganizerStore({
          dataDir: hostedDataDir,
        }),
      });
    const records = freshStore().listImports();
    assert.equal(records.length, 1);
    const record = records[0];
    assert.ok(record);
    assert.equal(record.status, "imported");
    assert.equal(record.itemCount, 5);
    assert.equal(record.strippedAttributionCount, 1);
    const archiveStore = createFileBoardArchiveStore({
      dataDir: hostedDataDir,
    });
    assert.ok(record.manifestKey);
    const manifest = JSON.parse(
      (await archiveStore.readArchive(record.manifestKey))?.toString("utf8") ||
        "{}",
    );
    assert.equal(manifest.authorship, "unknown");
    assert.equal(manifest.changeAudit, "none");
    assert.ok(record.canvasKey);
    const canvas = (await archiveStore.readArchive(record.canvasKey))?.toString(
      "utf8",
    );
    assert.ok(canvas);
    assert.ok(!canvas.includes("data-wbo-created-by"));
    assert.deepEqual(await archiveStore.listObjectKeys("historical-archives"), [
      record.canvasKey,
      record.manifestKey,
    ]);

    // The operator console is the only surface that even names the import:
    // legacy WBO board entries stay deterministic 404s.
    for (const path of [
      "/boards/workshop-2019.svg",
      "/random",
      "/b/whatever",
    ]) {
      const refused = await requestWithCookies(app, path);
      assert.equal(refused.statusCode, 404, `${path} must be a plain 404`);
    }

    // Re-importing the same file is a deterministic refusal, never a second
    // artifact.
    const duplicate = await requestWithCookies(
      app,
      "/operator/historical-imports?lang=en",
      {
        method: "POST",
        cookie: jarCookie(operator),
        headers: { "content-type": form.contentType },
        body: form.body,
      },
    );
    assert.equal(duplicate.statusCode, 409);
    assert.ok(duplicate.body.includes("already been imported"));
    // The refusal leaves the audit trail unchanged: the completed import's
    // own record remains the one entry for this source.
    assert.equal(freshStore().listImports().length, 1);
  } finally {
    await closeServer(app);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("malformed and misdirected submissions are rejected deterministically and audited", async () => {
  const { app, root, outboxDir } = await createHostedServer({
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
    HOSTED_SESSION_MAX_AGE_MS: 1000 * DAY,
    HOSTED_SESSION_IDLE_TIMEOUT_MS: 1000 * DAY,
  });
  try {
    const { operator, organizerId } = await provisionOperatorAndOrganizer(
      app,
      outboxDir,
    );
    const importPage = await requestWithCookies(
      app,
      "/operator/historical-imports?lang=en",
      { cookie: jarCookie(operator) },
    );
    const csrfToken = formValue(importPage.body, "_csrf");

    // A structurally hostile file: rejected, nothing stored, reason shown.
    const hostile = multipartForm(
      { _csrf: csrfToken, organizerId },
      {
        name: "source",
        filename: "hostile.svg",
        content: '<svg><g id="drawingArea"><script>alert(1)</script></g></svg>',
      },
    );
    const rejected = await requestWithCookies(
      app,
      "/operator/historical-imports?lang=en",
      {
        method: "POST",
        cookie: jarCookie(operator),
        headers: { "content-type": hostile.contentType },
        body: hostile.body,
      },
    );
    assert.equal(rejected.statusCode, 422);
    assert.ok(
      rejected.body.includes("unsupported structure"),
      "the rejection reason renders",
    );
    assert.ok(rejected.body.includes("hostile.svg"));
    assert.ok(rejected.body.includes("Failed"));
    const hostedDataDir = path.join(root, "hosted-data");
    assert.deepEqual(
      await createFileBoardArchiveStore({
        dataDir: hostedDataDir,
      }).listObjectKeys("historical-archives"),
      [],
      "no archive objects exist for a rejected import",
    );

    // No file selected: a deterministic 400 without touching the store.
    const noFile = multipartForm({ _csrf: csrfToken, organizerId }, null);
    const missing = await requestWithCookies(
      app,
      "/operator/historical-imports?lang=en",
      {
        method: "POST",
        cookie: jarCookie(operator),
        headers: { "content-type": noFile.contentType },
        body: noFile.body,
      },
    );
    assert.equal(missing.statusCode, 400);
    assert.ok(missing.body.includes("Choose a legacy board SVG file"));

    // A tampered organizer reference: deterministic 400, no record.
    const tampered = multipartForm(
      { _csrf: csrfToken, organizerId: "no-such-organizer" },
      { name: "source", filename: "x.svg", content: VALID_LEGACY_SVG },
    );
    const unknown = await requestWithCookies(
      app,
      "/operator/historical-imports?lang=en",
      {
        method: "POST",
        cookie: jarCookie(operator),
        headers: { "content-type": tampered.contentType },
        body: tampered.body,
      },
    );
    assert.equal(unknown.statusCode, 400);
    assert.ok(unknown.body.includes("does not exist"));

    // The audit trail keeps the failed attempt and only the failed attempt.
    const records = createFileHistoricalArchiveStore({
      dataDir: hostedDataDir,
      archiveStore: createFileBoardArchiveStore({ dataDir: hostedDataDir }),
      organizerStore: createFileOrganizerStore({ dataDir: hostedDataDir }),
    }).listImports();
    assert.equal(records.length, 1);
    const failedRecord = records[0];
    assert.ok(failedRecord);
    assert.equal(failedRecord.status, "failed");
    assert.equal(failedRecord.sourceLabel, "hostile.svg");
  } finally {
    await closeServer(app);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("legacy SVGs are never imported implicitly: there is no scan, no batch, and no Event or Board Session creation", async () => {
  const holder = { now: Date.now() };
  const { app, root, outboxDir, hostedEventModule } = await createHostedServer({
    HOSTED_CLOCK: () => holder.now,
    HOSTED_OPERATOR_EMAILS: [OPERATOR_EMAIL],
    HOSTED_SESSION_MAX_AGE_MS: 1000 * DAY,
    HOSTED_SESSION_IDLE_TIMEOUT_MS: 1000 * DAY,
  });
  try {
    const { operator, organizerId } = await provisionOperatorAndOrganizer(
      app,
      outboxDir,
    );
    // Seed the data and history directories with plausible legacy boards —
    // exactly what an auto-scanning migration would pick up.
    const hostedDataDir = path.join(root, "hosted-data");
    await fs.writeFile(
      path.join(hostedDataDir, "abandoned-board.svg"),
      VALID_LEGACY_SVG,
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "history", "abandoned-board.svg"),
      VALID_LEGACY_SVG,
      "utf8",
    );

    // Several lifecycle passes: no implicit import appears, and the organizer
    // has no events or board sessions either.
    await hostedEventModule.refreshEventLifecycle();
    await hostedEventModule.refreshEventLifecycle();
    const freshOrganizerStore = createFileOrganizerStore({
      dataDir: hostedDataDir,
      clock: () => holder.now,
    });
    const freshHistoryStore = createFileHistoricalArchiveStore({
      dataDir: hostedDataDir,
      archiveStore: createFileBoardArchiveStore({ dataDir: hostedDataDir }),
      organizerStore: freshOrganizerStore,
    });
    assert.deepEqual(freshHistoryStore.listImports(), []);
    assert.deepEqual(
      await createFileBoardArchiveStore({
        dataDir: hostedDataDir,
      }).listObjectKeys("historical-archives"),
      [],
    );
    assert.deepEqual(
      freshOrganizerStore.listBoardSessionsForEvent(organizerId) || [],
      [],
    );

    // The operator console page stays reachable and shows the empty trail.
    const page = await requestWithCookies(
      app,
      "/operator/historical-imports?lang=en",
      { cookie: jarCookie(operator) },
    );
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes("No imports have been attempted yet."));
  } finally {
    await closeServer(app);
    await fs.rm(root, { recursive: true, force: true });
  }
});
