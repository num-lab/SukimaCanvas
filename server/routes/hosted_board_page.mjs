import { BoundaryError } from "../http/boundary_errors.mjs";
import { serveError } from "../http/observation.mjs";
import { publicPath } from "../http/request_url.mjs";
import { serveBoardSvg } from "./board_assets.mjs";
import { serveBoardPage } from "./board_page.mjs";

/** @import { HttpRouteContext } from "../../types/server-runtime.d.ts" */

/**
 * The Hosted Event board entry: `/b/{boardName}`. This is the only page in
 * hosted mode that renders the real WBO board, and it renders through the
 * exact same board renderer as legacy WBO — the difference is entirely in
 * who is admitted, which the Hosted Event Module decides server-side from
 * the hosted session cookie, the Event Membership, the Board Session
 * lifecycle, the Event Lock, and Participant Seat capacity. The page lives
 * one path segment below the app root so the board shell's root-relative
 * asset URLs resolve identically to legacy board pages.
 *
 * On success the route pins the admitted role onto the context and delegates
 * to the legacy board renderer with the event's board name, so capabilities,
 * ETags, baseline streaming, and the user-secret cookie all behave as
 * everywhere else. On refusal it redirects back to the event page with a
 * coarse notice (capacity, lifecycle, membership) — never a rendered error
 * page that would leak state, and never a compatibility fallback.
 *
 * @param {HttpRouteContext} ctx
 * @returns {Promise<void>}
 */
async function serveEventBoardPage(ctx) {
  const verdict = await admitEventBoardRequest(ctx);
  if (!verdict) return;
  await serveBoardPage(ctx);
}

/**
 * The hosted board's SVG baseline: the client's reconnect baseline refresh
 * fetches the page path with an `.svg` suffix, so hosted boards must serve
 * it under the same admission gate — a 404 here would strand every kicked
 * or resynchronizing client on a reconnect loop. Refusals answer with a
 * machine-readable 403 instead of the page redirect so the client can route
 * itself back to the event page.
 *
 * @param {HttpRouteContext} ctx
 * @returns {Promise<void>}
 */
async function serveEventBoardSvg(ctx) {
  const verdict = await admitEventBoardRequest(ctx, { svgBaseline: true });
  if (!verdict) return;
  await serveBoardSvg(ctx);
}

/**
 * Shared admission gate for the hosted board page and its SVG baseline:
 * lifecycle advance, admission verdict, role pinning, and the legacy-internal
 * URL rewrite. Returns null when the response was already sent.
 *
 * @param {HttpRouteContext} ctx
 * @param {{svgBaseline?: boolean}} [options]
 * @returns {Promise<boolean>}
 */
async function admitEventBoardRequest(ctx, options = {}) {
  const hosted = ctx.runtime.hostedEventModule;
  if (!hosted.enabled) {
    serveError(
      ctx.request,
      ctx.response,
      ctx.runtime.errorPage,
      ctx.observed,
    )();
    return false;
  }
  if (ctx.request.method !== "GET") {
    throw new BoundaryError(405, "method_not_allowed");
  }
  // Advance the durable lifecycle so admission sees the authoritative Board
  // Session status at the current service clock.
  if (typeof hosted.refreshEventLifecycle === "function") {
    await hosted.refreshEventLifecycle();
  }
  const verdict = hosted.admitEventBoardPage({
    boardName: ctx.params.boardName || "",
    cookieHeader: ctx.request.headers.cookie,
  });
  if (verdict.ok === false) {
    switch (verdict.reason) {
      case "account_required":
        // Same treatment as the organizer console: signed-out visitors go to
        // login rather than learning anything about the event.
        ctx.response.writeHead(303, {
          Location: publicPath(ctx.runtime.config, "/login"),
        });
        ctx.response.end();
        return false;
      case "event_not_found":
        throw new BoundaryError(404, "event_not_found");
      default:
        if (options.svgBaseline === true) {
          // A fetch() cannot observe the page redirect; the client routes
          // itself back to the event page from this reason instead.
          ctx.response.writeHead(403, {
            "X-WBO-Admission-Reason": verdict.reason,
          });
          ctx.response.end();
          return false;
        }
        // Capacity, membership, ban, and lifecycle refusals route back to the
        // event page with one coarse notice each.
        redirectToEventNotice(ctx, verdict);
        return false;
    }
  }
  ctx.hostedBoardRole = verdict.role;
  ctx.hostedEventPath = publicPath(
    ctx.runtime.config,
    `/events/${verdict.publicId}`,
  );
  ctx.params = { board: verdict.boardName };
  // The board renderer derives the board identity from the request URL.
  // Present the event's board under its legacy-internal shape so the shell,
  // ETags, and socket bootstrap bind to the right board while the
  // browser-visible URL stays the hosted board path.
  const boardPath = `/boards/${verdict.boardName}`;
  const boardUrl = new URL(ctx.url.href);
  boardUrl.pathname = boardPath;
  ctx.url = boardUrl;
  ctx.request.url = `${boardPath}${boardUrl.search}`;
  return true;
}

/**
 * @param {HttpRouteContext} ctx
 * @param {{reason: string, publicId?: string}} verdict
 * @returns {void}
 */
function redirectToEventNotice(ctx, verdict) {
  // Coarse refusal reasons map onto event-page notices. Without a resolved
  // event (an unknown board name is a plain 404 before this point) there is
  // nothing to route back to.
  if (!verdict.publicId) throw new BoundaryError(404, "event_not_found");
  const noticeKeys = {
    event_full: "full",
    membership_required: "membership",
    event_banned: "banned",
    event_not_open: "not_open",
  };
  const notice = Object.prototype.hasOwnProperty.call(
    noticeKeys,
    verdict.reason,
  )
    ? noticeKeys[/** @type {keyof typeof noticeKeys} */ (verdict.reason)]
    : "not_open";
  ctx.response.writeHead(303, {
    Location: `${publicPath(
      ctx.runtime.config,
      `/events/${verdict.publicId}`,
    )}?notice=${notice}`,
  });
  ctx.response.end();
}

export { serveEventBoardPage, serveEventBoardSvg };
