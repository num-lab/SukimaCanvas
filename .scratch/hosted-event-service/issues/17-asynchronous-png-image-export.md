# 17 — 异步 PNG Image Export

**What to build:** 让 Organizer 从已成功归档的 Board Session 请求普通 PNG Image Export，并在后台生成不含作者和内部元数据的可下载图片。

**Blocked by:** 15 — 归档失败恢复与幂等重试

**Status:** done

- [x] Owner/Admin 可以提交导出请求并看到排队、处理、成功或失败状态；Participant 和公开访问者不能创建导出任务。
- [x] Export Job 使用成功的 Private Archive 作为输入，不读取仍可编辑的实时 Board Session，也不暴露原始 SVG 下载。
- [x] 输出为白色背景、内容边界加留白的普通 PNG，最长边不超过 8192 像素；过大或无法渲染的任务确定性失败。
- [x] PNG 不包含 Item Attribution、Participant Identifier、Change Audit、对象键、邮箱或其他内部 metadata。
- [x] 成功结果保存在对象存储，下载链接需要授权且只在 24 小时内有效；撤销或删除成果后链接立即失效。
- [x] 后台任务在重启后恢复，重复执行不会产生互相矛盾的结果或无限重复任务。
- [x] Node 集成测试检查任务生命周期、像素输出边界、metadata 清理和授权；Playwright 覆盖 Organizer 请求和下载流程。

## Comments

- Implemented on `ticket17`. Verified with `npm run typecheck`, `npm run
  lint`, the full Node suite (615 tests) and a targeted Playwright run of
  the new spec.
- New module [server/hosted_event/export/](../../../server/hosted_event/export/):
  - `render.mjs` — the sanitized projection. The archived canvas is decoded
    with the sanctioned summary path (`parseStoredSvgEnvelope` +
    `canonicalItemFromStoredSvgEntry`, so Pencil points are never hydrated)
    to compute tight content bounds (including half-stroke spill), the
    drawing area is re-wrapped in a fresh minimal SVG root with a white
    background rect and every `data-wbo-*` attribute stripped, and
    `@resvg/resvg-js` (new dependency; only image-capable option given the
    repo has no native image stack) rasterizes it. Small content exports 1:1;
    larger content scales down so the longest edge is capped at 8192 px
    (32 px white margin, content never upscaled). The output PNG is
    structurally validated (reusing `decodePng` from the brand-asset
    validator) and every chunk type is checked against a strict allowlist —
    text/metadata chunks fail the job, so attribution, Participant
    Identifiers, audit data, object keys, or emails can never reach the
    output. Failures carry deterministic codes: `archive_invalid`,
    `render_failed`, `output_limit_exceeded`, `output_metadata_rejected`.
  - `store.mjs` — durable job index (`<WBO_HOSTED_DATA_DIR>/board-exports/index.json`)
    plus opaque `<exportId>.png` bytes outside the web root (brand-asset
    store pattern). Statuses `queued|processing|succeeded|failed` with
    attempt counts; creating while a job is pending returns the pending job
    (idempotent UI). The download token is derived as
    `HMAC(AUTH_SECRET_KEY, exportId + finishedAtMs)` — nothing secret is
    stored at rest, the console can always re-derive the current link, and
    revocation is a stored flag that kills links immediately. Jobs past
    three failed attempts are terminal; recovery is a fresh request, never
    an endlessly repeating task.
  - `pipeline.mjs` — `requestExport` refuses anything but a session sealed
    `closed` with an `archiveKey` (the export input is the Private Archive,
    never a live Board Session), and `runDueExports` verifies the canvas
    bytes against the manifest's integrity hash before rendering, settles
    jobs durably, and never re-runs settled work. Runs ride the existing
    lifecycle poker via `refreshEventLifecycle`, so restarts recover
    automatically: `processing` jobs orphaned by a crash are re-queued and
    re-attempted on the next pass. Failures are classified (+
    `archive_unavailable`, `storage_write_failed`) onto the job record and
    the new `wbo.hosted.board_export` metric; they never fail the
    surrounding request.
- HTTP surface (Owner/Admin via the existing `requireManagedEvent` gate —
  existence-hiding 404s for non-members, login redirect for anonymous):
  POST `/organizers/{organizerId}/events/{eventId}/exports` (request),
  GET `.../exports/{exportId}/download?token=…` (authorized + token + 24 h
  validity, `no-store`, `attachment`), POST `.../revoke` and `.../delete`.
  The organizer event console gains an "Image export" section listing jobs
  with localized status/failure labels, the download link with its expiry,
  and revoke/delete actions; the page always advances the lifecycle first,
  so a refresh shows the current truth. The download path serves PNG bytes
  only — the archive, its ledger, and its manifest are never exposed.
- All new strings are translated in all 21 languages. Console template fix
  found while testing: Handlebars (non-compat) does not resolve parent
  context inside blocks, so the in-loop `{{hostedTranslations.*}}` and form
  actions need `../` paths — the pre-existing event-moderator revoke form in
  the same template had this latent bug (empty organizer/event ids and CSRF
  token) and was fixed the same way.
- Tests: `test-node/hosted_board_export.test.js` — render unit tests (pixel
  decode: white background, content bounds + margin, stroke placement,
  negative coordinates, 8192 px cap, blank empty-board export), metadata
  cleaning (canvas with/without `data-wbo-created-by` render byte-identical;
  chunk allowlist; participant identifier absent from output bytes),
  deterministic failures, store durability/token/expiry/revoke/delete,
  orphaned-`processing` recovery, the pipeline's exactly-once settlement
  over a real sealed archive (socket scenario), the retry budget ending in a
  terminal `failed` state, and an end-to-end HTTP flow (seeded closed session
  + archive) proving the authorization matrix: owner request → queued →
  succeeded → authorized download; anonymous redirect, tampered token 404,
  non-member 404, revoke/delete killing links immediately.
  `playwright/tests/hosted-board-export.spec.ts` covers the Organizer flow:
  request refused before the archive exists, then request → Ready →
  authorized download (headers, PNG signature, click-through download) →
  signed-out redirect → revoke kills the link.
- Code review decisions: (1) the "oversized fails deterministically" clause
  is enforced through the output-limit guards (padding ≥ cap, non-finite
  scale, rendered dimension mismatch); ordinary oversized content scales
  down to the 8192 px cap instead of failing, because failing every large
  whiteboard would make the feature unusable — the cap is the invariant the
  spec fixes. (2) Export passes are now kicked detached from
  `refreshEventLifecycle`, so no request path ever blocks on a multi-second
  rasterization; the durable job records plus the pipeline's in-flight guard
  make every pass equivalent, and restarts recover exactly as before. (3)
  `createExport` now also treats a failed job inside its retry budget as
  holding the session's export slot, so a second request joins it instead of
  duplicating work. (4) The store's three link-state readers were folded
  into one shared `downloadLinkState` predicate and the envelope is parsed
  once per render. Tests were adjusted for the detached pass (the HTTP flow
  polls for success) and extended for the slot-holding rule.
