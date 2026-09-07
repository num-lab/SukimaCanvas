# 01 — Hosted Runtime Shell 与源码披露

**What to build:** 在不破坏现有 WBO 运行方式的前提下，为 SukimaCanvas 增加可独立启动的 Hosted Event Service 外壳。访问者能够看到本地化的服务首页，并能从页脚和登录后导航找到与当前部署版本对应的 AGPL Corresponding Source；后续 Hosted Event 功能统一从同一个服务组合边界接入。

**Blocked by:** None — can start immediately

**Status:** done

- [x] 现有 WBO 模式继续启动并通过现有 HTTP、Socket.IO 和浏览器回归测试，Hosted 模式不会改变其公开行为。
- [x] Hosted 模式通过现有服务器组合入口启动，HTTP 与 Socket.IO 共用同一个 Hosted Event Module 运行时，不形成第二套旁路服务器。
- [x] Hosted 首页至少提供自然的 `zh-CN` 与 `en` 内容；其他语言确定性回退为英语。
- [x] 页脚和登录后导航均提供 Source 入口，公开页面展示不可变部署版本、可获取的 Corresponding Source 与构建说明。
- [x] 当前部署版本无法映射到源码时，Source 页面明确失败而不是指向不确定或滚动更新的源码。
- [x] Node 集成测试通过真实服务器组合入口验证 Hosted/WBO 两种模式、语言回退和 Source 合同。

## Comments

- Implemented in `3b6f170` (domain docs / ADRs / issue tracker) and `ddd52e5`
  (Hosted Event Service shell with version-pinned source disclosure) on
  `develop`. Verified with `npm run typecheck`, `npm run lint`,
  `test-node/hosted_runtime.test.js` (5 tests), and the full `npm test` gate
  (387 Node tests, 65 Playwright tests). Code review found and fixed: a dead
  Source link in `client-data/index.html` (removed), a fragile static-fallback
  404 for legacy `/source` (now an explicit 404), a redundant
  `socket.hostedEventModule` assignment on connection, and README wording
  about rolling version labels.

