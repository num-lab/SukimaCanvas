# 20 — 活动生命周期邮件通知

**What to build:** 通过可恢复的后台工作向正确的 Account 发送验证、恢复和活动生命周期邮件，让 Organizer 与已经进入过 Event 的 Participant 及时获知重要状态变化。

**Blocked by:** 03 — Account 恢复与 Session 安全控制；08 — Reservation 变更与耐久活动调度；15 — 归档失败恢复与幂等重试

**Status:** done

- [x] 邮箱验证和密码恢复邮件只发送给对应 Account，使用一次性限时凭据且不在日志中记录正文或 secret。
- [x] Organizer Member 按角色和权限收到 Reservation 审批、变更、取消、即将开始、归档成功或失败等必要通知。
- [x] Participant 只收到自己已经建立 Membership 的 Event 的取消、关闭或其他必要状态通知；未知 Access Code 持有者不会被猜测或触达。
- [x] 每个逻辑通知有稳定幂等键，重试、重复任务和进程重启不会重复发送同一通知。
- [x] 邮件内容提供自然的 `zh-CN` 与 `en` 版本，敏感链接限时、最小权限且不携带原始 Access Code 或 Entry Grant。
- [x] 邮件供应商暂时不可用时，任务进入可观察重试状态，不阻塞 Event 关闭、Socket.IO 或其他用户请求。
- [x] Node 集成测试使用可控邮件 Adapter 检查收件人隔离、幂等、重启恢复和本地化；Playwright 验证触发状态在控制台中的可见性。

## Comments

- Implemented in `e3cd51c` (plus review fixes folded in) on `ticket20`.
  Verified with `npm run typecheck`, `npm run lint`, the full Node suite (647
  tests, including 18 new ones across
  `test-node/hosted_notification_store.test.js`,
  `test-node/hosted_notification_service.test.js`, and
  `test-node/hosted_lifecycle_notices.test.js`), and the Playwright suite
  (`playwright/tests/hosted-lifecycle-notices.spec.ts` passes; one
  pre-existing `hosted-published-canvas.spec.ts` failure reproduces on the
  branch without these changes, proven by stashing the commit). Benchmarks
  were not run: nothing on the per-message, load, persist, or broadcast hot
  paths changed — the notice store is only touched on trigger events and
  drain passes.
- Notification module (`server/hosted_event/notifications/`):
  [store.mjs](../../../server/hosted_event/notifications/store.mjs) keeps one
  durable `notifications.json` per data directory with an idempotent enqueue
  on the caller-supplied stable key, a due list honoring retry backoff, and
  sent records shrunk to content-free tombstones (pruned after 30 days).
  [service.mjs](../../../server/hosted_event/notifications/service.mjs) is
  the single fan-out seam: trigger methods resolve audiences (organizer
  members via the organizer store, Event Membership holders via the
  membership store, active accounts only) and enqueue per-recipient records
  keyed `<logical trigger>:<audience>:<accountId>` in one durable write, then
  kick a detached, coalescing drain. Failures back off from
  `WBO_HOSTED_MAIL_RETRY_MS` (doubling, capped at one hour) and stay listed
  on the operator console's new "Mail delivery retries" section.
- Triggers: operator approval/rejection and Change Request decisions notify
  organizer members (reservation routes); cancellation notifies members and
  every Membership holder; the lifecycle pass sends one upcoming-start
  heads-up per scheduled session inside
  `WBO_HOSTED_NOTICE_UPCOMING_WINDOW_MS` (default 24 h, organizer members
  only, one per session via the idempotency key); the close pipeline reports
  archive success (members + participants) and first-failure episodes
  (members only, so retry backoff cannot become a mail storm). Account
  verification/reset mail now flows through the same queue: composed in the
  request's language, enqueued durably, delivered detached — a vendor outage
  becomes an observable retry instead of a failed registration or a 500 on
  forgot-password, while responses stay byte-identical on account existence.
- Content: lifecycle notices are composed bilingual in
  [notices.mjs](../../../server/hosted_event/notifications/notices.mjs)
  (zh-CN first, divider, then en) because background triggers have no request
  language and there is no recipient language preference; they carry no URLs
  (consoles are reached by login), no Access Codes, no Entry Grants. The only
  sensitive links (single-use verification/reset) keep their request-built,
  TTL-bound URLs from the account flows. Outbox filenames derive from the
  notification id, so a redelivery attempt after a crash rewrites the same
  message file instead of queueing a duplicate. Operator console labels are
  translated in all 21 languages. New metric `wbo.hosted.notice` records
  sent/failed per kind.
- Delivery semantics: enqueue→send→mark-sent gives at-least-once under one
  unavoidable crash window (vendor accepted, sent mark not yet persisted);
  the deterministic outbox filename makes that window harmless for the
  first-release file vendor, and the contract is documented in the service.
  Logs carry only notice id, kind, and error — never recipient, body, or
  token.
- Review fixes folded in: the error guard moved inside `fanOut` (trigger
  methods no longer repeat try/catch), recipient resolution deduplicated into
  one `resolveActiveRecipients`, the close pipeline's two notice hooks share
  `eventNameFor`/`notifyNotice` helpers, the kind-label map is keyed by the
  imported `NOTICE_KINDS` constants, the unused store `flush` was removed,
  and the durability docs now state the at-least-once crash window honestly.
