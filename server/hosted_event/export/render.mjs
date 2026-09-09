import { Resvg } from "@resvg/resvg-js";

import { normalizeSvgDimension } from "../../board/svg_extent.mjs";
import {
  projectStoredSvgForDisplay,
  projectStoredSvgItemForDisplay,
} from "../../persistence/svg_display_projection.mjs";
import {
  parseStoredSvgEnvelope,
  parseStoredSvgItems,
} from "../../persistence/svg_envelope.mjs";
import { decodePng } from "../assets/image_validation.mjs";

/**
 * Sanitized PNG rendering for Private Board Archives.
 *
 * An Image Export never rasterizes the archived canvas as-is: the archived
 * drawing area is re-wrapped in a fresh, minimal SVG document whose root
 * carries no WBO metadata, whose items carry no `data-wbo-*` attribution
 * attributes, and whose viewport is exactly the content bounds plus a fixed
 * white margin. The rasterizer then produces an ordinary PNG — pixels only —
 * which is structurally validated and rejected if it carries any ancillary
 * (metadata-bearing) chunk, so Item Attribution, Participant Identifiers,
 * audit data, object keys, or emails can never reach the output even by
 * accident of a future encoder change.
 *
 * Rendering is deterministic for a given archive content: same items, same
 * scale, same fonts, same bytes. A content whose envelope cannot be parsed or
 * that the rasterizer refuses fails with a deterministic error code instead of
 * producing a questionable image.
 */

/** Hard output cap: the longest image edge never exceeds this pixel count. */
const EXPORT_MAX_EDGE_PX = 8192;
/** Fixed white margin rendered around the content bounds, in output pixels. */
const EXPORT_PADDING_PX = 32;
/** Export background: an opaque white canvas, never transparent. */
const EXPORT_BACKGROUND = "#ffffff";

/** PNG chunk types a sanitized export may contain — strictly no text/metadata chunks. */
const EXPORT_PNG_CHUNK_ALLOWLIST = new Set([
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
 * Deterministic failure codes for export rendering. They land on the export
 * job's durable failure record and are the console's stable handles for "why
 * did this export fail".
 */
const EXPORT_FAILURE_CODES = {
  ARCHIVE_INVALID: "archive_invalid",
  RENDER_FAILED: "render_failed",
  OUTPUT_LIMIT: "output_limit_exceeded",
  METADATA_REJECTED: "output_metadata_rejected",
};

/**
 * Creates one rendering failure carrying its deterministic code.
 *
 * @param {string} code
 * @param {string} message
 * @returns {Error & {code: string}}
 */
function renderError(code, message) {
  const error = /** @type {Error & {code: string}} */ (new Error(message));
  error.code = code;
  return error;
}

/**
 * Computes the tight content bounds of a stored drawing area. Canonical item
 * summaries provide ordinary geometry; Pencil paths substitute the exact
 * bounds of their smoothed display projection. Every bound includes the
 * transformed stroke. Returns null when the drawing area is empty.
 *
 * @param {string} drawingAreaContent
 * @returns {{minX: number, minY: number, maxX: number, maxY: number, itemCount: number} | null}
 */
function computeArchiveContentBounds(drawingAreaContent) {
  const items = parseStoredSvgItems(drawingAreaContent);
  /** @type {{minX: number, minY: number, maxX: number, maxY: number} | null} */
  let bounds = null;
  let itemCount = 0;
  for (const entry of items) {
    const projected = projectStoredSvgItemForDisplay(entry, itemCount);
    if (!projected) continue;
    const effective = projected.bounds;
    itemCount += 1;
    bounds = {
      minX: Math.min(bounds ? bounds.minX : effective.minX, effective.minX),
      minY: Math.min(bounds ? bounds.minY : effective.minY, effective.minY),
      maxX: Math.max(bounds ? bounds.maxX : effective.maxX, effective.maxX),
      maxY: Math.max(bounds ? bounds.maxY : effective.maxY, effective.maxY),
    };
  }
  if (!bounds || itemCount === 0) return null;
  return {
    minX: bounds.minX,
    minY: bounds.minY,
    maxX: bounds.maxX,
    maxY: bounds.maxY,
    itemCount,
  };
}

/**
 * Strips every WBO-owned attribute from stored item markup. The render input
 * therefore never carries item attribution or internal metadata, defense in
 * depth beyond the pixel-only output.
 *
 * @param {string} drawingAreaContent
 * @returns {string}
 */
function stripWboAttributes(drawingAreaContent) {
  return drawingAreaContent.replace(
    /\s+data-wbo-[A-Za-z0-9_.:-]+="[^"]*"/g,
    "",
  );
}

/**
 * Walks the chunk types of a PNG buffer without validating them — structural
 * integrity is `decodePng`'s job. Used to enforce the metadata-chunk
 * allowlist on the produced output.
 *
 * @param {Buffer} png
 * @returns {string[]}
 */
function scanPngChunkTypes(png) {
  /** @type {string[]} */
  const types = [];
  const signatureLength = 8;
  let offset = signatureLength;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const dataStart = offset + 8;
    if (length > png.length || dataStart + length + 4 > png.length) break;
    types.push(png.toString("latin1", offset + 4, dataStart));
    offset = dataStart + length + 4;
    if (types[types.length - 1] === "IEND") break;
  }
  return types;
}

/**
 * Renders the sanitized PNG projection of one archived canvas.
 *
 * @param {{
 *   canvasSvg: string,
 *   maxEdgePx?: number,
 *   paddingPx?: number,
 * }} input
 * @returns {{png: Buffer, width: number, height: number}}
 */
function renderArchivePng(input) {
  const maxEdgePx =
    typeof input.maxEdgePx === "number" && input.maxEdgePx > 0
      ? Math.floor(input.maxEdgePx)
      : EXPORT_MAX_EDGE_PX;
  const paddingPx =
    typeof input.paddingPx === "number" && Number.isFinite(input.paddingPx)
      ? Math.max(0, Math.floor(input.paddingPx))
      : EXPORT_PADDING_PX;
  const canvasSvg = input.canvasSvg;
  if (typeof canvasSvg !== "string" || canvasSvg.length === 0) {
    throw renderError(
      EXPORT_FAILURE_CODES.ARCHIVE_INVALID,
      "Archive canvas is empty",
    );
  }

  /** @type {ReturnType<typeof parseStoredSvgEnvelope>} */
  let envelope;
  try {
    envelope = parseStoredSvgEnvelope(canvasSvg);
  } catch (error) {
    throw renderError(
      EXPORT_FAILURE_CODES.ARCHIVE_INVALID,
      `Archive canvas is not a stored SVG envelope: ${
        error instanceof Error ? error.message : String(error || "")
      }`,
    );
  }
  /** @type {string} */
  let drawingAreaContent;
  /** @type {ReturnType<typeof computeArchiveContentBounds>} */
  let content;
  try {
    const projectedEnvelope = parseStoredSvgEnvelope(
      projectStoredSvgForDisplay(canvasSvg),
    );
    drawingAreaContent = stripWboAttributes(
      projectedEnvelope.drawingAreaContent,
    );
    content = computeArchiveContentBounds(envelope.drawingAreaContent);
  } catch (error) {
    throw renderError(
      EXPORT_FAILURE_CODES.ARCHIVE_INVALID,
      `Archive canvas content could not be decoded: ${
        error instanceof Error ? error.message : String(error || "")
      }`,
    );
  }
  /** @type {number} x of the content box */
  let minX;
  let minY;
  let contentWidth;
  let contentHeight;
  if (content) {
    minX = content.minX;
    minY = content.minY;
    contentWidth = content.maxX - content.minX;
    contentHeight = content.maxY - content.minY;
  } else {
    // An empty Board Session still exports: the archived canvas's declared
    // extent becomes the content box, rendered as a blank white image.
    minX = 0;
    minY = 0;
    contentWidth = normalizeSvgDimension(envelope.rootAttributes.width);
    contentHeight = normalizeSvgDimension(envelope.rootAttributes.height);
  }
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !(contentWidth >= 0) ||
    !(contentHeight >= 0) ||
    contentWidth > Number.MAX_SAFE_INTEGER ||
    contentHeight > Number.MAX_SAFE_INTEGER
  ) {
    throw renderError(
      EXPORT_FAILURE_CODES.ARCHIVE_INVALID,
      "Archive canvas content bounds are not renderable",
    );
  }

  const longestEdge = Math.max(contentWidth, contentHeight);
  const usableEdge = maxEdgePx - 2 * paddingPx;
  if (usableEdge <= 0) {
    throw renderError(
      EXPORT_FAILURE_CODES.OUTPUT_LIMIT,
      `Export padding ${paddingPx}px leaves no usable edge under the ${maxEdgePx}px cap`,
    );
  }
  // Content is never upscaled: a small drawing exports 1:1 in board
  // coordinates; anything larger is scaled down to fit the cap exactly.
  const scale = Math.min(1, usableEdge / longestEdge);
  if (!(scale > 0) || !Number.isFinite(scale)) {
    throw renderError(
      EXPORT_FAILURE_CODES.OUTPUT_LIMIT,
      "Archive canvas content bounds do not fit the export size cap",
    );
  }
  const paddingContent = paddingPx / scale;
  const outWidth =
    Math.max(1, Math.floor(contentWidth * scale)) + 2 * paddingPx;
  const outHeight =
    Math.max(1, Math.floor(contentHeight * scale)) + 2 * paddingPx;
  if (
    outWidth > maxEdgePx ||
    outHeight > maxEdgePx ||
    outWidth > 0xffff ||
    outHeight > 0xffff
  ) {
    throw renderError(
      EXPORT_FAILURE_CODES.OUTPUT_LIMIT,
      `Computed export ${outWidth}x${outHeight} exceeds the ${maxEdgePx}px edge cap`,
    );
  }

  const viewBox = `${minX - paddingContent} ${minY - paddingContent} ${
    contentWidth + 2 * paddingContent
  } ${contentHeight + 2 * paddingContent}`;
  const renderSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outWidth}" height="${outHeight}" ` +
    `viewBox="${viewBox}">` +
    `<rect x="${minX - paddingContent}" y="${minY - paddingContent}" ` +
    `width="${contentWidth + 2 * paddingContent}" ` +
    `height="${contentHeight + 2 * paddingContent}" ` +
    `fill="${EXPORT_BACKGROUND}"/>` +
    `${drawingAreaContent}</svg>`;

  /** @type {Buffer} */
  let png;
  try {
    png = Buffer.from(
      new Resvg(renderSvg, { font: { loadSystemFonts: true } })
        .render()
        .asPng(),
    );
  } catch (error) {
    throw renderError(
      EXPORT_FAILURE_CODES.RENDER_FAILED,
      `The archived canvas could not be rendered: ${
        error instanceof Error ? error.message : String(error || "")
      }`,
    );
  }

  const decoded = decodePng(png);
  if (!decoded.ok) {
    throw renderError(
      EXPORT_FAILURE_CODES.RENDER_FAILED,
      "The rendered PNG failed structural validation",
    );
  }
  if (decoded.width !== outWidth || decoded.height !== outHeight) {
    throw renderError(
      EXPORT_FAILURE_CODES.OUTPUT_LIMIT,
      `Rendered PNG is ${decoded.width}x${decoded.height}, expected ${outWidth}x${outHeight}`,
    );
  }
  const metadataChunks = scanPngChunkTypes(png).filter(
    (type) => !EXPORT_PNG_CHUNK_ALLOWLIST.has(type),
  );
  if (metadataChunks.length > 0) {
    throw renderError(
      EXPORT_FAILURE_CODES.METADATA_REJECTED,
      `Rendered PNG carries non-allowlisted chunks: ${metadataChunks.join(", ")}`,
    );
  }
  return { png, width: outWidth, height: outHeight };
}

export {
  computeArchiveContentBounds,
  EXPORT_FAILURE_CODES,
  EXPORT_MAX_EDGE_PX,
  EXPORT_PADDING_PX,
  renderArchivePng,
};
