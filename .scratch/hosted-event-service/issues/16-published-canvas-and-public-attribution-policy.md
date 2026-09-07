# 16 — Published Canvas 与公开作者策略

**What to build:** 让 Organizer 从 Private Archive 派生可撤回、净化后的只读 Published Canvas，并按受众和 Participant 匿名选择决定是否展示 Event-scoped Participant Identifier。

**Blocked by:** 15 — 归档失败恢复与幂等重试

**Status:** done

- [x] Owner/Admin 可以选择不发布或创建 Published Canvas，发布永远从成功的 Private Archive 派生，不直接暴露权威原始 SVG。
- [x] Publication Audience 支持 Organizer-only、Event Membership-only 和持有不可枚举链接三种模式，并在每次读取时执行权限检查。
- [x] Published Canvas 只读且不被搜索引擎索引，不包含邮箱、内部 Account/Board Session 标识、Change Audit、私有对象键或可复用入场凭据。
- [x] 只有 Organizer 开启公开归属且 Participant 在关闭前未选择匿名时，相关 Board Item 才显示 Event-scoped Participant Identifier。
- [x] Participant 的匿名选择作用于其全部既有和未来 Board Item；Published Canvas 中不留下可反向关联匿名 Participant 的隐藏 metadata。
- [x] Owner/Admin 撤回发布后，全部受众和旧分享链接立即失效；重新发布不意外复用已撤回的公开能力。
- [x] 隐私集成测试检查净化产物；Playwright 覆盖三种受众、公开归属、匿名和撤回流程。

## Comments

- Implementation: `server/hosted_event/publication/canvas.mjs` (pure
  sanitizer: envelope parse → per-item keep/strip of `data-wbo-created-by` →
  rebuild with `data-wbo-readonly="true"`; keep-decision is an allow-list of
  "identified" Presentation Choices projected through
  `participantIdentifierFor`, so anonymous/banned/unknown creators fail safe
  to no identifier) and `server/hosted_event/publication/store.mjs` (durable
  publication records; derived artifacts put immutably under
  `published-canvases/<boardSessionId>/<generation>.svg` in the shared
  archive store; monotonic generation, unchanged content reuses the object;
  link audience mints a fresh 128-bit token on every publish, stored as a
  SHA-256 digest and revealed exactly once).
- Routes live with the sibling event management flows in
  `server/hosted_event/events/routes.mjs` (publish/update, revoke, and the
  public read); `GET /events/{publicId}/canvas[/{token}]` re-checks the
  audience against the live record on every read and renders one uniform 404
  (`published_canvas_not_found`) for every refusal. The page template is the
  hosted shell with inline sanitized SVG, a contributors list derived only
  from identifiers present on the artifact, `noindex` meta and
  `X-Robots-Tag`, `no-store` via the hosted template.
- Publish requires the session `closed` with an archive key
  (`advanceEventLifecycle` runs first, so a publish attempt also completes a
  due close); the archive-failed state therefore admits no publication.
  Revocation drops the stored digest so the revoked capability does not
  survive at rest; republishing always re-derives and never resurrects old
  tokens or generations.
- Tests: `test-node/hosted_publication_canvas.test.js` (sanitizer units,
  including hostile text content that mentions the attribute name),
  `test-node/hosted_publication_store.test.js` (policy updates, rotations,
  revocation, idempotent retry after a crash between object write and record
  persist), `test-node/hosted_publication_privacy.test.js` (socket fixture:
  two members, one anonymous, close, publish, artifact assertions plus
  audience checks against the real route handlers),
  `test-node/hosted_published_canvas.test.js` (full HTTP integration with an
  injected service clock: three audiences, noindex headers, revocation, fresh
  link on republish, legacy-mode 404), and
  `playwright/tests/hosted-published-canvas.spec.ts` (browser end to end:
  join, go anonymous, draw, close, publish, attribution display, audience
  switches, share link, revoke).
