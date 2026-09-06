/**
 * Real, dependency-free structural validation for the only Brand Asset image
 * formats the service accepts: PNG, JPEG, and WebP. The declared upload MIME
 * type is never trusted; a file is accepted only when its bytes actually decode
 * as one of these formats. SVG, forged MIME types, corrupt/truncated images,
 * and oversized inputs are all rejected deterministically.
 *
 * "Decode" here means walking the container/segment structure far enough to
 * prove the bytes are a coherent image of the claimed format and to read its
 * pixel dimensions — for PNG this includes verifying every chunk CRC. It is not
 * a full pixel codec, which the service does not need to safely store and serve
 * a logo or cover image.
 */

/** Maximum accepted Brand Asset size: 5 MiB per file. */
export const MAX_BRAND_ASSET_BYTES = 5 * 1024 * 1024;

/** Guard against absurd declared dimensions in an otherwise well-formed header. */
const MAX_IMAGE_DIMENSION = 20000;

/** Sniffed image format -> the content type the controlled read path serves. */
export const FORMAT_CONTENT_TYPES = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** @typedef {"png" | "jpeg" | "webp"} ImageFormat */
/**
 * @typedef {{ok: true, format: ImageFormat, contentType: string, width: number, height: number}
 *   | {ok: false, reason: "empty" | "too_large" | "unsupported_format" | "corrupt"}} SniffResult
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} end
 * @returns {number}
 */
function crc32(buffer, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index++) {
    const entry = CRC_TABLE[(crc ^ (buffer[index] ?? 0)) & 0xff] ?? 0;
    crc = entry ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param {number} width
 * @param {number} height
 * @returns {boolean}
 */
function plausibleDimensions(width, height) {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= 1 &&
    height >= 1 &&
    width <= MAX_IMAGE_DIMENSION &&
    height <= MAX_IMAGE_DIMENSION
  );
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Decodes the buffer as a PNG image: verifies the signature, every chunk CRC,
 * the IHDR dimensions, and the IEND trailer. Shared by the Brand Asset sniff
 * path and the Board Image Export's structural output validation.
 *
 * @param {Buffer} buffer
 * @returns {SniffResult}
 */
export function decodePng(buffer) {
  let offset = PNG_SIGNATURE.length;
  let sawHeader = false;
  let sawEnd = false;
  let width = 0;
  let height = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) return { ok: false, reason: "corrupt" };
    const length = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    // A chunk length that runs past the buffer is a truncated/corrupt file.
    if (length > buffer.length || crcEnd > buffer.length) {
      return { ok: false, reason: "corrupt" };
    }
    const type = buffer.toString("latin1", typeStart, dataStart);
    if (buffer.readUInt32BE(dataEnd) !== crc32(buffer, typeStart, dataEnd)) {
      return { ok: false, reason: "corrupt" };
    }
    if (!sawHeader) {
      // The first chunk of every PNG is a 13-byte IHDR.
      if (type !== "IHDR" || length !== 13) {
        return { ok: false, reason: "corrupt" };
      }
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      if (!plausibleDimensions(width, height)) {
        return { ok: false, reason: "corrupt" };
      }
      sawHeader = true;
    }
    offset = crcEnd;
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
  }
  // A valid PNG ends exactly at IEND, with no trailing bytes appended.
  if (!sawHeader || !sawEnd || offset !== buffer.length) {
    return { ok: false, reason: "corrupt" };
  }
  return {
    ok: true,
    format: "png",
    contentType: FORMAT_CONTENT_TYPES.png,
    width,
    height,
  };
}

/**
 * @param {number} marker
 * @returns {boolean}
 */
function isStartOfFrameMarker(marker) {
  // SOF0..SOF15 (0xC0..0xCF) except DHT (0xC4), JPG (0xC8), and DAC (0xCC).
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

/**
 * @param {Buffer} buffer
 * @returns {SniffResult}
 */
function decodeJpeg(buffer) {
  const endsWithEoi =
    buffer.length >= 2 &&
    buffer[buffer.length - 2] === 0xff &&
    buffer[buffer.length - 1] === 0xd9;
  if (!endsWithEoi) return { ok: false, reason: "corrupt" };
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawFrame = false;
  while (offset + 1 < buffer.length) {
    if (buffer[offset] !== 0xff) return { ok: false, reason: "corrupt" };
    let marker = buffer[offset + 1] ?? 0;
    // Any number of 0xFF fill bytes may precede a marker code.
    while (marker === 0xff) {
      offset += 1;
      if (offset + 1 >= buffer.length) return { ok: false, reason: "corrupt" };
      marker = buffer[offset + 1] ?? 0;
    }
    offset += 2;
    if (marker === 0xd9) break; // EOI
    // RSTn (0xD0..0xD7), TEM (0x01), and re-encountered SOI carry no payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) return { ok: false, reason: "corrupt" };
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      return { ok: false, reason: "corrupt" };
    }
    const segmentDataStart = offset + 2;
    if (isStartOfFrameMarker(marker)) {
      if (segmentLength < 7) return { ok: false, reason: "corrupt" };
      height = buffer.readUInt16BE(segmentDataStart + 1);
      width = buffer.readUInt16BE(segmentDataStart + 3);
      if (!plausibleDimensions(width, height)) {
        return { ok: false, reason: "corrupt" };
      }
      sawFrame = true;
    }
    if (marker === 0xda) {
      // Start of scan: a frame header must already have been seen, and the
      // trailing EOI (verified above) bounds the entropy-coded data.
      if (!sawFrame) return { ok: false, reason: "corrupt" };
      return {
        ok: true,
        format: "jpeg",
        contentType: FORMAT_CONTENT_TYPES.jpeg,
        width,
        height,
      };
    }
    offset += segmentLength;
  }
  return { ok: false, reason: "corrupt" };
}

/**
 * @param {Buffer} buffer
 * @returns {SniffResult}
 */
function decodeWebp(buffer) {
  if (buffer.length < 20) return { ok: false, reason: "corrupt" };
  const chunkFourCc = buffer.toString("latin1", 12, 16);
  const chunkSize = buffer.readUInt32LE(16);
  const chunkStart = 20;
  // The declared chunk must fit; an odd size is padded with one byte.
  if (chunkStart + chunkSize > buffer.length) {
    return { ok: false, reason: "corrupt" };
  }
  let width = 0;
  let height = 0;
  if (chunkFourCc === "VP8 ") {
    if (chunkSize < 10) return { ok: false, reason: "corrupt" };
    // Lossy frames carry the fixed start code 0x9D 0x01 0x2A after the tag.
    if (
      buffer[chunkStart + 3] !== 0x9d ||
      buffer[chunkStart + 4] !== 0x01 ||
      buffer[chunkStart + 5] !== 0x2a
    ) {
      return { ok: false, reason: "corrupt" };
    }
    width = buffer.readUInt16LE(chunkStart + 6) & 0x3fff;
    height = buffer.readUInt16LE(chunkStart + 8) & 0x3fff;
  } else if (chunkFourCc === "VP8L") {
    if (chunkSize < 5 || buffer[chunkStart] !== 0x2f) {
      return { ok: false, reason: "corrupt" };
    }
    const bits =
      ((buffer[chunkStart + 1] ?? 0) |
        ((buffer[chunkStart + 2] ?? 0) << 8) |
        ((buffer[chunkStart + 3] ?? 0) << 16) |
        ((buffer[chunkStart + 4] ?? 0) << 24)) >>>
      0;
    width = (bits & 0x3fff) + 1;
    height = ((bits >> 14) & 0x3fff) + 1;
  } else if (chunkFourCc === "VP8X") {
    if (chunkSize < 10) return { ok: false, reason: "corrupt" };
    width = buffer.readUIntLE(chunkStart + 4, 3) + 1;
    height = buffer.readUIntLE(chunkStart + 7, 3) + 1;
  } else {
    return { ok: false, reason: "corrupt" };
  }
  if (!plausibleDimensions(width, height)) {
    return { ok: false, reason: "corrupt" };
  }
  return {
    ok: true,
    format: "webp",
    contentType: FORMAT_CONTENT_TYPES.webp,
    width,
    height,
  };
}

/**
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function looksLikePng(buffer) {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

/**
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function looksLikeJpeg(buffer) {
  return (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  );
}

/**
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function looksLikeWebp(buffer) {
  return (
    buffer.length >= 12 &&
    buffer.toString("latin1", 0, 4) === "RIFF" &&
    buffer.toString("latin1", 8, 12) === "WEBP"
  );
}

/**
 * Decodes the buffer as a Brand Asset image, returning its format, the content
 * type to serve it with, and its dimensions — or a deterministic rejection
 * reason. The claimed upload MIME type is intentionally not consulted.
 *
 * @param {Buffer} buffer
 * @returns {SniffResult}
 */
export function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (buffer.length > MAX_BRAND_ASSET_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  if (looksLikePng(buffer)) return decodePng(buffer);
  if (looksLikeJpeg(buffer)) return decodeJpeg(buffer);
  if (looksLikeWebp(buffer)) return decodeWebp(buffer);
  return { ok: false, reason: "unsupported_format" };
}
