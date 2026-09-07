import crypto from "node:crypto";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { assertSafeArchiveKey, createArchiveExistsError } from "./store.mjs";

/**
 * @param {unknown} error
 * @returns {number | undefined}
 */
function httpStatus(error) {
  if (!error || typeof error !== "object" || !("$metadata" in error)) {
    return undefined;
  }
  return /** @type {{httpStatusCode?: number}} */ (error.$metadata)
    .httpStatusCode;
}

/**
 * @param {unknown} body
 * @returns {Promise<Buffer>}
 */
async function bodyToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (typeof body === "object" && "transformToByteArray" in body) {
    const bytes =
      await /** @type {{transformToByteArray: () => Promise<Uint8Array>}} */ (
        body
      ).transformToByteArray();
    return Buffer.from(bytes);
  }
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (body)) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * S3-compatible immutable object adapter. Cloudflare R2 uses `region=auto`
 * and its account endpoint, but the adapter intentionally remains portable.
 *
 * @param {{
 *   bucket: string,
 *   endpoint: string,
 *   accessKeyId: string,
 *   secretAccessKey: string,
 *   region?: string,
 *   prefix?: string,
 *   client?: Pick<S3Client, "send">,
 * }} options
 */
function createS3BoardArchiveStore(options) {
  const bucket = String(options.bucket || "").trim();
  const endpoint = String(options.endpoint || "").trim();
  const accessKeyId = String(options.accessKeyId || "");
  const secretAccessKey = String(options.secretAccessKey || "");
  const rawPrefix = String(options.prefix || "").replace(/^\/+|\/+$/g, "");
  if (rawPrefix) assertSafeArchiveKey(rawPrefix);
  const prefix = rawPrefix ? `${rawPrefix}/` : "";
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "S3 object storage requires endpoint, bucket, access key id, and secret access key",
    );
  }
  const parsedEndpoint = new URL(endpoint);
  if (
    parsedEndpoint.protocol !== "https:" ||
    parsedEndpoint.username ||
    parsedEndpoint.password ||
    parsedEndpoint.search ||
    parsedEndpoint.hash
  ) {
    throw new Error(
      "S3 object storage endpoint must be an HTTPS URL without credentials, query, or fragment",
    );
  }
  const client =
    options.client ||
    new S3Client({
      region: options.region || "auto",
      endpoint: parsedEndpoint.href,
      credentials: { accessKeyId, secretAccessKey },
    });

  /** @param {string} key */
  const storedKey = (key) => `${prefix}${key}`;

  async function initialize() {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    const probeKey = `storage-probes/${crypto.randomUUID()}.txt`;
    const probe = Buffer.from("sukimacanvas-storage-probe-v1", "utf8");
    let written = false;
    try {
      await putArchive(probeKey, probe);
      written = true;
      const restored = await readArchive(probeKey);
      if (!restored?.equals(probe)) {
        throw new Error("S3 object storage probe did not round-trip");
      }
    } finally {
      if (written) await deleteObject(probeKey);
    }
  }

  /** @param {string} key */
  async function readArchive(key) {
    assertSafeArchiveKey(key);
    try {
      const result = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: storedKey(key) }),
      );
      return await bodyToBuffer(result.Body);
    } catch (error) {
      if (httpStatus(error) === 404) return null;
      throw error;
    }
  }

  /** @param {string} key @param {string | Uint8Array} content */
  async function putArchive(key, content) {
    assertSafeArchiveKey(key);
    const bytes =
      typeof content === "string" ? Buffer.from(content, "utf8") : content;
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: storedKey(key),
          Body: bytes,
          ContentLength: bytes.byteLength,
          IfNoneMatch: "*",
        }),
      );
      return;
    } catch (error) {
      if (httpStatus(error) !== 412) throw error;
    }
    const existing = await readArchive(key);
    if (!existing || !existing.equals(bytes))
      throw createArchiveExistsError(key);
  }

  /** @param {string} keyPrefix */
  async function listObjectKeys(keyPrefix) {
    const cleanPrefix = keyPrefix.endsWith("/")
      ? keyPrefix.slice(0, -1)
      : keyPrefix;
    assertSafeArchiveKey(cleanPrefix);
    const requestedPrefix = `${storedKey(cleanPrefix)}/`;
    /** @type {string[]} */
    const keys = [];
    let continuationToken;
    const seenTokens = new Set();
    do {
      const result =
        /** @type {import("@aws-sdk/client-s3").ListObjectsV2Output} */ (
          await client.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: requestedPrefix,
              ContinuationToken: continuationToken,
            }),
          )
        );
      for (const item of result.Contents || []) {
        if (
          typeof item.Key === "string" &&
          item.Key.startsWith(requestedPrefix)
        ) {
          keys.push(item.Key.slice(prefix.length));
        }
      }
      if (!result.IsTruncated) {
        continuationToken = undefined;
        continue;
      }
      continuationToken = result.NextContinuationToken;
      if (!continuationToken || seenTokens.has(continuationToken)) {
        throw new Error("S3 object listing returned an invalid continuation");
      }
      seenTokens.add(continuationToken);
    } while (continuationToken);
    return keys.sort();
  }

  /** @param {string} key */
  async function deleteObject(key) {
    assertSafeArchiveKey(key);
    await client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: storedKey(key) }),
    );
  }

  return { initialize, putArchive, readArchive, listObjectKeys, deleteObject };
}

export { createS3BoardArchiveStore };
