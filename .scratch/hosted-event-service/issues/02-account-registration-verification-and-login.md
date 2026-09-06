# 02 — Account 注册、邮箱验证与登录

**What to build:** 让中国大陆首发地区的成年访问者创建 Account、验证邮箱并安全登录 Hosted Event Service，从而获得可跨设备使用的可信 Participant 身份。

**Blocked by:** 01 — Hosted Runtime Shell 与源码披露

**Status:** done

- [x] 注册要求用户确认已满 18 周岁，并对规范化邮箱执行确定性的唯一性检查。
- [x] 密码只以合适的密码散列保存；HTTP 响应、日志和邮件均不泄露密码、散列或验证凭据。
- [x] 注册产生一次性邮箱验证流程；无效、已使用或过期凭据被确定性拒绝，且不能使进程崩溃。
- [x] 只有邮箱已验证且未禁用的 Account 可以登录；失败响应不泄露邮箱是否已注册。
- [x] 登录创建持久服务端 Session，浏览器 cookie 使用 `Secure`、`HttpOnly` 和 `SameSite=Lax` 的生产安全属性。
- [x] 注册、验证、登录和登出页面提供自然的 `zh-CN` 与 `en` 文案，所有可见字符串走既定本地化机制。
- [x] 注册与登录入口同时按 Account/IP 限速，并通过可配置 CAPTCHA 合同抵抗自动化滥用。
- [x] Node 集成测试覆盖成功和 hostile 输入；Playwright 覆盖从注册到验证、登录和登出的完整浏览器流程。

## Comments

- Implemented on `develop`. Verified with `npm run typecheck`, `npm run lint`,
  `test-node/hosted_account_store.test.js` (10 unit tests),
  `test-node/hosted_accounts.test.js` (12 integration tests through the real
  composition entry), `playwright/tests/hosted-accounts.spec.ts` (2 browser
  tests), and the full `npm test` gate.
- Storage seam: the first release keeps account state in JSON files under
  `WBO_HOSTED_DATA_DIR` behind a single store seam
  (`server/hosted_event/accounts/store.mjs`); verification tokens and session
  ids are persisted only as SHA-256 digests. This satisfies the behavior
  contract (durable across restarts, atomic writes, serialized writes) until
  the PostgreSQL adapter lands with the ledger workstream.
- Mail seam: verification mail is queued as JSON files in
  `WBO_HOSTED_MAIL_OUTBOX_DIR` (default `<WBO_HOSTED_DATA_DIR>/mail-outbox`)
  until the mail vendor is selected; tests read the outbox through the real
  interface rather than injecting a capture adapter.
- CAPTCHA contract: `server/hosted_event/accounts/captcha.mjs` exposes a
  vendor-shaped contract (`required`/`siteKey`/`fieldName`/`verify`) with the
  existing Turnstile configuration as the first implementation; unset
  `TURNSTILE_SECRET_KEY` disables it.
- Re-registering an email whose account is still unverified refreshes the
  password to the latest submission and replaces the outstanding verification
  token (the account is unusable either way, so no privilege change);
  registering an already-verified email deterministically returns 409.
- Disable semantics: `setAccountStatus(accountId, "disabled")` revokes all of
  that account's sessions, satisfying the spec's session-revocation contract
  before operator tooling arrives. There is no public disable interface yet,
  so the contract is covered at the store seam.
- Code review accepted the verification token traveling in the verify URL
  query (the industry norm for email links; the app's own logs record
  pathname only) and mitigated onward leakage with `Referrer-Policy:
  no-referrer` on all hosted pages. Translation catalogs carry the new keys in
  all 21 supported languages per the AGENTS.md localization invariant (only
  `en`/`zh-CN` are reachable on hosted pages; the rest fall back to `en`).
