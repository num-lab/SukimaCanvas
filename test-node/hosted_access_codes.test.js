const test = require("node:test");
const assert = require("node:assert/strict");

const {
  accessCodeMatches,
  digestAccessCode,
  generateAccessCode,
  normalizeAccessCode,
} = require("../server/hosted_event/memberships/access_codes.mjs");

test("generated access codes use the unambiguous alphabet and grouping", () => {
  const seen = new Set();
  for (let index = 0; index < 50; index += 1) {
    const code = generateAccessCode();
    // Four groups of five unambiguous digits, hyphen-separated.
    assert.match(code, /^[2-9A-HJKMNP-Z]{5}(-[2-9A-HJKMNP-Z]{5}){3}$/);
    seen.add(code);
  }
  assert.equal(seen.size, 50, "codes must not repeat at this sample size");
});

test("normalization strips separators and case for hand-typed codes", () => {
  assert.equal(normalizeAccessCode("abcdE-2345"), "ABCDE2345");
  assert.equal(normalizeAccessCode(" ab cd 23 "), "ABCD23");
  assert.equal(normalizeAccessCode("全角Spaces-Inside"), "SPACESINSIDE");
  assert.equal(normalizeAccessCode(null), "");
  assert.equal(normalizeAccessCode(42), "");
  assert.equal(normalizeAccessCode("!!!"), "");
});

test("matching compares digests, not raw codes, and rejects garbage", () => {
  const raw = generateAccessCode();
  const digest = digestAccessCode(normalizeAccessCode(raw));
  assert.equal(accessCodeMatches(raw, digest), true);
  // Case and separator differences still match.
  assert.equal(accessCodeMatches(raw.toLowerCase(), digest), true);
  assert.equal(accessCodeMatches(raw.replace(/-/g, " "), digest), true);
  // Wrong codes, empty inputs, and malformed digests never match.
  assert.equal(accessCodeMatches("WRONG-CODE", digest), false);
  assert.equal(accessCodeMatches("", digest), false);
  assert.equal(accessCodeMatches(null, digest), false);
  assert.equal(accessCodeMatches(raw, ""), false);
  assert.equal(accessCodeMatches(raw, null), false);
  assert.equal(accessCodeMatches(raw, "not-a-digest"), false);
  // The digest never leaks the raw code.
  assert.ok(!digest.toUpperCase().includes(normalizeAccessCode(raw)));
});
