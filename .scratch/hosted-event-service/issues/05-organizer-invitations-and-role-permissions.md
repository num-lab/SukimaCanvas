# 05 — Organizer 成员邀请与角色权限

**What to build:** 让 Organizer Owner 邀请其他 Account 加入组织，并以最小权限管理 Owner/Admin 成员关系，为后续 Reservation、成果和集成管理提供可靠授权边界。

**Blocked by:** 03 — Account 恢复与 Session 安全控制；04 — Organizer Application 与平台审批

**Status:** done

- [x] Organizer Owner 可以向指定 Account 发出 7 天有效的 Organizer Invitation，邀请只有目标 Account 能接受。
- [x] 未接受、已过期、已撤销或已使用的邀请不能建立成员关系，并给出不泄露其他组织信息的失败响应。
- [x] Owner 可以授予或撤销 Organizer Admin；Admin 不能执行仅限 Owner 的成员和集成凭据管理。
- [x] 系统阻止移除最后一名 Owner，避免产生无人可管理的 Organizer。
- [x] 移除成员后，该 Account 的 Organizer Console 权限和相关 Session 授权立即失效，但不篡改其历史操作归属。
- [x] 邀请、接受、角色变更和移除均写入 Change Audit，记录实际操作者。
- [x] Node 集成测试覆盖完整角色矩阵、邀请过期和并发接受；Playwright 覆盖邀请与成员管理主流程。

## Comments

- Implemented on `develop`. Verified with `npm run typecheck`, `npm run lint`,
  `test-node/hosted_organizer_members.test.js` (9 store unit tests),
  `test-node/hosted_organizer_membership.test.js` (7 integration tests through
  the real composition entry),
  `playwright/tests/hosted-organizer-members.spec.ts` (1 cross-console browser
  test), and the full `npm test` gate (455 Node tests, 73 Playwright tests).
- Console structure: `/organizer` is the account's hub (organizations they
  belong to + invitations addressed to them + an apply CTA); `/organizers/{id}`
  is the per-organizer management page. Membership is authorized per request
  against the store, so a removed member's console access and any session-scoped
  authorization fail on the very next request; a signed-in non-member gets 404
  (the organizer's existence is not disclosed) and a signed-out visitor is
  redirected to login.
- Invitations: an Owner invites a specific email at a chosen role (owner or
  admin), 7-day TTL, single-use. Acceptance requires the signed-in account's
  verified email to match the invitation, so only the target can accept.
  Invalid, expired, revoked, declined, used, and wrong-recipient invitations all
  fail identically (`hosted_organizer_invitation_unavailable`), leaking nothing
  about other organizers. Accept/decline run their check-and-consume
  synchronously, so concurrent accepts establish membership exactly once (store
  test proves it).
- Role model & least privilege: member management (invite, revoke, change role,
  remove) is Owner-only; an Admin can view the organizer but the manage page
  renders no owner-only controls and the Owner-only POST endpoints return 403
  for admins. The change-audit trail is likewise an Owner-only view. The store
  refuses to demote or remove the last remaining Owner so an organizer can never
  be left unmanageable. Integration-credential management (issue 19) inherits
  the same Owner-only boundary.
- Change Audit: invite/accept/decline/revoke/role-change/remove each append a
  record with the actual actor's account id and kind; the Owner's activity log
  renders the trail. Removing a member never rewrites historical attribution
  (the removed member's past actions still show their identity), which the tests
  assert after removal.
- Deferred by design: Organizer Invitations are surfaced in the invitee's
  console rather than emailed. Invitation delivery belongs to the Lifecycle
  Notice workstream (issue 20), which will own notification templates and
  localization; the acceptance flow here already enforces "only the target
  Account can accept" without an emailed token, avoiding token-leak risk.
- Refactor: the organizer store now also holds Organizer Invitations, role
  grants, and organizer-scoped Change Audit; the shared hosted form/CSRF/cookie
  helpers from issue 04 are reused unchanged. 36 new hosted translation keys
  were added across all 21 supported languages per the AGENTS.md invariant.
- Code review (high) fixed in the new code: the org activity log no longer
  discloses the approving Platform Operator's email (it shows a generic
  "Platform operator" label) and is restricted to Owners; `acceptInvitation`
  reports the account's real role when it is already a member; and organizer
  invitations use their own rate-limit config
  (`WBO_HOSTED_ORGANIZER_INVITE_ATTEMPTS_*`) rather than sharing the
  application flow's budget.

