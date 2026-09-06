# 06 — Reservation 申请、审批与容量约束

**What to build:** 让 Organizer Owner/Admin 创建和提交 Reservation，并让 Platform Operator 在不超出服务器承诺的前提下审批，为获批活动分配确定容量和不可枚举的 Event Public ID。

**Blocked by:** 05 — Organizer 成员邀请与角色权限

**Status:** done

- [x] Owner/Admin 可以维护 Reservation 草稿的活动名称、计划时间、1–50 个请求席位、可见性和必要展示信息。
- [x] 只有合法且完整的草稿可以进入 SUBMITTED；提交后未经 Change Request 不可直接改写影响审批的字段。
- [x] Operator 可以批准或拒绝已提交 Reservation，并在控制台看到目标时间窗的 Capacity Allocation 影响。
- [x] 容量窗口覆盖计划开始前 15 分钟到计划结束后 15 分钟；任意重叠窗口最多批准 20 个 Board Session 和 1,000 个 Participant Seat。
- [x] 审批与 Capacity Allocation 在并发请求下保持原子，不发生超卖或部分批准。
- [x] 批准生成不可枚举的 Event Public ID；内部 Reservation/Board Session 标识不出现在公共 URL。
- [x] 非法状态、冲突容量和越权审批给出确定性结果，并写入 Change Audit。
- [x] Node 集成测试覆盖边界值与并发容量竞争；Playwright 覆盖 Organizer 提交和 Operator 审批流程。

## Comments

- Implemented on `develop`. Verified with `npm run typecheck`, `npm run lint`,
  `test-node/hosted_reservation_store.test.js` (12 store/capacity unit tests),
  `test-node/hosted_reservations.test.js` (6 integration tests through the real
  composition entry), `playwright/tests/hosted-reservation-approval.spec.ts` (1
  cross-console browser test), and the full `npm test` gate (473 Node tests, 74
  Playwright tests).
- Model: Reservation and Board Session are modelled separately in the organizer
  store (`draft → submitted → approved/rejected/cancelled`). Organizer members
  (owner or admin) draft/edit/submit/cancel via `/organizers/{id}/reservations`;
  the operator reviews at `/operator/reservations`. Approval-affecting fields
  are frozen once submitted (direct edit → 409); a submitted reservation may
  still be withdrawn (cancel) before a decision.
- Capacity Allocation: the window is `start − buffer` to `end + buffer` (buffer
  configurable, default 15 min). A pure sweep (`computeCapacityPeak`) evaluates
  the peak concurrent Board Session count and Participant Seat total at every
  allocation start inside the window; approval is refused if the peak would
  exceed the concurrent limits (defaults 20 sessions / 1,000 seats, config
  `WBO_HOSTED_MAX_CONCURRENT_*`). The check-and-commit is synchronous, so
  concurrent approvals never oversell or partially approve (proven by store- and
  HTTP-level race tests). The operator console shows the would-be peak vs. the
  limits before deciding.
- Event Public ID: approval atomically mints a 16-char base64url, non-enumerable
  Event Public ID (with a collision retry) plus the Event and its scheduled
  Board Session. Public URLs use only `/events/{publicId}`; the internal
  reservation/board-session ids never appear there.
- Timezone: reservation wall-clock times are interpreted and displayed in a
  fixed service timezone (config `WBO_HOSTED_SERVICE_UTC_OFFSET_MINUTES`,
  default UTC+8 for the mainland-China launch, no DST), so the datetime-local
  edit fields and the read-only display always agree and store the correct
  absolute instant.
- Change Audit: create/submit/approve/reject/cancel all append records with the
  actual actor (operator actions marked `operator`), surfaced in the organizer's
  activity log; the operator-only rejection note is never shown to the
  organizer. Illegal transitions, capacity conflicts, past-start approvals, and
  unauthorized access all return deterministic results (409/403/404/redirect).
- Deferred by design: the participant-facing public event page at
  `/events/{publicId}` belongs to issue 07 (event discovery & brand assets);
  this issue mints and displays the public id/URL and exposes
  `getEventByPublicId` for that page but does not register the public route yet.
- Code review (high) fixes folded in: datetime-local values are no longer
  parsed as UTC (service-timezone offset, resolving the wrong-instant and
  display-mismatch findings); `approveReservation` re-checks that the start is
  still in the future; requested seats reject trailing garbage; the create-form
  visibility choice survives a validation re-render; the reservation rate limit
  also covers submit; and a stray `organizer_invitation_declineed` log-event
  typo from issue 05 was corrected.

