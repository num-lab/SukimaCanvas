import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Object storage for Private Board Archives.
 *
 * This is the first production adapter behind the archive storage contract:
 * objects live as files under `<WBO_HOSTED_DATA_DIR>/board-archives/<key>`, so
 * an S3-compatible adapter can replace it without touching the close
 * pipeline. The contract is deliberately small — put and read — because
 * archives are write-once results that only the platform's own authorized
 * surfaces ever consume.
 *
 * Immutability contract: the content stored under a key can never change. A
 * put against an existing key with different content is refused; re-putting
 * byte-identical content is a no-op success, so a close attempt that crashed
 * between the archive writes and the lifecycle seal can retry safely.
 *
 * Keys are internal identifiers, never public access credentials: nothing
 * serves this directory over HTTP, public URLs carry only Event Public IDs,
 * and archive access always goes through an authorized platform surface.
 */

const ARCHIVE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;

/**
 * @param {string} key
 * @returns {Error & {code: string, key: string}}
 */
function createArchiveExistsError(key) {
  const error =
    /** @type {Error & {code: string, key: string}} */
    (
      new Error(
        `Board Archive object already exists with other content: ${key}`,
      )
    );
  error.code = "WBO_ARCHIVE_OBJECT_EXISTS";
  error.key = key;
  return error;
}

/**
 * @param {string} key
 * @returns {void}
 */
function assertSafeArchiveKey(key) {
  if (
    typeof key !== "string" ||
    !ARCHIVE_KEY_PATTERN.test(key) ||
    key.includes("..") ||
    key.includes("//")
  ) {
    throw new Error(`Refusing unsafe Board Archive key: ${key}`);
  }
}

/**
 * @param {{
 *   dataDir: string,
 * }} dependencies
 * @returns {{
 *   putArchive: (key: string, content: string | Uint8Array) => Promise<void>,
 *   readArchive: (key: string) => Promise<Buffer | null>,
 * }}
 */
function createFileBoardArchiveStore(dependencies) {
  const root = path.join(dependencies.dataDir, "board-archives");

  /**
   * Stores one archive object under its key, atomically (temp file + rename)
   * and immutably.
   *
   * @param {string} key
   * @param {string | Uint8Array} content
   * @returns {Promise<void>}
   */
  async function putArchive(key, content) {
    assertSafeArchiveKey(key);
    const target = path.join(root, key);
    const bytes =
      typeof content === "string" ? Buffer.from(content, "utf8") : content;
    let existing = null;
    try {
      existing = await fsp.readFile(target);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {
        throw error;
      }
    }
    if (existing) {
      if (!existing.equals(bytes)) throw createArchiveExistsError(key);
      return;
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const temporaryPath = `${target}.tmp-${process.pid}-${crypto
      .randomBytes(4)
      .toString("hex")}`;
    await fsp.writeFile(temporaryPath, bytes);
    await fsp.rename(temporaryPath, target);
  }

  /**
   * Reads one archive object, or null when it does not exist.
   *
   * @param {string} key
   * @returns {Promise<Buffer | null>}
   */
  async function readArchive(key) {
    assertSafeArchiveKey(key);
    try {
      return await fsp.readFile(path.join(root, key));
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  return { putArchive, readArchive };
}

export { createFileBoardArchiveStore };
