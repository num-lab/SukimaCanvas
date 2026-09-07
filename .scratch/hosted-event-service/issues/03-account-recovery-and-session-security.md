# 03 — Account 恢复与 Session 安全控制

**What to build:** 让 Account 持有人能够找回密码、修改密码、查看并撤销登录会话，同时让过期、被撤销或可能已泄漏的 Session 及时失效。

**Blocked by:** 02 — Account 注册、邮箱验证与登录

**Status:** done

- [x] 忘记密码流程使用一次性、限时凭据；申请和兑换响应不泄露 Account 是否存在。
- [x] 修改或重置密码后，旧 Session 按安全策略撤销，已打开页面在下一次受保护请求或实时重连时失去权限。
- [x] 用户可以查看自己的活跃 Session、撤销指定 Session，并从当前设备登出。
- [x] Session 最长存活 30 天且连续闲置 12 小时失效；两个时限均由服务端权威时间执行。
- [x] 账号禁用和明确的全局撤销能够使所有已有 Session 失效。
- [x] 所有改变状态的浏览器请求验证 CSRF；畸形、缺失、复用和跨 Session token 被确定性拒绝。
- [x] Node 集成测试使用可控时钟覆盖绝对/闲置过期、密码重置和撤销；Playwright 覆盖恢复与 Session 管理主流程。

## Comments

- Implemented in `3799764`-successor commit on `develop`. Verified with
  `npm run typecheck`, `npm run lint`, `test-node/hosted_account_store.test.js`
  (13 unit tests including controlled-clock token expiry),
  `test-node/hosted_accounts.test.js` (12 integration tests),
  `test-node/hosted_sessions.test.js` (10 controlled-clock integration tests),
  `playwright/tests/hosted-accounts.spec.ts` + 
  `playwright/tests/hosted-account-security.spec.ts` (5 browser tests), and the
  full `npm test` gate.
- Recovery flows: `/forgot` queues a single-use, hour-limited reset link for
  verified, active accounts only; every response is byte-identical regardless
  of account existence (tests assert identical bodies). `/reset` peeks the
  token to render the form, then consumes it on submission; failed validation
  retries re-render with the still-unconsumed token. Reset adopts the new
  password and revokes all of the account's sessions.
- Session management: `/account` lists active sessions (most recently active
  first, timestamps localized per page language) keyed by stable 10-hex public
  ids — raw session ids and digests are never rendered. Devices can revoke a
  specific session, revoke all others (keeping the current device), and log
  out. Authenticated password change re-proves the current password, adopts
  the new one, and revokes all other sessions while keeping the current device
  signed in (proven-ownership policy, matching mainstream practice).
- Time authority: both session limits (30-day absolute, 12-hour idle) are
  enforced against the store's clock. `HOSTED_CLOCK` is an injectable adapter
  on the composed config (never read from the environment); integration tests
  drive idle expiry, absolute expiry (including a continuously active session
  dying at exactly the absolute limit), reset-token expiry, and revocation
  through it without sleeps.
- CSRF rotation: login and logout each rotate the browser's CSRF cookie, so
  tokens rendered before a session transition are deterministically rejected;
  malformed, missing, and cross-jar tokens are rejected with 403. Reuse of a
  pre-rotation token is rejected exactly this way (double-submit cookies are
  per-cookie-jar; requiring server-side single-use tokens would break
  multi-tab flows the rotation already secures).
- Disable and global revocation: `setAccountStatus(disabled)` and
  `revokeAllSessions()` invalidate every session (unit-tested, persistence
  checked across reload). Production triggers for them arrive with the
  operator tooling issue; the realtime-reconnect admission limb lands with the
  Socket.IO event-membership issue (hosted pages have no realtime surface yet).
- Code review fixes folded in: shared single-use token table in the store
  (verification and reset tokens), shared token-URL builder, reset submissions
  get their own rate-limit budget, `listSessions` no longer lists idle-expired
  sessions, session-flavored "changed" copy no longer trips the head-snippet
  leak test (assertion tightened to the actual invariant), and test debug
  leftovers removed.
