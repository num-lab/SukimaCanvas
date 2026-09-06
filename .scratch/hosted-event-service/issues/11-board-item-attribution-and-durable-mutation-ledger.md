# 11 — Board Item 创建归属与耐久 Mutation Ledger

**What to build:** 让每个被服务端接受的新 Board Item 都拥有可信创建者，并在向实时客户端确认前同步进入 PostgreSQL 持久变更账本，使 SVG 成为可重建投影而非唯一历史。

**Blocked by:** 10 — Participant Seat 与实时连接准入

**Status:** done

- [x] 服务端从权威 Session、Event Membership、Board Session 和活动角色解析操作者，不信任客户端提交的作者或权限字段。
- [x] 每个持久创建 mutation 记录 Event、Board Session、Account、操作时间、序号和 mutation 内容，并给新 Board Item 写入不可变 `createdBy` 语义。
- [x] 写入只有在账本持久确认后才向发送者确认并广播；数据库失败时 mutation 被拒绝且不会只存在于其他客户端或 SVG。
- [x] 实时广播、重放和现有乐观回滚保持一致，重复客户端 mutation 不会创建重复的持久项目。
- [x] 从 SVG 快照加载时可以用后续账本 mutation 补齐到权威序号，且归属信息不会依赖浏览器提供。
- [x] 日志、画板公开载荷和普通 Participant UI 不泄露邮箱或内部 Account 标识。
- [x] Node/Socket 集成测试覆盖所有创建型工具、失败和重复提交；对账本、重放和广播热点运行改动前后基准并记录结果。

## Comments

- Implemented on `develop` (see commit history for this issue). Composition:
  [attribution.mjs](../../../server/hosted_event/attribution.mjs) derives the
  opaque, event-scoped Participant Identifier (`p` + 16 hex HMAC-SHA256) from
  the deployment secret; admission verdicts now carry `participantId` and
  `boardSessionId`; the socket write path resolves the operator only from that
  pinned verdict; [session.mjs](../../../server/board/session.mjs) stamps
  `createdBy` on item-creating mutations (top-level and tool-owned children),
  gates acceptance on a durable ledger append, and deduplicates accepted
  `clientMutationId`s (idempotent retries re-confirm the original entry).
- The durable ledger is a file adapter
  ([ledger/store.mjs](../../../server/hosted_event/ledger/store.mjs), one
  fsynced JSONL per board under `<WBO_HOSTED_DATA_DIR>/mutation-ledger/`)
  reached through the injection seam
  [ledger_registry.mjs](../../../server/board/ledger_registry.mjs) that the
  hosted module registers at composition. Per the spec's implementation
  decision, the concrete PostgreSQL vendor is deliberately not selected yet:
  the adapter contract (`appendEntries` / `readEntriesAfter`)
  is the swap point, and hosted mode fail-closes (`ledger_unavailable`) when
  acceptance would run without one.
- Durability semantics: `processMessage` applies first, then one fsync
  persists the accepted mutation plus any follow-up effects (trim-overflow and
  seed-drop deletes), then the in-memory log mirrors the ledger-assigned
  sequences, and only then is the sender confirmed and the mutation broadcast.
  A failed append rejects the write and drops the mutated board instance
  (existing stale-board machinery), so the mutation survives nowhere; the
  reload path reconstructs state from snapshot + ledger.
- Snapshot lag: board loads replay ledger entries newer than the stored SVG
  sequence, rebuild duplicate tracking from them, and attribute items from
  ledger mutations (never from browser input). The ledger is append-only for
  the Board Session's lifetime — the save path never trims it, so the
  complete accepted-mutation history stays retrievable for the Change Audit
  and 90-day retention work that builds on this ledger, duplicate retries
  stay idempotent across saves, and a lost snapshot is rebuilt by full
  replay. Ledger corruption or a sequence gap fails the load loudly instead
  of silently diverging; a torn final line from a crashed append is dropped
  on read.
- Privacy: ledger entries hold the internal `accountId` but never reach
  broadcasts, stored SVG, logs, or board payloads; items carry only the
  opaque `createdBy`. Integration tests assert emitted payloads and stored
  SVG are free of account ids and emails.
- Hosted mode now requires `AUTH_SECRET_KEY` at boot (fail-closed): the
  participant identifier derivation needs a stable secret. Test helpers and
  the Playwright harness were updated to compose it like production.
- Also fixed while wiring: hosted mode's deterministic 404 for legacy
  `/export` and `/random` was preempted by their `access: "user"` auth check
  once a secret is configured; those routes now opt out of the auth pre-check
  in hosted mode via a new `hostedOpenAccess` route flag, preserving the
  uniform 404 contract.
- Tests: `test-node/hosted_attribution.test.js` (identifier semantics),
  `test-node/hosted_mutation_ledger.test.js` (durable file adapter: torn tail,
  corruption, trim, unsafe names), extended `test-node/board_session.test.js`
  (stamping, batch children, ledger gating, dedupe, replay dedupe), and
  `test-node/hosted_board_attribution.test.js` (all creation tools —
  rectangle, ellipse, straight line, text, pencil create+append, hand copy —
  plus forged-field rejection, duplicate retries, ledger failure + board
  drop, snapshot-lag reload with hydration, replay continuity, payload/SVG
  leak checks, and legacy no-op behavior).
- Benchmarks (avg of 3 runs, legacy paths unchanged by design; additions sit
  behind hosted-only checks): persist 52.0ms → 47.3ms, broadcast
  112.7ms → 113.4ms, load 91.5ms → 86.2ms. The hosted acceptance path pays
  one fsync per accepted mutation by contract. Full gate: `npm run typecheck`,
  `npm run lint`, 554 Node tests, 78 Playwright tests — all green.
