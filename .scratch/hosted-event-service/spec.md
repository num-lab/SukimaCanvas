# SukimaCanvas Hosted Event Service

Status: ready-for-agent

## Problem Statement

WBO 当前是一个以匿名浏览器身份、任意画板名和直接 SVG 持久化为中心的协作画板。它不能让 Organizer 申请并预约有容量保证的 Board Session，不能要求 Participant 注册后通过 Access Code 进入 Event，也不能为 Organizer 提供持久的成员权限、Event Ban、归档、导出和外部网站接入能力。

SukimaCanvas 需要把现有实时画板引擎包装成中国大陆首发的托管活动服务：Organizer 可预约并管理 Event；Participant 以 Account 加入；每个 Board Item 有可信的 Item Attribution；活动关闭后产生私有 Board Archive、可控的 Published Canvas 与去身份化 Image Export；同时不允许旧 WBO 路由、原始 SVG 或直接 Socket.IO 连接绕过平台规则。

## Solution

建立一个围绕 WBO 引擎的 Hosted Event Module。该 Module 以 HTTP 与 Socket.IO 作为唯一公开 Interface，统一协调 Account、Organizer、Reservation、Event、Board Session、Event Membership、Participant Seat、Access Code、Entry Grant、Event Ban、Change Audit 和 Board Archive。

平台使用 PostgreSQL 保存业务状态、会话、Capacity Allocation、持久变更账本和审计；使用 S3-compatible object storage 保存 SVG 快照、归档、净化后的 Published Canvas、Brand Asset 和 PNG Image Export。WBO 保留为实时绘图与协作引擎，但不再拥有公开的画板发现、访问控制或最终权威历史。

参与者从首页选择公开 Event 或通过未列出 Event 的链接到达活动页，完成登录并提交 Access Code 后获得 Event Membership。Organizer 的后端可使用 API Credential 兑换短时单次的 Entry Grant，使已登录 Participant 从 Organizer 网站安全跳转到目标 Event。所有实时连接和持久写入都再次验证 Event 生命周期、Membership、Participant Seat、Event Ban 和权限；服务端在接纳写入时注入 Item Attribution 与 Change Audit，不信任客户端提交作者信息。

## User Stories

1. 作为首次访问者，我希望创建并验证 Account，以便以可信身份参加 Event。
2. 作为 Participant，我希望使用验证邮箱和密码登录，以便跨设备保留自己的活动资格。
3. 作为 Participant，我希望重置忘记的密码，以便不会因凭据遗失错过 Event。
4. 作为 Account 持有人，我希望登出或修改密码后旧会话失效，以便保护自己的活动访问权。
5. 作为首次注册者，我希望确认自己已满 18 周岁，以便服务在首发地区维持明确的使用边界。
6. 作为 Participant，我希望首页展示可发现的公开 Event，以便选择想参加的活动。
7. 作为 Participant，我希望通过直接链接访问未列出 Event，以便 Organizer 可以私下分发活动入口。
8. 作为 Participant，我希望活动页只展示必要的名称、主办方展示名、封面、时间和状态，以便在输入 Access Code 前不泄露容量、参与者或管理员信息。
9. 作为 Participant，我希望输入正确 Access Code 后获得 Event Membership，以便进入对应 Board Session。
10. 作为 Participant，我希望错误 Access Code 不泄露 Event 是否存在，以便活动入口不会成为枚举接口。
11. 作为 Participant，我希望通过 Access Code 获得资格而不是匿名身份，以便我的 Board Item 有可信归属。
12. 作为 Participant，我希望刷新页面或短暂断线后无需重新输入 Access Code，以便稳定参加活动。
13. 作为 Participant，我希望在所有写入连接断开十分钟内保留 Participant Seat，以便网络波动后可以重新加入。
14. 作为 Participant，我希望同一场活动只保留一个可写连接，其他标签页或设备只读，以便不会重复占用容量。
15. 作为 Participant，我希望在 Event 仍有空闲 Participant Seat 时重新进入，以便在重连宽限期过后仍可继续活动。
16. 作为 Participant，我希望在 Event 已满时看到明确的等待或容量提示，以便理解无法进入的原因。
17. 作为 Participant，我希望在首次进入时选择是否在 Published Canvas 中显示自己的 Participant Identifier，以便控制公开归属。
18. 作为 Participant，我希望之后随时切换为匿名，以便撤回公开展示的 Participant Identifier。
19. 作为 Participant，我希望匿名选择隐藏我在整个 Published Canvas 中的所有既有和未来 Board Item 标识，以便公开作品不会保留反向识别线索。
20. 作为 Participant，我希望 Board Session 关闭后不能再改变匿名选择，以便归档结果稳定。
21. 作为 Participant，我希望在活动关闭后看到只读的完成说明，以便知道为何不能继续绘制。
22. 作为 Participant，我希望在自己已经进入过的 Event 取消或关闭时收到必要通知，以便了解活动状态变化。
23. 作为 Participant，我希望举报当前在线的另一位 Participant，以便 Event Moderator 可以处理不当行为。
24. 作为被 Event Ban 的 Participant，我希望被清楚告知无法继续进入该 Event，以便理解访问受限的范围。
25. 作为 Organizer 申请者，我希望提交 Organizer Application，以便申请成为可预约活动的 Organizer。
26. 作为 Platform Operator，我希望审核、批准或拒绝 Organizer Application，以便避免未审核主体占用平台资源。
27. 作为 Organizer Owner，我希望邀请 Account 加入 Organizer，以便分担预约、活动和归档管理。
28. 作为受邀 Account，我希望主动接受未过期的 Organizer Invitation，以便不会被无意加入某个 Organizer。
29. 作为 Organizer Owner，我希望授予或撤销 Organizer Admin，以便控制组织级管理权限。
30. 作为 Organizer Owner，我希望管理 API Credential 和 Webhook Subscription，以便安全集成自己的网站。
31. 作为 Organizer Owner 或 Organizer Admin，我希望创建 Reservation 草稿，以便准备活动名称、时间、容量、可见性和 Brand Asset。
32. 作为 Organizer Owner 或 Organizer Admin，我希望提交 Reservation 审批，以便请求一个有容量保证的 Board Session。
33. 作为 Platform Operator，我希望在审批时查看重叠 Capacity Allocation，以便不确认超过 20 个 Board Session 或 1,000 Participant Seat 的请求。
34. 作为 Platform Operator，我希望只确认 1 至 50 个 requested Participant Seat 的 Reservation，以便维持单场活动安全上限。
35. 作为 Organizer Owner 或 Organizer Admin，我希望得到 Reservation 批准、拒绝、开始、归档完成和失败通知，以便及时采取行动。
36. 作为 Organizer Owner 或 Organizer Admin，我希望为已提交或已确认的 Reservation 提交 Reservation Change Request，以便申请改期、延期、改容量或取消。
37. 作为 Platform Operator，我希望审核影响容量的 Reservation Change Request，以便保持已确认 Capacity Allocation 的可信承诺。
38. 作为 Organizer Owner 或 Organizer Admin，我希望取消未来 Event，以便立即停止新入场并释放未来容量。
39. 作为 Organizer Owner 或 Organizer Admin，我希望在 Event 开始前十五分钟进入 Preparation Window，以便准备 Board Session。
40. 作为 Event Moderator，我希望在 Preparation Window 和开放期间进入被分配的 Event，以便实时协助 Organizer。
41. 作为 Participant，我希望只在计划开始后进入普通 Board Session，以便 Organizer 有受保护的准备时间。
42. 作为 Organizer Owner 或 Organizer Admin，我希望配置 Event Visibility 为公开或未列出，以便控制活动发现方式。
43. 作为 Organizer Owner 或 Organizer Admin，我希望管理共享 Access Code 并在泄漏时轮换它，以便阻止后续未授权入场。
44. 作为 Organizer Owner 或 Organizer Admin，我希望轮换 Access Code 不影响已获 Event Membership 的 Participant，以便安全处置不打断正常活动。
45. 作为 Organizer Owner 或 Organizer Admin，我希望启用 Event Lock，以便紧急暂停所有新入场而不强制移除当前 Participant。
46. 作为 Event Moderator，我希望警告、踢出、Event Ban 或解除 Event Ban，以便维护单场 Event 秩序。
47. 作为 Event Moderator，我希望对处理行为填写原因并看到事件内的 Participant Identifier 与冻结展示名，以便负责地执行管理。
48. 作为 Organizer Owner 或 Organizer Admin，我希望可以分配 Event Moderator，以便把实时治理权限定在具体 Event。
49. 作为 Organizer Owner 或 Organizer Admin，我希望清空 Board Session 时保留 Change Audit，以便破坏性操作可追责。
50. 作为 Participant，我希望使用既有 Pencil、Straight Line、Rectangle、Ellipse、Text、Eraser、Hand、Grid、Zoom 和 Cursor 工具，以便维持 WBO 的核心绘图体验。
51. 作为 Participant，我希望没有 Download 工具和原始 SVG 下载入口，以便作者归属与私有归档不会被绕过。
52. 作为 Participant，我希望所有持久 Board Item 由服务端关联我的 Account，以便无法伪造作者。
53. 作为 Organizer Owner 或 Organizer Admin，我希望看到每个 Board Item 的 Participant Identifier 和该场次冻结展示名，以便在不暴露邮箱的前提下管理贡献。
54. 作为 Organizer Owner 或 Organizer Admin，我希望查看创建、编辑、移动、复制、删除和清空的 Change Audit，以便在 90 天归档期内调查问题。
55. 作为 Participant，我希望移动或编辑 Board Item 不会篡改其原始 Item Attribution，以便作品创建者保持可信。
56. 作为 Participant，我希望复制 Board Item 时新项目归属于复制者并保留来源关系，以便复制行为可审计。
57. 作为 Organizer Owner 或 Organizer Admin，我希望在计划结束前获得关闭提示，以便提醒 Participant 完成创作。
58. 作为系统，我希望 Board Session 进入 CLOSING 后立即拒绝新持久写入，以便最终归档有确定边界。
59. 作为系统，我希望在 CLOSED 前排空已接纳的变更、持久化账本并核对快照，以便不丢失已接受的创作。
60. 作为系统，我希望归档失败时保持可恢复的失败状态并通知 Platform Operator 与 Organizer，以便不把失败伪装成成功关闭。
61. 作为 Organizer Owner 或 Organizer Admin，我希望关闭后的 Board Session 不可重新编辑，以便 Board Archive 是不可变成果。
62. 作为 Organizer Owner 或 Organizer Admin，我希望在需要继续创作时创建新的 Board Session，而不是重开已关闭归档，以便保留审计边界。
63. 作为 Organizer Owner 或 Organizer Admin，我希望即使空白 Event 也有 Board Archive 记录，以便审批、活动和审计历史完整。
64. 作为 Organizer Owner 或 Organizer Admin，我希望选择是否发布 Published Canvas，以便控制成果展示。
65. 作为 Organizer Owner 或 Organizer Admin，我希望将 Published Canvas 限定为仅 Organizer、仅 Event Membership 或持有不可猜链接的访问者，以便控制受众。
66. 作为公开链接访问者，我希望只能查看净化后的只读 Published Canvas，以便不会接触原始 SVG、审计或私有作者数据。
67. 作为 Organizer Owner 或 Organizer Admin，我希望在 Publication Policy 允许且 Participant 未匿名时显示 Participant Identifier，以便展示贡献而不公开 Account 信息。
68. 作为 Organizer Owner 或 Organizer Admin，我希望随时撤回 Published Canvas，以便停止后续公开访问。
69. 作为 Organizer Owner 或 Organizer Admin，我希望异步请求 Image Export，以便大画布 PNG 渲染不会阻塞页面请求。
70. 作为 Organizer Owner 或 Organizer Admin，我希望 Image Export 使用白色背景、内容边界和留白、最长边 8192 像素，以便获得可用的普通图片。
71. 作为 Organizer Owner 或 Organizer Admin，我希望 Image Export 从不包含 Participant Identifier、Item Attribution、Change Audit 或其他内部元数据，以便安全分享。
72. 作为 Organizer Owner 或 Organizer Admin，我希望下载链接只在 24 小时内有效，以便降低导出文件长期暴露风险。
73. 作为 Organizer Owner 或 Organizer Admin，我希望在 Board Archive、Item Attribution 和 Change Audit 的 90 天保留期内查看受权内容，以便处理活动后事务。
74. 作为 Organizer Owner 或 Organizer Admin，我希望提前删除活动成果后有 7 天可恢复期，以便防止误删。
75. 作为注销 Account 的 Participant，我希望公开归属变为不可反推的已注销身份，以便不再公开暴露个人资料。
76. 作为 Platform Operator，我希望在归档到期后统一清除 Board Archive、Item Attribution 和 Change Audit，以便不无限保留数据。
77. 作为 Organizer 后端，我希望以 API Credential 创建一次性 Entry Grant，以便将已登录 Participant 从自己的网站跳转到 Event。
78. 作为 Organizer 后端，我希望 Entry Grant 十分钟失效且只能兑换一次，以便减少跳转凭据泄漏风险。
79. 作为 Organizer 后端，我希望可选地附带 opaque External Participant Reference，以便关联自己的记录而不冒充 Participant 身份。
80. 作为 Participant，我希望 Entry Grant 只经 URL fragment 传递并在兑换后清除，以便不进入普通访问日志、referrer 或持久历史。
81. 作为 Organizer Owner，我希望创建、轮换、过期和撤销 API Credential，以便最小化集成密钥泄漏影响。
82. 作为 Organizer 后端，我希望查询 Event 生命周期状态，以便更新自己的网站体验。
83. 作为 Organizer 后端，我希望订阅签名 webhook，以便获知 `event.opened`、`event.closed`、`archive.ready` 和 `archive.failed`。
84. 作为 Organizer 后端，我希望 webhook 带稳定事件标识，以便安全处理至少一次投递中的重复。
85. 作为 Organizer Owner，我希望 webhook 持续失败后被暂停并收到通知，以便修复接收端。
86. 作为 Platform Operator，我希望使用独立控制台处理 Organizer Application、Reservation、容量、归档失败、禁令和恢复任务，以便不把运营工作塞进画板工具栏。
87. 作为 Organizer Member，我希望使用独立控制台处理成员、Reservation、Event、整合、审计、归档和导出，以便不干扰实时绘图。
88. 作为系统，我希望在重启后恢复到期或未完成的生命周期、导出、通知和 webhook 工作，以便不依赖进程内定时器。
89. 作为 Platform Operator，我希望看到容量、加载、连接、保存、归档和任务失败信号，以便在承诺无法满足前介入。
90. 作为 Platform Operator，我希望以数据库持久变更账本恢复最近 SVG 快照之后的已接纳写入，以便实现 RPO 不超过 5 秒。
91. 作为 Platform Operator，我希望在服务故障后于 15 分钟内恢复活动能力，以便满足首版 RTO 目标。
92. 作为 Platform Operator，我希望显式导入选定的历史 WBO SVG 为 Historical Archive，以便保留旧成果而不伪造作者或审计。
93. 作为 Platform Operator，我希望 Historical Archive 保持私有并标记未知作者，以便与有可信 Item Attribution 的新归档区分。
94. 作为服务用户，我希望在页脚和登录后菜单获取当前部署版本的 Corresponding Source，以便满足 AGPL 网络服务义务。
95. 作为 Participant，我希望服务条款说明 Organizer 的公开责任和内容授权范围，以便理解 Board Archive 与 Published Canvas 的使用方式。
96. 作为 Organizer，我希望 Brand Asset 仅接受经过验证的 PNG、JPEG 或 WebP，以便避免任意文件和 SVG 带来的安全风险。
97. 作为服务用户，我希望首版服务页提供 `zh-CN` 和 `en`，以便在不虚假承诺全部 WBO 语言已完成服务化翻译的前提下使用平台。

## Implementation Decisions

- 构建一个深的 Hosted Event Module。其 Interface 是面向浏览器、Organizer 后端和 Socket.IO 客户端的实际 HTTP/实时协议，而不是一组按领域对象拆分的浅 facade。该 Module 负责将平台规则与 WBO 实时引擎协调在一起。
- 以现有服务器组合入口作为唯一主测试 seam。新 Module 由该入口装配，HTTP 请求和 Socket.IO 握手、持久 mutation、断开与关闭流程都经由同一运行时组合。数据库、对象存储、邮件、webhook、时钟和随机源作为内部 Adapter 注入；生产与测试各有真实的 Adapter，避免在公开 Interface 上暴露这些实现细节。
- 服务公共路由只使用 Event Public ID。Participant 通过 `/events/<public-id>` 一类入口访问；内部 Board Session 标识不出现在 URL。旧任意 `/boards/*`、随机画板、原始 SVG、preview、export 和 download 不是服务模式入口，必须统一拒绝，而不是重定向到可绕过权限的兼容路径。
- Account 使用验证邮箱、密码安全散列和服务端持久会话。浏览器 cookie 为 `Secure`、`HttpOnly`、`SameSite=Lax`；会话最长 30 天、闲置 12 小时。登出、改密、账号禁用和 Organizer 成员移除会撤销会话；状态变更请求有 CSRF 防护。
- 首发地区固定为中国大陆。平台仅面向自我确认年满 18 周岁的普通组织活动；新服务页面正式支持 `zh-CN` 与 `en`，其他 WBO 语言在服务页面确定性回退为英语，直到完整翻译完成。
- Organizer 只能经 Platform Operator 批准的 Organizer Application 建立。Organizer Invitation 由 Owner 发起、7 天过期、必须接受；Owner 管理成员和集成凭据，Admin 管理活动与成果，Event Moderator 仅拥有单场实时治理权。
- Reservation 与 Board Session 分开建模。Reservation 的状态为 `DRAFT`、`SUBMITTED`、`APPROVED`、`REJECTED`、`CANCELLED`、`COMPLETED`；Board Session 的状态为 `SCHEDULED`、`OPEN`、`CLOSING`、`CLOSED`、`ARCHIVED`，并支持需人工处理的 `ARCHIVE_FAILED`。状态转换必须由持久后台工作恢复，不以进程内 timer 为权威。
- Reservation 审批时创建 Capacity Allocation：完整容量窗口为计划开始前 15 分钟至结束后 15 分钟，确认后占用一个 Board Session 与声明的 1–50 Participant Seat。任何重叠窗口内最多确认 20 场、1,000 席；不做候补、自动超卖或基于未到场者的二次预订。
- Preparation Window 是 `SCHEDULED` 中的权限规则，不新增额外持久状态。仅 Owner、Admin、Event Moderator 可在开始前 15 分钟编辑；普通 Participant 到计划开始才可进入。开始后普通 Participant 通过 Event Membership 加入。
- Access Code 为每个 Event 的共享随机凭据，仅保存安全摘要。成功验证创建或恢复 Event Membership；轮换阻止未来入场但不移除既有 Membership；Event Lock 阻止所有新入场；错误尝试按 Account 与 IP 限速。Event Ban 覆盖 Access Code 与 Entry Grant，立即移除并阻止重入。
- Participant Seat 按同时占用的独立 Account 而非浏览器 tab 计算。每个 Account 最多一个可写连接，其余只读；全部连接断开十分钟后释放座位，Event Membership 不消失，但重新进入须重新获得空闲座位。
- WBO 保留既有绘图工具，移除 Download；只有 Owner/Admin 可 Clear。服务端对每个持久 mutation 在接纳时记录 Account、Event、Board Session、时间与操作类型，并将不可变 `createdBy` 写入新 Board Item。复制产生新创建者并保留来源关系；移动或编辑不改写创建者；删除与 Clear 保留 Change Audit。
- PostgreSQL 是平台事务、持久变更账本、Item Attribution、Change Audit、会话、Capacity Allocation、任务和 outbox 的存储。每个接纳写入同步入账；SVG 是可物化、可重建的 Board Session 快照。恢复从最近快照回放后续账本，满足 RPO 不超过 5 秒。
- S3-compatible object storage 保存 Board Archive 快照、净化后的 Published Canvas、Brand Asset 和 Image Export；本地磁盘仅作可丢弃工作缓存。Brand Asset 只接收经真实解码验证的 PNG、JPEG、WebP，单文件最大 5 MiB，不接收 SVG 或任意文件。
- 关闭流程为：进入 CLOSING 后拒绝新持久写入；排空已接纳写入；保存并校验序列；生成私有 Board Archive；成功后标记 CLOSED/ARCHIVED。失败保持 `ARCHIVE_FAILED`、重试并通知，不将失败伪装成成功。已连接 Participant 最终看到只读完成界面，之后仅按权限访问 Published Canvas。
- Board Archive、Item Attribution 与 Change Audit 默认保留 90 天。Owner/Admin 的提前删除进入 7 天可恢复期；Image Export 下载链接有效 24 小时；Account 注销后公开身份不可反推。过期时同步清除归档及其相关归属和审计。
- Published Canvas 永远是从私有 Board Archive 派生的净化只读投影，受 Publication Audience 控制：仅 Organizer、仅 Event Membership 或持有不可猜链接。公开页面不被索引，可立即撤回。Participant Identifier 只有在 Publication Policy 打开且 Participant 未选择匿名时才显示。
- Image Export 为异步 Export Job，生成白底 PNG，按内容边界加留白，最长边限制为 8192 像素。它必须去除所有 Item Attribution、Participant Identifier、Change Audit 和内部 metadata，不提供原始 SVG 给 Participant 或公众。
- Organizer 后端用可轮换、作用域最小化的 API Credential 调用版本化集成 Interface。Entry Grant 10 分钟有效、单次使用，可携带不含个人信息的 External Participant Reference，但不建立外部身份登录或 Account 冒充。
- Entry Grant 只置于跳转 URL fragment；登录完成后浏览器以 HTTPS `POST` 兑换并立即清除 fragment。不得在 query、路径、referrer 或普通服务器访问日志中传递 grant。
- Webhook Subscription 使用每个 Organizer 独立 HMAC secret。通过 durable outbox 进行至少一次投递，携带稳定事件标识供接收方去重；指数退避最多 24 小时，随后暂停并通知 Owner。首版事件为 `event.opened`、`event.closed`、`archive.ready`、`archive.failed`。
- Lifecycle Notice 使用持久后台工作发送。Participant 仅接收账号验证、密码重置以及自己已进入过 Event 的取消/关闭通知；Organizer Member 接收预约、开始、归档和失败通知；不发送营销邮件，也不为未知共享 Access Code 持有者猜测收件人。
- Platform Operator、Organizer 与 Participant 分别使用独立控制台页面。白板工具栏只承载实时绘图和已分配的实时治理，不承载预约、成员、导出、审计或运营表单。
- Historical Archive 仅由 Platform Operator 显式选取旧 SVG 导入。导入数据标记未知作者，不补造 Change Audit，不自动扫描历史目录，也不作为可重新开放的 Board Session。
- 每次部署必须关联不可变源码版本。站点页脚和登录后菜单提供 Source 页面，指向可获取当前 Corresponding Source 的公开版本与构建说明，符合已接受的 AGPL 决策。

## Testing Decisions

- 好的测试只断言调用者可观察到的 HTTP 响应、浏览器界面、Socket.IO 事件、持久化成果、归档内容和通知投递结果；不断言私有表结构、内部调用次数、临时变量或具体实现顺序。
- 主要测试 surface 是现有服务器组合入口。Node 集成测试以隔离的 PostgreSQL、对象存储、邮件、webhook 和时钟 Adapter 启动真实 HTTP/Socket.IO 应用，覆盖每条用户合同而非直接测试内部 Repository 或任务函数。
- 对现有 WBO 引擎的低层 mutation、协议归一化、速率限制和绘图重放保持已有 Node 测试覆盖。新增功能优先从 Hosted Event Module 的公开 Interface 验证，避免为 Account、Reservation、Archive 分别建立不一致的测试 seam。
- Playwright 使用现有浏览器服务器夹具覆盖高价值的跨页面流程：注册/登录、公开与未列出 Event、Access Code 入场、Preparation Window、容量拒绝、多标签只读、匿名选择、Moderator 处置、关闭后的只读界面、Published Canvas 与 Organizer 导出页。
- Node 集成测试覆盖 Account 验证、会话撤销、Organizer Application、Invitation、角色矩阵、Reservation 审批、并发 Capacity Allocation、Change Request、取消、Public ID 不可绕过性、旧 WBO 路由拒绝、Access Code 轮换、Event Lock、Event Ban 和 Seat 重连宽限。
- Socket 集成测试覆盖：未满足 Event Membership、生命周期、Event Ban 或容量条件的握手被拒绝；直接连接内部 Board Session 被拒绝；持久 mutation 被服务端赋予正确 Item Attribution；复制、删除和 Clear 生成可检索 Change Audit；关闭中和关闭后写入被一致拒绝。
- 持久化与恢复测试覆盖：已接纳 mutation 在崩溃恢复后从账本重放；快照落后账本时不丢失已接纳写入；关闭等待已接纳写入落盘；空 Board Session 仍生成 Board Archive；`ARCHIVE_FAILED` 重试而不误报成功。
- 隐私与成果测试覆盖：原始 SVG、preview、export、download 和旧 `/boards/*` 入口不可访问；Published Canvas 不含邮箱、内部 Account 标识、审计或匿名 Participant Identifier；PNG Image Export 不含 metadata；撤回发布即时阻止访问；保留期和删除恢复期按时间生效。
- 集成测试覆盖：API Credential 只能在所属 Organizer scope 内使用；撤销和过期后失败；Entry Grant 只能兑换一次且过期失败；fragment 兑换后 URL 被清理；External Participant Reference 不影响 Account 身份；webhook HMAC、稳定事件标识、重复投递、重试、暂停和 Owner 通知符合合同。
- 后台工作测试通过可控时钟验证开始、关闭、归档、导出、邮件和 webhook 在重启后被恢复处理；验证 RPO/RTO 所需的报警条件与失败可见性。
- 延续现有 server route、socket scenario、认证、协作和 Playwright 页面测试作为 prior art。任何触及实时 mutation、快照、广播或重放的改动都运行对应 Node 测试与基准；若热点改变，按项目约定在改动前后运行 load、persist 或 broadcast benchmark。
- 测试必须将 HTTP 和 Socket 输入视为 hostile：畸形 ID、重复 grant、越权 role、过期会话、恶意 MIME、超长 payload、冲突的容量申请和异常 webhook 响应均应被确定性拒绝，且不得使进程崩溃。

## Out of Scope

- 在线支付、退款、发票、报价和自动财务对账；首版仅支持线下处理与运营备注。
- SSO、OAuth、passkey、Organizer 外部身份直接登录，以及从外部身份自动创建或冒充 Account。
- iframe 嵌入、自定义域名、完全白标、自定义 CSS、主办方独立邮件发件身份和多租户主题系统。
- 多活或跨地域高可用、自动横向扩容、跨区域数据驻留和“全球可用”承诺。
- 周期性 Reservation、候补队列、自动超卖、按实时未到场者动态转售容量和观察者角色。
- 画板内图片、文件、音视频、嵌入内容或任意附件上传；只支持有限类型的 Brand Asset。
- Participant 或公众直接下载原始 SVG、编辑归档、重开 CLOSED Board Session，或查看私有作者映射与审计。
- AI 内容审核、公开申诉门户、跨 Organizer 黑名单、全站封禁和自动内容下架。
- 自动批量迁移、自动扫描旧 WBO 历史目录，或为历史 SVG 补造作者信息和 Change Audit。
- 除 `zh-CN` 与 `en` 之外的新服务页面正式本地化；现有白板翻译可保留但不构成服务页面完整支持承诺。
- 在未完成中国大陆适用条款、隐私政策和法律顾问复核前上线或作合规保证。

## Further Notes

- 本规格遵守已确认的领域词汇和 ADR：继续使用 WBO、提供 AGPL Corresponding Source、以平台层隔离引擎、使用持久变更账本、对象存储、持久后台工作、Organizer-scoped Entry Grant、至少一次 webhook、净化成果投影和 opaque Event Public ID。
- 数据层已选定自托管 PostgreSQL，对象存储已选定 Cloudflare R2（通过 portable S3 adapter），事务邮件已选定 Cloudflare Email Sending（通过 portable SMTP adapter）；CAPTCHA、部署平台和秘密管理供应商仍待部署阶段确认。供应商选择不得反向改变产品 Interface。
- 20 场 Board Session、1,000 Participant Seat、单场最多 50 席是首版初始安全上限，不是未经验证的永久承诺。实施前后应基于真实绘图模式压测，并保留足够运维余量。
- V1 以单个活跃应用实例为部署约束，但持久化、对象存储、任务和入场规则不得永久依赖本地进程状态，为后续扩展保留迁移空间。
- 本规格将当前工作标为 `ready-for-agent`；后续可将其拆分为按依赖顺序实施的本地 tickets，而不重新讨论已确认的用户合同。
