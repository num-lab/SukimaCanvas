import crypto from "node:crypto";
import observability from "../../observability/index.mjs";
import { createFileStateDocuments } from "../storage/documents.mjs";
import { isValidNormalizedEmail, normalizeEmail } from "./emails.mjs";

const { logger } = observability;

const STORE_FORMAT_VERSION = 1;
const MAX_SESSIONS_PER_ACCOUNT = 50;
const SESSION_TOUCH_INTERVAL_MS = 60_000;
const PUBLIC_ID_PATTERN = /^[0-9a-f]{10}$/;

/**
 * @returns {string}
 */
function randomPublicId() {
  return crypto.randomBytes(5).toString("hex");
}

/**
 * A deregistered account keeps its internal id (so durable security audit —
 * the mutation ledger, moderation log, and organizer Change Audit — stays
 * accountable) but its identity is irreversibly pseudonymized: the email is
 * replaced by a random placeholder no one can map back, and the password
 * hash is dropped. The holder can never sign in again, and public attribution
 * was already an opaque event-scoped Participant Identifier.
 *
 * @typedef {{
 *   accountId: string,
 *   email: string,
 *   passwordHash: string,
 *   status: "active" | "disabled" | "deleted",
 *   verifiedAtMs: number | null,
 *   createdAtMs: number,
 * }} StoredAccount
 */
/**
 * @typedef {{
 *   accountId: string,
 *   expiresAtMs: number,
 * }} StoredSingleUseToken
 */
/**
 * @typedef {{
 *   accountId: string,
 *   publicId: string,
 *   createdAtMs: number,
 *   lastSeenAtMs: number,
 *   expiresAtMs: number,
 * }} StoredSession
 */
/**
 * Single-use digest-token table shared by email verification and password
 * reset: at most one outstanding token per account, replace-on-issue,
 * consume-on-redemption, server-clock expiry. Only digests are ever stored.
 *
 * @param {{
 *   ttlMs: number,
 *   digest: (rawToken: string) => string,
 *   randomToken: () => string,
 *   clock: () => number,
 * }} options
 */
function createSingleUseTokenTable(options) {
  const { ttlMs, digest, randomToken, clock } = options;
  /** @type {Map<string, StoredSingleUseToken>} */
  const tokensByDigest = new Map();
  /** @type {Map<string, string>} */
  const digestsByAccountId = new Map();

  /**
   * @param {string} tokenDigest
   * @param {string} accountId
   * @returns {void}
   */
  function forget(tokenDigest, accountId) {
    tokensByDigest.delete(tokenDigest);
    if (digestsByAccountId.get(accountId) === tokenDigest) {
      digestsByAccountId.delete(accountId);
    }
  }

  return {
    /**
     * @param {string} accountId
     * @returns {string}
     */
    issue(accountId) {
      const previousDigest = digestsByAccountId.get(accountId);
      if (previousDigest !== undefined) forget(previousDigest, accountId);
      const rawToken = randomToken();
      const tokenDigest = digest(rawToken);
      tokensByDigest.set(tokenDigest, {
        accountId,
        expiresAtMs: clock() + ttlMs,
      });
      digestsByAccountId.set(accountId, tokenDigest);
      return rawToken;
    },

    /**
     * @param {string} rawToken
     * @returns {string | null}
     */
    consume(rawToken) {
      if (typeof rawToken !== "string" || rawToken.length === 0) return null;
      const tokenDigest = digest(rawToken);
      const token = tokensByDigest.get(tokenDigest);
      if (!token) return null;
      forget(tokenDigest, token.accountId);
      return token.expiresAtMs <= clock() ? null : token.accountId;
    },

    /**
     * @param {string} rawToken
     * @returns {string | null}
     */
    peek(rawToken) {
      if (typeof rawToken !== "string" || rawToken.length === 0) return null;
      const token = tokensByDigest.get(digest(rawToken));
      if (!token) return null;
      return token.expiresAtMs <= clock() ? null : token.accountId;
    },

    /**
     * @param {number} now
     * @returns {void}
     */
    prune(now) {
      for (const [tokenDigest, token] of tokensByDigest) {
        if (token.expiresAtMs <= now) forget(tokenDigest, token.accountId);
      }
    },

    /**
     * Drops any outstanding token of the account, so a deregistration also
     * kills its verification and password-reset capabilities.
     *
     * @param {string} accountId
     * @returns {void}
     */
    revokeForAccount(accountId) {
      const tokenDigest = digestsByAccountId.get(accountId);
      if (tokenDigest !== undefined) forget(tokenDigest, accountId);
    },

    /**
     * @param {string} tokenDigest
     * @param {StoredSingleUseToken} token
     * @returns {void}
     */
    adopt(tokenDigest, token) {
      tokensByDigest.set(tokenDigest, token);
      digestsByAccountId.set(token.accountId, tokenDigest);
    },

    /**
     * @returns {Map<string, StoredSingleUseToken>}
     */
    tokens() {
      return tokensByDigest;
    },
  };
}

/**
 * Durable account storage for the Hosted Event Service.
 *
 * Reads are served from an in-memory index loaded synchronously on first use,
 * and every mutation is appended to a serialized queue that replaces the
 * store's state documents through the selected file or PostgreSQL adapter.
 * Verification tokens and session ids are persisted only as
 * SHA-256 digests; raw values exist solely in the verification email and the
 * browser cookie.
 *
 * @param {{
 *   dataDir: string,
 *   clock?: () => number,
 *   sessionMaxAgeMs?: number,
 *   sessionIdleMs?: number,
 *   verificationTokenTtlMs?: number,
 *   passwordResetTtlMs?: number,
 *   randomToken?: () => string,
 *   stateDocuments?: import("../storage/documents.mjs").StateDocuments,
 * }} options
 */
function createFileAccountStore(options) {
  const dataDir = options.dataDir;
  const stateDocuments =
    options.stateDocuments || createFileStateDocuments({ dataDir });
  const clock = options.clock || (() => Date.now());
  const sessionMaxAgeMs = positiveOr(
    options.sessionMaxAgeMs,
    30 * 24 * 60 * 60 * 1000,
  );
  const sessionIdleMs = positiveOr(options.sessionIdleMs, 12 * 60 * 60 * 1000);
  const verificationTokenTtlMs = positiveOr(
    options.verificationTokenTtlMs,
    24 * 60 * 60 * 1000,
  );
  const passwordResetTtlMs = positiveOr(
    options.passwordResetTtlMs,
    60 * 60 * 1000,
  );
  const randomToken =
    options.randomToken || (() => crypto.randomBytes(32).toString("base64url"));

  /** @type {Map<string, StoredAccount>} */
  const accountsById = new Map();
  /** @type {Map<string, string>} */
  const accountIdsByEmail = new Map();
  /** @type {Map<string, StoredSession>} */
  const sessionsByDigest = new Map();
  let loaded = false;
  let writeQueue = Promise.resolve();

  const ACCOUNTS_FILE = "accounts.json";
  const VERIFICATIONS_FILE = "verifications.json";
  const RESETS_FILE = "resets.json";
  const SESSIONS_FILE = "sessions.json";

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    const accounts = readStoreFile(ACCOUNTS_FILE, { accounts: [] });
    for (const account of /** @type {StoredAccount[]} */ (
      accounts.accounts || []
    )) {
      accountsById.set(account.accountId, account);
      accountIdsByEmail.set(account.email, account.accountId);
    }
    const verifications = readStoreFile(VERIFICATIONS_FILE, { tokens: {} });
    for (const [
      digestValue,
      token,
    ] of /** @type {[string, StoredSingleUseToken][]} */ (
      Object.entries(verifications.tokens || {})
    )) {
      verificationTokens.adopt(digestValue, token);
    }
    const resets = readStoreFile(RESETS_FILE, { tokens: {} });
    for (const [
      digestValue,
      token,
    ] of /** @type {[string, StoredSingleUseToken][]} */ (
      Object.entries(resets.tokens || {})
    )) {
      resetTokens.adopt(digestValue, token);
    }
    const sessions = readStoreFile(SESSIONS_FILE, { sessions: {} });
    for (const [
      digestValue,
      session,
    ] of /** @type {[string, StoredSession][]} */ (
      Object.entries(sessions.sessions || {})
    )) {
      // Sessions written before public ids existed get one backfilled.
      if (typeof session.publicId !== "string") {
        session.publicId = randomPublicId();
      }
      sessionsByDigest.set(digestValue, session);
    }
  }

  /**
   * @template T
   * @param {string} filePath
   * @param {T} fallback
   * @returns {T}
   */
  function readStoreFile(filePath, fallback) {
    const parsed = /** @type {any} */ (stateDocuments.read(filePath, fallback));
    if (parsed === fallback) return fallback;
    if (parsed.version !== STORE_FORMAT_VERSION) {
      throw new Error(`Unsupported hosted account store format in ${filePath}`);
    }
    return parsed;
  }

  /**
   * Appends one persistence task to the serialized write queue. The caller
   * observes failures of its own task; the chain itself stays alive so a
   * single failed write cannot poison later ones.
   *
   * @template T
   * @param {() => T | Promise<T>} task
   * @returns {Promise<T>}
   */
  function enqueueWrite(task) {
    const pending = /** @type {Promise<void>} */ (
      writeQueue.then(
        () => {},
        () => {},
      )
    );
    const run = pending.then(task);
    writeQueue = run.then(
      () => {},
      (error) => {
        logger.error("hosted_account_store.write_failed", { error });
      },
    );
    return run;
  }

  /**
   * @returns {Promise<void>}
   */
  async function persistNow() {
    const now = clock();
    verificationTokens.prune(now);
    resetTokens.prune(now);
    for (const [sessionDigest, session] of sessionsByDigest) {
      if (session.expiresAtMs <= now) sessionsByDigest.delete(sessionDigest);
    }
    await stateDocuments.writeMany([
      {
        key: ACCOUNTS_FILE,
        payload: {
          version: STORE_FORMAT_VERSION,
          accounts: [...accountsById.values()],
        },
      },
      {
        key: VERIFICATIONS_FILE,
        payload: {
          version: STORE_FORMAT_VERSION,
          tokens: Object.fromEntries(verificationTokens.tokens()),
        },
      },
      {
        key: RESETS_FILE,
        payload: {
          version: STORE_FORMAT_VERSION,
          tokens: Object.fromEntries(resetTokens.tokens()),
        },
      },
      {
        key: SESSIONS_FILE,
        payload: {
          version: STORE_FORMAT_VERSION,
          sessions: Object.fromEntries(sessionsByDigest),
        },
      },
    ]);
  }

  /**
   * @param {string} rawToken
   * @returns {string}
   */
  function digest(rawToken) {
    return crypto.createHash("sha256").update(rawToken, "utf8").digest("hex");
  }

  const verificationTokens = createSingleUseTokenTable({
    ttlMs: verificationTokenTtlMs,
    digest,
    randomToken,
    clock,
  });
  const resetTokens = createSingleUseTokenTable({
    ttlMs: passwordResetTtlMs,
    digest,
    randomToken,
    clock,
  });

  /**
   * @param {{email: string, passwordHash: string}} input
   * @returns {Promise<StoredAccount>}
   */
  async function createAccount(input) {
    ensureLoaded();
    const email = normalizeEmail(input.email);
    if (!isValidNormalizedEmail(email)) {
      throw new Error("invalid account email");
    }
    if (accountIdsByEmail.has(email)) {
      throw new Error(`email already registered: ${email}`);
    }
    /** @type {StoredAccount} */
    const account = {
      accountId: crypto.randomUUID(),
      email,
      passwordHash: String(input.passwordHash || ""),
      status: "active",
      verifiedAtMs: null,
      createdAtMs: clock(),
    };
    accountsById.set(account.accountId, account);
    accountIdsByEmail.set(email, account.accountId);
    await enqueueWrite(persistNow);
    return account;
  }

  /**
   * @param {string} email
   * @returns {StoredAccount | null}
   */
  function getAccountByEmail(email) {
    ensureLoaded();
    const accountId = accountIdsByEmail.get(normalizeEmail(email));
    return accountId ? accountsById.get(accountId) || null : null;
  }

  /**
   * @param {string} accountId
   * @returns {StoredAccount | null}
   */
  function getAccountById(accountId) {
    ensureLoaded();
    return accountsById.get(accountId) || null;
  }

  /**
   * @param {string} accountId
   * @param {number} verifiedAtMs
   * @returns {Promise<void>}
   */
  async function markAccountVerified(accountId, verifiedAtMs) {
    ensureLoaded();
    const account = accountsById.get(accountId);
    if (!account) throw new Error(`unknown account: ${accountId}`);
    account.verifiedAtMs = verifiedAtMs;
    await enqueueWrite(persistNow);
  }

  /**
   * @param {string} accountId
   * @param {"active" | "disabled" | "deleted"} status
   * @returns {Promise<void>}
   */
  async function setAccountStatus(accountId, status) {
    ensureLoaded();
    const account = accountsById.get(accountId);
    if (!account) throw new Error(`unknown account: ${accountId}`);
    account.status = status;
    if (status !== "active") await revokeAccountSessions(accountId);
    await enqueueWrite(persistNow);
  }

  /**
   * Irreversibly pseudonymizes an account (deregistration): the email is
   * replaced by a random placeholder that cannot be mapped back to the
   * holder — not by the platform, not by whoever later reads the store — and
   * the password hash is dropped. Sessions and outstanding verification or
   * reset tokens are revoked, and the terminal `deleted` status keeps every
   * sign-in path refusing. The internal account id is kept on purpose:
   * durable security audit (the mutation ledger, the moderation log, and the
   * organizer Change Audit) remains accountable without exposing an identity,
   * and already-published attribution stays an opaque Participant Identifier.
   *
   * @param {string} accountId
   * @returns {Promise<{ok: boolean, reason?: "not_found" | "already_deleted"}>}
   */
  async function deleteAccount(accountId) {
    ensureLoaded();
    const account = accountsById.get(String(accountId || ""));
    if (!account) return { ok: false, reason: "not_found" };
    if (account.status === "deleted") {
      return { ok: false, reason: "already_deleted" };
    }
    // 128 random bits: no relation to the previous email, no collision risk
    // against the email index. The `.invalid` TLD is reserved and unrouteable.
    const placeholderEmail = `deleted-${crypto
      .randomBytes(16)
      .toString("hex")}@sukimacanvas.invalid`;
    accountIdsByEmail.delete(normalizeEmail(account.email));
    account.email = placeholderEmail;
    accountIdsByEmail.set(placeholderEmail, account.accountId);
    account.passwordHash = "";
    account.status = "deleted";
    await revokeAccountSessions(account.accountId);
    verificationTokens.revokeForAccount(account.accountId);
    resetTokens.revokeForAccount(account.accountId);
    logger.info("hosted.account_deleted", { account_id: account.accountId });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * Issues a new single-use verification token for the account, replacing any
   * outstanding token so only the newest email link works.
   *
   * @param {string} accountId
   * @returns {Promise<string>}
   */
  async function createVerificationToken(accountId) {
    ensureLoaded();
    if (!accountsById.has(accountId)) {
      throw new Error(`unknown account: ${accountId}`);
    }
    const rawToken = verificationTokens.issue(accountId);
    await enqueueWrite(persistNow);
    return rawToken;
  }

  /**
   * @param {string} rawToken
   * @returns {Promise<string | null>}
   */
  async function consumeVerificationToken(rawToken) {
    ensureLoaded();
    const accountId = verificationTokens.consume(rawToken);
    if (accountId) await enqueueWrite(persistNow);
    return accountId;
  }

  /**
   * Issues a new single-use password reset token, replacing any outstanding
   * one so only the newest email link works.
   *
   * @param {string} accountId
   * @returns {Promise<string>}
   */
  async function createPasswordResetToken(accountId) {
    ensureLoaded();
    if (!accountsById.has(accountId)) {
      throw new Error(`unknown account: ${accountId}`);
    }
    const rawToken = resetTokens.issue(accountId);
    await enqueueWrite(persistNow);
    return rawToken;
  }

  /**
   * @param {string} rawToken
   * @returns {Promise<string | null>}
   */
  async function consumePasswordResetToken(rawToken) {
    ensureLoaded();
    const accountId = resetTokens.consume(rawToken);
    if (accountId) await enqueueWrite(persistNow);
    return accountId;
  }

  /**
   * Non-consuming validity check used when rendering the reset form.
   *
   * @param {string} rawToken
   * @returns {string | null}
   */
  function peekPasswordResetToken(rawToken) {
    ensureLoaded();
    return resetTokens.peek(rawToken);
  }

  /**
   * @param {string} accountId
   * @returns {Promise<string>}
   */
  async function createSession(accountId) {
    ensureLoaded();
    if (!accountsById.has(accountId)) {
      throw new Error(`unknown account: ${accountId}`);
    }
    const now = clock();
    const existing = [...sessionsByDigest.entries()]
      .filter(([, session]) => session.accountId === accountId)
      .sort(([, left], [, right]) => left.lastSeenAtMs - right.lastSeenAtMs);
    while (existing.length >= MAX_SESSIONS_PER_ACCOUNT) {
      const oldest = existing.shift();
      if (oldest) sessionsByDigest.delete(oldest[0]);
    }
    const rawSessionId = randomToken();
    sessionsByDigest.set(digest(rawSessionId), {
      accountId,
      publicId: randomPublicId(),
      createdAtMs: now,
      lastSeenAtMs: now,
      expiresAtMs: now + sessionMaxAgeMs,
    });
    await enqueueWrite(persistNow);
    return rawSessionId;
  }

  /**
   * Shared session validation: absolute-expiry, idle-expiry, and last-seen
   * refresh. Returns null and drops the session when it is no longer valid.
   *
   * @param {string} sessionDigest
   * @param {StoredSession} session
   * @returns {{accountId: string, publicId: string} | null}
   */
  function validateSession(sessionDigest, session) {
    const now = clock();
    if (
      session.expiresAtMs <= now ||
      now - session.lastSeenAtMs > sessionIdleMs
    ) {
      sessionsByDigest.delete(sessionDigest);
      enqueueWrite(persistNow);
      return null;
    }
    if (now - session.lastSeenAtMs > SESSION_TOUCH_INTERVAL_MS) {
      session.lastSeenAtMs = now;
      enqueueWrite(persistNow);
    }
    return { accountId: session.accountId, publicId: session.publicId };
  }

  /**
   * @param {string} rawSessionId
   * @returns {Promise<{accountId: string, publicId: string} | null>}
   */
  async function resolveSession(rawSessionId) {
    ensureLoaded();
    if (typeof rawSessionId !== "string" || rawSessionId.length === 0) {
      return null;
    }
    const sessionDigest = digest(rawSessionId);
    const session = sessionsByDigest.get(sessionDigest);
    if (!session) return null;
    return validateSession(sessionDigest, session);
  }

  /**
   * Synchronous session lookup for page rendering. Reads memory only and
   * lets the write queue observe the scheduled persist without blocking the
   * render on disk.
   *
   * @param {string} rawSessionId
   * @returns {{accountId: string, publicId: string} | null}
   */
  function peekSession(rawSessionId) {
    ensureLoaded();
    if (typeof rawSessionId !== "string" || rawSessionId.length === 0) {
      return null;
    }
    const sessionDigest = digest(rawSessionId);
    const session = sessionsByDigest.get(sessionDigest);
    if (!session) return null;
    return validateSession(sessionDigest, session);
  }

  /**
   * Revokes every session held by an account, e.g. when the account is
   * disabled.
   *
   * @param {string} accountId
   * @returns {Promise<void>}
   */
  async function revokeAccountSessions(accountId) {
    ensureLoaded();
    let revoked = false;
    for (const [sessionDigest, session] of sessionsByDigest) {
      if (session.accountId === accountId) {
        sessionsByDigest.delete(sessionDigest);
        revoked = true;
      }
    }
    if (revoked) await enqueueWrite(persistNow);
  }

  /**
   * @param {string} rawSessionId
   * @returns {Promise<void>}
   */
  async function revokeSession(rawSessionId) {
    ensureLoaded();
    if (typeof rawSessionId !== "string" || rawSessionId.length === 0) return;
    const sessionDigest = digest(rawSessionId);
    if (!sessionsByDigest.has(sessionDigest)) return;
    sessionsByDigest.delete(sessionDigest);
    await enqueueWrite(persistNow);
  }

  /**
   * Lists the account's active sessions, most recently active first, with
   * only the stable public id and timestamps; never digests or raw tokens.
   *
   * @param {string} accountId
   * @returns {Promise<{publicId: string, createdAtMs: number, lastSeenAtMs: number}[]>}
   */
  async function listSessions(accountId) {
    ensureLoaded();
    const now = clock();
    return [...sessionsByDigest.values()]
      .filter(
        (session) =>
          session.accountId === accountId &&
          session.expiresAtMs > now &&
          now - session.lastSeenAtMs <= sessionIdleMs,
      )
      .sort((left, right) => right.lastSeenAtMs - left.lastSeenAtMs)
      .map((session) => ({
        publicId: session.publicId,
        createdAtMs: session.createdAtMs,
        lastSeenAtMs: session.lastSeenAtMs,
      }));
  }

  /**
   * Revokes the one session of the account matching the public id.
   *
   * @param {string} accountId
   * @param {string} publicId
   * @returns {Promise<boolean>}
   */
  async function revokeSessionByPublicId(accountId, publicId) {
    ensureLoaded();
    if (typeof publicId !== "string" || !PUBLIC_ID_PATTERN.test(publicId)) {
      return false;
    }
    for (const [sessionDigest, session] of sessionsByDigest) {
      if (session.accountId === accountId && session.publicId === publicId) {
        sessionsByDigest.delete(sessionDigest);
        await enqueueWrite(persistNow);
        return true;
      }
    }
    return false;
  }

  /**
   * Revokes every session of the account except the one to keep (the raw
   * session id of the current browser), returning how many were revoked.
   *
   * @param {string} accountId
   * @param {string} rawSessionIdToKeep
   * @returns {Promise<number>}
   */
  async function revokeOtherSessions(accountId, rawSessionIdToKeep) {
    ensureLoaded();
    const keepDigest = digest(rawSessionIdToKeep);
    let revoked = 0;
    for (const [sessionDigest, session] of sessionsByDigest) {
      if (session.accountId !== accountId) continue;
      if (sessionDigest === keepDigest) continue;
      sessionsByDigest.delete(sessionDigest);
      revoked += 1;
    }
    if (revoked > 0) await enqueueWrite(persistNow);
    return revoked;
  }

  /**
   * Explicit global revocation: invalidates every session in the store.
   *
   * @returns {Promise<number>}
   */
  async function revokeAllSessions() {
    ensureLoaded();
    const revoked = sessionsByDigest.size;
    sessionsByDigest.clear();
    if (revoked > 0) await enqueueWrite(persistNow);
    return revoked;
  }

  /**
   * Replaces the password hash of an existing account. Used by repeated
   * registrations of unverified accounts and by password resets and changes.
   *
   * @param {string} accountId
   * @param {string} passwordHash
   * @returns {Promise<void>}
   */
  async function updateAccountPassword(accountId, passwordHash) {
    ensureLoaded();
    const account = accountsById.get(accountId);
    if (!account) throw new Error(`unknown account: ${accountId}`);
    account.passwordHash = String(passwordHash || "");
    await enqueueWrite(persistNow);
  }

  /**
   * Resolves once every scheduled write has landed on disk.
   *
   * @returns {Promise<void>}
   */
  async function flush() {
    ensureLoaded();
    await writeQueue;
  }

  return {
    createAccount,
    getAccountByEmail,
    getAccountById,
    markAccountVerified,
    setAccountStatus,
    deleteAccount,
    updateAccountPassword,
    createVerificationToken,
    consumeVerificationToken,
    createPasswordResetToken,
    peekPasswordResetToken,
    consumePasswordResetToken,
    createSession,
    resolveSession,
    peekSession,
    listSessions,
    revokeAccountSessions,
    revokeSessionByPublicId,
    revokeOtherSessions,
    revokeAllSessions,
    revokeSession,
    flush,
  };
}

/**
 * @param {number | undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export { createFileAccountStore };
