import { createFileBoardArchiveStore } from "../archive/store.mjs";
import { createS3BoardArchiveStore } from "../archive/s3_store.mjs";
import {
  createFileBoardMutationLedger,
  deleteBoardMutationLedgerFile,
} from "../ledger/store.mjs";
import { createFileStateDocuments } from "./documents.mjs";
import { createPostgresPersistence } from "./postgres.mjs";

/**
 * Selects durable adapters once, at the Hosted composition seam. Business
 * modules keep their existing synchronous read interfaces; PostgreSQL is
 * loaded before listen and receives every completed mutation transaction.
 *
 * @param {import("../../../types/server-runtime.d.ts").ServerConfig} config
 */
function createHostedStorage(config) {
  const stateBackend = String(
    config.HOSTED_STATE_STORE || "file",
  ).toLowerCase();
  const objectBackend = String(
    config.HOSTED_OBJECT_STORE || "file",
  ).toLowerCase();
  if (stateBackend !== "file" && stateBackend !== "postgres") {
    throw new Error(
      `Unsupported WBO_HOSTED_STATE_STORE: ${stateBackend} (expected file or postgres)`,
    );
  }
  if (objectBackend !== "file" && objectBackend !== "s3") {
    throw new Error(
      `Unsupported WBO_HOSTED_OBJECT_STORE: ${objectBackend} (expected file or s3)`,
    );
  }

  const postgres =
    stateBackend === "postgres"
      ? createPostgresPersistence({
          connectionString: config.HOSTED_DATABASE_URL,
          ssl:
            config.HOSTED_DATABASE_SSL === "disable"
              ? false
              : {
                  rejectUnauthorized:
                    config.HOSTED_DATABASE_SSL === "verify-full",
                },
          maxConnections: config.HOSTED_DATABASE_MAX_CONNECTIONS,
        })
      : null;
  const stateDocuments =
    postgres?.stateDocuments ||
    createFileStateDocuments({ dataDir: config.HOSTED_DATA_DIR });

  const archiveStore =
    objectBackend === "s3"
      ? createS3BoardArchiveStore({
          endpoint: config.HOSTED_S3_ENDPOINT,
          bucket: config.HOSTED_S3_BUCKET,
          region: config.HOSTED_S3_REGION,
          prefix: config.HOSTED_S3_PREFIX,
          accessKeyId: config.HOSTED_S3_ACCESS_KEY_ID,
          secretAccessKey: config.HOSTED_S3_SECRET_ACCESS_KEY,
        })
      : createFileBoardArchiveStore({ dataDir: config.HOSTED_DATA_DIR });

  async function initialize() {
    await postgres?.initialize();
    try {
      await archiveStore.initialize();
    } catch (error) {
      await postgres?.close();
      throw error;
    }
  }

  /** @param {string} boardName */
  function createBoardMutationLedger(boardName) {
    return postgres
      ? postgres.createBoardMutationLedger(boardName)
      : createFileBoardMutationLedger({
          boardName,
          dataDir: config.HOSTED_DATA_DIR,
        });
  }

  /** @param {string} boardName */
  async function deleteBoardMutationLedger(boardName) {
    if (postgres) {
      await postgres.deleteBoardMutationLedger(boardName);
      return;
    }
    await deleteBoardMutationLedgerFile({
      boardName,
      dataDir: config.HOSTED_DATA_DIR,
    });
  }

  async function close() {
    await postgres?.close();
  }

  return {
    archiveStore,
    stateDocuments,
    initialize,
    createBoardMutationLedger,
    deleteBoardMutationLedger,
    close,
  };
}

export { createHostedStorage };
