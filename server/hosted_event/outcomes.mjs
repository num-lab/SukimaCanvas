import observability from "../observability/index.mjs";
import { deleteBoardMutationLedgerFile } from "./ledger/store.mjs";

const { logger, metrics } = observability;

/**
 * The durable outcome-retention pipeline.
 *
 * A closed Board Session's outcomes — its Private Board Archive, the Item
 * Attribution inside the archived canvas, its Change Audit (the durable
 * mutation ledger), and the event's Published Canvas and Board Image Export
 * objects — are retained for a bounded window (90 days from the archive seal
 * by default) and purged together when the window elapses. An Owner/Admin's
 * early deletion request enters a recoverable window first and purges through
 * the exact same routine when it elapses, so both triggers share one
 * idempotent, event-isolated cleanup.
 *
 * The pipeline is deliberately ordered for crash safety: outcome objects are
 * deleted first and the durable purge markers land last, so an interrupted
 * purge leaves the due triggers intact and the next pass replays the deletions
 * as no-ops. A failed attempt records a durable failure context on the event
 * (visible on the organizer event console and the operator console) and is
 * retried after its backoff; a Platform Operator can retry immediately. As
 * every durable background pipeline here, this one never propagates failures
 * into the surrounding request.
 *
 * @typedef {{
 *   organizerStore: ReturnType<typeof import("./organizers/store.mjs").createFileOrganizerStore>,
 *   archiveStore: ReturnType<typeof import("./archive/store.mjs").createFileBoardArchiveStore>,
 *   publicationStore: ReturnType<typeof import("./publication/store.mjs").createFilePublicationStore>,
 *   exportStore: ReturnType<typeof import("./export/store.mjs").createFileBoardExportStore>,
 *   config: import("../../types/server-runtime.d.ts").ServerConfig,
 *   clock?: () => number,
 * }} OutcomeRetentionPipelineDependencies
 */

/**
 * Deterministic failure codes for purge attempts that could not complete.
 * They land on the event's durable failure record, in the Change Audit trail,
 * and on metrics.
 */
const OUTCOME_PURGE_FAILURE_CODES = {
  STORAGE_WRITE_FAILED: "storage_write_failed",
  INTERNAL: "internal",
};

const PUBLISHED_CANVASES_PREFIX = "published-canvases";
const BOARD_ARCHIVES_PREFIX = "board-archives";

/**
 * Maps one thrown purge error to its durable failure record. The mapping
 * never throws — an unknown failure still records as `internal` rather than
 * vanishing.
 *
 * @param {unknown} error
 * @returns {{code: string, message: string}}
 */
function classifyOutcomePurgeFailure(error) {
  const errorCode = /** @type {NodeJS.ErrnoException} */ (error || {}).code;
  return {
    code: errorCode
      ? OUTCOME_PURGE_FAILURE_CODES.STORAGE_WRITE_FAILED
      : OUTCOME_PURGE_FAILURE_CODES.INTERNAL,
    message: error instanceof Error ? error.message : String(error || ""),
  };
}

/**
 * Failure code -> existing archive-failure console label. Both failure codes
 * reuse the archive-failure strings, so the organizer event console and the
 * operator console render one shared vocabulary.
 */
const OUTCOME_PURGE_FAILURE_LABEL_KEYS = {
  storage_write_failed: "hosted_archive_failure_storage_write_failed",
  internal: "hosted_archive_failure_internal",
};

/**
 * Resolves one purge-failure context to its console label: the mapped
 * translation when the code has one, the raw code otherwise, undefined when
 * there is no failure. `translate` is the shared http_forms helper so this
 * module carries no template dependency.
 *
 * @param {{code: string} | null | undefined} failure
 * @param {(template: any, ctx: any, key: string, substitutions?: Record<string, string>) => string} translate
 * @param {any} template
 * @param {any} ctx
 * @returns {string | undefined}
 */
function resolveOutcomePurgeFailureLabel(failure, translate, template, ctx) {
  if (!failure) return undefined;
  const labelKey =
    OUTCOME_PURGE_FAILURE_LABEL_KEYS[
      /** @type {keyof typeof OUTCOME_PURGE_FAILURE_LABEL_KEYS} */ (
        failure.code
      )
    ];
  return labelKey ? translate(template, ctx, labelKey) : failure.code;
}

/**
 * @param {OutcomeRetentionPipelineDependencies} dependencies
 * @returns {{
 *   purgeEventOutcomes: (input: {eventId: string}) => Promise<{purgedSessions: number, deletedObjects: number, deletedExports: number}>,
 *   runDueOutcomePurges: (input?: {now?: number, retentionMs?: number, retryMs?: number}) => Promise<string[]>,
 * }}
 */
function createOutcomeRetentionPipeline(dependencies) {
  const { organizerStore, archiveStore, publicationStore, exportStore } =
    dependencies;
  const clock = dependencies.clock || (() => Date.now());
  const retentionMs = Math.max(
    0,
    Number(dependencies.config.HOSTED_OUTCOME_RETENTION_MS) || 0,
  );
  const retryMs = Math.max(
    0,
    Number(dependencies.config.HOSTED_OUTCOME_PURGE_RETRY_MS) || 0,
  );
  /** @type {Set<string>} */
  const purgesInFlight = new Set();

  /**
   * Deletes every archive-store object under one session's key namespace and
   * returns how many objects went away. Both purge scopes (Private Board
   * Archives and derived Published Canvases) share this shape.
   *
   * @param {string} prefix
   * @returns {Promise<number>}
   */
  async function deleteObjectsUnder(prefix) {
    const keys = await archiveStore.listObjectKeys(prefix);
    for (const key of keys) {
      await archiveStore.deleteObject(key);
    }
    return keys.length;
  }

  /**
   * Purges the due outcomes of one event. An elapsed early-deletion request
   * covers every session of the event (the owner asked for the event's
   * outcomes); a retention-driven purge covers only the sessions whose own
   * 90-day window elapsed, so a newer Board Session's outcomes are never
   * destroyed before their time. Object deletion happens first (idempotent
   * per object), the durable markers land last; a crash anywhere in between
   * leaves the due triggers intact and replays as a no-op. The Change Audit
   * ledger file is deleted only once no session of the event is live or
   * unpurged — a newer session keeps writing to it.
   *
   * @param {{eventId: string, now?: number}} input
   * @returns {Promise<{purgedSessions: number, deletedObjects: number, deletedExports: number}>}
   */
  async function purgeEventOutcomes(input) {
    const eventId = String(input.eventId || "");
    const event = organizerStore.getEventById(eventId);
    if (!event)
      return { purgedSessions: 0, deletedObjects: 0, deletedExports: 0 };
    const now = typeof input.now === "number" ? input.now : clock();
    const deletionDue =
      event.outcomeDeletion !== null &&
      event.outcomeDeletion.purgedAtMs === null &&
      now >= event.outcomeDeletion.purgeAtMs;
    const dueSessions = organizerStore
      .listBoardSessionsForEvent(eventId)
      .filter(
        (session) =>
          session.status === "closed" &&
          session.archiveKey !== null &&
          session.outcomesPurgedAtMs === null &&
          (deletionDue ||
            (retentionMs > 0 &&
              session.archivedAtMs !== null &&
              now >= session.archivedAtMs + retentionMs)),
      );
    let deletedObjects = 0;

    // Private Board Archives: the canvas (Item Attribution), the
    // accepted-mutation ledger entries (Change Audit), and the manifest
    // binding them.
    for (const session of dueSessions) {
      deletedObjects += await deleteObjectsUnder(
        `${BOARD_ARCHIVES_PREFIX}/${session.boardSessionId}`,
      );
    }

    // Published Canvases: every stored generation of the derived artifact.
    for (const session of dueSessions) {
      deletedObjects += await deleteObjectsUnder(
        `${PUBLISHED_CANVASES_PREFIX}/${session.boardSessionId}`,
      );
      await publicationStore.purgeForBoardSession(session.boardSessionId);
    }

    // Associated Image Exports: job records and rendered PNG bytes. An
    // event-wide deletion clears the event's whole export history; a
    // session-scoped retention purge only that session's jobs.
    let deletedExports = 0;
    if (deletionDue) {
      deletedExports = await exportStore.deleteExportsForEvent(eventId);
    } else {
      for (const session of dueSessions) {
        deletedExports += await exportStore.deleteExportsForSession(
          session.boardSessionId,
        );
      }
    }

    const markers = await organizerStore.markEventOutcomesPurged({
      eventId,
      sessionIds: deletionDue ? undefined : dueSessions.map((s) => s.boardSessionId),
    });

    // The Change Audit boundary of the board: the durable mutation ledger
    // file. Its item attribution died with the archived canvases above; the
    // file itself only goes away when no session of the event is live and
    // every closed session's outcomes are gone.
    const remainingSessions = organizerStore.listBoardSessionsForEvent(eventId);
    const hasLiveSession = remainingSessions.some(
      (session) =>
        session.status === "scheduled" ||
        session.status === "open" ||
        session.status === "closing" ||
        session.status === "archive_failed",
    );
    const hasUnpurgedSession = remainingSessions.some(
      (session) =>
        session.status === "closed" && session.outcomesPurgedAtMs === null,
    );
    if (!hasLiveSession && !hasUnpurgedSession) {
      await deleteBoardMutationLedgerFile({
        boardName: event.boardName,
        dataDir: dependencies.config.HOSTED_DATA_DIR,
      });
    }
    return {
      purgedSessions: markers.purgedSessions,
      deletedObjects,
      deletedExports,
    };
  }

  /**
   * One retention pass: purges every event the store reports due and records
   * each failure durably against the event. Failures never propagate to the
   * caller (which may be an admission or console path); the in-flight guard
   * keeps overlapping passes from racing on one event.
   *
   * @param {{now?: number, retentionMs?: number, retryMs?: number}} [input]
   * @returns {Promise<string[]>} the event ids purged in this pass
   */
  async function runDueOutcomePurges(input = {}) {
    const now = typeof input.now === "number" ? input.now : clock();
    const due = organizerStore.listEventsDueForOutcomePurge({
      now,
      retentionMs:
        typeof input.retentionMs === "number" ? input.retentionMs : retentionMs,
      retryMs: typeof input.retryMs === "number" ? input.retryMs : retryMs,
    });
    /** @type {string[]} */
    const purged = [];
    for (const item of due) {
      if (purgesInFlight.has(item.eventId)) continue;
      purgesInFlight.add(item.eventId);
      try {
        const result = await purgeEventOutcomes({ eventId: item.eventId });
        metrics.recordOutcomePurge("purged");
        logger.info("hosted.event_outcomes_purged", {
          event: item.eventId,
          board: item.boardName,
          purged_sessions: result.purgedSessions,
          deleted_objects: result.deletedObjects,
          deleted_exports: result.deletedExports,
        });
        purged.push(item.eventId);
      } catch (error) {
        const failure = classifyOutcomePurgeFailure(error);
        metrics.recordOutcomePurge("failed", failure.code);
        logger.error("hosted.event_outcome_purge_attempt_failed", {
          event: item.eventId,
          board: item.boardName,
          failure_code: failure.code,
          error,
        });
        await organizerStore
          .recordEventOutcomePurgeFailed({
            eventId: item.eventId,
            code: failure.code,
            message: failure.message,
          })
          .catch((auditError) => {
            logger.error("hosted.event_outcome_purge_audit_failed", {
              event: item.eventId,
              error: auditError,
            });
          });
      } finally {
        purgesInFlight.delete(item.eventId);
      }
    }
    return purged;
  }

  return { purgeEventOutcomes, runDueOutcomePurges };
}

export {
  createOutcomeRetentionPipeline,
  OUTCOME_PURGE_FAILURE_CODES,
  resolveOutcomePurgeFailureLabel,
};
