# 22 — 受控 Legacy SVG 历史归档导入

**What to build:** 让 Platform Operator 显式选择并导入旧 WBO SVG 作为私有 Historical Archive，以便保留历史成果，同时不伪造作者、审计或可编辑 Board Session。

**Blocked by:** 15 — 归档失败恢复与幂等重试

**Status:** done

- [x] 只有 Platform Operator 可以发起单个历史 SVG 导入，并在导入前明确选择来源和目标 Organizer/归档上下文。
- [x] 导入数据标记为 Historical Archive、作者未知、没有可信 Item Attribution 和 Change Audit，不生成虚假的 Participant 或操作者记录。
- [x] 结构合法的旧 SVG 转为私有、不可编辑 Archive；Participant、公众和 Organizer 未授权成员不能通过旧 WBO 入口访问。
- [x] 损坏、超限、包含不支持结构或无法安全解析的 SVG 被确定性拒绝或隔离，不静默修复或覆盖既有归档。
- [x] 系统不自动扫描历史目录、不批量迁移、不自动创建 Event/Reservation，也不允许把 Historical Archive 重开为 Board Session。
- [x] 导入操作、来源、结果和失败原因可由 Platform Operator 审计，重复导入不会产生不可区分的冲突成果。
- [x] Node 集成测试覆盖合法、恶意、重复和失败恢复导入；控制台测试验证私有性、未知作者标记和权限边界。

## Comments

- Implemented on `ticket22`. Verified with `npm run typecheck`, `npm run
  lint`, and the full Node suite (683 tests). Playwright suite and
  benchmarks not run: the feature adds no board-page, socket, or
  persistence hot-path work — the import is an operator-only cold path.
- Strict import parser
  ([history/legacy_svg_import.mjs](../../../server/hosted_event/history/legacy_svg_import.mjs)):
  accepts exactly the stored-SVG item vocabulary (`rect`, `line`,
  `ellipse`, `path`, `text`) inside `<g id="drawingArea">` and re-serializes
  every item canonically through the tools' own stored-item contracts, so
  the stored canvas is rendered from validated fields only. Unknown
  elements, nested groups, duplicate ids, unparseable items, gap content
  between items, non-empty shape content, oversized (>32 MiB constant),
  empty, and non-UTF-8 uploads all fail with deterministic coded errors
  (`WBO_HISTORY_IMPORT_*`); nothing is silently skipped or "repaired".
  Hostile attributes (event handlers, foreign namespaces, junk in the
  prefix/tail) cannot survive because output is canonical; a forged
  `data-wbo-created-by` is stripped and counted
  (`strippedAttributionCount`) — authorship is always `unknown`.
- Import operation + durable records
  ([history/store.mjs](../../../server/hosted_event/history/store.mjs)):
  `importLegacySvg` refuses unknown organizers, refuses duplicates
  deterministically, parses, puts `historical-archives/<importId>/canvas.svg`
  then `manifest.json` (manifest last = commit marker) through the shared
  write-once archive store, and only then appends the record to
  `historical_archives.json`. The import id derives from
  `sha256(organizerId:sourceSha256)` and the manifest is content-deterministic
  (no clock, no operator), so a crashed import (objects partially written,
  record missing) is completed — never duplicated — by re-importing the same
  file, and a completed import refuses the same source for the same
  organizer outright. Failed attempts (rejected or storage failure) leave no
  archive objects and record `{code, message}` in the audit trail. The
  manifest declares `format: sukimacanvas-historical-archive-v1`,
  `authorship: "unknown"`, `changeAudit: "none"`, and no ledger object ever
  exists.
- Operator console ([history/routes.mjs](../../../server/hosted_event/history/routes.mjs)
  + `operator-historical-imports.html`, linked from the operator console):
  `GET/POST /operator/historical-imports` is operator-only (login redirect /
  403 gates, CSRF-protected multipart upload). The form asks for the target
  Organizer (from a new operator-only `organizerStore.listOrganizers()`
  accessor) and the source file; every outcome re-renders the page with a
  deterministic notice (imported with item count / 409 duplicate / 422
  rejected with localized reason / 500 storage failure / 400 missing file or
  unknown organizer) plus the import audit trail (newest 20 attempts with
  status, organizer, source label, item count, time, failure label and
  detail). New strings added in en, zh-CN, and ja.
- Privacy by construction: archives live under the
  `historical-archives/` key namespace that no retention, publication,
  export, or board route ever enumerates; hosted mode 404s every legacy WBO
  entry (`/boards/*`, `/random`, raw SVG, `/b/*`); the only surface that
  names an import is the operator console. Historical Archives are not Board
  Sessions, so nothing can reopen, publish, export, or expire them.
- No implicit behavior: tests seed legacy SVG files into the data and
  history directories and run lifecycle passes to prove no scan, batch
  migration, Event/Reservation creation, or Board Session creation happens.
- Tests: `test-node/hosted_historical_import.test.js` (18 tests) covers the
  parser (valid round-trip per tool, BOM, empty canvas, escaped text,
  attribution stripping, hostile markup, oversized/empty/encoding, eight
  structural rejections), the store (artifact shape, duplicate refusal,
  cross-organizer re-use, rejection audit, crash-recovery via a fresh store
  composition, unknown organizer), and the HTTP surface (permission gates,
  CSRF, successful import with forged attribution stripped, duplicate 409,
  rejected/malformed/misdirected submissions, no-auto-import).
- Pre-existing gate fix: `biome.json` now sets `files.maxSize` (1.2 MiB) —
  `server/http/translations.json` had already crossed Biome's default 1 MiB
  cap at the previous merge, making `npm run lint` (and therefore `npm
  test`) fail before this ticket. Three files from the previous ticket were
  also biome-formatted (`outcomes.mjs`, `export/pipeline.mjs`,
  `hosted_outcome_retention.test.js`).
- Code review fixes: (1) a present-but-unparsable root `width`/`height` is
  now a deterministic structure rejection instead of a silent fallback to
  the default canvas size; (2) the organizer selector gained a disabled
  placeholder option so `required` forces an explicit choice instead of
  pre-selecting the first organizer; (3) the duplicate-notice timestamp now
  uses the same localized rendering as the audit list; (4) the record
  timestamp was renamed `importedAtMs` → `attemptedAtMs` since failed
  attempts carry it too; (5) the import id uses the full SHA-256 digest
  instead of a 16-hex truncation. Review-judgement items left as-is: the
  `requireOperator` copy mirrors the per-module convention of the sibling
  route files; the console's newest-20 window is a display cap over the
  durable full trail in `historical_archives.json`; the cross-file wiring
  shape (module.mjs/server.mjs/create_runtime.mjs/hosted_pages.mjs/types)
  is the established route-registration pattern.
