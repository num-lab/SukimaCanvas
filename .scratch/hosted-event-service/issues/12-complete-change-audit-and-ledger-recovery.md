# 12 — 完整笔画审计、派生关系与崩溃恢复

**What to build:** 将更新、移动、追加、复制、删除、批量和清空纳入同一可信账本与 Change Audit，使原始作者稳定、复制来源可追踪，并能在快照落后或进程崩溃后恢复所有已接受写入。

**Blocked by:** 11 — Board Item 创建归属与耐久 Mutation Ledger

**Status:** done

- [x] 移动、编辑和追加保持 Board Item 的原始创建者，同时记录实际操作者、操作类型、时间和目标项目。
- [x] 复制创建归属于复制者的新 Board Item，并保存可审计的来源关系；客户端不能伪造复制者或来源 Event。
- [x] 删除、批量变更和 Clear 保留足以调查行为的 Change Audit，不因当前 SVG 中项目消失而丢失历史。
- [x] 每个持久 mutation 获得连续权威序号；批量 mutation 要么按合同完整接纳，要么确定性拒绝，不能留下不可解释的部分状态。
- [x] 快照落后账本、保存中断和应用崩溃后，恢复结果与已确认给客户端的最终状态一致。
- [x] 损坏或结构不一致的快照作为显式故障处理，不静默修复、跳过整个审计边界或覆盖可恢复数据。
- [x] Node/Socket 集成测试覆盖全部 mutation 类型和故障注入；对 load、persist、replay 与 broadcast 热点运行改动前后基准。

## Comments

- Implemented on `develop` (see commit history for this issue). Issue 11's
  acceptance flow already routes every persistent mutation type (create,
  update, append, copy, delete, batch, clear) through the same durable ledger
  gate in [session.mjs](../../../server/board/session.mjs), so this issue's
  production work is the two recovery-fault fixes below plus the audit
  integration tests; the audit fields (operator `accountId`, mutation type,
  `acceptedAtMs`, target id/parent/newid, server-stamped attribution) were
  verified against the existing entry shape rather than redesigned.
- Creator preservation: updates and appends clone the canonical item and only
  apply schema-permitted fields, so `createdBy` is immutable across moves,
  edits, and appends; normalization drops client-supplied attribution before
  acceptance, including on tool-owned batch children and COPY children.
- Copy derivation: the durable COPY entry records source `id` → `newid`
  together with the copier's `accountId`, `eventId`, and the server-stamped
  participant identifier, which is the auditable source relation; the on-item
  `copySource` remains the rewrite-time hydration aid it already was.
- Fix 1 — silent snapshot repair made explicit: quarantining an unreadable
  stored SVG ([svg_board_store.mjs](../../../server/persistence/svg_board_store.mjs))
  previously left no log trace; it now emits `svg.snapshot_unreadable_quarantined`
  (error level). Recovery stays explicit and audit-bound: quarantine preserves
  the corrupt bytes, the fallback order is backup → ledger rebuild, the ledger
  is never trimmed by the save path, and a ledger gap or corruption still
  fails the load loudly (`WBO_LEDGER_SEQ_GAP` / `WBO_LEDGER_CORRUPT`).
- Fix 2 — torn-ledger-tail append boundary ([ledger/store.mjs](../../../server/hosted_event/ledger/store.mjs)):
  a crash mid-append left the torn bytes in the file; reads dropped the torn
  final line, but the next append then wrote *after* the torn bytes, burying
  them mid-file so every later read failed as corruption — a permanent load
  failure after otherwise-successful crash recovery. The adapter now repairs
  the boundary once per instance before the first append: an unparseable
  trailing line (never fsync-confirmed) is truncated, while a complete final
  entry that only lost its trailing newline is sealed with a newline, because
  reads already accept it. Confirmed entries are never truncated.
- Tests: new `test-node/hosted_change_audit_recovery.test.js` (creator
  preservation + operator audit for move/edit/append including forged fields,
  copy source-relation audit, delete/clear audit surviving SVG removal with
  reload + sequence continuity, batch all-or-nothing acceptance/rejection with
  one sequence, corrupt-snapshot quarantine + exact ledger rebuild, save
  interruption between the backup and primary renames, torn tail recovery with
  continued acceptance, ledger gap/corruption failing the connection loudly);
  two new adapter tests in `test-node/hosted_mutation_ledger.test.js` for the
  boundary repair; shared hosted composition extracted to
  `test-node/helpers/hosted_board_fixture.js` and reused by
  `test-node/hosted_board_attribution.test.js`.
- Benchmarks (before → after, `npm run bench`, clean runs): e2e 398.0ms →
  374.2ms, load 90.5ms → 86.6ms, persist 52.2ms → 46.2ms, broadcast
  125.9ms → 121.3ms. The changes sit on failure branches only (quarantine
  logging, boundary repair), so the hot paths are unchanged and the deltas
  are run-to-run noise. Full gate: `npm run typecheck`,
  `npm run lint`, 562 Node tests, 78 Playwright tests — all green.
