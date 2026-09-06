# 21 — 签名 Webhook 与可靠 Outbox

**What to build:** 让 Organizer 订阅 Event 生命周期 webhook，并以 HMAC、稳定事件标识、至少一次投递和可恢复重试把归档与活动状态可靠传回租用方网站。

**Blocked by:** 15 — 归档失败恢复与幂等重试；19 — API Credential 与单次 Entry Grant；20 — 活动生命周期邮件通知

**Status:** done

- [x] Organizer Owner 可以创建、查看、轮换 secret 和撤销 Webhook Subscription；非 Owner 不能读取或替换 HMAC secret。
- [x] Webhook 仅发送 `event.opened`、`event.closed`、`archive.ready` 和 `archive.failed` 等已定义事件，payload 不含邮箱、原始 SVG、Access Code 或私有对象凭据。
- [x] 每次投递带稳定 Event ID、事件类型、时间和签名；接收方可以用 HMAC 验证来源并安全去重。
- [x] 投递由 durable outbox 驱动，至少一次发送；超时、网络错误和非成功响应按退避策略最多重试 24 小时。
- [x] 24 小时后仍失败的 Subscription 被暂停并通知 Organizer Owner；修复后可恢复，不丢失已产生的事件记录。
- [x] 无效 URL、超时响应、恶意响应体和重复投递不会使后台 worker 或主服务崩溃，secret、签名材料和内部地址不进入日志。
- [x] Node 集成测试覆盖签名、重放、去重、重试、暂停、恢复和重启；使用受控接收端验证 Organizer scope 隔离。

