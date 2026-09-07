const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  sniffImage,
  MAX_BRAND_ASSET_BYTES,
} = require("../server/hosted_event/assets/image_validation.mjs");
const {
  createFileBrandAssetStore,
} = require("../server/hosted_event/assets/store.mjs");

/**
 * CRC-32 (same polynomial the PNG spec uses) for building valid fixtures.
 *
 * @param {Buffer} buffer
 * @returns {number}
 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Builds a genuine, CRC-correct 1x1 PNG so the decoder is exercised against a
 * real file rather than a hand-forged header.
 *
 * @returns {Buffer}
 */
function makeValidPng() {
  /**
   * @param {string} type
   * @param {Buffer} data
   * @returns {Buffer}
   */
  const chunk = (type, data) => {
    const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData), 0);
    return Buffer.concat([length, typeAndData, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const idat = zlib.deflateSync(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// A real minimal baseline JPEG (1x1) — the widely used smallest-JPEG blob.
const VALID_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
    "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
    "AAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==",
  "base64",
);

// A real lossless WebP (VP8L) container.
const VALID_WEBP = Buffer.from(
  "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==",
  "base64",
);

test("decodable PNG, JPEG, and WebP are accepted with their sniffed content type", () => {
  const png = sniffImage(makeValidPng());
  assert.equal(png.ok, true);
  assert.equal(png.format, "png");
  assert.equal(png.contentType, "image/png");

  const jpeg = sniffImage(VALID_JPEG);
  assert.equal(jpeg.ok, true, "the minimal JPEG fixture must decode");
  assert.equal(jpeg.format, "jpeg");
  assert.equal(jpeg.contentType, "image/jpeg");

  const webp = sniffImage(VALID_WEBP);
  assert.equal(webp.ok, true, "the minimal WebP fixture must decode");
  assert.equal(webp.format, "webp");
  assert.equal(webp.contentType, "image/webp");
});

test("SVG is rejected even when it claims an image content type", () => {
  const svg = Buffer.from(
    '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    "utf8",
  );
  const result = sniffImage(svg);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported_format");
});

test("a forged MIME (wrong magic bytes) is rejected", () => {
  // Not any supported magic — the declared type is irrelevant to sniffing.
  const forged = Buffer.from("GIF89a not really an image", "latin1");
  assert.equal(sniffImage(forged).ok, false);
});

test("a corrupt PNG with a broken chunk CRC is rejected", () => {
  const png = makeValidPng();
  // Flip a byte inside the IDAT payload; its CRC no longer matches.
  const corrupt = Buffer.from(png);
  const flipAt = corrupt.length - 6;
  corrupt[flipAt] = (corrupt[flipAt] ?? 0) ^ 0xff;
  const result = sniffImage(corrupt);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "corrupt");
});

test("a truncated PNG is rejected", () => {
  const png = makeValidPng();
  assert.equal(sniffImage(png.subarray(0, png.length - 8)).ok, false);
});

test("a truncated JPEG (no EOI) is rejected", () => {
  assert.equal(
    sniffImage(VALID_JPEG.subarray(0, VALID_JPEG.length - 4)).ok,
    false,
  );
});

test("an empty buffer is rejected", () => {
  assert.equal(sniffImage(Buffer.alloc(0)).ok, false);
});

test("an oversized buffer is rejected without decoding", () => {
  const huge = Buffer.alloc(MAX_BRAND_ASSET_BYTES + 1);
  // Even with a valid PNG signature, the size guard fires first.
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(huge);
  const result = sniffImage(huge);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "too_large");
});

test("the brand asset store round-trips bytes under an unguessable id", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-brand-asset-"));
  const store = createFileBrandAssetStore({ dataDir });
  const bytes = makeValidPng();
  const put = await store.putAsset({
    kind: "event_cover",
    organizerId: "org-1",
    eventId: "ev-1",
    format: "png",
    contentType: "image/png",
    bytes,
  });
  assert.ok(put.assetId.length >= 16);
  // The id is opaque base64url, not a path or a guessable counter.
  assert.match(put.assetId, /^[A-Za-z0-9_-]+$/);

  const meta = store.getAsset(put.assetId);
  assert.ok(meta);
  assert.equal(meta.contentType, "image/png");
  assert.equal(meta.byteLength, bytes.length);

  const read = await store.readAssetBytes(put.assetId);
  assert.ok(read);
  assert.ok(read.equals(bytes));

  // Unknown ids resolve to nothing rather than throwing or leaking a path.
  assert.equal(store.getAsset("does-not-exist"), null);
  assert.equal(await store.readAssetBytes("does-not-exist"), null);

  // A fresh store instance recovers the persisted asset.
  const reloaded = createFileBrandAssetStore({ dataDir });
  const reloadedMeta = reloaded.getAsset(put.assetId);
  assert.ok(reloadedMeta);
  assert.equal(reloadedMeta.byteLength, bytes.length);

  // Deleting the asset drops both the index entry and the bytes; a reload no
  // longer finds it, and deleting an unknown id is a harmless no-op.
  assert.deepEqual(await reloaded.deleteAsset(put.assetId), { ok: true });
  await reloaded.flush();
  assert.equal(reloaded.getAsset(put.assetId), null);
  assert.equal(await reloaded.readAssetBytes(put.assetId), null);
  assert.deepEqual(await reloaded.deleteAsset(put.assetId), { ok: false });
  const afterDelete = createFileBrandAssetStore({ dataDir });
  assert.equal(afterDelete.getAsset(put.assetId), null);
});
