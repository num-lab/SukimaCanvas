const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { renderBoard } = require("../server/persistence/create_svg.mjs");

/**
 * @param {any} storedBoard
 * @returns {Promise<string>}
 */
async function renderStoredBoard(storedBoard) {
  const historyDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "wbo-create-svg-"),
  );
  const file = path.join(historyDir, "board-export.json");
  await fs.writeFile(file, JSON.stringify(storedBoard), "utf8");
  /** @type {string[]} */
  const chunks = [];
  await renderBoard(file, {
    write: (chunk) => {
      chunks.push(chunk);
    },
  });
  return chunks.join("");
}

test("renderBoard normalizes rectangle bounds for reverse-dragged shapes", async () => {
  const svg = await renderStoredBoard({
    rect1: {
      tool: "rectangle",
      type: "rect",
      id: "rect1",
      color: "#000000",
      size: 2,
      x: 10,
      y: 20,
      x2: 5,
      y2: 1,
    },
  });

  assert.match(svg, /<rect[^>]*x="50"/);
  assert.match(svg, /<rect[^>]*y="10"/);
  assert.match(svg, /<rect[^>]*width="50"/);
  assert.match(svg, /<rect[^>]*height="190"/);
  assert.doesNotMatch(svg, /width="-/);
  assert.doesNotMatch(svg, /height="-/);
});

test("renderBoard projects pencil points into smooth SVG curves", async () => {
  const points = [
    { x: 1, y: 2 },
    { x: 10, y: 12 },
    { x: 18, y: 9 },
    { x: 25, y: 30 },
  ];
  const svg = await renderStoredBoard({
    line1: {
      tool: "pencil",
      type: "line",
      id: "line1",
      color: "#000000",
      size: 2,
      _children: points,
    },
  });

  assert.ok(
    svg.includes(
      'd="M 10 20 L 10 20 C 10 20 59 103 100 120 C 126 131 162 68 180 90 C 227 147 250 300 250 300"',
    ),
  );
});
