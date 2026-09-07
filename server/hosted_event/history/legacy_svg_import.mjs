import crypto from "node:crypto";
import { TOOL_BY_STORED_TAG_NAME } from "../../../client-data/tools/index.js";
import { serializeStoredPencilPath } from "../../../client-data/tools/pencil/index.js";
import {
  createSvgExtent,
  extendSvgExtentForItem,
} from "../../board/svg_extent.mjs";
import {
  createDefaultStoredSvgEnvelope,
  parseAttributes,
  parseStoredSvgEnvelope,
  readRawAttribute,
  serializeStoredSvgEnvelope,
} from "../../persistence/svg_envelope.mjs";
import {
  serializeStoredSvgItem,
  storedSvgSerializeHelpers,
  summarizeStoredSvgItem,
} from "../../persistence/stored_svg_item_codec.mjs";
import { unescapeHtml } from "../../persistence/xml_escape.mjs";

/**
 * Controlled legacy SVG import: the strict parser that turns one uploaded old
 * WBO board file into a canonical, read-only historical canvas.
 *
 * The source is hostile. The parser accepts exactly the stored-SVG item
 * vocabulary the live engine produces (rect, line, ellipse, path, text under
 * `<g id="drawingArea">`) and rejects everything else deterministically — an
 * unknown element, a nested group, a duplicated id, an item whose required
 * fields do not parse, or an undecodable/oversized upload never silently
 * disappears into a "best effort" result. The output is re-serialized from the
 * parsed fields alone through the tools' own stored-item contracts, so hostile
 * attributes (event handlers, foreign namespaces, forged
 * `data-wbo-created-by` attribution) cannot survive: the stored canvas is
 * rendered from validated values, never copied from the source bytes.
 *
 * The creator attribute deserves its explicit mention: a legacy file has no
 * trusted Item Attribution, and a malicious one may carry a forged
 * `data-wbo-created-by`. Every occurrence is stripped and counted, so an
 * imported Historical Archive always reads "author unknown".
 */

/** Uploads beyond this size are rejected before parsing. */
const MAX_HISTORICAL_IMPORT_BYTES = 32 * 1024 * 1024;

/** Deterministic failure codes; the durable import record keeps them. */
const IMPORT_FAILURE_CODES = {
  EMPTY: "WBO_HISTORY_IMPORT_EMPTY",
  TOO_LARGE: "WBO_HISTORY_IMPORT_TOO_LARGE",
  ENCODING: "WBO_HISTORY_IMPORT_ENCODING",
  STRUCTURE: "WBO_HISTORY_IMPORT_STRUCTURE",
  ITEM_INVALID: "WBO_HISTORY_IMPORT_ITEM_INVALID",
};

const STORED_ITEM_TAG_PATTERN = Object.keys(TOOL_BY_STORED_TAG_NAME).join("|");
/**
 * One complete stored-item tag: the opening tag name is captured and the
 * close tag must be its exact backreference, so content spans are always
 * derived from the same match, never re-parsed out of hostile bytes.
 */
const STORED_ITEM_PATTERN = new RegExp(
  `<(${STORED_ITEM_TAG_PATTERN})\\b([^>]*)>([\\s\\S]*?)<\\/\\1>`,
  "g",
);

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & {code: string}}
 */
function importError(code, message) {
  const error = /** @type {Error & {code: string}} */ (new Error(message));
  error.code = code;
  return error;
}

/**
 * Error details must stay short: they come from hostile input and end up in
 * the durable import record and operator console.
 *
 * @param {string} detail
 * @returns {string}
 */
function clampDetail(detail) {
  const clean = detail.replace(/\s+/g, " ").trim();
  return clean.length > 100 ? `${clean.slice(0, 100)}…` : clean;
}

/**
 * Reads one stored-SVG root dimension: undefined when the attribute is
 * absent (createSvgExtent falls back to the default), a finite positive
 * number when it parses, and a deterministic structure rejection otherwise.
 *
 * @param {{[name: string]: string}} rootAttributes
 * @param {"width" | "height"} name
 * @returns {number | undefined}
 */
function readRootDimension(rootAttributes, name) {
  const raw = rootAttributes[name];
  if (raw === undefined) return undefined;
  const dimension = Number(raw);
  if (!Number.isFinite(dimension) || dimension <= 0) {
    throw importError(
      IMPORT_FAILURE_CODES.STRUCTURE,
      `The root ${name} "${clampDetail(raw)}" is not a usable canvas dimension`,
    );
  }
  return dimension;
}

/**
 * Reads the stored-SVG root tag's own attributes: everything between the
 * first `<svg` and the end of its open tag.
 *
 * @param {string} prefix
 * @returns {{[name: string]: string}}
 */
function readRootAttributes(prefix) {
  const svgStart = prefix.indexOf("<svg");
  if (svgStart === -1) return {};
  const openTagEnd = prefix.indexOf(">", svgStart);
  if (openTagEnd === -1) return {};
  return parseAttributes(prefix.slice(svgStart + 4, openTagEnd));
}

/**
 * The whole drawing-area content must be a whitespace-separated sequence of
 * complete stored-item tags. Anything else — an unknown element, a nested
 * group, leftover junk — leaves an unaccounted span and is rejected instead
 * of skipped.
 *
 * @param {string} drawingAreaContent
 * @returns {void}
 */
function assertOnlyStoredItems(drawingAreaContent) {
  const itemPattern = new RegExp(STORED_ITEM_PATTERN.source, "g");
  let position = 0;
  let match = itemPattern.exec(drawingAreaContent);
  while (match) {
    if (match.index !== position) {
      const gap = drawingAreaContent.slice(position, match.index).trim();
      if (gap !== "") {
        throw importError(
          IMPORT_FAILURE_CODES.STRUCTURE,
          `Unsupported drawing-area structure at offset ${position}: ${clampDetail(gap)}`,
        );
      }
    }
    position = match.index + match[0].length;
    match = itemPattern.exec(drawingAreaContent);
  }
  const remainder = drawingAreaContent.slice(position).trim();
  if (remainder !== "") {
    throw importError(
      IMPORT_FAILURE_CODES.STRUCTURE,
      `Unsupported drawing-area structure at offset ${position}: ${clampDetail(remainder)}`,
    );
  }
}

/**
 * @param {string} tagName
 * @param {string} content
 * @returns {void}
 */
function assertItemContentShape(tagName, content) {
  if (tagName === "text") return;
  if (content === "") return;
  throw importError(
    IMPORT_FAILURE_CODES.STRUCTURE,
    `Unsupported content inside <${tagName}> item: ${clampDetail(content)}`,
  );
}

/**
 * Parses and validates one legacy SVG upload into a canonical read-only
 * historical canvas. Throws a deterministic coded error for every
 * unsupported input shape.
 *
 * @param {{
 *   bytes: Uint8Array,
 *   maxBytes?: number,
 * }} input
 * @returns {{
 *   canvas: string,
 *   itemCount: number,
 *   sourceSha256: string,
 *   strippedAttributionCount: number,
 * }}
 */
function importLegacySvgCanvas(input) {
  const bytes = input.bytes;
  const maxBytes =
    typeof input.maxBytes === "number" && input.maxBytes > 0
      ? input.maxBytes
      : MAX_HISTORICAL_IMPORT_BYTES;
  if (!bytes || bytes.length === 0) {
    throw importError(IMPORT_FAILURE_CODES.EMPTY, "The upload is empty");
  }
  if (bytes.length > maxBytes) {
    throw importError(
      IMPORT_FAILURE_CODES.TOO_LARGE,
      `The upload exceeds the ${maxBytes} byte import limit`,
    );
  }
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw importError(
      IMPORT_FAILURE_CODES.ENCODING,
      "The upload is not valid UTF-8",
    );
  }
  if (source.startsWith("﻿")) {
    source = source.slice(1);
  }

  /** @type {{prefix: string, drawingAreaContent: string, suffix: string}} */
  let envelope;
  try {
    envelope = parseStoredSvgEnvelope(source);
  } catch (error) {
    throw importError(
      IMPORT_FAILURE_CODES.STRUCTURE,
      `The upload has no usable stored-SVG structure: ${clampDetail(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
  }
  assertOnlyStoredItems(envelope.drawingAreaContent);

  const rootAttributes = readRootAttributes(envelope.prefix);
  // A present-but-unparsable root dimension is unsupported structure, not
  // something to repair silently; a missing one falls back to the default
  // canvas size, and item extents still extend the envelope below.
  const svgExtent = createSvgExtent(
    readRootDimension(rootAttributes, "width"),
    readRootDimension(rootAttributes, "height"),
  );
  /** @type {string[]} */
  const itemTags = [];
  /** @type {Set<string>} */
  const seenIds = new Set();
  let strippedAttributionCount = 0;
  const itemPattern = new RegExp(STORED_ITEM_PATTERN.source, "g");
  let match = itemPattern.exec(envelope.drawingAreaContent);
  let paintOrder = 0;
  while (match) {
    const tagName = match[1] || "";
    const rawAttributes = match[2] || "";
    const content = match[3] || "";
    const raw = match[0];
    assertItemContentShape(tagName, content);

    const id = readRawAttribute(rawAttributes, "id");
    const entry = { tagName, rawAttributes, id, content, raw };
    const summary = summarizeStoredSvgItem(entry, paintOrder);
    if (!summary) {
      throw importError(
        IMPORT_FAILURE_CODES.ITEM_INVALID,
        `The <${tagName}> item "${clampDetail(String(id || "(unnamed)"))}" is not a parseable stored item`,
      );
    }
    if (seenIds.has(summary.id)) {
      throw importError(
        IMPORT_FAILURE_CODES.STRUCTURE,
        `Duplicate item id: ${clampDetail(String(summary.id))}`,
      );
    }
    seenIds.add(summary.id);

    const { createdBy, ...summaryWithoutAttribution } = summary;
    if (typeof createdBy === "string" && createdBy !== "") {
      strippedAttributionCount += 1;
    }
    const item = {
      id: summary.id,
      tool: summary.tool,
      ...summaryWithoutAttribution.data,
    };

    let tag;
    if (summary.tool === "pencil") {
      // The path data never survives a summary round-trip: take the validated
      // `d` attribute straight from the parsed open tag.
      const pathData = readRawAttribute(rawAttributes, "d") || "";
      tag = serializeStoredPencilPath(
        item,
        pathData,
        storedSvgSerializeHelpers,
      );
    } else {
      if (summary.tool === "text") {
        item.txt = unescapeHtml(content);
      }
      tag = serializeStoredSvgItem(item);
    }
    if (!tag) {
      throw importError(
        IMPORT_FAILURE_CODES.ITEM_INVALID,
        `The <${tagName}> item "${clampDetail(String(summary.id))}" could not be serialized`,
      );
    }
    itemTags.push(tag);
    extendSvgExtentForItem(svgExtent, {
      bounds: summary.localBounds,
      ...(item.transform !== undefined ? { transform: item.transform } : {}),
    });
    paintOrder += 1;
    match = itemPattern.exec(envelope.drawingAreaContent);
  }

  const canonicalEnvelope = createDefaultStoredSvgEnvelope(
    { readonly: true },
    0,
    svgExtent,
  );
  const canvas = serializeStoredSvgEnvelope(
    canonicalEnvelope.prefix,
    itemTags,
    canonicalEnvelope.suffix,
  );
  const sourceSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  return {
    canvas,
    itemCount: itemTags.length,
    sourceSha256,
    strippedAttributionCount,
  };
}

export {
  importLegacySvgCanvas,
  MAX_HISTORICAL_IMPORT_BYTES,
  IMPORT_FAILURE_CODES,
};
