# 04 — Organizer Application 与平台审批

**What to build:** 让已验证 Account 提交 Organizer Application，并让 Platform Operator 在独立控制台审核、批准或拒绝申请；批准后申请人成为新 Organizer 的 Owner。

**Blocked by:** 02 — Account 注册、邮箱验证与登录

**Status:** done

- [x] 已验证 Account 可以提交包含必要主体信息的 Organizer Application，并查看当前申请状态。
- [x] 重复提交、非法状态转换和超限输入被确定性处理，不会创建互相冲突的有效申请。
- [x] 只有 Platform Operator 可以查看待审队列并批准或拒绝申请；普通 Account 无法调用相同能力。
- [x] 批准操作原子创建 Organizer 并授予申请人 Organizer Owner；并发审批不会重复创建 Organizer 或角色。
- [x] 拒绝结果向申请人显示清晰状态，但不会暴露仅供运营使用的敏感备注。
- [x] 提交、审批、拒绝和操作者身份写入 Change Audit。
- [x] Node 集成测试覆盖角色隔离、并发审批和非法状态；Playwright 覆盖申请人与 Operator 的跨控制台流程。

## Comments

- Implemented on `develop`. Verified with `npm run typecheck`, `npm run lint`,
  `test-node/hosted_organizer_store.test.js` (10 store unit tests),
  `test-node/hosted_organizers.test.js` (7 integration tests through the real
  composition entry), `playwright/tests/hosted-organizer-approval.spec.ts` (2
  cross-console browser tests), and the full `npm test` gate (439 Node tests,
  72 Playwright tests).
- Operator identity seam: Platform Operators are provisioned by deployment
  config (`WBO_HOSTED_OPERATOR_EMAILS`, a normalized email allowlist), not by
  self-service registration — matching the domain definition of a "service
  representative" and the existing `WBO_BOARD_MODERATORS` pattern. A signed-in,
  verified, active Account whose email is listed is an operator; the shared
  header shows the operator-console link only for operators. `/operator` and its
  decision endpoints return 403 for ordinary accounts and redirect signed-out
  visitors to `/login`.
- Storage seam: organizer applications, organizers, role grants, and the Change
  Audit live in JSON files under `WBO_HOSTED_DATA_DIR` behind a single store
  seam (`server/hosted_event/organizers/store.mjs`), consistent with the account
  store. Approval/rejection run their check-and-mutate synchronously before the
  first `await`, so concurrent approvals deterministically create exactly one
  Organizer and one Owner role (covered by a `Promise.all` race test).
- Application state machine: an account may submit only when it has no
  application or its most recent one was rejected; a `pending` or `approved`
  application deterministically refuses a resubmission (`already_pending` /
  `already_approved`), so one founding account maps to at most one Organizer in
  V1. Field bounds (name/contact ≤120, description ≤2000), invalid contact
  email, missing CSRF, wrong media type, and oversized bodies are all rejected
  without creating an application.
- Change Audit: submit, approve, and reject each append a record with the actor
  account id and `actorKind` (`account` vs `operator`); the operator
  application-detail console renders the trail (action, actor email, timestamp),
  making the audit observable through the public interface. The operator-only
  rejection note is stored on the application and shown only on the operator
  console — never on the applicant's status view (asserted at both the store and
  HTTP layers).
- Refactor: extracted the shared hosted browser-form plumbing (CSRF
  double-submit validation, cookie attributes, form-body reading, redirect and
  translation helpers) into `server/hosted_event/http_forms.mjs` so the account
  and organizer flows cannot drift on security-relevant behavior; the account
  routes were moved onto it with all prior account/session tests still green.
- Translations: the 45 new hosted keys were added to all 21 supported languages
  per the AGENTS.md localization invariant; only `en`/`zh-CN` are reachable on
  hosted pages (others fall back to `en` via strict matching).
- Code review (high) flagged two issues in the new code — both fixed: a
  misspelled `hosted.organizer_application_rejectd` log event, and the backend
  allowing a re-application after approval while the UI hid the form (now
  refused as `already_approved`). Review also surfaced pre-existing
  account-flow items from issues 02/03 (notably that `buildTokenUrl` trusts the
  client `Host`/`X-Forwarded-Host` header when building reset/verify links,
  which is a reset-link-poisoning risk); these are outside this ticket's scope
  and left for a dedicated hardening pass rather than changed here.

