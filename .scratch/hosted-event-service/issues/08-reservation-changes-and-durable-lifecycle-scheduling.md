# 08 — Reservation 变更与耐久活动调度

**What to build:** 让 Organizer 对已提交或获批 Reservation 提交变更/取消请求，并让 Event 生命周期由可恢复的持久后台工作推进，而不是依赖进程内 timer。

**Blocked by:** 06 — Reservation 申请、审批与容量约束

**Status:** done

- [x] Owner/Admin 可以针对改期、延期、容量或取消提交 Reservation Change Request，并查看审批状态。
- [x] 影响容量的变更只有 Operator 审批后才更新 Reservation 与 Capacity Allocation，更新过程重新执行全部重叠容量约束。
- [x] 取消未来 Event 会阻止新入场并释放尚未消耗的未来容量；已形成的审计记录不会被删除。
- [x] 耐久任务将 Board Session 按权威时间从 SCHEDULED 推进到 OPEN、CLOSING 和后续关闭工作，不以进程内 timer 为事实来源。
- [x] 服务重启后，到期或中断的生命周期任务会恢复执行；重复执行不会产生重复转换或相互矛盾的状态。
- [x] 非法状态转换、并发审批和过期任务被确定性处理并记录可观察失败。
- [x] Node 集成测试用可控时钟覆盖变更、取消、边界时间和重启恢复；控制台展示与实际权威状态一致。

## Comments

- Implemented on `develop`. Verified with `npm run typecheck`, `npm run lint`,
  `test-node/hosted_lifecycle_store.test.js` (9 store/lifecycle/change unit
  tests), `test-node/hosted_reservation_changes.test.js` (5 integration tests
  through the composed server with a controllable clock), and
  `playwright/tests/hosted-reservation-changes.spec.ts` (1 cross-console browser
  flow), plus the full `npm test` gate (503 Node tests, 76 Playwright tests).
- Change Requests: a `StoredChangeRequest` (`amend` / `cancel`) is modelled in
  the organizer store. An Owner/Admin submits an amend (new times/seats) on an
  approved, still-scheduled reservation at
  `POST /organizers/{id}/reservations/{rid}/change` — one pending amend at a
  time. The operator reviews at `/operator/changes[/{crId}]` and approves or
  rejects; approval re-runs the full overlapping capacity constraint with the
  reservation's own allocation excluded and only then atomically updates the
  reservation, event, and board session (concurrent approvals cannot oversell,
  proven by a store race test). Amend validation reuses the shared
  `validateScheduleFields` with reservation creation.
- Cancellation: cancelling a future (still-scheduled) approved event is a direct,
  capacity-releasing action (no operator needed) via the existing `/cancel`
  route, which now branches on status — draft/submitted withdraw, approved-future
  cancels. It moves the reservation/event/board session to cancelled (dropping
  the future Capacity Allocation and hiding the event from discovery), records
  the cancellation as an applied cancel Change Request, supersedes any pending
  amend with an audited rejection, and never deletes existing audit records.
- Durable lifecycle: `advanceLifecycle({now, closeDrainMs})` is the idempotent,
  time-authoritative background work that moves each non-terminal board session
  `scheduled → open` (at start), `open → closing` (at end), and
  `closing → closed` (after `HOSTED_BOARD_SESSION_CLOSE_DRAIN_MS`). Guards make
  re-runs and post-restart catch-up safe — no duplicate transitions. It is run
  lazily before any console/decision read (so the displayed status always
  matches authoritative state) and, in production, by a `setInterval` poker
  gated on `HOSTED_LIFECYCLE_POLL_MS` and disabled whenever a clock is injected
  (tests) so no in-process timer is the source of truth. Restart recovery is
  covered by an integration test that boots a second instance on the same data
  directory with the clock past the whole window.
- Deferred by design: the actual archive pipeline behind CLOSING → CLOSED
  (draining accepted writes, snapshot, Board Archive) is issues 14–15; this
  issue advances the lifecycle states and leaves that hook for them. Amending a
  reservation that is only submitted (not yet approved) is done by withdrawing
  and resubmitting; amend Change Requests target approved reservations, where a
  Capacity Allocation exists to re-check.
- Code review (high) fixes folded in: the cancellation-time auto-rejection of a
  pending amend now records the actor and a `change_request.rejected` audit like
  the normal reject path; reservation and change validation share
  `validateScheduleFields`; and the public event-page seat-leak test was made
  robust against clock-minute collisions. SameSite=Lax on the session cookie
  blocks the cross-site vector behind the noted upload rate-limit ordering.
