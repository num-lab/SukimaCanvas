import { BoardData } from "./data.mjs";
import { getLoadedBoard, setLoadedBoard } from "./registry.mjs";

/** @import { BoardData as BoardDataInstance } from "./data.mjs" */
/** @typedef {{actualFileSeq?: number, durationMs?: number, saveTargetSeq?: number}} StaleSaveDetails */
/** @typedef {(board: BoardDataInstance, details: StaleSaveDetails) => void | Promise<void>} CompositionStaleSaveHandler */

/**
 * Loads a board once per process and shares the instance with every later
 * caller, so the socket layer and the Board Session close pipeline always
 * observe the same in-memory board. The composition that creates the
 * instance installs its own stale-save policy through `onStaleSave` (the
 * socket layer drops the instance and disconnects its sockets; the close
 * pipeline only drops the instance) — the cache itself stays here, exactly
 * once.
 *
 * @param {string} name
 * @param {import("./data.mjs").BoardConfig} config
 * @param {{onStaleSave?: CompositionStaleSaveHandler}} [options]
 * @returns {Promise<BoardDataInstance>}
 */
function loadOrGetLoadedBoard(name, config, options) {
  const cached = getLoadedBoard(name);
  if (cached) return cached;
  const onStaleSave = options?.onStaleSave;
  const loaded = BoardData.load(name, config).then((board) => {
    if (onStaleSave) {
      board.onStaleSave = (details) => onStaleSave(board, details);
    }
    return board;
  });
  setLoadedBoard(name, loaded);
  return loaded;
}

export { loadOrGetLoadedBoard };
