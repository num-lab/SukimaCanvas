const test = require("node:test");
const assert = require("node:assert/strict");

const {
  derivePublishedCanvas,
  listPublishedContributorIds,
} = require("../server/hosted_event/publication/canvas.mjs");

const IDENTIFIED_ID = "p1a2b3c4d5e6f7a8b";
const OTHER_IDENTIFIED_ID = "p9f8e7d6c5b4a3210";
const ANONYMOUS_ID = "p0f1e2d3c4b5a697";

/**
 * Builds an archived canvas exactly like the close pipeline stores one:
 * escaped attribute values, items under drawingArea, a cursors group.
 *
 * @param {{id: string, tag: string, createdBy?: string, body?: string}[]} items
 * @param {number} [seq]
 */
function archiveCanvas(items, seq = 3) {
  const itemTags = items
    .map((item) => {
      const attribution =
        item.createdBy === undefined
          ? ""
          : ` data-wbo-created-by="${item.createdBy}"`;
      return `<${item.tag} id="${item.id}" stroke="#1f2937"${attribution}>${item.body || ""}</${item.tag}>`;
    })
    .join("");
  return (
    `<svg id="canvas" xmlns="http://www.w3.org/2000/svg" version="1.1" ` +
    `width="1000" height="800" data-wbo-format="whitebophir-svg-v2" ` +
    `data-wbo-seq="${seq}" data-wbo-readonly="true">` +
    `<defs id="defs"></defs>` +
    `<g id="drawingArea">${itemTags}</g>` +
    `<g id="cursors"></g></svg>`
  );
}

test("attribution keeps only identified creators' identifiers on their items", () => {
  const canvas = archiveCanvas([
    { id: "r1", tag: "rect", createdBy: IDENTIFIED_ID },
    { id: "r2", tag: "rect", createdBy: ANONYMOUS_ID },
    { id: "r3", tag: "rect", createdBy: "punknowncreator01" },
    { id: "r4", tag: "rect" },
  ]);
  const published = derivePublishedCanvas({
    archiveCanvas: canvas,
    showAttribution: true,
    identifiedParticipantIds: new Set([IDENTIFIED_ID, OTHER_IDENTIFIED_ID]),
  });
  assert.ok(
    published.includes(`data-wbo-created-by="${IDENTIFIED_ID}"`),
    "an identified participant's identifier survives on their items",
  );
  assert.ok(
    !published.includes(ANONYMOUS_ID),
    "an anonymous participant's identifier is removed from the artifact",
  );
  assert.ok(
    !published.includes("punknowncreator01"),
    "an identifier without an identified membership is stripped",
  );
  assert.ok(published.includes('id="r1"'));
  assert.ok(published.includes('id="r2"'), "the item itself stays");
  assert.ok(published.includes('id="r4"'));
  assert.match(published, /<rect id="r2" stroke="#1f2937"><\/rect>/);
});

test("attribution off strips every identifier while keeping all items", () => {
  const canvas = archiveCanvas([
    { id: "r1", tag: "rect", createdBy: IDENTIFIED_ID },
    { id: "t1", tag: "text", createdBy: ANONYMOUS_ID, body: "hello" },
  ]);
  const published = derivePublishedCanvas({
    archiveCanvas: canvas,
    showAttribution: false,
    identifiedParticipantIds: new Set([IDENTIFIED_ID]),
  });
  assert.ok(!published.includes("data-wbo-created-by"));
  assert.ok(published.includes('id="r1"'));
  assert.ok(published.includes(">hello<"));
});

test("the derived canvas is read-only, keeps the extent and format, and is deterministic", () => {
  const canvas = archiveCanvas(
    [{ id: "r1", tag: "rect", createdBy: IDENTIFIED_ID }],
    41,
  );
  const input = {
    archiveCanvas: canvas,
    showAttribution: true,
    identifiedParticipantIds: new Set([IDENTIFIED_ID]),
  };
  const published = derivePublishedCanvas(input);
  assert.match(published, /data-wbo-readonly="true"/);
  assert.match(published, /data-wbo-format="whitebophir-svg-v2"/);
  assert.match(published, /data-wbo-seq="41"/);
  assert.match(published, /width="1000" height="800"/);
  assert.match(published, /<g id="cursors"><\/g><\/svg>$/);
  assert.equal(published, derivePublishedCanvas(input));
  // An already-derived canvas derives to itself: no double stripping drift.
  assert.equal(
    derivePublishedCanvas(input),
    derivePublishedCanvas({ ...input, archiveCanvas: published }),
  );
});

test("hostile text content mentioning the attribute name never hides markup decisions", () => {
  const hostileBody = 'see data-wbo-created-by="&#34;spoof&#34;" inside';
  const canvas = archiveCanvas([
    { id: "t1", tag: "text", createdBy: IDENTIFIED_ID, body: hostileBody },
    { id: "r1", tag: "rect", createdBy: ANONYMOUS_ID },
  ]);
  const published = derivePublishedCanvas({
    archiveCanvas: canvas,
    showAttribution: true,
    identifiedParticipantIds: new Set([IDENTIFIED_ID]),
  });
  // The identified item keeps its identifier even though its text mentions
  // the attribute, and the anonymous item is stripped without touching the
  // text content of the other item.
  assert.ok(published.includes(`data-wbo-created-by="${IDENTIFIED_ID}"`));
  assert.ok(published.includes(hostileBody));
  const rectTag = /<rect[^>]*id="r1"[^>]*>/.exec(published)?.[0] || "";
  assert.ok(!rectTag.includes("data-wbo-created-by"));
});

test("contributors list exactly the identifiers the published canvas shows", () => {
  const canvas = archiveCanvas([
    { id: "r1", tag: "rect", createdBy: IDENTIFIED_ID },
    { id: "r2", tag: "rect", createdBy: OTHER_IDENTIFIED_ID },
    { id: "r3", tag: "rect", createdBy: IDENTIFIED_ID },
    { id: "r4", tag: "rect", createdBy: ANONYMOUS_ID },
  ]);
  const published = derivePublishedCanvas({
    archiveCanvas: canvas,
    showAttribution: true,
    identifiedParticipantIds: new Set([IDENTIFIED_ID, OTHER_IDENTIFIED_ID]),
  });
  assert.deepEqual(listPublishedContributorIds(published).sort(), [
    IDENTIFIED_ID,
    OTHER_IDENTIFIED_ID,
  ]);
  assert.deepEqual(
    listPublishedContributorIds(
      derivePublishedCanvas({
        archiveCanvas: canvas,
        showAttribution: false,
        identifiedParticipantIds: new Set([IDENTIFIED_ID, OTHER_IDENTIFIED_ID]),
      }),
    ),
    [],
  );
});
