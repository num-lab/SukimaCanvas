# 14 — 关闭 Board Session 并生成 Private Archive

**What to build:** 在计划结束或授权关闭时形成明确写入边界，排空已经接纳的绘图变更，校验最终序号，并把不可变 Private Board Archive 保存到 S3-compatible object storage。

**Blocked by:** 08 — Reservation 变更与耐久活动调度；12 — 完整笔画审计、派生关系与崩溃恢复

**Status:** ready-for-agent

- [x] Board Session 进入 CLOSING 后立即拒绝新的持久写入，但允许已接纳队列完成并向客户端得到确定结果。
- [x] 关闭流程等待账本和 SVG 投影达到同一最终权威序号，校验失败时不标记归档成功。
- [x] 成功关闭生成不可变 Private Archive，保存画布、Item Attribution 和必要审计边界；对象键不作为公共访问凭据。
- [x] 空 Board Session 同样产生合法 Archive 与生命周期记录。
- [x] Archive 成功后 Board Session 不可重新编辑或重开；继续创作必须创建新的 Board Session。
- [x] 已连接 Participant 收到只读完成状态，之后无法通过旧页面、socket 或 mutation 重获写权限。
- [x] Node/Socket 集成测试覆盖关闭竞争、队列排空、空画布和对象存储成果；Playwright 覆盖关闭后的只读完成界面。

## Comments

- Implemented on `develop` (commit "Add board session closing and private
  archive"). Verified with `npm run typecheck`, `npm run lint`, the full
  `npm test` gate (600 Node tests, 81 Playwright tests), and before/after
  `npm run bench` (e2e 395.0→428.5ms, load 91.5→87.4ms, persist
  48.9→50.6ms, broadcast 131.6→128.9ms — run-to-run noise; the acceptance
  path adds one boolean check that the benchmarks never execute, since they
  run without a hosted operator).
- Lifecycle change: `advanceLifecycle` no longer time-transitions
  `closing → closed`. That seal is owned by the new close pipeline
  ([hosted_event/archive/close.mjs](../../../server/hosted_event/archive/close.mjs))
  so an unfinished or failed archive can never masquerade as a closed
  session. The store exposes `listBoardSessionsDueToClose` (drain-elapsed,
  still `closing`, unarchived), `markBoardSessionClosed` (guarded
  `closing`-only seal recording `archiveKey`/`archivedFinalSeq`, audited as
  `board_session.closed`), and `recordBoardSessionArchiveFailed` (audited,
  session stays `closing`).
- Write boundary: [session.mjs](../../../server/board/session.mjs) gains
  `sealWrites()` — a barrier enqueued on the per-board serial queue. Every
  mutation already admitted into the queue completes with its deterministic
  result (idempotent `clientMutationId` retries still re-confirm the
  original entry); anything enqueued afterwards is refused with
  `writes_sealed`. Live revalidation refuses writes as soon as the session
  leaves `open`, so the barrier closes the remaining interleavings. Legacy
  boards never pass an operator and are unaffected.
- Close pipeline (`runDueCloses`, idempotent, single-flight per session):
  seal → save snapshot → validate that in-memory `getSeq()`, the on-disk
  snapshot's `data-wbo-seq` (via `readStoredSvgSeq`, whose backup fallback
  also heals the primary), and the ledger's last confirmed entry all agree →
  archive → seal `closed`. Any disagreement throws
  `WBO_BOARD_ARCHIVE_SEQ_MISMATCH`, records an observable
  `board_session.archive_failed` audit entry, and leaves the session
  `closing` for the next pass; nothing is marked archived.
- Private Board Archive: one write-once prefix per session
  `board-archives/{boardSessionId}/` holding `canvas.svg` (with immutable
  item attribution), `ledger.jsonl` (the full accepted-mutation audit
  boundary), and `manifest.json` (format, ids, finalSeq, item/mutation
  counts, SHA-256 integrity for both objects). The manifest lands last, so
  an interrupted close never leaves a manifest vouching for an incomplete
  archive. The file adapter
  ([archive/store.mjs](../../../server/hosted_event/archive/store.mjs))
  refuses overwrites with different bytes (identical re-put is the no-op
  success of a crash retry) and rejects path-unsafe keys; keys are internal
  identifiers — no route serves the archive directory and keys never appear
  in public URLs or embed the Event Public ID.
- Empty sessions archive a canonical empty canvas (`data-wbo-seq="0"`,
  empty `drawingArea`, empty ledger, valid integrity hashes) and get the
  same `closed` lifecycle record.
- Post-close irreversibility: `closed` is terminal — `markBoardSessionClosed`
  refuses non-closing sessions, admission refuses closed sessions (old page
  redirects to the event page with `notice=not_open`, socket reconnect is
  refused), and no reopen path exists.
- Read-only completion: when the pipeline seals a session, live sockets are
  demoted to reader, re-emitted `BOARDSTATE` carrying `eventClosed: true`,
  and the board shell shows a sticky completion status
  (`event_closed_read_only_title`/`_detail`, translated in all 21 languages);
  editing tools disappear and mutations are refused. Connections stay open
  for viewing; reconnects route to the event page.
- Composition: the hosted module creates the pipeline and folds
  `runDueCloses` into `refreshEventLifecycle` (admission, every console/API
  read, and the durable lifecycle poker all run it — failures never fail the
  surrounding request). Route modules receive the composed refresh via an
  injected `advanceEventLifecycle` with their previous behavior as the
  standalone default. The socket layer registers the real-time close effect
  through `registerBoardCloseEffects` at IO start (test seam mirrors it).
- Tests: new `test-node/hosted_board_archive.test.js` (close race with a
  write during closing; seal barrier completing an in-admission mutation and
  refusing/refunding later ones; empty-canvas archive; corrupted-ledger
  validation failure staying `closing` with no archive, then sealing on
  retry; archive immutability and unsafe-key refusal),
  `test-node/hosted_lifecycle_store.test.js` updated to the new contract
  (time never seals; guarded sealing; failure audit; restart catch-up stops
  at `closing` until sealed), the shared fixture composes the pipeline like
  production, and
  `playwright/tests/hosted-board-close.spec.ts` covers the full
  browser flow ending on the read-only completion UI and event-page refusal.
- Deferred by design to ticket 15 (archive failure recovery): persistent
  `ARCHIVE_FAILED` state modeling beyond the audit record, operator/organizer
  notifications, and idempotent-retry UX. The pipeline already retries every
  pass and never fakes success, which is the surface ticket 15 builds on.


