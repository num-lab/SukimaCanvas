# 15 — 归档失败恢复与幂等重试

**What to build:** 让关闭过程中发生的数据库、快照或对象存储故障保持为可观察、可恢复的 ARCHIVE_FAILED，而不是伪装成功；Operator 能安全重试，进程重启也不会丢失工作。

**Blocked by:** 14 — 关闭 Board Session 并生成 Private Archive

**Status:** done

- [x] 任何无法验证最终序号或无法持久保存 Private Archive 的关闭工作进入 ARCHIVE_FAILED，并保留完整失败原因和重试上下文。
- [x] ARCHIVE_FAILED 不开放写入、不发布成果，也不把 Reservation 或 Board Session 显示为已成功归档。
- [x] Platform Operator 控制台列出失败工作并允许授权重试；Organizer 只能看到适当的失败状态，不能操作其他 Organizer 的任务。
- [x] 自动恢复和人工重试均幂等，不产生冲突 Archive、重复状态推进或不同最终序号的“成功”副本。
- [x] 进程在关闭任意阶段崩溃并重启后，耐久任务可以继续或安全重做，最终结果与一次正常执行一致。
- [x] 故障和恢复产生可观测指标与 Change Audit，敏感对象凭据和内部错误不会暴露给普通用户。
- [x] 集成测试通过故障注入覆盖数据库、快照、对象存储和重启边界，并证明失败不会被误报为成功。

## Comments

- Implemented on `develop`. Verified with `npm run typecheck`, `npm run
  lint`, the full Node suite (606 tests) and the full Playwright suite
  (81 tests). Benchmarks were not run: nothing on the per-message, load,
  persist, or broadcast hot paths changed — `listBoardSessionsDueToClose`
  keeps its O(sessions) shape and the close pipeline runs only on close
  passes.
- Durable `ARCHIVE_FAILED` state
  ([organizers/store.mjs](../../../server/hosted_event/organizers/store.mjs)):
  the first failed close attempt transitions a session `closing →
  archive_failed`; `recordBoardSessionArchiveFailed` now records the
  classified failure code, the internal detail (length-clamped), the attempt
  count, and first/last failure times on the session's new `archiveFailure`
  record and appends one audited `board_session.archive_failed` entry per
  failed attempt (bounded by the retry backoff, so the trail cannot spin).
  The state is hydrated for pre-existing on-disk records, so no migration.
- Recovery model: `archive_failed` sessions are re-picked by the close
  pipeline after `WBO_HOSTED_BOARD_SESSION_ARCHIVE_RETRY_MS` (default 15
  min, new config) — automatic recovery for transient faults; a Platform
  Operator's authorized retry (`retryBoardSessionArchive`, audited as
  `board_session.archive_retry_requested` with the operator account) moves
  the session back to `closing` so the next pass runs immediately, bypassing
  the backoff. Failure context survives retries until a success clears it
  (`markBoardSessionClosed` now seals from `archive_failed` too and nulls
  the failure record); retrying a non-failed session is a deterministic
  `not_failed` refusal, never a duplicate advancement.
- Failure classification ([archive/close.mjs](../../../server/hosted_event/archive/close.mjs)):
  every close-path throw now carries a deterministic code (snapshot save,
  ledger missing, `final_sequence_mismatch`, archive-object conflict,
  storage write failure, seal refusal, internal fallback) which lands on the
  failure record, the audit trail, and the new
  `wbo.hosted.board_archive` metric (`outcome=archived|failed`,
  `error.type=<code>`). Idempotency is unchanged and now covered by tests:
  deterministic manifest, immutable store re-put, guarded seal.
- Success-only completion (misreport fix): `runDueCloses` used to notify the
  socket layer after failures too, telling connected participants
  `eventClosed: true` while nothing had sealed. The read-only completion
  notification is now sent only for sessions that actually sealed; a failed
  attempt leaves live connections untouched (writes stay refused by live
  revalidation since the session is not open).
- Operator console ([organizers/routes.mjs](../../../server/hosted_event/organizers/routes.mjs)
  + `operator.html`): a new "Archive failures" section lists every
  `archive_failed` session with event, organizer, failure reason (localized
  label per code), attempt count, last attempt time, and the internal
  detail; the retry button POSTs
  `/operator/board-sessions/{boardSessionId}/archive-retry`
  (operator-gated, CSRF-protected), runs one lifecycle pass inline, and
  re-renders with a deterministic outcome notice (completed / failed again /
  409 no-longer-failed / 403 CSRF). Organizer surfaces show only the
  localized `hosted_session_status_archive_failed` lifecycle label on the
  reservation page — no failure detail, no internal ids, no retry surface;
  retry authority is operator-only by construction. All new strings are
  translated in all 21 languages.
- Tests: `test-node/hosted_lifecycle_store.test.js` covers the store state
  machine (first failure entry, context retention, backoff gating of the
  due list, failing retry refresh, double-retry refusal, sealing from
  `archive_failed` clearing context, exact audit trail);
  `test-node/hosted_board_archive.test.js` asserts the validation-failure
  and seal-failure paths end `archive_failed` with classified context and a
  withheld completion signal; new
  `test-node/hosted_archive_recovery.test.js` injects faults at real
  boundaries — manifest write failure (commit marker) with backoff-gated
  automatic retry over byte-identical objects, snapshot save failure, a
  process restart simulated by recomposing every store and the pipeline from
  the same data directory, and a full HTTP flow with a genuinely unwritable
  archive directory (chmod) proving failures are not misreported as success
  on any surface.
- Code review fixes: (1) a zero retry backoff now actually disables the
  automatic retry (previously `archiveRetryMs: 0` made a failed session due
  on every pass — the inverse of the documented
  `WBO_HOSTED_BOARD_SESSION_ARCHIVE_RETRY_MS` contract); tests that meant
  "bypass the backoff" now go through the operator retry path instead;
  (2) the four hand-rolled coded close errors collapsed into one
  `closeError(code, message)` helper. Review-judgement items left as-is:
  the relative retry-form action is correct on re-rendered pages because
  hosted pages resolve relative URLs against the deployment-root
  `<base href>` (same convention as the application approve/reject forms);
  the 500-character failure-detail clamp is deliberate so one hostile
  error cannot grow the durable state, while the structured log keeps the
  full error; the `advanceEventLifecycle` optional-injection pattern
  matches the sibling route modules.
- Deferred by design to ticket 20 (lifecycle notices): organizer/operator
  notification delivery; the failure state, audit, metrics, and console
  surfaces here are what those notices will report.

