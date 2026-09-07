const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createParticipantIdentifierResolver,
} = require("../server/hosted_event/attribution.mjs");

test("participant identifiers are stable, opaque, and event-scoped", () => {
  const participantIdentifierFor = createParticipantIdentifierResolver(
    "deployment-secret-1",
  );

  const aliceInEventA = participantIdentifierFor("event-a", "account-1");
  const aliceInEventAAgain = participantIdentifierFor("event-a", "account-1");
  const aliceInEventB = participantIdentifierFor("event-b", "account-1");
  const bobInEventA = participantIdentifierFor("event-a", "account-2");

  assert.equal(aliceInEventA, aliceInEventAAgain);
  assert.notEqual(aliceInEventA, aliceInEventB);
  assert.notEqual(aliceInEventA, bobInEventA);
  assert.match(aliceInEventA, /^p[0-9a-f]{16}$/);
  // The identifier is opaque: it must not embed either input.
  assert.ok(!aliceInEventA.includes("event-a"));
  assert.ok(!aliceInEventA.includes("account-1"));
});

test("participant identifiers are deployment secrets and differ across secrets", () => {
  const first = createParticipantIdentifierResolver("secret-one");
  const second = createParticipantIdentifierResolver("secret-two");
  assert.notEqual(
    first("event-a", "account-1"),
    second("event-a", "account-1"),
  );
});

test("an empty deployment secret is refused", () => {
  assert.throws(() => createParticipantIdentifierResolver(""));
  assert.throws(() =>
    createParticipantIdentifierResolver(/** @type {any} */ (undefined)),
  );
});
