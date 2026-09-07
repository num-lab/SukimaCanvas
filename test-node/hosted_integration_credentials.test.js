const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  digestCredentialToken,
  generateCredentialToken,
  generateEntryGrantToken,
  isValidEntryGrantToken,
  normalizeExternalReference,
  parseCredentialToken,
} = require("../server/hosted_event/integrations/credentials.mjs");
const {
  createFileIntegrationStore,
} = require("../server/hosted_event/integrations/store.mjs");

const MINUTE = 60 * 1000;

/**
 * A store over a fresh temp data directory driven by an injected clock.
 *
 * @param {{now: number}} holder
 * @param {{grantTtlMs?: number}} [options]
 */
async function createStore(holder, options = {}) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "wbo-hosted-integrations-"),
  );
  return createFileIntegrationStore({
    dataDir,
    clock: () => holder.now,
    grantTtlMs: options.grantTtlMs,
  });
}

test("credential tokens parse only in their issued shape", () => {
  const { secret, token } = generateCredentialToken("abcdefgh-1234");
  const parsed = parseCredentialToken(token);
  assert.ok(parsed);
  assert.equal(parsed.credentialId, "abcdefgh-1234");
  assert.equal(parsed.secret, secret);
  // The secret carries 256 bits of entropy.
  assert.ok(secret.length >= 40);
  // Garbage is rejected before any store lookup.
  assert.equal(parseCredentialToken("no-dot-at-all"), null);
  assert.equal(parseCredentialToken(".nosecret"), null);
  assert.equal(parseCredentialToken("id."), null);
  assert.equal(parseCredentialToken("id.short"), null);
  assert.equal(
    parseCredentialToken("id.with spaces.aabbccddeeff00112233"),
    null,
  );
  assert.equal(parseCredentialToken(42), null);
  assert.equal(parseCredentialToken(null), null);
  assert.equal(parseCredentialToken(undefined), null);
});

test("credential digests never reveal the token and compare safely", () => {
  const { token } = generateCredentialToken("abcdefgh-1234");
  const digest = digestCredentialToken(token);
  assert.ok(!digest.includes("abcdefgh-1234"));
  assert.match(digest, /^[0-9a-f]{64}$/);
  // A different secret does not match; the exact token does.
  const other = generateCredentialToken("abcdefgh-1234");
  assert.notEqual(digestCredentialToken(other.token), digest);
  // A single flipped secret character changes the digest — mutated so the
  // result cannot accidentally reproduce the original token.
  const flipped = token.endsWith("A")
    ? `${token.slice(0, -1)}B`
    : `${token.slice(0, -1)}A`;
  assert.notEqual(digestCredentialToken(flipped), digest);
});

test("grant tokens have the issued shape and hostile values do not", () => {
  for (let index = 0; index < 20; index += 1) {
    assert.equal(isValidEntryGrantToken(generateEntryGrantToken()), true);
  }
  assert.equal(isValidEntryGrantToken(""), false);
  assert.equal(isValidEntryGrantToken("short"), false);
  assert.equal(isValidEntryGrantToken("has/slash____has/slash____"), false);
  assert.equal(isValidEntryGrantToken("has=equal;sign___is-not-ok"), false);
  assert.equal(isValidEntryGrantToken(`A`.repeat(500)), false);
  assert.equal(isValidEntryGrantToken("入場リンク"), false);
  assert.equal(isValidEntryGrantToken(null), false);
  assert.equal(isValidEntryGrantToken(undefined), false);
  assert.equal(isValidEntryGrantToken(12345), false);
});

test("external references stay opaque, bounded, and control-character free", () => {
  assert.equal(normalizeExternalReference(" customer-42 "), "customer-42");
  assert.equal(normalizeExternalReference(" 会议-房间-3"), "会议-房间-3");
  // Control characters are malformed: deterministic rejection, never a
  // silent rewrite.
  assert.equal(normalizeExternalReference("bad\nvalue"), null);
  assert.equal(normalizeExternalReference("with\u0000nul"), null);
  assert.equal(normalizeExternalReference("inte\riors"), null);
  assert.equal(normalizeExternalReference(""), null);
  assert.equal(normalizeExternalReference("   "), null);
  assert.equal(normalizeExternalReference(42), null);
  assert.equal(normalizeExternalReference(null), null);
  // Overlong references fail deterministically instead of truncating.
  assert.equal(normalizeExternalReference("a".repeat(257)), null);
  assert.equal(normalizeExternalReference("a".repeat(256)), "a".repeat(256));
});

test("credentials authenticate, rotate, and revoke within their organizer scope", async () => {
  const holder = { now: 1_000_000 };
  const store = await createStore(holder);

  const created = await store.createCredential({
    organizerId: "org-1",
    createdByAccountId: "owner-1",
  });
  assert.equal(created.ok, true);
  assert.equal(created.credential.organizerId, "org-1");
  assert.equal(created.credential.status, "active");

  // The issued bearer value authenticates.
  const verdict = store.authenticateCredential(`Bearer ${created.token}`);
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.equal(
      verdict.credential.credentialId,
      created.credential.credentialId,
    );
  }
  // The digest alone never authenticates, and neither do near-misses.
  assert.equal(store.authenticateCredential("Bearer not-a-token").ok, false);
  assert.equal(
    store.authenticateCredential(`Bearer ${created.token}x`).ok,
    false,
  );
  assert.equal(
    store.authenticateCredential(`Bearer ${created.token.slice(0, -2)}`).ok,
    false,
  );
  assert.equal(
    store.authenticateCredential(`bearer ${created.token}`).ok,
    false,
  );
  assert.equal(store.authenticateCredential(created.token).ok, false);
  assert.equal(store.authenticateCredential(undefined).ok, false);

  // A credential of another organizer is invisible through this one's id.
  assert.equal(
    store.getCredentialForOrganizer(
      "org-other",
      created.credential.credentialId,
    ),
    null,
  );

  // Rotation replaces the secret: the old bearer value dies immediately.
  holder.now += MINUTE;
  const rotated = await store.rotateCredential({
    organizerId: "org-1",
    credentialId: created.credential.credentialId,
  });
  assert.equal(rotated.ok, true);
  if (rotated.ok) {
    assert.notEqual(rotated.token, created.token);
    assert.equal(
      store.authenticateCredential(`Bearer ${created.token}`).ok,
      false,
    );
    assert.equal(
      store.authenticateCredential(`Bearer ${rotated.token}`).ok,
      true,
    );
  }

  // A credential of another organizer cannot be rotated or revoked here.
  assert.equal(
    (
      await store.rotateCredential({
        organizerId: "org-other",
        credentialId: created.credential.credentialId,
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await store.revokeCredential({
        organizerId: "org-other",
        credentialId: created.credential.credentialId,
      })
    ).ok,
    false,
  );
  // The scoped rotate/revoke calls above left the credential intact.
  assert.equal(
    store.authenticateCredential(
      `Bearer ${/** @type {string} */ (rotated.ok ? rotated.token : "")}`,
    ).ok,
    true,
  );

  // Revocation is permanent: the bearer value stops authenticating and the
  // credential cannot be rotated back to life.
  holder.now += MINUTE;
  assert.equal(
    (
      await store.revokeCredential({
        organizerId: "org-1",
        credentialId: created.credential.credentialId,
      })
    ).ok,
    true,
  );
  assert.equal(
    store.authenticateCredential(
      `Bearer ${/** @type {string} */ (rotated.ok ? rotated.token : "")}`,
    ).ok,
    false,
  );
  const rotateRevoked = await store.rotateCredential({
    organizerId: "org-1",
    credentialId: created.credential.credentialId,
  });
  assert.ok(!rotateRevoked.ok);
  if (!rotateRevoked.ok) {
    assert.equal(rotateRevoked.reason, "revoked");
  }
  // Revoking twice is a no-op, not an error.
  assert.equal(
    (
      await store.revokeCredential({
        organizerId: "org-1",
        credentialId: created.credential.credentialId,
      })
    ).ok,
    true,
  );

  // The metadata list never exposes secrets or digests.
  const listed = store.listCredentialsForOrganizer("org-1");
  assert.equal(listed.length, 1);
  const listedJson = JSON.stringify(listed);
  assert.ok(!listedJson.includes(created.token));
  assert.ok(!listedJson.includes(created.credential.secretDigest));
  const record = listed[0];
  assert.ok(record, "exactly one credential is listed");
  assert.equal(record.status, "revoked");
  assert.equal(typeof record.revokedAtMs, "number");
  assert.equal(typeof record.rotatedAtMs, "number");
});

test("entry grants are single-use, expiring, and die with their credential", async () => {
  const holder = { now: 2_000_000 };
  const store = await createStore(holder, { grantTtlMs: 10 * MINUTE });

  const credential = await store.createCredential({
    organizerId: "org-1",
    createdByAccountId: "owner-1",
  });
  const grant = await store.createEntryGrant({
    organizerId: "org-1",
    eventId: "event-1",
    credentialId: credential.credential.credentialId,
    externalReference: "customer-42",
  });
  assert.equal(grant.grant.expiresAtMs, holder.now + 10 * MINUTE);
  assert.equal(grant.grant.redeemedAtMs, null);

  // Exactly one redemption succeeds.
  assert.equal(
    (
      await store.redeemEntryGrant({
        token: grant.token,
        eventId: "event-1",
        accountId: "account-1",
      })
    ).ok,
    true,
  );
  const rejected = await store.redeemEntryGrant({
    token: grant.token,
    eventId: "event-1",
    accountId: "account-1",
  });
  assert.equal(rejected.ok, false);

  // Redeeming against a different event fails without consuming anything.
  const second = await store.createEntryGrant({
    organizerId: "org-1",
    eventId: "event-1",
    credentialId: credential.credential.credentialId,
  });
  assert.equal(
    (
      await store.redeemEntryGrant({
        token: second.token,
        eventId: "event-2",
        accountId: "account-1",
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await store.redeemEntryGrant({
        token: second.token,
        eventId: "event-1",
        accountId: "account-2",
      })
    ).ok,
    true,
    "the failed foreign-event attempt must not consume the grant",
  );

  // Expiry is inclusive and deterministic.
  const third = await store.createEntryGrant({
    organizerId: "org-1",
    eventId: "event-1",
    credentialId: credential.credential.credentialId,
  });
  holder.now = third.grant.expiresAtMs;
  assert.equal(
    (
      await store.redeemEntryGrant({
        token: third.token,
        eventId: "event-1",
        accountId: "account-1",
      })
    ).ok,
    false,
  );

  // A malformed token never matches anything and never throws.
  for (const hostile of [
    "",
    "short",
    42,
    null,
    undefined,
    {},
    "a".repeat(500),
  ]) {
    const outcome = await store.redeemEntryGrant({
      token: /** @type {any} */ (hostile),
      eventId: "event-1",
      accountId: "account-1",
    });
    assert.equal(outcome.ok, false);
  }

  // Revoking the credential invalidates its outstanding grants.
  holder.now += MINUTE;
  const fourth = await store.createEntryGrant({
    organizerId: "org-1",
    eventId: "event-1",
    credentialId: credential.credential.credentialId,
  });
  await store.revokeCredential({
    organizerId: "org-1",
    credentialId: credential.credential.credentialId,
  });
  assert.equal(
    (
      await store.redeemEntryGrant({
        token: fourth.token,
        eventId: "event-1",
        accountId: "account-1",
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await store.createEntryGrant({
        organizerId: "org-1",
        eventId: "event-1",
        credentialId: credential.credential.credentialId,
      })
    ).ok,
    true,
    "grant creation is the route's decision; the store mints even for revoked credentials",
  );
});

test("credential and grant state survives a restart without secrets", async () => {
  const holder = { now: 3_000_000 };
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "wbo-hosted-integrations-"),
  );
  const options = { dataDir, clock: () => holder.now };
  const store = createFileIntegrationStore(options);
  const credential = await store.createCredential({
    organizerId: "org-1",
    createdByAccountId: "owner-1",
  });
  const grant = await store.createEntryGrant({
    organizerId: "org-1",
    eventId: "event-1",
    credentialId: credential.credential.credentialId,
  });
  await store.flush();

  // Nothing on disk contains the raw secrets.
  const files = await fs.readdir(dataDir);
  assert.deepEqual(files.sort(), ["api_credentials.json", "entry_grants.json"]);
  for (const file of files) {
    const contents = await fs.readFile(path.join(dataDir, file), "utf8");
    assert.ok(!contents.includes(credential.token));
    assert.ok(!contents.includes(grant.token));
  }

  // A fresh store over the same directory keeps authenticating and
  // enforces single-use across the restart.
  const revived = createFileIntegrationStore(options);
  assert.equal(
    revived.authenticateCredential(`Bearer ${credential.token}`).ok,
    true,
  );
  assert.equal(
    (
      await revived.redeemEntryGrant({
        token: grant.token,
        eventId: "event-1",
        accountId: "account-1",
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await revived.redeemEntryGrant({
        token: grant.token,
        eventId: "event-1",
        accountId: "account-1",
      })
    ).ok,
    false,
  );
});
