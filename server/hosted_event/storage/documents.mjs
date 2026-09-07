import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const DOCUMENT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;

/**
 * @param {string} key
 * @returns {void}
 */
function assertSafeDocumentKey(key) {
  if (
    typeof key !== "string" ||
    !DOCUMENT_KEY_PATTERN.test(key) ||
    key.includes("..") ||
    key.includes("//") ||
    path.isAbsolute(key)
  ) {
    throw new Error(`Refusing unsafe hosted state document key: ${key}`);
  }
}

/**
 * Small persistence seam used by the in-memory Hosted stores. Reads stay
 * synchronous after startup; mutations replace one or more JSON documents
 * durably before their caller completes.
 *
 * @typedef {{key: string, payload: unknown}} DocumentWrite
 * @typedef {{
 *   read: <T>(key: string, fallback: T) => T,
 *   writeMany: (writes: DocumentWrite[]) => Promise<void>,
 * }} StateDocuments
 */

/**
 * @param {{dataDir: string}} options
 * @returns {StateDocuments}
 */
function createFileStateDocuments(options) {
  const root = options.dataDir;

  /**
   * @template T
   * @param {string} key
   * @param {T} fallback
   * @returns {T}
   */
  function read(key, fallback) {
    assertSafeDocumentKey(key);
    try {
      return JSON.parse(fs.readFileSync(path.join(root, key), "utf8"));
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
        return fallback;
      }
      throw error;
    }
  }

  /**
   * @param {DocumentWrite[]} writes
   * @returns {Promise<void>}
   */
  async function writeMany(writes) {
    for (const write of writes) assertSafeDocumentKey(write.key);
    for (const write of writes) {
      const target = path.join(root, write.key);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const temporaryPath = `${target}.tmp-${process.pid}-${crypto
        .randomBytes(4)
        .toString("hex")}`;
      await fs.promises.writeFile(
        temporaryPath,
        JSON.stringify(write.payload),
        "utf8",
      );
      await fs.promises.rename(temporaryPath, target);
    }
  }

  return { read, writeMany };
}

export { assertSafeDocumentKey, createFileStateDocuments };
