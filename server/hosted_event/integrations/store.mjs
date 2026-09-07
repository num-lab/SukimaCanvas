import crypto from "node:crypto";

import observability from "../../observability/index.mjs";
import { createFileStateDocuments } from "../storage/documents.mjs";
import {
  credentialTokenMatches,
  digestCredentialToken,
  digestEntryGrantToken,
  generateCredentialToken,
  generateEntryGrantToken,
  isValidEntryGrantToken,
  parseCredentialToken,
} from "./credentials.mjs";

const { logger } = observability;

const STORE_FORMAT_VERSION = 1;
/** Default Entry Grant validity; the checklist contract is 10 minutes. */
const DEFAULT_ENTRY_GRANT_TTL_MS = 10 * 60 * 1000;

/**
 * @typedef {{
 *   credentialId: string,
 *   organizerId: string,
 *   secretDigest: string,
 *   status: "active" | "revoked",
 *   createdAtMs: number,
 *   createdByAccountId: string,
 *   rotatedAtMs: number | null,
 *   revokedAtMs: number | null,
 * }} StoredApiCredential
 */
/**
 * @typedef {{
 *   tokenDigest: string,
 *   eventId: string,
 *   organizerId: string,
 *   credentialId: string,
 *   externalReference: string | null,
 *   createdAtMs: number,
 *   expiresAtMs: number,
 *   redeemedAtMs: number | null,
 *   redeemedByAccountId: string | null,
 * }} StoredEntryGrant
 */

/**
 * Durable storage for Organizer API Credentials and Entry Grants, in JSON
 * files under the shared hosted data directory, exactly like the other hosted
 * stores: reads come from an in-memory index loaded on first use, and every
 * mutation is appended to a serialized write queue with atomic file
 * replacement. Only digests of credential secrets and grant tokens are ever
 * persisted.
 *
 * Single-use semantics are enforced the same way membership admission is:
 * the check-and-consume of a grant runs synchronously before yielding, so
 * two concurrent redemptions cannot both spend one grant.
 *
 * @param {{
 *   dataDir: string,
 *   clock?: () => number,
 *   randomId?: () => string,
 *   grantTtlMs?: number,
 *   stateDocuments?: import("../storage/documents.mjs").StateDocuments,
 * }} options
 */
function createFileIntegrationStore(options) {
  const dataDir = options.dataDir;
  const stateDocuments =
    options.stateDocuments || createFileStateDocuments({ dataDir });
  const clock = options.clock || (() => Date.now());
  const randomId = options.randomId || (() => crypto.randomUUID());
  const grantTtlMs =
    typeof options.grantTtlMs === "number" &&
    Number.isFinite(options.grantTtlMs) &&
    options.grantTtlMs > 0
      ? options.grantTtlMs
      : DEFAULT_ENTRY_GRANT_TTL_MS;

  /** @type {Map<string, StoredApiCredential>} */
  const credentialsById = new Map();
  /** @type {Map<string, StoredEntryGrant>} */
  const grantsByTokenDigest = new Map();
  let loaded = false;
  let writeQueue = Promise.resolve();

  const CREDENTIALS_FILE = "api_credentials.json";
  const GRANTS_FILE = "entry_grants.json";

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    const storedCredentials = readStoreFile(CREDENTIALS_FILE, {
      credentials: [],
    });
    for (const credential of /** @type {StoredApiCredential[]} */ (
      storedCredentials.credentials || []
    )) {
      credentialsById.set(credential.credentialId, credential);
    }
    const storedGrants = readStoreFile(GRANTS_FILE, { grants: [] });
    for (const grant of /** @type {StoredEntryGrant[]} */ (
      storedGrants.grants || []
    )) {
      grantsByTokenDigest.set(grant.tokenDigest, grant);
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
      throw new Error(
        `Unsupported hosted integration store format in ${filePath}`,
      );
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
        logger.error("hosted_integration_store.write_failed", { error });
      },
    );
    return run;
  }

  /**
   * @returns {Promise<void>}
   */
  async function persistNow() {
    await stateDocuments.writeMany([
      {
        key: CREDENTIALS_FILE,
        payload: {
          version: STORE_FORMAT_VERSION,
          credentials: [...credentialsById.values()],
        },
      },
      {
        key: GRANTS_FILE,
        payload: {
          version: STORE_FORMAT_VERSION,
          grants: [...grantsByTokenDigest.values()],
        },
      },
    ]);
  }

  /**
   * The credential behind a credential id, scoped to one organizer. A
   * credential of another organizer resolves to null so nothing about other
   * organizers' integrations leaks.
   *
   * @param {string} organizerId
   * @param {string} credentialId
   * @returns {StoredApiCredential | null}
   */
  function getCredentialForOrganizer(organizerId, credentialId) {
    ensureLoaded();
    const credential = credentialsById.get(String(credentialId || ""));
    if (!credential || credential.organizerId !== organizerId) return null;
    return credential;
  }

  /**
   * Creates a new API Credential for an organizer. The bearer value is
   * returned exactly once; only its digest is stored.
   *
   * @param {{organizerId: string, createdByAccountId: string}} input
   * @returns {Promise<{ok: true, credential: StoredApiCredential, token: string}>}
   */
  async function createCredential(input) {
    ensureLoaded();
    const organizerId = String(input.organizerId || "");
    const generated = generateCredentialToken(randomId());
    /** @type {StoredApiCredential} */
    const credential = {
      credentialId: generated.credentialId,
      organizerId,
      secretDigest: digestCredentialToken(generated.token),
      status: "active",
      createdAtMs: clock(),
      createdByAccountId: String(input.createdByAccountId || ""),
      rotatedAtMs: null,
      revokedAtMs: null,
    };
    credentialsById.set(credential.credentialId, credential);
    await enqueueWrite(persistNow);
    return { ok: true, credential, token: generated.token };
  }

  /**
   * Rotates an active credential: a fresh bearer value replaces the old one,
   * which stops working immediately. Rotation is not revocation — grants the
   * credential already issued stay redeemable.
   *
   * @param {{organizerId: string, credentialId: string}} input
   * @returns {Promise<{ok: true, token: string} | {ok: false, reason: "not_found" | "revoked"}>}
   */
  async function rotateCredential(input) {
    const credential = getCredentialForOrganizer(
      input.organizerId,
      input.credentialId,
    );
    if (!credential) return { ok: false, reason: "not_found" };
    if (credential.status === "revoked") {
      return { ok: false, reason: "revoked" };
    }
    const { token } = generateCredentialToken(credential.credentialId);
    credential.secretDigest = digestCredentialToken(token);
    credential.rotatedAtMs = clock();
    await enqueueWrite(persistNow);
    return { ok: true, token };
  }

  /**
   * Revokes a credential: its bearer value stops authenticating immediately,
   * and its outstanding Entry Grants can no longer be redeemed. Idempotent.
   *
   * @param {{organizerId: string, credentialId: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found"}>}
   */
  async function revokeCredential(input) {
    const credential = getCredentialForOrganizer(
      input.organizerId,
      input.credentialId,
    );
    if (!credential) return { ok: false, reason: "not_found" };
    if (credential.status !== "revoked") {
      credential.status = "revoked";
      credential.revokedAtMs = clock();
      await enqueueWrite(persistNow);
    }
    return { ok: true };
  }

  /**
   * Metadata projections of an organizer's credentials, newest first. Never
   * exposes digests or bearer values.
   *
   * @param {string} organizerId
   * @returns {{credentialId: string, status: "active" | "revoked", createdAtMs: number, rotatedAtMs: number | null, revokedAtMs: number | null}[]}
   */
  function listCredentialsForOrganizer(organizerId) {
    ensureLoaded();
    return [...credentialsById.values()]
      .filter((credential) => credential.organizerId === organizerId)
      .sort((left, right) => right.createdAtMs - left.createdAtMs)
      .map((credential) => ({
        credentialId: credential.credentialId,
        status: credential.status,
        createdAtMs: credential.createdAtMs,
        rotatedAtMs: credential.rotatedAtMs,
        revokedAtMs: credential.revokedAtMs,
      }));
  }

  /**
   * Authenticates an integration API request from its `Authorization: Bearer`
   * value. Strictly read-only: a failed or successful authentication never
   * writes, so the API stays side-effect free until it actually does work.
   * Invalid shape, unknown id, wrong secret, and revoked status are
   * indistinguishable failures.
   *
   * @param {unknown} authorizationHeader
   * @returns {{ok: true, credential: StoredApiCredential} | {ok: false, reason: "invalid"}}
   */
  function authenticateCredential(authorizationHeader) {
    ensureLoaded();
    const raw =
      typeof authorizationHeader === "string" ? authorizationHeader : "";
    // The issued scheme is exactly one bearer value; the shared parser
    // rejects everything else before any lookup.
    const match = /^Bearer +([^\s]+)$/.exec(raw.trim());
    const parsed = parseCredentialToken(match && match[1]);
    if (!parsed) return { ok: false, reason: "invalid" };
    const credential = credentialsById.get(parsed.credentialId);
    if (
      !credential ||
      !credentialTokenMatches(
        `${parsed.credentialId}.${parsed.secret}`,
        credential.secretDigest,
      )
    ) {
      return { ok: false, reason: "invalid" };
    }
    if (credential.status !== "active") {
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, credential };
  }

  /**
   * Mints a 10-minute single-use Entry Grant for one event on behalf of a
   * credential. Event selection and state are the route's responsibility;
   * the store only binds the grant to the resolved event.
   *
   * @param {{
   *   organizerId: string,
   *   eventId: string,
   *   credentialId: string,
   *   externalReference?: string | null,
   * }} input
   * @returns {Promise<{ok: true, token: string, grant: StoredEntryGrant}>}
   */
  async function createEntryGrant(input) {
    ensureLoaded();
    const token = generateEntryGrantToken();
    const now = clock();
    /** @type {StoredEntryGrant} */
    const grant = {
      tokenDigest: digestEntryGrantToken(token),
      eventId: String(input.eventId || ""),
      organizerId: String(input.organizerId || ""),
      credentialId: String(input.credentialId || ""),
      externalReference: input.externalReference || null,
      createdAtMs: now,
      expiresAtMs: now + grantTtlMs,
      redeemedAtMs: null,
      redeemedByAccountId: null,
    };
    grantsByTokenDigest.set(grant.tokenDigest, grant);
    await enqueueWrite(persistNow);
    return { ok: true, token, grant };
  }

  /**
   * Redeems an Entry Grant for one signed-in account, atomically. The
   * check-and-consume is synchronous: expired, already-redeemed, revoked-
   * credential, and event-mismatched grants all fail identically without
   * state changes, and a grant that survives the checks is marked redeemed
   * before the first await, so it can only ever be redeemed once. The
   * External Participant Reference never influences admission — the
   * redeeming account's hosted session is the only identity involved.
   *
   * @param {{token: unknown, eventId: string, accountId: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "invalid"}>}
   */
  async function redeemEntryGrant(input) {
    ensureLoaded();
    const token = /** @type {string} */ (input.token);
    if (!isValidEntryGrantToken(token)) {
      return { ok: false, reason: "invalid" };
    }
    const grant = grantsByTokenDigest.get(digestEntryGrantToken(token));
    const now = clock();
    if (
      !grant ||
      grant.eventId !== input.eventId ||
      grant.expiresAtMs <= now ||
      grant.redeemedAtMs !== null
    ) {
      return { ok: false, reason: "invalid" };
    }
    // A grant dies with its credential: revoking the credential also
    // invalidates everything it issued that is still unredeemed.
    const credential = credentialsById.get(grant.credentialId);
    if (!credential || credential.status !== "active") {
      return { ok: false, reason: "invalid" };
    }
    grant.redeemedAtMs = now;
    grant.redeemedByAccountId = String(input.accountId || "");
    await enqueueWrite(persistNow);
    return { ok: true };
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
    createCredential,
    rotateCredential,
    revokeCredential,
    getCredentialForOrganizer,
    listCredentialsForOrganizer,
    authenticateCredential,
    createEntryGrant,
    redeemEntryGrant,
    flush,
  };
}

export { createFileIntegrationStore };
