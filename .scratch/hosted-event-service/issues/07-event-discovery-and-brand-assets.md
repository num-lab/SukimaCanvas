# 07 — Event 发现页与 Brand Asset

**What to build:** 让访问者从 Hosted 首页发现公开 Event，或通过不可枚举直达链接访问未列出 Event；Organizer 可以安全配置活动展示信息和有限类型的 Brand Asset。

**Blocked by:** 06 — Reservation 申请、审批与容量约束

**Status:** done

- [x] 首页只列出允许公开发现且处于可展示生命周期的 Event，不暴露未列出或取消的活动。
- [x] 未列出 Event 不出现在列表和索引中，但持有 Event Public ID 的访问者可以打开活动页。
- [x] Access Code 验证前，活动页只显示名称、Organizer 展示名、封面、时间和适当状态，不泄露容量、Participant 或管理员信息。
- [x] Organizer Owner/Admin 可以切换公开/未列出可见性并管理活动展示信息，越权用户不能修改。
- [x] Brand Asset 仅接受真实解码成功的 PNG、JPEG 或 WebP，单文件不超过 5 MiB；SVG、伪造 MIME、损坏图片和超限输入被拒绝。
- [x] 对象存储中的 Brand Asset 通过受控读取路径提供，不把内部对象键或任意上传内容变成可执行页面。
- [x] Node 集成测试覆盖发现规则和 hostile 文件；Playwright 覆盖公开列表、未列出直达和品牌展示。

## Comments

- Implemented on `develop`. Verified with `npm run typecheck`, `npm run lint`,
  `test-node/hosted_brand_asset.test.js` (9 image-decode/asset-store unit tests),
  `test-node/hosted_reservation_store.test.js` (+3 event lifecycle/discovery/display
  unit tests), `test-node/hosted_event_discovery.test.js` (4 integration tests through
  the composed server), and `playwright/tests/hosted-event-discovery.spec.ts` (1
  cross-page browser flow), plus the full `npm test` gate.
- Discovery: events are minted on reservation approval (issue 06). The homepage
  (`GET /`) lists only `visibility=public` events whose board-session window has
  not yet ended (`listPublicDiscoverableEvents`), soonest first; unlisted and
  ended events never appear. A pure `eventLifecycleState(event, now)` derives
  `scheduled | open | ended` from the service clock. Cancellation of an approved
  event is owned by issue 08; the discovery predicate already excludes any
  non-active lifecycle so that terminal state joins `ended` when it lands.
- Event page: `GET /events/{publicId}` resolves by the unguessable Public ID and
  renders only name, organizer display name, cover, times, and a lifecycle status
  badge — never capacity, seats, participants, or organizer members. An unknown
  Public ID is a plain 404 (`event.html` is `noindex`).
- Management: `GET/POST /organizers/{organizerId}/events/{eventId}` lets an
  Owner/Admin toggle public/unlisted visibility, edit the public tagline, and
  clear the cover; `POST .../events/{eventId}/cover` accepts a cover upload.
  Non-members 404, signed-out visitors redirect to login, all POSTs are CSRF- and
  rate-limited.
- Brand Assets: `server/hosted_event/assets/image_validation.mjs` really decodes
  the bytes — PNG (chunk walk + per-chunk CRC), JPEG (segment walk + SOF dims +
  EOI), WebP (RIFF/VP8·VP8L·VP8X) — ignoring the declared MIME entirely, so SVG,
  forged MIME, corrupt/truncated images, and >5 MiB inputs are all rejected.
  Uploads arrive as `multipart/form-data` through a small bounded parser
  (`assets/upload.mjs`). Validated bytes are stored by `assets/store.mjs` under an
  unguessable base64url id, outside the static web root, and served only through
  the controlled `GET /assets/{assetId}` path with the sniffed content type,
  `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`, and
  `Content-Security-Policy: default-src 'none'; sandbox` so an upload can never
  become an executable page and the internal object key is never exposed.
- Refactor: the service-timezone helpers shared by reservations and events moved
  to `server/hosted_event/service_time.mjs`.

