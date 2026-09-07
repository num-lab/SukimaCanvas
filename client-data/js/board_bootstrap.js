import { initializeCoreRuntime } from "./app_tools_core.js";
import { attachBoardDomToRuntime } from "./board_dom_bootstrap.js";
import { parseEmbeddedJson, resolveBoardName } from "./board_page_state.js";
import {
  createInitialPreferences,
  DEFAULT_COLOR_PRESETS,
} from "./board_preferences.js";

/** @import { AppToolsState, ServerConfig } from "../../types/app-runtime" */

/**
 * @returns {AppToolsState}
 */
export function createBoardRuntimeShellFromPage() {
  const colorPresets = DEFAULT_COLOR_PRESETS;
  // The shell may be served at a URL that is not a /boards/ path (the Hosted
  // Event board page); the server-rendered identity wins over URL derivation.
  const boardIdentity =
    /** @type {{board?: unknown, socketIoPath?: unknown, hostedEventPath?: unknown}} */ (
      parseEmbeddedJson("board-identity", {})
    );
  const embeddedBoardName =
    typeof boardIdentity.board === "string" ? boardIdentity.board : "";
  const tools = /** @type {AppToolsState} */ (
    /** @type {unknown} */ (
      initializeCoreRuntime(
        {},
        {
          translations: /** @type {{[key: string]: string}} */ (
            parseEmbeddedJson("translations", {})
          ),
          serverConfig: /** @type {ServerConfig} */ (
            parseEmbeddedJson("configuration", {})
          ),
          boardName:
            embeddedBoardName !== ""
              ? embeddedBoardName
              : resolveBoardName(window.location.pathname),
          socketIoPath:
            typeof boardIdentity.socketIoPath === "string"
              ? boardIdentity.socketIoPath
              : "",
          hostedEventPath:
            typeof boardIdentity.hostedEventPath === "string" &&
            boardIdentity.hostedEventPath !== ""
              ? boardIdentity.hostedEventPath
              : undefined,
          token: new URL(window.location.href).searchParams.get("token"),
          colorPresets,
          initialPreferences: createInitialPreferences(colorPresets),
        },
      )
    )
  );
  window.WBOApp = tools;
  return tools;
}

/**
 * @param {AppToolsState} tools
 * @param {Document} document
 * @returns {Promise<() => void>}
 */
export async function attachPanReadyRuntime(tools, document) {
  const baseline = await attachBoardDomToRuntime(tools, document);
  tools.initialAuthoritativeSeq = baseline.authoritativeSeq;
  tools.viewportState.install();
  tools.viewportState.controller.setTouchPolicy("native-pan");
  tools.viewportState.restoreFromHash();
  return tools.viewportState.controller.installTemporaryPan();
}
