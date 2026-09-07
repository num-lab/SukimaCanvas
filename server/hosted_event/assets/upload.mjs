import { BoundaryError } from "../../http/boundary_errors.mjs";
import { MAX_BRAND_ASSET_BYTES } from "./image_validation.mjs";

/**
 * A single file upload flows in as `multipart/form-data`, so the urlencoded
 * `readFormBody` cannot handle it. This is a deliberately small, bounded parser
 * for exactly that: it reads a size-capped body into memory (the whole thing is
 * at most a few MiB), splits it on the declared boundary, and returns the text
 * fields plus the first file part. Hostile inputs — the wrong media type, a
 * missing boundary, an oversized body, or malformed structure — produce
 * deterministic results and never crash the process.
 */

// Headroom over the 5 MiB image cap for boundaries, part headers, and the CSRF
// field. The file's own bytes are still checked against MAX_BRAND_ASSET_BYTES.
const MULTIPART_BODY_HEADROOM_BYTES = 64 * 1024;
const MAX_MULTIPART_BODY_BYTES =
  MAX_BRAND_ASSET_BYTES + MULTIPART_BODY_HEADROOM_BYTES;

/**
 * @param {string | string[] | undefined} value
 * @returns {string | undefined}
 */
function firstHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * @param {string} contentType
 * @returns {string | null}
 */
function boundaryFromContentType(contentType) {
  const match = /;\s*boundary=("?)([^";]+)\1/i.exec(contentType);
  return match ? match[2] || null : null;
}

/**
 * @param {string} headerBlock
 * @returns {{[name: string]: string}}
 */
function parsePartHeaders(headerBlock) {
  /** @type {{[name: string]: string}} */
  const headers = {};
  for (const line of headerBlock.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    headers[name] = line.slice(separator + 1).trim();
  }
  return headers;
}

/**
 * @param {string} disposition
 * @param {string} parameter
 * @returns {string | undefined}
 */
function dispositionParameter(disposition, parameter) {
  const match = new RegExp(`;\\s*${parameter}="([^"]*)"`, "i").exec(
    disposition,
  );
  return match ? match[1] : undefined;
}

/**
 * @typedef {{
 *   fields: {[name: string]: string},
 *   file: {fieldName: string, filename: string, contentType: string, bytes: Buffer} | null,
 * }} MultipartResult
 */

/**
 * Reads a `multipart/form-data` request. Text fields are decoded as UTF-8; the
 * first part that carries a filename is returned as the file. Throws a
 * BoundaryError for the wrong media type (415) or an oversized body (413);
 * returns a result with `file: null` when the body is structurally unusable so
 * the caller can render a deterministic validation error.
 *
 * @param {import("http").IncomingMessage} request
 * @param {{maxBytes?: number}} [options]
 * @returns {Promise<MultipartResult>}
 */
async function readMultipartFormData(request, options = {}) {
  const maxBytes = options.maxBytes || MAX_MULTIPART_BODY_BYTES;
  const contentType = firstHeaderValue(request.headers["content-type"]);
  if (
    typeof contentType !== "string" ||
    !contentType.toLowerCase().startsWith("multipart/form-data")
  ) {
    throw new BoundaryError(415, "unsupported_form_media_type");
  }
  const boundary = boundaryFromContentType(contentType);
  if (!boundary) {
    throw new BoundaryError(415, "unsupported_form_media_type");
  }
  /** @type {Buffer[]} */
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      throw new BoundaryError(413, "form_body_too_large");
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  return parseMultipartBody(body, boundary);
}

/**
 * @param {Buffer} body
 * @param {string} boundary
 * @returns {MultipartResult}
 */
function parseMultipartBody(body, boundary) {
  /** @type {MultipartResult} */
  const result = { fields: {}, file: null };
  const delimiter = Buffer.from(`--${boundary}`);
  const CRLF = Buffer.from("\r\n");
  let searchStart = body.indexOf(delimiter);
  if (searchStart === -1) return result;
  while (searchStart !== -1) {
    let partStart = searchStart + delimiter.length;
    // The closing delimiter is followed by "--"; anything else should be CRLF.
    if (body[partStart] === 0x2d && body[partStart + 1] === 0x2d) break;
    if (body[partStart] === 0x0d && body[partStart + 1] === 0x0a) {
      partStart += 2;
    }
    const nextDelimiter = body.indexOf(delimiter, partStart);
    if (nextDelimiter === -1) break;
    // The bytes between parts end with the CRLF that precedes the delimiter.
    let partEnd = nextDelimiter;
    if (body[partEnd - 2] === 0x0d && body[partEnd - 1] === 0x0a) {
      partEnd -= 2;
    }
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), partStart);
    if (headerEnd !== -1 && headerEnd < partEnd) {
      const headers = parsePartHeaders(
        body.toString("latin1", partStart, headerEnd),
      );
      const disposition = headers["content-disposition"] || "";
      const name = dispositionParameter(disposition, "name");
      const filename = dispositionParameter(disposition, "filename");
      const contentStart = headerEnd + CRLF.length * 2;
      const partBody = body.subarray(contentStart, partEnd);
      if (name !== undefined) {
        if (filename !== undefined) {
          if (!result.file) {
            result.file = {
              fieldName: name,
              filename,
              contentType:
                headers["content-type"] || "application/octet-stream",
              bytes: partBody,
            };
          }
        } else {
          result.fields[name] = partBody.toString("utf8");
        }
      }
    }
    searchStart = nextDelimiter;
  }
  return result;
}

export { readMultipartFormData, MAX_MULTIPART_BODY_BYTES };
