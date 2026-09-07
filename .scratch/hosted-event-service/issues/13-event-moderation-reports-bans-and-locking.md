# 13 — Event 管理、举报、封禁与锁定

**What to build:** 让 Organizer 为具体 Event 分配 Moderator，并让有权人员在实时画板和独立控制台处理举报、警告、踢出、Event Ban、解除封禁和破坏性 Clear，而不扩大为跨 Organizer 黑名单。

**Blocked by:** 05 — Organizer 成员邀请与角色权限；12 — 完整笔画审计、派生关系与崩溃恢复

**Status:** done

- [x] Owner/Admin 可以为单个 Event 分配或撤销 Event Moderator；该角色不能管理 Organizer 成员、Reservation、凭据、归档或其他 Event。
- [x] 被分配 Moderator 可在 Preparation Window 进入并执行事件内治理，权限撤销后现有实时连接及时刷新。
- [x] Participant 可以举报当前 Event 中另一名在线 Participant；自我举报、跨 Event 目标和畸形 socket 标识被确定性拒绝。
- [x] Moderator 可以填写原因并执行警告、踢出、限于该 Event 的 Ban 或解除 Ban；Ban 立即驱逐目标并覆盖 Access Code、Membership 和 Entry Grant 重入。
- [x] Moderator 看到的是 Event-scoped Participant Identifier 与冻结展示名，不暴露邮箱或全局 Account 标识。
- [x] 只有 Owner/Admin 可以 Clear；所有警告、踢出、Ban、解封、锁定和 Clear 均记录实际操作者与原因。
- [x] Node/Socket 集成测试覆盖角色矩阵、实时权限刷新和 Ban 重入；Playwright 覆盖举报与 Moderator 处置主流程。

## Comments

- Implemented on `develop`. Verified with `npm run typecheck`, `npm run lint`,
  `npm run test-node` (578 tests, incl. 16 new in
  [hosted_event_moderation.test.js](../../../test-node/hosted_event_moderation.test.js)
  and 2 in [hosted_event_moderators.test.js](../../../test-node/hosted_event_moderators.test.js)),
  and the full Playwright suite (79 tests, incl. the new
  [hosted-moderation.spec.ts](../../../playwright/tests/hosted-moderation.spec.ts)).
- Role model: `event_moderators` grants live in the organizer store (per-event,
  Owner/Admin managed, change-audited). Admission maps them to a new
  `event_moderator` board role — the same Preparation Window entry and seat
  exemption as Owner/Admin, `canBan` but never `canClear`
  ([admission/index.mjs](../../../server/hosted_event/admission/index.mjs),
  [board_capabilities.mjs](../../../server/auth/board_capabilities.mjs)).
  Moderators have no console access and no authority over other events; the
  grant targets a verified account by email and refuses organizer members.
- Realtime governance: hosted `report_user` records a report and notifies
  governance roles via `user_reported` without disconnecting anyone;
  `moderation_action` (warn/kick/ban/unban, reason required, ack-reported)
  applies dispositions ([hosted_moderation.mjs](../../../server/socket/hosted_moderation.mjs));
  `moderation_state` serves the ban list as Participant Identifiers with
  frozen names. Governance roles are protected targets. Bans revoke the
  membership and evict every connection of the account through the
  moderation socket-effects registry
  ([moderation/socket_effects.mjs](../../../server/hosted_event/moderation/socket_effects.mjs));
  revoking a moderator's grant refreshes their live connection (downgraded to
  member capabilities if they hold a membership, dropped otherwise).
- Durable trail: [moderation/store.mjs](../../../server/hosted_event/moderation/store.mjs)
  records report/warn/kick/ban/unban/lock/unlock/clear with operator, reason,
  and the frozen target identity; the Owner/Admin event console renders the
  trail, the moderator list, and lock reasons. Clear records its reason via
  an optional `reason` field on the CLEAR wire message (collected by the
  Clear tool in hosted mode) mirrored into the trail on acceptance; the
  mutation ledger remains the technical audit.
- Ban re-entry: an Event Ban overrides the Access Code entry form with the
  uniform non-enumerating failure and the board admission gate (`event_banned`);
  unbanning never resurrects the revoked membership. Hosted board pages now
  serve `/b/{boardName}.svg` behind the same admission gate so reconnect
  baseline refreshes work, and terminal admission refusals route the client
  back to the event page notice (`?notice=banned` et al.) instead of looping
  reconnects.
- Identity exposure: moderators see the event-scoped Participant Identifier
  (already carried by item attribution on the board) plus the frozen display
  name; no emails or Account ids reach the board surface. The Owner/Admin
  console resolves operator emails only.
- Follow-ups that stay open by design: Entry Grant re-entry (issue 19) is
  covered by construction because the shared admission gate checks bans before
  any grant redemption exists; moderation actions are not rate limited (gated
  by `canBan` and live targets); reports carry no free-text reason yet.
- Code review round: fixed two locale strings (Burmese CJK artifact,
  Catalan grammar), deduplicated the hosted-refusal redirect and the
  500-character reason limit, removed a dead parameter, resolved the operator
  email into the console trail, and made the hosted Clear reason server-
  enforced (`write_blocked` rejection without a reason, even for Owner/Admin).
  Broadcast benchmark after the CLEAR-only policy hook: 114.8ms avg vs the
  121.3ms issue-12 baseline — run-to-run noise, no regression.
