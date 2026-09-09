import MessageCommon from "../../client-data/js/message_common.js";
import { LIMITS } from "../../client-data/js/message_limits.js";
import { projectStoredPencilPath } from "../../client-data/tools/pencil/index.js";
import { canonicalItemFromStoredSvgEntry } from "../board/canonical_items.mjs";
import { normalizeSvgDimension } from "../board/svg_extent.mjs";
import {
  parseStoredSvgEnvelope,
  parseStoredSvgItems,
  serializeStoredSvgEnvelope,
  updateSvgRootAttributes,
} from "./svg_envelope.mjs";
import { escapeHtml } from "./xml_escape.mjs";

const PATH_DATA_ATTRIBUTE_PATTERN = /\sd="[^"]*"/g;

/**
 * @param {{minX: number, minY: number, maxX: number, maxY: number} | null} bounds
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} next
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}}
 */
function extendBounds(bounds, next) {
  if (!bounds) return { ...next };
  return {
    minX: Math.min(bounds.minX, next.minX),
    minY: Math.min(bounds.minY, next.minY),
    maxX: Math.max(bounds.maxX, next.maxX),
    maxY: Math.max(bounds.maxY, next.maxY),
  };
}

/**
 * Includes a stroke around its transformed center-line bounds. The
 * matrix row lengths are the exact axis-aligned spill of a transformed circle.
 *
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} bounds
 * @param {number} strokeWidth
 * @param {{a: number, b: number, c: number, d: number} | undefined} transform
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}}
 */
function includeStrokeBounds(bounds, strokeWidth, transform) {
  const radius = Math.min(
    Number.isFinite(strokeWidth) && strokeWidth > 0 ? strokeWidth / 2 : 0,
    LIMITS.MAX_SIZE / 2,
  );
  const spillX = transform
    ? radius * Math.hypot(transform.a, transform.c)
    : radius;
  const spillY = transform
    ? radius * Math.hypot(transform.b, transform.d)
    : radius;
  return {
    minX: bounds.minX - spillX,
    minY: bounds.minY - spillY,
    maxX: bounds.maxX + spillX,
    maxY: bounds.maxY + spillY,
  };
}

/**
 * @param {string} raw
 * @param {string} d
 * @returns {string | null}
 */
function replacePathDataAttribute(raw, d) {
  const openTagEnd = raw.indexOf(">");
  if (openTagEnd === -1) return null;
  const openTag = raw.slice(0, openTagEnd);
  const matches = [...openTag.matchAll(PATH_DATA_ATTRIBUTE_PATTERN)];
  if (matches.length !== 1 || matches[0]?.index === undefined) return null;
  const match = matches[0];
  const start = match.index;
  const replacement = ` d="${escapeHtml(d)}"`;
  return `${raw.slice(0, start)}${replacement}${raw.slice(start + match[0].length)}`;
}

/**
 * Projects one canonical stored item for display and returns its painted
 * bounds. Pencil paths use their smoothed center line; every other item keeps
 * its stored geometry. Unknown or malformed items return null.
 *
 * @param {{raw: string, tagName: string, attributes: {[name: string]: string}}} item
 * @param {number} paintOrder
 * @returns {{raw: string, bounds: {minX: number, minY: number, maxX: number, maxY: number}} | null}
 */
function projectStoredSvgItemForDisplay(item, paintOrder) {
  const canonical = canonicalItemFromStoredSvgEntry(item, paintOrder);
  if (!canonical?.bounds) return null;

  let raw = item.raw;
  let localBounds = canonical.bounds;
  if (item.tagName === "path") {
    const projected = projectStoredPencilPath(item.attributes.d);
    const projectedRaw = projected
      ? replacePathDataAttribute(item.raw, projected.d)
      : null;
    if (projected && projectedRaw) {
      raw = projectedRaw;
      localBounds = projected.bounds;
    }
  }

  const effective = MessageCommon.applyTransformToBounds(
    localBounds,
    canonical.transform,
  );
  if (!effective) return null;
  const strokeWidth = Number(item.attributes["stroke-width"]);
  return {
    raw,
    bounds: includeStrokeBounds(effective, strokeWidth, canonical.transform),
  };
}

/**
 * Expands a stored SVG viewport when painted display content extends beyond
 * it. Width, height, and viewBox use the same coordinate scale so the display
 * projection remains 1:1.
 *
 * @param {string} prefix
 * @param {{[name: string]: string}} rootAttributes
 * @param {{minX: number, minY: number, maxX: number, maxY: number} | null} displayBounds
 * @returns {string}
 */
function expandViewport(prefix, rootAttributes, displayBounds) {
  if (!displayBounds) return prefix;
  const sourceWidth = normalizeSvgDimension(rootAttributes.width);
  const sourceHeight = normalizeSvgDimension(rootAttributes.height);
  const minX = Math.min(0, Math.floor(displayBounds.minX));
  const minY = Math.min(0, Math.floor(displayBounds.minY));
  const maxX = Math.max(sourceWidth, Math.ceil(displayBounds.maxX));
  const maxY = Math.max(sourceHeight, Math.ceil(displayBounds.maxY));
  if (
    minX === 0 &&
    minY === 0 &&
    maxX === sourceWidth &&
    maxY === sourceHeight
  ) {
    return prefix;
  }

  const attributes = {
    width: String(maxX - minX),
    height: String(maxY - minY),
    viewBox: `${minX} ${minY} ${maxX - minX} ${maxY - minY}`,
  };
  return updateSvgRootAttributes(prefix, attributes);
}

/**
 * Rebuilds a stored SVG as a display projection. Only canonical Pencil paths
 * are changed; every unrecognized stored item is preserved byte-for-byte.
 *
 * @param {string} svg
 * @returns {string}
 */
function projectStoredSvgForDisplay(svg) {
  const envelope = parseStoredSvgEnvelope(svg);
  const items = parseStoredSvgItems(envelope.drawingAreaContent);
  /** @type {{minX: number, minY: number, maxX: number, maxY: number} | null} */
  let displayBounds = null;
  const fragments = [];
  let sourceOffset = 0;
  for (let paintOrder = 0; paintOrder < items.length; paintOrder += 1) {
    const item = items[paintOrder];
    if (!item) continue;
    const itemOffset = envelope.drawingAreaContent.indexOf(
      item.raw,
      sourceOffset,
    );
    if (itemOffset === -1) return svg;
    fragments.push(envelope.drawingAreaContent.slice(sourceOffset, itemOffset));
    const projected = projectStoredSvgItemForDisplay(item, paintOrder);
    if (projected) {
      displayBounds = extendBounds(displayBounds, projected.bounds);
      fragments.push(projected.raw);
    } else {
      fragments.push(item.raw);
    }
    sourceOffset = itemOffset + item.raw.length;
  }
  fragments.push(envelope.drawingAreaContent.slice(sourceOffset));
  const prefix = expandViewport(
    envelope.prefix,
    envelope.rootAttributes,
    displayBounds,
  );
  return serializeStoredSvgEnvelope(prefix, fragments, envelope.suffix);
}

export { projectStoredSvgForDisplay, projectStoredSvgItemForDisplay };
