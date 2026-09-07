import pg from "pg";

import { assertSafeDocumentKey } from "./documents.mjs";

const { Pool } = pg;
const INSTANCE_LOCK_KEY = "sukimacanvas:hosted-state:v1";

/**
 * @typedef {import("pg").Pool} PgPool
 * @typedef {import("pg").PoolClient} PgClient
 * @typedef {import("./documents.mjs").DocumentWrite} DocumentWrite
 */

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isLedgerEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = /** @type {any} */ (value);
  return (
    Number.isSafeInteger(entry.seq) &&
    entry.seq >= 0 &&
    Number.isSafeInteger(entry.acceptedAtMs) &&
    typeof entry.eventId === "string" &&
    typeof entry.boardSessionId === "string" &&
    typeof entry.accountId === "string" &&
    entry.mutation &&
    typeof entry.mutation === "object" &&
    !Array.isArray(entry.mutation)
  );
}

/**
 * @param {string} boardName
 * @returns {void}
 */
function assertSafeBoardName(boardName) {
  if (!/^[A-Za-z0-9_-]+$/.test(boardName)) {
    throw new Error(`Refusing ledger for unsafe board name: ${boardName}`);
  }
}

/**
 * PostgreSQL owns every mutable Hosted document plus the append-only board
 * ledger. One session-level advisory lock enforces the release's explicit
 * single-active-instance contract, preventing two in-memory snapshots from
 * overwriting each other.
 *
 * @param {{connectionString: string, ssl: false | {rejectUnauthorized: boolean}, maxConnections?: number}} options
 */
function createPostgresPersistence(options) {
  if (
    typeof options.connectionString !== "string" ||
    !options.connectionString
  ) {
    throw new Error(
      "PostgreSQL state storage requires WBO_HOSTED_DATABASE_URL",
    );
  }
  const maxConnections = options.maxConnections ?? 10;
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 2) {
    throw new Error(
      "WBO_HOSTED_DATABASE_MAX_CONNECTIONS must be an integer of at least 2",
    );
  }
  const pool = new Pool({
    connectionString: options.connectionString,
    ssl: options.ssl,
    max: maxConnections,
  });
  /** @type {Map<string, unknown>} */
  const documents = new Map();
  /** @type {PgClient | null} */
  let lockClient = null;
  let initialized = false;
  let closed = false;

  async function initialize() {
    if (initialized) return;
    const client = await pool.connect();
    try {
      const lock = await client.query(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
        [INSTANCE_LOCK_KEY],
      );
      if (lock.rows[0]?.acquired !== true) {
        throw new Error(
          "Another SukimaCanvas instance already owns the PostgreSQL hosted-state lock",
        );
      }
      await client.query(`
        CREATE TABLE IF NOT EXISTS wbo_hosted_state_documents (
          document_key text PRIMARY KEY,
          payload jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS wbo_board_mutation_ledger (
          board_name text NOT NULL,
          seq bigint NOT NULL CHECK (seq >= 0),
          accepted_at_ms bigint NOT NULL,
          event_id text NOT NULL,
          board_session_id text NOT NULL,
          account_id text NOT NULL,
          mutation jsonb NOT NULL,
          PRIMARY KEY (board_name, seq)
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS wbo_board_mutation_ledger_session_idx
        ON wbo_board_mutation_ledger (board_session_id, seq)
      `);
      // Prove the configured role can write, not merely connect and SELECT.
      // The rollback leaves no probe record behind and restores any unlikely
      // pre-existing row with the same key.
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO wbo_hosted_state_documents (document_key, payload)
         VALUES ('storage-probe.json', '{"ok":true}'::jsonb)
         ON CONFLICT (document_key) DO UPDATE SET payload = EXCLUDED.payload`,
      );
      await client.query("ROLLBACK");
      const stored = await client.query(
        "SELECT document_key, payload FROM wbo_hosted_state_documents",
      );
      for (const row of stored.rows) {
        documents.set(String(row.document_key), row.payload);
      }
      lockClient = client;
      initialized = true;
    } catch (error) {
      client.release();
      await pool.end().catch(() => {});
      closed = true;
      throw error;
    }
  }

  function requireInitialized() {
    if (!initialized) {
      throw new Error("PostgreSQL hosted state was read before initialization");
    }
  }

  const stateDocuments = {
    /**
     * @template T
     * @param {string} key
     * @param {T} fallback
     * @returns {T}
     */
    read(key, fallback) {
      requireInitialized();
      assertSafeDocumentKey(key);
      return documents.has(key)
        ? /** @type {T} */ (documents.get(key))
        : fallback;
    },

    /**
     * @param {DocumentWrite[]} writes
     * @returns {Promise<void>}
     */
    async writeMany(writes) {
      requireInitialized();
      for (const write of writes) assertSafeDocumentKey(write.key);
      if (writes.length === 0) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const write of writes) {
          await client.query(
            `INSERT INTO wbo_hosted_state_documents
               (document_key, payload, updated_at)
             VALUES ($1, $2::jsonb, clock_timestamp())
             ON CONFLICT (document_key) DO UPDATE
             SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
            [write.key, JSON.stringify(write.payload)],
          );
        }
        await client.query("COMMIT");
        for (const write of writes) documents.set(write.key, write.payload);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };

  /**
   * @param {string} boardNameInput
   */
  function createBoardMutationLedger(boardNameInput) {
    const boardName = String(boardNameInput || "");
    assertSafeBoardName(boardName);
    let tail = Promise.resolve();

    /**
     * @template T
     * @param {() => Promise<T>} operation
     * @returns {Promise<T>}
     */
    function enqueue(operation) {
      const run = tail.then(operation, operation);
      tail = run.then(
        () => {},
        () => {},
      );
      return run;
    }

    return {
      /**
       * @param {import("../ledger/store.mjs").LedgerEntry[]} entries
       * @returns {Promise<void>}
       */
      async appendEntries(entries) {
        requireInitialized();
        if (!Array.isArray(entries) || entries.length === 0) return;
        for (const entry of entries) {
          if (!isLedgerEntry(entry)) {
            throw new Error("Refusing to append an invalid ledger entry");
          }
        }
        await enqueue(async () => {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            for (const entry of entries) {
              await client.query(
                `INSERT INTO wbo_board_mutation_ledger
                   (board_name, seq, accepted_at_ms, event_id,
                    board_session_id, account_id, mutation)
                 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
                [
                  boardName,
                  entry.seq,
                  entry.acceptedAtMs,
                  entry.eventId,
                  entry.boardSessionId,
                  entry.accountId,
                  JSON.stringify(entry.mutation),
                ],
              );
            }
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
          } finally {
            client.release();
          }
        });
      },

      /**
       * @param {number} fromExclusiveSeq
       * @returns {Promise<import("../ledger/store.mjs").LedgerEntry[]>}
       */
      async readEntriesAfter(fromExclusiveSeq) {
        requireInitialized();
        const result = await pool.query(
          `SELECT seq, accepted_at_ms, event_id, board_session_id,
                  account_id, mutation
           FROM wbo_board_mutation_ledger
           WHERE board_name = $1 AND seq > $2
           ORDER BY seq ASC`,
          [boardName, Number(fromExclusiveSeq) || 0],
        );
        return result.rows.map((row) => ({
          seq: Number(row.seq),
          acceptedAtMs: Number(row.accepted_at_ms),
          eventId: String(row.event_id),
          boardSessionId: String(row.board_session_id),
          accountId: String(row.account_id),
          mutation: row.mutation,
        }));
      },
    };
  }

  /** @param {string} boardNameInput */
  async function deleteBoardMutationLedger(boardNameInput) {
    requireInitialized();
    const boardName = String(boardNameInput || "");
    assertSafeBoardName(boardName);
    await pool.query(
      "DELETE FROM wbo_board_mutation_ledger WHERE board_name = $1",
      [boardName],
    );
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (lockClient) {
      await lockClient
        .query("SELECT pg_advisory_unlock(hashtext($1))", [INSTANCE_LOCK_KEY])
        .catch(() => {});
      lockClient.release();
      lockClient = null;
    }
    initialized = false;
    await pool.end();
  }

  return {
    stateDocuments,
    initialize,
    createBoardMutationLedger,
    deleteBoardMutationLedger,
    close,
  };
}

export { createPostgresPersistence };
