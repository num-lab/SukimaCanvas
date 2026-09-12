import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { MutationType } from "../client-data/js/mutation_type.js";
import { Pencil } from "../client-data/tools/index.js";
import { loadOrGetLoadedBoard } from "../server/board/board_loader.mjs";
import {
  registerBoardMutationLedgerFactory,
  resetBoardMutationLedgerFactory,
} from "../server/board/ledger_registry.mjs";
import { deleteLoadedBoard } from "../server/board/registry.mjs";
import { getBoardSession } from "../server/board/session.mjs";
import { createBoardArchivePipeline } from "../server/hosted_event/archive/close.mjs";
import { createFileBoardArchiveStore } from "../server/hosted_event/archive/store.mjs";
import { createBoardExportPipeline } from "../server/hosted_event/export/pipeline.mjs";
import { createFileBoardExportStore } from "../server/hosted_event/export/store.mjs";
import { createFileBoardMutationLedger } from "../server/hosted_event/ledger/store.mjs";
import { createFileOrganizerStore } from "../server/hosted_event/organizers/store.mjs";
import {
  boardSvgPath,
  writeBoardState,
} from "../server/persistence/svg_board_store.mjs";

/**
 * Benchmarks for the two Hosted Event Module outcome hot paths.
 *
 * - `archive`: the durable close pipeline — seal the write boundary, settle
 *   the snapshot at the final authoritative sequence, export and hash the
 *   accepted-mutation ledger, write the three immutable archive objects, and
 *   seal the Board Session closed.
 * - `export`: the Image Export pipeline — read the sealed archive, verify the
 *   canvas against its manifest integrity hash, render the sanitized PNG
 *   projection, and store the result.
 *
 * Both scenarios drive the real composed pipelines against real file stores;
 * only the fixture is synthetic. The seeded ledger history is byte-faithful
 * rather than a replay of the fixture snapshot: the stored snapshot is written
 * level with the ledger's final sequence, so a close reads, re-serializes, and
 * hashes that history exactly as it would in production, and a board load
 * never replays it.
 *
 * @typedef {import("../types/server-runtime.d.ts").ServerConfig} ServerConfig
 * @typedef {{[id: string]: any}} BoardFixture
 * @typedef {{timeMs: number, details?: string, retain?: unknown}} BenchmarkSample
 * @typedef {{runSample: (index: number) => Promise<BenchmarkSample>, cleanup: () => Promise<void>}} PreparedBenchmark
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The capacity window buffer an approved Reservation commits, as in production. */
const CAPACITY_BUFFER_MS = 15 * MINUTE;
const OWNER_ACCOUNT_ID = "bench-owner-account";
const OPERATOR_ACCOUNT_ID = "bench-operator-account";
/** A fixed base instant: the benchmark clock is controlled, never wall time. */
const BASE_TIME_MS = Date.UTC(2026, 0, 5, 9, 0, 0);

/** @param {number} bytes */
const formatMiB = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

/**
 * @param {string} filePath
 * @returns {Promise<number>}
 */
async function fileSize(filePath) {
  return (await fsp.stat(filePath)).size;
}

/**
 * Composes the organizer store, archive store, and the close and export
 * pipelines exactly as the hosted module composition does, against one
 * controlled clock in a temporary data directory, and provisions one approved
 * Organizer to reserve against.
 *
 * @param {ServerConfig} config
 */
async function composeHostedOutcomes(config) {
  const dataDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "wbo-bench-hosted-"),
  );
  const holder = { now: BASE_TIME_MS };
  const clock = () => holder.now;
  const organizerStore = createFileOrganizerStore({ dataDir, clock });
  const archiveStore = createFileBoardArchiveStore({ dataDir });
  const archivePipeline = createBoardArchivePipeline({
    organizerStore,
    archiveStore,
    config,
    clock,
  });
  const exportStore = createFileBoardExportStore({
    dataDir,
    clock,
    linkTtlMs: config.HOSTED_BOARD_EXPORT_LINK_TTL_MS,
    hmacKey: config.AUTH_SECRET_KEY || "benchmark-export-key",
  });
  const exportPipeline = createBoardExportPipeline({
    exportStore,
    archiveStore,
    organizerStore,
    config,
    clock,
  });
  registerBoardMutationLedgerFactory((boardName) =>
    createFileBoardMutationLedger({ boardName, dataDir }),
  );

  const application = await organizerStore.submitApplication({
    accountId: OWNER_ACCOUNT_ID,
    organizerName: "Benchmark Collective",
    contactName: "Benchmark Owner",
    contactEmail: "owner@example.com",
  });
  if (application.ok === false) {
    throw new Error(`benchmark organizer application: ${application.reason}`);
  }
  const approved = await organizerStore.approveApplication({
    applicationId: application.application.applicationId,
    operatorAccountId: OPERATOR_ACCOUNT_ID,
  });
  if (approved.ok === false) {
    throw new Error(`benchmark organizer approval: ${approved.reason}`);
  }
  const organizerId = approved.organizerId;

  /**
   * Reserves, submits, and approves one Board Session whose window opens a day
   * after the current benchmark clock, so every sample runs its own event
   * through the real reservation and capacity path.
   *
   * @param {number} index
   * @param {number} seats
   * @returns {Promise<{boardSessionId: string, eventId: string, boardName: string, startsAtMs: number, endsAtMs: number}>}
   */
  async function provisionSession(index, seats) {
    const startsAtMs = BASE_TIME_MS + (index + 1) * DAY;
    const created = await organizerStore.createReservation({
      organizerId,
      createdByAccountId: OWNER_ACCOUNT_ID,
      eventName: `Benchmark Session ${index + 1}`,
      visibility: "unlisted",
      startsAtMs,
      endsAtMs: startsAtMs + HOUR,
      requestedSeats: seats,
    });
    const reservationId = created.reservation.reservationId;
    const submitted = await organizerStore.submitReservation({
      reservationId,
      actorAccountId: OWNER_ACCOUNT_ID,
      now: holder.now,
    });
    if (submitted.ok === false) {
      throw new Error(`benchmark reservation submit: ${submitted.reason}`);
    }
    const approvedReservation = await organizerStore.approveReservation({
      reservationId,
      operatorAccountId: OPERATOR_ACCOUNT_ID,
      now: holder.now,
      bufferMs: CAPACITY_BUFFER_MS,
      sessionLimit: 20,
      seatLimit: 1000,
    });
    if (approvedReservation.ok === false) {
      throw new Error(
        `benchmark reservation approval: ${approvedReservation.reason}`,
      );
    }
    const event = organizerStore.getEventById(approvedReservation.eventId);
    const boardSession = event
      ? organizerStore.getBoardSessionForEvent(event.eventId)
      : null;
    if (!event || !boardSession) {
      throw new Error("benchmark reservation produced no Board Session");
    }
    return {
      boardSessionId: boardSession.boardSessionId,
      eventId: event.eventId,
      boardName: event.boardName,
      startsAtMs,
      endsAtMs: startsAtMs + HOUR,
    };
  }

  return {
    dataDir,
    holder,
    organizerId,
    organizerStore,
    archivePipeline,
    exportStore,
    exportPipeline,
    provisionSession,
    ledgerPath: (/** @type {string} */ boardName) =>
      path.join(dataDir, "mutation-ledger", `${boardName}.jsonl`),
    cleanup: async () => {
      resetBoardMutationLedgerFactory();
      await fsp.rm(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Seeds one Board Session's durable history: the accepted-mutation ledger
 * through its real adapter, and the stored snapshot written level with the
 * ledger's final sequence. A board loaded from this pair replays nothing and
 * closes at exactly that sequence.
 *
 * @param {{
 *   hosted: Awaited<ReturnType<typeof composeHostedOutcomes>>,
 *   session: {boardSessionId: string, eventId: string, boardName: string},
 *   templateName: string,
 *   historyDir: string,
 *   entryCount: number,
 *   pencilIds: string[],
 * }} input
 * @returns {Promise<void>}
 */
async function seedBoardHistory(input) {
  await fsp.copyFile(
    boardSvgPath(input.templateName, input.historyDir),
    boardSvgPath(input.session.boardName, input.historyDir),
  );
  if (input.entryCount === 0) return;
  const ledger = createFileBoardMutationLedger({
    boardName: input.session.boardName,
    dataDir: input.hosted.dataDir,
  });
  const acceptedFrom = input.hosted.holder.now;
  try {
    await ledger.appendEntries(
      Array.from({ length: input.entryCount }, (_, index) => ({
        seq: index + 1,
        acceptedAtMs: acceptedFrom + index,
        eventId: input.session.eventId,
        boardSessionId: input.session.boardSessionId,
        accountId: OWNER_ACCOUNT_ID,
        mutation: /** @type {any} */ ({
          tool: Pencil.id,
          type: MutationType.APPEND,
          parent: input.pencilIds[index % input.pencilIds.length],
          x: (index * 13) % 8000,
          y: (index * 17) % 8000,
        }),
      })),
    );
  } finally {
    await ledger.close();
  }
}

/**
 * Closes one provisioned Board Session through the real pipeline and returns
 * how long the close took.
 *
 * @param {Awaited<ReturnType<typeof composeHostedOutcomes>>} hosted
 * @param {{boardSessionId: string, endsAtMs: number}} session
 * @returns {Promise<number>}
 */
async function measureClose(hosted, session) {
  hosted.holder.now = session.endsAtMs + MINUTE;
  await hosted.organizerStore.advanceLifecycle({ now: hosted.holder.now });
  const startedAt = performance.now();
  const closed = await hosted.archivePipeline.runDueCloses({
    now: hosted.holder.now,
  });
  const timeMs = performance.now() - startedAt;
  if (
    !closed.some((entry) => entry.boardSessionId === session.boardSessionId)
  ) {
    const failed = hosted.organizerStore.getBoardSessionById(
      session.boardSessionId,
    );
    throw new Error(
      `benchmark close did not archive the session: ${
        failed?.archiveFailure?.code || failed?.status || "unknown"
      }`,
    );
  }
  return timeMs;
}

/**
 * Prepares the `archive` scenario: one Board Session per sample, carrying a
 * full-size board and a long accepted-mutation history, closed into its
 * Private Board Archive.
 *
 * @param {{
 *   config: ServerConfig,
 *   historyDir: string,
 *   board: BoardFixture,
 *   pencilIds: string[],
 *   ledgerEntryCount: number,
 *   closingWrites: number,
 * }} options
 * @returns {Promise<PreparedBenchmark>}
 */
export async function prepareArchiveCloseBenchmark(options) {
  const hosted = await composeHostedOutcomes(options.config);
  const itemCount = Object.keys(options.board).length;
  const templateName = "bench-archive-template";
  // The snapshot is stored at the ledger's final sequence: the close pipeline
  // then validates one agreed final sequence across board, snapshot, and
  // ledger, exactly as it does for a session that saved before closing.
  await writeBoardState(
    templateName,
    options.board,
    { readonly: false },
    options.ledgerEntryCount,
    { historyDir: options.historyDir },
  );

  /** @param {number} index */
  async function runSample(index) {
    const session = await hosted.provisionSession(index, 50);
    hosted.holder.now = session.startsAtMs;
    await hosted.organizerStore.advanceLifecycle({ now: hosted.holder.now });
    // Seeded after the session opens, so the stand-in history carries
    // acceptance times inside the Board Session's own window.
    await seedBoardHistory({
      hosted,
      session,
      templateName,
      historyDir: options.historyDir,
      entryCount: options.ledgerEntryCount,
      pencilIds: options.pencilIds,
    });

    const board = await loadOrGetLoadedBoard(
      session.boardName,
      options.config,
      {},
    );
    // No background save may settle the closing writes first: the close is
    // the boundary that must persist them, so it is measured with the whole
    // snapshot still dirty.
    board.delaySave = () => {};
    const boardSession = getBoardSession(board);
    const operator = {
      eventId: session.eventId,
      boardSessionId: session.boardSessionId,
      accountId: OWNER_ACCOUNT_ID,
      participantId: `bench-participant-${index}`,
    };
    for (let write = 0; write < options.closingWrites; write += 1) {
      const parent = options.pencilIds[write % options.pencilIds.length];
      const bounds = parent ? board.itemsById.get(parent)?.bounds : null;
      const accepted = await boardSession.acceptPersistentMutation(
        /** @type {any} */ ({
          tool: Pencil.id,
          type: MutationType.APPEND,
          parent,
          x: (bounds?.maxX ?? 0) + 1,
          y: (bounds?.maxY ?? 0) + 1,
        }),
        hosted.holder.now,
        operator,
      );
      if (accepted.ok === false) {
        throw new Error(`benchmark closing write refused: ${accepted.reason}`);
      }
    }

    const timeMs = await measureClose(hosted, session);
    const canvasBytes = await fileSize(
      boardSvgPath(session.boardName, options.historyDir),
    );
    const ledgerBytes = await fileSize(hosted.ledgerPath(session.boardName));
    deleteLoadedBoard(session.boardName);
    return {
      timeMs,
      details:
        `${itemCount} items, ${options.ledgerEntryCount + options.closingWrites} ledger entries, ` +
        `${options.closingWrites} closing writes, archived ${formatMiB(canvasBytes)} canvas + ${formatMiB(ledgerBytes)} ledger`,
      retain: board,
    };
  }

  return { runSample, cleanup: hosted.cleanup };
}

/**
 * Prepares the `export` scenario: one sealed Private Board Archive, rendered
 * to a sanitized PNG once per sample through the real export pipeline.
 *
 * @param {{
 *   config: ServerConfig,
 *   historyDir: string,
 *   board: BoardFixture,
 * }} options
 * @returns {Promise<PreparedBenchmark>}
 */
export async function prepareImageExportBenchmark(options) {
  const hosted = await composeHostedOutcomes(options.config);
  const itemCount = Object.keys(options.board).length;
  const session = await hosted.provisionSession(0, 50);
  // A never-written session archives its stored snapshot at sequence zero,
  // which is all the export pipeline needs: it reads the sealed archive, never
  // a live Board Session.
  await writeBoardState(
    session.boardName,
    options.board,
    { readonly: false },
    0,
    { historyDir: options.historyDir },
  );
  hosted.holder.now = session.startsAtMs;
  await hosted.organizerStore.advanceLifecycle({ now: hosted.holder.now });
  await measureClose(hosted, session);
  deleteLoadedBoard(session.boardName);

  async function runSample() {
    const requested = await hosted.exportPipeline.requestExport({
      boardSessionId: session.boardSessionId,
      eventId: session.eventId,
      organizerId: hosted.organizerId,
      requestedByAccountId: OWNER_ACCOUNT_ID,
    });
    if (requested.ok === false) {
      throw new Error(`benchmark export request: ${requested.reason}`);
    }
    const exportId = requested.export.exportId;
    const startedAt = performance.now();
    const settled = await hosted.exportPipeline.runDueExports({
      now: hosted.holder.now,
    });
    const timeMs = performance.now() - startedAt;
    if (!settled.succeeded.includes(exportId)) {
      const failure = settled.failed.find(
        (entry) => entry.exportId === exportId,
      );
      throw new Error(
        `benchmark export did not render: ${failure?.code || "not attempted"}`,
      );
    }
    const rendered = hosted.exportStore.getExport(exportId)?.result;
    if (!rendered) throw new Error("benchmark export stored no result");
    // Settled jobs are terminal, so the next sample renders a fresh one; the
    // deletion also drops the stored PNG between samples.
    await hosted.exportStore.deleteExport(exportId);
    return {
      timeMs,
      details:
        `${itemCount}-item archive rendered to ${rendered.width}x${rendered.height} ` +
        `(${formatMiB(rendered.byteLength)} PNG)`,
    };
  }

  return { runSample, cleanup: hosted.cleanup };
}
