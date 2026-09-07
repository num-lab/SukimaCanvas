/**
 * Composition seam for per-board durable mutation ledgers.
 *
 * The board layer only knows the ledger contract (appendEntries,
 * readEntriesAfter, trimBefore). The Hosted Event Module registers a factory
 * at composition time, so hosted boards get a ledger while legacy boards keep
 * today's in-memory-only behavior. Keeping the seam here avoids making the
 * board data layer depend on hosted modules.
 */

/**
 * @typedef {{
 *   appendEntries: (entries: import("../hosted_event/ledger/store.mjs").LedgerEntry[]) => Promise<void>,
 *   readEntriesAfter: (fromExclusiveSeq: number) => Promise<import("../hosted_event/ledger/store.mjs").LedgerEntry[]>,
 * }} BoardMutationLedger
 */
/** @typedef {(boardName: string) => BoardMutationLedger | null | undefined} BoardMutationLedgerFactory */

/** @type {BoardMutationLedgerFactory | null} */
let ledgerFactory = null;

/**
 * @param {BoardMutationLedgerFactory | null} factory
 * @returns {void}
 */
function registerBoardMutationLedgerFactory(factory) {
  ledgerFactory = factory;
}

/**
 * @param {string} boardName
 * @returns {BoardMutationLedger | null}
 */
function boardMutationLedgerFor(boardName) {
  if (!ledgerFactory) return null;
  try {
    return ledgerFactory(boardName) || null;
  } catch {
    // A factory failure must not prevent the board from loading in
    // non-ledger mode; the first acceptance without a ledger will surface
    // the deployment problem in server logs.
    return null;
  }
}

/** Test seam: restores the no-ledger default. */
function resetBoardMutationLedgerFactory() {
  ledgerFactory = null;
}

export {
  boardMutationLedgerFor,
  registerBoardMutationLedgerFactory,
  resetBoardMutationLedgerFactory,
};
