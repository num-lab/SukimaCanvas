/**
 *                        WHITEBOPHIR
 *********************************************************
 * @licstart  The following is the entire license notice for the
 *  JavaScript code in this page.
 *
 * Copyright (C) 2020  Ophir LOJKINE
 *
 *
 * The JavaScript code in this page is free software: you can
 * redistribute it and/or modify it under the terms of the GNU
 * General Public License (GNU GPL) as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option)
 * any later version.  The code is distributed WITHOUT ANY WARRANTY;
 * without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE.  See the GNU GPL for more details.
 *
 * As additional permission under GNU GPL version 3 section 7, you
 * may distribute non-source (e.g., minimized or compacted) forms of
 * that code without the copy of the GNU GPL normally required by
 * section 4, provided you include this license notice and a URL
 * through which recipients can access the Corresponding Source.
 *
 * @licend
 */

import { MutationType } from "../../js/mutation_type.js";
import { BOARD_CAPABILITY, TOOL_CODE_BY_ID } from "../manifest.js";

/** @import { ToolBootContext } from "../../../types/app-runtime" */
/** @typedef {ReturnType<typeof createClearMessage>} ClearMessage */
/** @typedef {ReturnType<typeof boot>} ClearToolState */

export const toolId = "clear";
const toolCode = TOOL_CODE_BY_ID[toolId];
export const oneTouch = true;
export const mouseCursor = "crosshair";
export const requiredCapability = BOARD_CAPABILITY.CLEAR;
export const liveMessageFields = /** @type {const} */ ({
  [MutationType.CLEAR]: {
    // Governance reason: hosted events require one and freeze it into the
    // moderation trail; legacy boards never send it.
    reason: "text?",
  },
});

/**
 * @param {ClearToolState} state
 * @param {string | undefined} reason
 */
function createClearMessage(state, reason) {
  return {
    tool: toolCode,
    type: MutationType.CLEAR,
    id: "",
    token: state.identity.token,
    ...(reason ? { reason } : {}),
  };
}

/** @param {ClearToolState} state */
function confirmClearBoard(state) {
  return state.ui.confirm({
    message: state.i18n.t("clear_confirmation_message"),
    confirmLabel: state.i18n.t("Clear"),
    cancelLabel: state.i18n.t("Cancel"),
    variant: "danger",
  });
}

/**
 * Hosted events record who cleared and why: collect a reason after the
 * confirmation before the message goes out.
 *
 * @param {ClearToolState} state
 * @returns {Promise<string | null>} null when the moderator cancels
 */
function requestClearReason(state) {
  return state.ui
    .showActionDialog({
      title: state.i18n.t("clear_reason_title"),
      message: state.i18n.t("clear_reason_message"),
      sections: [
        {
          id: "reason",
          layout: "input",
          placeholder: state.i18n.t("clear_reason_placeholder"),
          required: true,
          submit: true,
          choices: [],
        },
      ],
      cancelLabel: state.i18n.t("Cancel"),
    })
    .then((selection) => {
      const reason = String(selection?.selections?.reason || "").trim();
      return selection === null || reason === "" ? null : reason;
    });
}

/** @param {ClearToolState} state */
export function onstart(state) {
  void confirmClearBoard(state).then((confirmed) => {
    if (!confirmed) return;
    if (!state.hostedEventPath) {
      state.writes.drawAndSend(createClearMessage(state, undefined));
      return;
    }
    void requestClearReason(state).then((reason) => {
      if (reason === null) return;
      state.writes.drawAndSend(createClearMessage(state, reason));
    });
  });
  return false;
}

/** @param {ClearToolState} state */
export function draw(state) {
  state.board.drawingArea.innerHTML = "";
}

/** @param {ToolBootContext} ctx */
export function boot(ctx) {
  return {
    board: ctx.runtime.board,
    identity: ctx.runtime.identity,
    i18n: ctx.runtime.i18n,
    ui: ctx.runtime.ui,
    writes: ctx.runtime.writes,
    hostedEventPath: ctx.runtime.hostedEventPath,
  };
}
