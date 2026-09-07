# 26 — 真实 SMTP 邮件投递

**What to build:** 让 Lifecycle Notice 真正发得出去。此前唯一的投递适配器是文件外发箱，账号验证、密码重置、Organizer Invitation 和活动生命周期通知都只写成 JSON 文件，等人工搬运；部署到服务器后没人能完成注册验证。首版供应商选定 Cloudflare Email Service，但适配器保持供应商无关。

**Blocked by:** 20 — 活动生命周期邮件通知

**Status:** done

- [x] 存在一个真实的 SMTP 投递适配器，通过隐式 TLS 认证提交，凭据来自部署配置而非代码。
- [x] 供应商可替换：host、port、用户名、口令、发件地址全部为配置项，默认值指向 Cloudflare Email Service，换供应商不需要改代码。
- [x] 配置不完整时在组合期 fail closed（缺发件地址或口令即拒绝启动），不得带着"发不出邮件"的状态接受注册。
- [x] 未配置供应商的部署保持文件外发箱行为不变，邮件不丢。
- [x] 凭据不出现在任何错误、日志或运营台面上；失败携带供应商的 SMTP 应答码供运维定位。
- [x] 失败抛出，由既有 notice 队列按退避重试并在运营台可见；投递问题不影响触发它的状态变更。
- [x] 中文主题按 RFC 2047 正确编码，正文按 UTF-8 完整送达；崩溃后重投使用同一 Message-ID。
- [x] Node 测试以真实 SMTP 协议对本地 stub 断言线上实际字节：AUTH、信封、编码、稳定 Message-ID、拒绝路径、fail-closed 配置。

## Comments

- 2026-09-06（agent）：已交付。新增 `server/hosted_event/accounts/smtp_mail.mjs`，`mail.mjs` 增加 `createMailDelivery` 选择器（`WBO_HOSTED_MAIL_TRANSPORT=outbox|smtp`，默认 `outbox`）。决策记入 `docs/adr/0010-send-notices-through-a-portable-smtp-vendor.md`，配置与首次部署步骤记入 `docs/operations/deployment.md`。
- 选择 SMTP 而非 Cloudflare REST API 的理由：首发地区为中国大陆，境外发送端点的可达性与对国内邮箱服务商的送达率是整个设计里最不确定的部分，发信供应商因此是最可能被替换的组件。SMTP 适配器换供应商只改配置；REST 适配器锁定 Cloudflare。代价是引入 `nodemailer`（MIT-0，零运行时依赖）——它负责的正是容易出错的部分：21 种语言的 RFC 2047 主题编码、UTF-8 正文编码、dot-stuffing、隐式 TLS 下的 AUTH 流程。
- 安全取舍：`WBO_HOSTED_SMTP_TLS` 允许关闭 TLS，但适配器只在 host 为回环地址时接受，其他一律拒绝启动。这样测试能跑真实 SMTP 协议而凭据永远不会明文离开本机。
- 每封一条连接。单实例每场活动只发少量邮件，队列本身已串行化并重试，逐封连接不会像常驻连接那样腐化或泄漏描述符（参见票 25）。
- 未验证项（需要真实账号和域名）：Cloudflare 侧的域名 onboarding、SPF/DKIM/DMARC 记录生效、以及**从中国大陆服务器到 `smtp.mx.cloudflare.net:465` 的实际可达性与对 QQ/163/126 等国内邮箱的送达率**。前者按 Cloudflare 文档操作即可；后者是这次选型的主要风险，部署测试时应实测并记入 `launch-evidence.md`。Cloudflare Email Sending 目前是 Beta，且仅限事务性邮件（本服务的用途正好符合）。
