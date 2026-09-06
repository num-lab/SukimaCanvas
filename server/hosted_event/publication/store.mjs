import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import observability from "../../observability/index.mjs";

const { logger } = observability;

const STORE_FORMAT_VERSION = 1;

/**
 * The three Publication Audiences of a Published Canvas, re-checked on every
 * read: only the organizer's members, only the event's participants, or
 * whoever holds the unguessable share link.
 *
 * @typedef {"organizer" | "members" | "link"} PublicationAudience
 */
/**
 * The durable publication of one closed Board Session. `published` records
 * serve the derived canvas; `revoked` records serve nothing — revocation
 * immediately invalidates every audience and share link, and a later publish
 * re-derives from the archive and mints fresh capabilities.
 *
 * @typedef {"published" | "revoked"} PublicationStatus
 */
/**
 * @typedef {{
 *   publicationId: string,
 *   boardSessionId: string,
 *   eventId: string,
 *   organizerId: string,
 *   status: PublicationStatus,
 *   audience: PublicationAudience,
 *   showAttribution: boolean,
 *   shareTokenDigest: string | null,
 *   generation: number,
 *   canvasKey: string,
 *   canvasSha256: string,
 *   archivedFinalSeq: number,
 *   itemCount: number,
 *   publishedByAccountId: string,
 *   publishedAtMs: number,
 *   updatedAtMs: number,
 *   revokedAtMs: number | null,
 *   revokedByAccountId: string | null,
 * }} StoredPublication
 */

/**
 * A non-enumerable share link token: 128 bits of base64url entropy. The raw
 * token is returned by the minting publish exactly once and lives on in the
 * organizer's copy of the link; the store persists only its SHA-256 digest,
 * like every other credential in the service.
 *
 * @returns {string}
 */
function generateShareToken() {
  return crypto.randomBytes(16).toString("base64url");
}

/**
 * SHA-256 hex digest of a share link token; the only form ever stored.
 *
 * @param {string} token
 * @returns {string}
 */
function digestShareToken(token) {
  return crypto
    .createHash("sha256")
    .update(String(token || ""), "utf8")
    .digest("hex");
}

const AUDIENCES = new Set(["organizer", "members", "link"]);

/**
 * Durable storage for Published Canvas publications, in JSON files under the
 * shared hosted data directory, exactly like the other hosted stores: reads
 * come from an in-memory index loaded on first use, and every mutation is
 * appended to a serialized write queue with atomic file replacement.
 *
 * The store owns the derived canvas objects too, putting them into the same
 * immutable archive store the Private Board Archives use under their own
 * `published-canvases/` key namespace. Keys are internal identifiers, never
 * public access credentials — reads go through the audience-checked route.
 * Derivation is deterministic, so each generation's put is a no-op when a
 * crashed publish retries, and content that the policy did not change keeps
 * the current generation's object.
 *
 * @param {{
 *   dataDir: string,
 *   clock?: () => number,
 *   randomId?: () => string,
 *   archiveStore: ReturnType<typeof import("../archive/store.mjs").createFileBoardArchiveStore>,
 * }} options
 */
function createFilePublicationStore(options) {
  const dataDir = options.dataDir;
  const clock = options.clock || (() => Date.now());
  const randomId = options.randomId || (() => crypto.randomUUID());
  const archiveStore = options.archiveStore;

  /** @type {Map<string, StoredPublication>} */
  const publicationsByBoardSession = new Map();
  /** @type {Map<string, string>} */
  const boardSessionIdsByShareTokenDigest = new Map();
  let loaded = false;
  let writeQueue = Promise.resolve();

  const PUBLICATIONS_FILE = path.join(dataDir, "publications.json");

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    fs.mkdirSync(dataDir, { recursive: true });
    const stored = readStoreFile(PUBLICATIONS_FILE, { publications: [] });
    for (const publication of /** @type {StoredPublication[]} */ (
      stored.publications || []
    )) {
      publicationsByBoardSession.set(publication.boardSessionId, publication);
      if (publication.shareTokenDigest) {
        boardSessionIdsByShareTokenDigest.set(
          publication.shareTokenDigest,
          publication.boardSessionId,
        );
      }
    }
  }

  /**
   * @template T
   * @param {string} filePath
   * @param {T} fallback
   * @returns {T}
   */
  function readStoreFile(filePath, fallback) {
    let contents;
    try {
      contents = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
        return fallback;
      }
      throw error;
    }
    const parsed = JSON.parse(contents);
    if (parsed.version !== STORE_FORMAT_VERSION) {
      throw new Error(
        `Unsupported hosted publication store format in ${filePath}`,
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
        logger.error("hosted_publication_store.write_failed", { error });
      },
    );
    return run;
  }

  /**
   * @returns {Promise<void>}
   */
  async function persistNow() {
    fs.mkdirSync(dataDir, { recursive: true });
    await writeStoreFile(PUBLICATIONS_FILE, {
      version: STORE_FORMAT_VERSION,
      publications: [...publicationsByBoardSession.values()],
    });
  }

  /**
   * @param {string} filePath
   * @param {unknown} payload
   * @returns {Promise<void>}
   */
  async function writeStoreFile(filePath, payload) {
    const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto
      .randomBytes(4)
      .toString("hex")}`;
    await fs.promises.writeFile(temporaryPath, JSON.stringify(payload), "utf8");
    await fs.promises.rename(temporaryPath, filePath);
  }

  /**
   * @param {string} boardSessionId
   * @param {number} generation
   * @returns {string}
   */
  function canvasObjectKey(boardSessionId, generation) {
    return `published-canvases/${boardSessionId}/${generation}.svg`;
  }

  /**
   * Publishes (or republishes) one closed Board Session's sanitized canvas.
   * The sanitized content is derived by the caller from the Private Board
   * Archive; this store addresses it immutably and owns the policy record:
   *
   * - Unchanged content keeps the current generation's object, so a policy
   *   edit that does not affect the artifact never duplicates storage.
   * - Changed content lands under the next generation key — monotonic per
   *   Board Session, so a republished canvas never collides with an older
   *   generation's immutable object.
   * - A `link` audience mints a fresh share token on every publish: the raw
   *   token is returned exactly once, the previous link stops working, and a
   *   revoked publication never has its old capabilities reused.
   *
   * @param {{
   *   boardSessionId: string,
   *   eventId: string,
   *   organizerId: string,
   *   audience: string,
   *   showAttribution: boolean,
   *   canvasContent: string,
   *   archivedFinalSeq: number,
   *   itemCount: number,
   *   actorAccountId: string,
   * }} input
   * @returns {Promise<{ok: true, publication: StoredPublication, shareToken: string | null} | {ok: false, reason: "invalid_input"}>}
   */
  async function publish(input) {
    ensureLoaded();
    const boardSessionId = String(input.boardSessionId || "");
    const eventId = String(input.eventId || "");
    const organizerId = String(input.organizerId || "");
    const audience = /** @type {PublicationAudience} */ (input.audience);
    const canvasContent = String(input.canvasContent || "");
    if (
      boardSessionId === "" ||
      eventId === "" ||
      organizerId === "" ||
      !AUDIENCES.has(audience) ||
      canvasContent === "" ||
      !Number.isSafeInteger(input.archivedFinalSeq) ||
      input.archivedFinalSeq < 0 ||
      !Number.isSafeInteger(input.itemCount) ||
      input.itemCount < 0
    ) {
      return { ok: false, reason: "invalid_input" };
    }
    const canvasSha256 = crypto
      .createHash("sha256")
      .update(canvasContent, "utf8")
      .digest("hex");
    const now = clock();
    const existing = publicationsByBoardSession.get(boardSessionId);
    const contentUnchanged =
      existing !== undefined &&
      existing.status === "published" &&
      existing.canvasSha256 === canvasSha256;
    let generation;
    let canvasKey;
    if (contentUnchanged) {
      generation = existing.generation;
      canvasKey = existing.canvasKey;
    } else {
      generation = (existing?.generation || 0) + 1;
      canvasKey = canvasObjectKey(boardSessionId, generation);
      await archiveStore.putArchive(canvasKey, canvasContent);
    }
    let shareToken = null;
    let shareTokenDigest = null;
    if (audience === "link") {
      shareToken = generateShareToken();
      shareTokenDigest = digestShareToken(shareToken);
    }
    /** @type {StoredPublication} */
    const publication = {
      publicationId: existing?.publicationId || randomId(),
      boardSessionId,
      eventId,
      organizerId,
      status: "published",
      audience,
      showAttribution: input.showAttribution === true,
      shareTokenDigest,
      generation,
      canvasKey,
      canvasSha256,
      archivedFinalSeq: input.archivedFinalSeq,
      itemCount: input.itemCount,
      publishedByAccountId: String(input.actorAccountId || ""),
      publishedAtMs:
        existing?.status === "revoked" ? now : existing?.publishedAtMs || now,
      updatedAtMs: now,
      revokedAtMs: null,
      revokedByAccountId: null,
    };
    // A replaced share token stops granting access immediately: the digest
    // index only ever holds the live record's token.
    if (
      existing?.shareTokenDigest &&
      existing.shareTokenDigest !== shareTokenDigest
    ) {
      boardSessionIdsByShareTokenDigest.delete(existing.shareTokenDigest);
    }
    publicationsByBoardSession.set(boardSessionId, publication);
    if (shareTokenDigest) {
      boardSessionIdsByShareTokenDigest.set(shareTokenDigest, boardSessionId);
    }
    await enqueueWrite(persistNow);
    return { ok: true, publication, shareToken };
  }

  /**
   * Withdraws a publication: every audience and share link stops working
   * immediately because reads consult this record. The share token digest is
   * dropped, so the revoked capability does not even survive at rest.
   * Revoking an unpublished Board Session is refused without side effects.
   *
   * @param {{boardSessionId: string, actorAccountId: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found" | "not_published"}>}
   */
  async function revoke(input) {
    ensureLoaded();
    const publication = publicationsByBoardSession.get(
      String(input.boardSessionId || ""),
    );
    if (!publication) return { ok: false, reason: "not_found" };
    if (publication.status !== "published") {
      return { ok: false, reason: "not_published" };
    }
    if (publication.shareTokenDigest) {
      boardSessionIdsByShareTokenDigest.delete(publication.shareTokenDigest);
    }
    publication.status = "revoked";
    publication.shareTokenDigest = null;
    publication.revokedAtMs = clock();
    publication.revokedByAccountId = String(input.actorAccountId || "");
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * The publication of a Board Session, whatever its status, or null.
   *
   * @param {string} boardSessionId
   * @returns {StoredPublication | null}
   */
  function getPublicationForBoardSession(boardSessionId) {
    ensureLoaded();
    return publicationsByBoardSession.get(String(boardSessionId || "")) || null;
  }

  /**
   * The live publication behind a share link token, or null. Only a
   * `published` record with a matching token digest resolves; revoked,
   * replaced, and unknown tokens are all the same null.
   *
   * @param {string} token
   * @returns {StoredPublication | null}
   */
  function getPublicationByShareToken(token) {
    ensureLoaded();
    if (typeof token !== "string" || token === "") return null;
    const boardSessionId = boardSessionIdsByShareTokenDigest.get(
      digestShareToken(token),
    );
    if (!boardSessionId) return null;
    const publication = publicationsByBoardSession.get(boardSessionId);
    return publication && publication.status === "published"
      ? publication
      : null;
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
    publish,
    revoke,
    getPublicationForBoardSession,
    getPublicationByShareToken,
    flush,
  };
}

export { createFilePublicationStore };
