# 19 — API Credential 与单次 Entry Grant

**What to build:** 让 Organizer 后端安全地把已登录 Participant 从自有网站跳转到目标 Event，而不把 API 密钥或长期访问凭据交给浏览器。

**Blocked by:** 05 — Organizer 成员邀请与角色权限；09 — Access Code 入场与 Event Membership

**Status:** done

- [x] Organizer Owner 可以创建、轮换、查看元数据和撤销 API Credential；完整 secret 只在创建或轮换时显示一次，之后不能恢复。
- [x] Credential 只可访问所属 Organizer 已授权的集成 Interface，越权 Event、Reservation、Participant 和其他 Organizer 请求被拒绝。
- [x] Organizer 后端可以用 Credential 与 External Participant Reference 请求 10 分钟有效的 Entry Grant；Reference 不得携带或冒充 Account 身份。
- [x] Participant 必须先完成 Hosted Account 登录，Entry Grant 才能兑换为对应 Event 的准入；Event Ban、Event Lock、生命周期和容量规则仍然优先。
- [x] Entry Grant 只经 URL fragment 传递，由浏览器通过 HTTPS `POST` 单次兑换，成功、失败或过期后立即清除 fragment。
- [x] Grant 过期、重复兑换、撤销 Credential、错误 Organizer scope 和畸形输入均确定性失败，且不出现在普通访问日志、referrer 或 query/path 中。
- [x] Node 集成测试覆盖 Credential 生命周期、scope、单次语义和 hostile 输入；Playwright 覆盖从 Organizer 网站跳转、登录、兑换到 Event 的流程。

## Comments

- Implemented with `npm run typecheck`, `npm run lint`,
  `test-node/hosted_integration_credentials.test.js` (7 unit tests over the
  token primitives and the integration store, including restart persistence),
  `test-node/hosted_entry_grants.test.js` (9 integration tests through the
  real composition entry: Owner-only credential lifecycle, API auth/scope,
  grant creation payloads, single-use/expiry/revocation/lock/lifecycle/ban
  redemption, rate limits, hostile bodies), and
  `playwright/tests/hosted-entry-grants.spec.ts` (1 browser test covering the
  fragment jump, fragment clearing, login-first redemption, and single-use
  reuse rejection). Full `npm test` gate run before commit.
- Storage: new `server/hosted_event/integrations/` module —
  `credentials.mjs` (pure token/digest/reference helpers),
  `store.mjs` (`api_credentials.json` + `entry_grants.json` in the shared
  hosted data dir, same in-memory index + serialized write queue pattern as
  the other hosted stores; only SHA-256 digests are persisted), and
  `routes.mjs` (the two API endpoints plus browser redemption). The bearer
  value is `<credentialId>.<secret>` with a 256-bit base64url secret;
  authentication is strictly read-only. Credential metadata (id, created,
  last rotated, revoked, status) renders in an Owner-only section of the
  organizer manage page with audit records in the existing organizer activity
  log (`organizer_credential.created|rotated|revoked` via a new public
  `organizerStore.appendAudit`).
- Integration API surface: exactly `GET /api/v1/events/{publicId}` (lifecycle
  status + times, lifecycle advanced before reporting) and
  `POST /api/v1/events/{publicId}/entry-grants` (returns a root-relative
  `entryGrantPath` whose fragment carries the token, `expiresAtMs`, and the
  echoed reference). Responses are JSON with `no-store` +
  `Referrer-Policy: no-referrer`; malformed JSON bodies, wrong media types,
  oversized payloads, and bad references are deterministic machine-readable
  errors. The integration API exists only in hosted mode (same wrapper 404 as
  the other hosted pages).
- Redemption: `POST /events/{publicId}/entry-grant` requires the hosted
  session (401 otherwise, checked before CSRF so a mid-flow session expiry
  tells the client to re-authenticate), the CSRF pair, and per-Account/per-IP
  rate limits. Eligibility (Event Ban, Entry Lock, open session, cancelled)
  is checked before the grant is consumed, so hostile or too-early attempts
  never burn a grant; the check-and-consume itself is synchronous in the
  store, so one grant redeems exactly once. Existing members redeem
  successfully without touching their membership or anonymity choice; grant
  admission defaults to identified attribution (switchable on the event page).
  Every terminal failure is one uniform `{error: "entry_grant_invalid"}` 400.
- Browser flow: the organizer backend redirects to
  `/events/{publicId}#entryGrant=<token>`; a small deferred script
  (`client-data/hosted-entry-grant.js`, wired by an anchor div in
  `event.html`) reads the fragment, clears it immediately with
  `history.replaceState`, and POSTs once. Signed-out visitors keep the token
  in per-tab `sessionStorage` (never a URL) until Hosted Account login
  completes, then the next visit to the event page redeems automatically.
  Success/failure/expiry all navigate to a clean event URL (failures carry
  `?notice=grant_invalid`, translated in all 21 languages like the other new
  keys). Fragments structurally never reach server logs; pages already send
  `Referrer-Policy: no-referrer`, and the token never appears in query, path,
  or observation fields.
- Config additions in [server/configuration.mjs](./server/configuration.mjs):
  `WBO_HOSTED_ENTRY_GRANT_TTL_MS` (default 10 min),
  `WBO_HOSTED_ENTRY_GRANT_ATTEMPTS_*` (redemption),
  `WBO_HOSTED_API_ENTRY_GRANT_*` (per-credential creation), and
  `WBO_HOSTED_CREDENTIAL_ATTEMPTS_*` (mint/rotation; revoke is deliberately
  unlimited so a leaked credential can always be killed immediately).
- Review outcomes: an External Participant Reference carrying control
  characters is now deterministically rejected (`invalid_external_reference`)
  rather than silently rewritten, keeping the "malformed input fails
  deterministically" contract strict. The redemption ordering is deliberate:
  the grant is marked redeemed synchronously before membership admission runs,
  because single-use must hold absolutely while admission is idempotent — the
  reverse order could admit twice. The route-level checks (Event Ban, Entry
  Lock, open session) run *before* consumption so hostile or too-early
  attempts never burn a grant. A redeemed grant yields Event Membership — the
  same thing an Access Code yields — never a Participant Seat; seat capacity
  keeps governing Board Session entry through the admission module exactly as
  it does for Access Code admission (the membership/seat split is the
  established issue 09/10 model). The API answers with a root-relative
  `entryGrantPath` because the service cannot know its public origin behind
  proxies; the organizer prefixes the same origin it already targets with API
  calls.
- Scope note: "scope" is organizer-level by design — each credential is bound
  to its Organizer and the integration interface is exactly the two endpoints
  above; fabricated resource types (Reservation, Participant) are not part of
  the interface and fall through to deterministic 404/400s. Per-permission
  scope flags can be layered onto the credential record when a second
  integration surface actually exists.
- Known scaling note (for the PostgreSQL migration the platform spec already
  plans): `entry_grants.json` keeps every grant record — volume is low (one
  row per participant entry through an organizer site) but unbounded, mirroring
  the file-store pattern shared with the other hosted stores.
- Deferred by design: Event Ban injection in tests writes the membership
  store's file and reboots the composed app (the moderation UI arrives with
  issue 13); the ban-precedence contract itself is asserted end to end
  through the real redemption route.
