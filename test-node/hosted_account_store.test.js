const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  hashPassword,
  verifyPassword,
  verifyDummyPassword,
} = require("../server/hosted_event/accounts/passwords.mjs");
const {
  normalizeEmail,
  isValidNormalizedEmail,
} = require("../server/hosted_event/accounts/emails.mjs");
const {
  createFileAccountStore,
} = require("../server/hosted_event/accounts/store.mjs");
const {
  createRateLimiter,
} = require("../server/hosted_event/accounts/rate_limits.mjs");
const {
  createOutboxMailDelivery,
} = require("../server/hosted_event/accounts/mail.mjs");
const { createConfig } = require("./test_helpers.js");

const PASSWORD = "correct horse battery staple";

test("password hashes are scrypt strings that verify only for the right password", async () => {
  const stored = await hashPassword(PASSWORD);
  assert.match(stored, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword(PASSWORD, stored), true);
  assert.equal(await verifyPassword("wrong password", stored), false);
  assert.equal(await verifyPassword("", stored), false);
  assert.equal(await verifyDummyPassword(PASSWORD), false);
});

test("password hashes use random salts and reject malformed stored values", async () => {
  const first = await hashPassword(PASSWORD);
  const second = await hashPassword(PASSWORD);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(PASSWORD, "not-a-hash"), false);
  assert.equal(await verifyPassword(PASSWORD, ""), false);
  assert.equal(await verifyPassword(PASSWORD, undefined), false);
  const forged = first.replace(/\$[^$]+$/, `$${"A".repeat(88)}`);
  assert.equal(await verifyPassword(PASSWORD, forged), false);
});

test("email normalization is deterministic and validation rejects hostile input", () => {
  assert.equal(normalizeEmail("  User@Example.COM \n"), "user@example.com");
  assert.equal(normalizeEmail("user@example.com"), "user@example.com");
  assert.equal(normalizeEmail(undefined), "");
  assert.equal(normalizeEmail(42), "");

  assert.equal(isValidNormalizedEmail("user@example.com"), true);
  assert.equal(isValidNormalizedEmail("a.b+tag@sub.example.co"), true);
  assert.equal(isValidNormalizedEmail(""), false);
  assert.equal(isValidNormalizedEmail("user@example.com "), false);
  assert.equal(isValidNormalizedEmail("User@example.com"), false);
  assert.equal(isValidNormalizedEmail("user@localhost"), false);
  assert.equal(isValidNormalizedEmail("user@localhost.com"), true);
  assert.equal(isValidNormalizedEmail("user name@example.com"), false);
  assert.equal(isValidNormalizedEmail("user@exa mple.com"), false);
  assert.equal(isValidNormalizedEmail(".user@example.com"), false);
  assert.equal(isValidNormalizedEmail("user.@example.com"), false);
  assert.equal(isValidNormalizedEmail("us..er@example.com"), false);
  assert.equal(isValidNormalizedEmail("user@-example.com"), false);
  assert.equal(isValidNormalizedEmail("user@example.com."), false);
  assert.equal(isValidNormalizedEmail("user@example..com"), false);
  assert.equal(isValidNormalizedEmail("user@example.c"), false);
  assert.equal(isValidNormalizedEmail("user@example.123"), false);
  assert.equal(isValidNormalizedEmail(`u${"a".repeat(64)}@example.com`), false);
  assert.equal(isValidNormalizedEmail(`u${"a".repeat(63)}@example.com`), true);
  assert.equal(isValidNormalizedEmail(`${"x@".padEnd(255, "a")}.com`), false);
  assert.equal(isValidNormalizedEmail("user@example.com\n"), false);
  assert.equal(isValidNormalizedEmail("user@exa\tmple.com"), false);
});

/**
 * @returns {Promise<string>}
 */
async function createDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "wbo-hosted-accounts-"));
}

/**
 * @param {string} dataDir
 * @param {{clock?: () => number}} [options]
 */
function createStore(dataDir, options = {}) {
  const clock = options.clock || (() => 1_700_000_000_000);
  return createFileAccountStore({
    dataDir,
    clock,
    sessionMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
    sessionIdleMs: 12 * 60 * 60 * 1000,
    verificationTokenTtlMs: 24 * 60 * 60 * 1000,
  });
}

test("account store persists accounts, verification tokens, and sessions across reloads", async () => {
  const dataDir = await createDataDir();
  const store = createStore(dataDir);
  const now = 1_700_000_000_000;
  const clock = () => now;

  const account = await store.createAccount({
    email: "user@example.com",
    passwordHash: await hashPassword(PASSWORD),
  });
  assert.match(account.accountId, /^[0-9a-f-]{36}$/);
  assert.equal(account.email, "user@example.com");
  assert.equal(account.status, "active");
  assert.equal(account.verifiedAtMs, null);
  assert.equal(account.passwordHash.includes(PASSWORD), false);

  await assert.rejects(
    () => store.createAccount({ email: "USER@example.com", passwordHash: "x" }),
    /already registered/,
  );

  const rawToken = await store.createVerificationToken(account.accountId);
  assert.equal(rawToken.length >= 32, true);
  // Regenerating replaces the previous single-use token.
  const rawToken2 = await store.createVerificationToken(account.accountId);
  assert.notEqual(rawToken, rawToken2);
  assert.equal(await store.consumeVerificationToken(rawToken), null);
  assert.equal(
    await store.consumeVerificationToken(rawToken2),
    account.accountId,
  );
  assert.equal(await store.consumeVerificationToken(rawToken2), null);
  assert.equal(await store.consumeVerificationToken("garbage"), null);

  await store.markAccountVerified(account.accountId, clock());
  await store.setAccountStatus(account.accountId, "disabled");
  assert.equal(
    (await store.getAccountByEmail("user@example.com"))?.status,
    "disabled",
  );
  await store.setAccountStatus(account.accountId, "active");

  const rawSession = await store.createSession(account.accountId);
  assert.equal(rawSession.length >= 32, true);
  const resolved = await store.resolveSession(rawSession);
  assert.equal(resolved?.accountId, account.accountId);

  // A reloaded store observes the same durable state.
  const reloaded = createStore(dataDir, { clock });
  const persisted = await reloaded.getAccountByEmail("user@example.com");
  assert.equal(persisted?.verifiedAtMs, clock());
  assert.equal(persisted?.status, "active");
  assert.equal(
    (await reloaded.resolveSession(rawSession))?.accountId,
    account.accountId,
  );
  assert.equal(await reloaded.consumeVerificationToken(rawToken2), null);
});

test("sessions expire by idle timeout and absolute age, and logout revokes them", async () => {
  const dataDir = await createDataDir();
  let now = 1_700_000_000_000;
  const store = createStore(dataDir, { clock: () => now });
  const account = await store.createAccount({
    email: "session-user@example.com",
    passwordHash: await hashPassword(PASSWORD),
  });
  await store.markAccountVerified(account.accountId, now);

  const rawSession = await store.createSession(account.accountId);
  assert.equal(
    (await store.resolveSession(rawSession))?.accountId,
    account.accountId,
  );

  now += 12 * 60 * 60 * 1000 + 1;
  assert.equal(await store.resolveSession(rawSession), null);

  now = 1_700_000_000_000;
  const freshSession = await store.createSession(account.accountId);
  now += 30 * 24 * 60 * 60 * 1000 + 1;
  assert.equal(await store.resolveSession(freshSession), null);

  now = 1_700_000_000_000;
  const revokedSession = await store.createSession(account.accountId);
  await store.revokeSession(revokedSession);
  assert.equal(await store.resolveSession(revokedSession), null);

  // Expired and revoked sessions do not come back after a reload.
  const reloaded = createStore(dataDir, { clock: () => now });
  assert.equal(await reloaded.resolveSession(freshSession), null);
  assert.equal(await reloaded.resolveSession(revokedSession), null);
});

test("disabling an account revokes all of its live sessions", async () => {
  const dataDir = await createDataDir();
  const now = 1_700_000_000_000;
  const store = createStore(dataDir, { clock: () => now });
  const account = await store.createAccount({
    email: "disable-sessions@example.com",
    passwordHash: await hashPassword(PASSWORD),
  });
  await store.markAccountVerified(account.accountId, now);
  const session = await store.createSession(account.accountId);
  assert.equal(
    (await store.resolveSession(session))?.accountId,
    account.accountId,
  );

  await store.setAccountStatus(account.accountId, "disabled");
  assert.equal(await store.resolveSession(session), null);

  // Re-enabling does not resurrect revoked sessions, and the revocation
  // survives a reload.
  await store.setAccountStatus(account.accountId, "active");
  const reloaded = createStore(dataDir, { clock: () => now });
  assert.equal(await reloaded.resolveSession(session), null);
});

test("verification tokens expire after the configured ttl", async () => {
  const dataDir = await createDataDir();
  let now = 1_700_000_000_000;
  const store = createStore(dataDir, { clock: () => now });
  const account = await store.createAccount({
    email: "ttl-user@example.com",
    passwordHash: await hashPassword(PASSWORD),
  });
  const rawToken = await store.createVerificationToken(account.accountId);
  now += 24 * 60 * 60 * 1000 + 1;
  assert.equal(await store.consumeVerificationToken(rawToken), null);
});

test("rate limiter applies fixed windows per key and reports retry time", () => {
  let now = 1_000_000;
  const limiter = createRateLimiter({ clock: () => now, maxEntries: 64 });
  const consume = () => limiter.consume("register", "ip:10.0.0.1", 2, 60_000);

  assert.equal(consume().allowed, true);
  assert.equal(consume().allowed, true);
  const rejected = consume();
  assert.equal(rejected.allowed, false);
  assert.ok(rejected.retryAfterMs > 0 && rejected.retryAfterMs <= 60_000);

  now += 60_001;
  assert.equal(consume().allowed, true);

  // A different key is independent; keys are scoped per kind.
  assert.equal(
    limiter.consume("register", "ip:10.0.0.2", 2, 60_000).allowed,
    true,
  );
  assert.equal(
    limiter.consume("login", "ip:10.0.0.1", 2, 60_000).allowed,
    true,
  );
});

test("outbox mail delivery writes exactly one message file per send", async () => {
  const dataDir = await createDataDir();
  const config = createConfig({
    HOSTED_DATA_DIR: dataDir,
  });
  const mail = createOutboxMailDelivery(config);
  await mail.send({
    to: "user@example.com",
    subject: "Verify your account",
    body: "Open https://example.test/verify?token=secret-token to verify.",
  });

  const outboxDir = path.join(dataDir, "mail-outbox");
  const files = (await fs.readdir(outboxDir)).filter((name) =>
    name.endsWith(".json"),
  );
  assert.equal(files.length, 1);
  const firstFile = files[0] || "";
  const message = JSON.parse(
    await fs.readFile(path.join(outboxDir, firstFile), "utf8"),
  );
  assert.equal(message.to, "user@example.com");
  assert.match(message.body, /secret-token/);
  assert.equal(typeof message.sentAtMs, "number");
});

test("outbox mail delivery fails loudly on invalid recipients", async () => {
  const dataDir = await createDataDir();
  const config = createConfig({ HOSTED_DATA_DIR: dataDir });
  const mail = createOutboxMailDelivery(config);
  await assert.rejects(
    () => mail.send({ to: "../escape", subject: "x", body: "y" }),
    /recipient/,
  );
  const outboxDir = path.join(dataDir, "mail-outbox");
  const files = await fs.readdir(outboxDir).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  assert.equal(files.length, 0);
});

test("password reset tokens are single-use, time-limited, and replace prior ones", async () => {
  const dataDir = await createDataDir();
  let now = 1_700_000_000_000;
  const store = createFileAccountStore({
    dataDir,
    clock: () => now,
    passwordResetTtlMs: 60 * 60 * 1000,
  });
  const account = await store.createAccount({
    email: "reset-tokens@example.com",
    passwordHash: await hashPassword(PASSWORD),
  });
  await store.markAccountVerified(account.accountId, now);

  const firstToken = await store.createPasswordResetToken(account.accountId);
  assert.ok(firstToken.length >= 32);
  // Requesting again replaces the outstanding reset token.
  const secondToken = await store.createPasswordResetToken(account.accountId);
  assert.notEqual(firstToken, secondToken);
  assert.equal(await store.consumePasswordResetToken(firstToken), null);
  assert.equal(
    await store.consumePasswordResetToken(secondToken),
    account.accountId,
  );
  assert.equal(await store.consumePasswordResetToken(secondToken), null);

  const expiredToken = await store.createPasswordResetToken(account.accountId);
  now += 60 * 60 * 1000 + 1;
  assert.equal(await store.consumePasswordResetToken(expiredToken), null);

  const reloaded = createStore(dataDir, { clock: () => now });
  assert.equal(await reloaded.consumePasswordResetToken(expiredToken), null);
});

test("sessions expose stable public ids for listing and targeted revocation", async () => {
  const dataDir = await createDataDir();
  let now = 1_700_000_000_000;
  const store = createFileAccountStore({
    dataDir,
    clock: () => now,
  });
  const account = await store.createAccount({
    email: "public-ids@example.com",
    passwordHash: await hashPassword(PASSWORD),
  });
  await store.markAccountVerified(account.accountId, now);

  const first = await store.createSession(account.accountId);
  now += 5_000;
  const second = await store.createSession(account.accountId);

  const listed = await store.listSessions(account.accountId);
  assert.equal(listed.length, 2);
  const secondEntry = listed[1] || /** @type {typeof listed[number]} */ ({});
  const firstEntry = listed[0] || /** @type {typeof listed[number]} */ ({});
  for (const entry of listed) {
    assert.match(entry.publicId, /^[0-9a-f]{10}$/);
    assert.equal(typeof entry.createdAtMs, "number");
    assert.equal(typeof entry.lastSeenAtMs, "number");
  }
  // Most recently active first, so the current session is easy to spot.
  assert.equal(
    firstEntry.publicId,
    (await store.peekSession(second))?.publicId,
  );
  assert.equal(
    secondEntry.publicId,
    (await store.peekSession(first))?.publicId,
  );

  // Revoking by public id kills exactly that session.
  assert.equal(
    await store.revokeSessionByPublicId(
      account.accountId,
      secondEntry.publicId,
    ),
    true,
  );
  assert.equal(await store.resolveSession(first), null);
  assert.equal(
    (await store.resolveSession(second))?.accountId,
    account.accountId,
  );
  // Revoking an unknown or foreign public id is a no-op.
  assert.equal(
    await store.revokeSessionByPublicId(account.accountId, "nope000000"),
    false,
  );
  assert.equal(
    await store.revokeSessionByPublicId("other-account", firstEntry.publicId),
    false,
  );

  // Revoking all but the kept session leaves only the current one.
  now += 5_000;
  const third = await store.createSession(account.accountId);
  const revokedCount = await store.revokeOtherSessions(
    account.accountId,
    third,
  );
  assert.equal(revokedCount, 1);
  assert.equal(await store.resolveSession(second), null);
  assert.equal(
    (await store.resolveSession(third))?.accountId,
    account.accountId,
  );
  assert.equal((await store.listSessions(account.accountId)).length, 1);

  // A reloaded store backfills public ids for sessions written before them
  // and still lists the survivor.
  const reloaded = createFileAccountStore({ dataDir, clock: () => now });
  const listedAfterReload = await reloaded.listSessions(account.accountId);
  assert.equal(listedAfterReload.length, 1);
  assert.match(listedAfterReload[0]?.publicId || "", /^[0-9a-f]{10}$/);
});

test("global session revocation invalidates every session", async () => {
  const dataDir = await createDataDir();
  const now = 1_700_000_000_000;
  const store = createFileAccountStore({ dataDir, clock: () => now });
  const accountA = await store.createAccount({
    email: "global-a@example.com",
    passwordHash: await hashPassword(PASSWORD),
  });
  const accountB = await store.createAccount({
    email: "global-b@example.com",
    passwordHash: await hashPassword(PASSWORD),
  });
  for (const account of [accountA, accountB]) {
    await store.markAccountVerified(account.accountId, now);
  }
  const sessionA = await store.createSession(accountA.accountId);
  const sessionB = await store.createSession(accountB.accountId);

  await store.revokeAllSessions();
  assert.equal(await store.resolveSession(sessionA), null);
  assert.equal(await store.resolveSession(sessionB), null);
  assert.equal((await store.listSessions(accountA.accountId)).length, 0);

  // Revocation persists across a reload.
  const reloaded = createStore(dataDir, { clock: () => now });
  assert.equal(await reloaded.resolveSession(sessionB), null);
});
