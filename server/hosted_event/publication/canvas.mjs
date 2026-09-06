import {
  parseStoredSvgEnvelope,
  parseStoredSvgItems,
  serializeStoredSvgEnvelope,
  updateRootMetadata,
} from "../../persistence/svg_envelope.mjs";

/**
 * Sanitized Published Canvas derivation from a Private Board Archive canvas.
 *
 * The Private Board Archive is the authoritative outcome: its canvas carries
 * every item's server-stamped Participant Identifier (`data-wbo-created-by`)
 * plus the audit boundary. The Published Canvas is a separately derived,
 * read-only presentation of that canvas for an allowed audience — never the
 * archive itself. Derivation is deterministic given (archive canvas,
 * attribution policy, anonymity choices), so a publish that crashed between
 * the derived-object write and the record persist re-derives byte-identical
 * content on retry.
 *
 * Attribution display rule: an item keeps its Participant Identifier only
 * when the organizer enabled public attribution AND the item's creator is in
 * the identified set — the event's members whose frozen Presentation Choice
 * is "identified". Everything else is stripped: anonymous participants,
 * departed or banned members without a membership, and unknown creators all
 * fail safe to no identifier, leaving no hidden metadata that could be
 * reverse-correlated to them.
 *
 * All attribute values in stored SVG are XML-escaped (`"`, `<`, `>`, `&`),
 * so the first `>` after the tag name reliably ends an item's open tag and
 * hostile item content can never disguise itself as markup.
 */

const CREATED_BY_ATTRIBUTE = "data-wbo-created-by";
const CREATED_BY_ATTRIBUTE_PATTERN = /\sdata-wbo-created-by="[^"]*"/;

/**
 * Removes the item creator attribute from one stored-item tag, operating only
 * on the open tag so text content that merely mentions the attribute name
 * survives untouched. Tags without the attribute are returned unchanged.
 *
 * @param {string} raw
 * @returns {string}
 */
function stripCreatedByAttribute(raw) {
  const openTagEnd = raw.indexOf(">");
  if (openTagEnd === -1) return raw;
  const openTag = raw.slice(0, openTagEnd);
  if (!openTag.includes(CREATED_BY_ATTRIBUTE)) return raw;
  return (
    openTag.replace(CREATED_BY_ATTRIBUTE_PATTERN, "") + raw.slice(openTagEnd)
  );
}

/**
 * @param {string} svg
 * @returns {number}
 */
function readRootSeq(svg) {
  const parsed = Number.parseInt(
    /data-wbo-seq="(\d+)"/.exec(svg)?.[1] || "",
    10,
  );
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Derives the sanitized Published Canvas from one archived canvas.
 *
 * @param {{
 *   archiveCanvas: string,
 *   showAttribution: boolean,
 *   identifiedParticipantIds?: ReadonlySet<string>,
 * }} input
 * @returns {string}
 */
function derivePublishedCanvas(input) {
  const archiveCanvas = String(input.archiveCanvas || "");
  const identifiedParticipantIds = input.identifiedParticipantIds || new Set();
  const envelope = parseStoredSvgEnvelope(archiveCanvas);
  const itemTags = parseStoredSvgItems(envelope.drawingAreaContent).map(
    (item) => {
      const createdBy = item.attributes[CREATED_BY_ATTRIBUTE];
      const showsIdentifier =
        input.showAttribution === true &&
        typeof createdBy === "string" &&
        createdBy !== "" &&
        identifiedParticipantIds.has(createdBy);
      return showsIdentifier ? item.raw : stripCreatedByAttribute(item.raw);
    },
  );
  // The presentation is read-only by construction; every other root field
  // (extent, format) carries over from the archived canvas.
  const prefix = updateRootMetadata(
    envelope.prefix,
    { readonly: true },
    readRootSeq(envelope.prefix),
  );
  return serializeStoredSvgEnvelope(prefix, itemTags, envelope.suffix);
}

/**
 * The distinct Participant Identifiers still present on a derived canvas —
 * the contributors the read page may list. Only identified participants'
 * identifiers survive derivation, so this can never surface an anonymous one.
 *
 * @param {string} publishedCanvas
 * @returns {string[]}
 */
function listPublishedContributorIds(publishedCanvas) {
  const envelope = parseStoredSvgEnvelope(String(publishedCanvas || ""));
  const contributorIds = new Set();
  for (const item of parseStoredSvgItems(envelope.drawingAreaContent)) {
    const createdBy = item.attributes[CREATED_BY_ATTRIBUTE];
    if (typeof createdBy === "string" && createdBy !== "") {
      contributorIds.add(createdBy);
    }
  }
  return [...contributorIds];
}

export {
  CREATED_BY_ATTRIBUTE,
  derivePublishedCanvas,
  listPublishedContributorIds,
};
