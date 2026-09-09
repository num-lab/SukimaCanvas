import MessageCommon from "../../client-data/js/message_common.js";
import { LIMITS } from "../../client-data/js/message_limits.js";
import { projectStoredPencilPath } from "../../client-data/tools/pencil/index.js";
import { canonicalItemFromStoredSvgEntry } from "../board/canonical_items.mjs";
import { normalizeSvgDimension } from "../board/svg_extent.mjs";
import {
  parseStoredSvgEnvelope,
  parseStoredSvgItems,
  serializeStoredSvgEnvelope,
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
 * Includes a Pencil stroke around its transformed center-line bounds. The
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
 * Projects one canonical stored Pencil item into its display path. Unknown or
 * malformed paths remain distinguishable from Pencil items by returning null.
 *
 * @param {{raw: string, tagName: string, attributes: {[name: string]: string}}} item
 * @returns {{raw: string, bounds: {minX: number, minY: number, maxX: number, maxY: number}} | null}
 */
function projectStoredSvgItemForDisplay(item) {
  if (item.tagName !== "path") return null;
  const projected = projectStoredPencilPath(item.attributes.d);
  if (!projected) return null;
  const raw = replacePathDataAttribute(item.raw, projected.d);
  return raw ? { raw, bounds: projected.bounds } : null;
}

/**
 * Expands a stored SVG viewport only when a smoothed Pencil stroke extends
 * beyond it. Width, height, and viewBox use the same coordinate scale so the
 * display projection remains 1:1.
 *
 * @param {string} prefix
 * @param {{[name: string]: string}} rootAttributes
 * @param {{minX: number, minY: number, maxX: number, maxY: number} | null} pencilBounds
 * @returns {string}
 */
function expandViewport(prefix, rootAttributes, pencilBounds) {
  if (!pencilBounds) return prefix;
  const sourceWidth = normalizeSvgDimension(rootAttributes.width);
  const sourceHeight = normalizeSvgDimension(rootAttributes.height);
  const minX = Math.min(0, Math.floor(pencilBounds.minX));
  const minY = Math.min(0, Math.floor(pencilBounds.minY));
  const maxX = Math.max(sourceWidth, Math.ceil(pencilBounds.maxX));
  const maxY = Math.max(sourceHeight, Math.ceil(pencilBounds.maxY));
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
  const svgStart = prefix.indexOf("<svg");
  const openTagEnd = prefix.indexOf(">", svgStart);
  if (svgStart === -1 || openTagEnd === -1) return prefix;
  let openTag = prefix.slice(svgStart, openTagEnd + 1);
  for (const [name, value] of Object.entries(attributes)) {
    const pattern = new RegExp(`\\s${name}="[^"]*"`);
    const attribute = ` ${name}="${escapeHtml(value)}"`;
    openTag = pattern.test(openTag)
      ? openTag.replace(pattern, attribute)
      : `${openTag.slice(0, -1)}${attribute}>`;
  }
  return `${prefix.slice(0, svgStart)}${openTag}${prefix.slice(openTagEnd + 1)}`;
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
  let pencilBounds = null;
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
    const projected = projectStoredSvgItemForDisplay(item);
    if (projected) {
      const canonical = canonicalItemFromStoredSvgEntry(item, paintOrder);
      if (!canonical) {
        fragments.push(item.raw);
        sourceOffset = itemOffset + item.raw.length;
        continue;
      }
      const effective = MessageCommon.applyTransformToBounds(
        projected.bounds,
        canonical.transform,
      );
      if (effective) {
        const strokeWidth = Number(item.attributes["stroke-width"]);
        pencilBounds = extendBounds(
          pencilBounds,
          includeStrokeBounds(effective, strokeWidth, canonical.transform),
        );
      }
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
    pencilBounds,
  );
  return serializeStoredSvgEnvelope(prefix, fragments, envelope.suffix);
}

export { projectStoredSvgForDisplay, projectStoredSvgItemForDisplay };
