# 23 — 运营恢复、容量与上线验收证据

**What to build:** 为 Hosted Event Service 建立可重复的运维验收：备份与恢复、容量承诺、任务失败可见性、性能基准、敏感日志脱敏和源码版本对应关系；该票产出上线前证据，但不替代中国大陆适用条款和法律复核。

**Blocked by:** 10 — Participant Seat 与实时连接准入；12 — 完整笔画审计、派生关系与崩溃恢复；13 — Event 管理、举报、封禁与锁定；15 — 归档失败恢复与幂等重试；18 — 审计查看、保留期与 Account 删除；21 — 签名 Webhook 与可靠 Outbox；22 — 受控 Legacy SVG 历史归档导入

**Status:** ready-for-human

- [ ] PostgreSQL 和对象存储具备可验证的备份、PITR 与恢复流程；月度恢复演练可以重建 Hosted Event Service 所需的最小状态。（自托管 PostgreSQL 与 Cloudflare R2 适配器已实现并通过 PostgreSQL 16 重启/账本测试及 S3 协议测试；生产 WAL 归档、独立 R2 备份和目标环境恢复演练仍待执行。）
- [x] 通过受控故障演练证明 RPO 不超过 5 秒、RTO 不超过 15 分钟，且恢复后账本、快照、任务、outbox 和权限边界一致。
- [ ] 对 20 个重叠 Board Session、1,000 个 Participant Seat 和单场 50 席的承诺执行带运维余量的负载验证，并记录不满足条件时的拒绝行为。（拒绝行为已在存储层测试证明；生产形态目标机上的全量负载验证待执行。）
- [x] 对实时 mutation、持久化、重放、广播、归档和导出热点运行项目约定的基准，确认没有引入无法接受的回归。（六项基准 e2e/load/persist/broadcast/archive/export 已运行并记录基线；归档与导出场景见 `scripts/benchmark-hosted-outcomes.mjs`。）
- [x] 运营信号覆盖容量、连接、保存、归档、导出、邮件和 webhook 失败；告警不含密码、Session、Access Code、Credential、Entry Grant、邮箱或原始画布内容。
- [x] 单活跃应用实例部署约束被明确记录，但 PostgreSQL、对象存储和耐久任务不依赖本地进程状态；滚动部署后 Source 页面仍对应不可变源码版本。
- [x] Node、Socket.IO、Playwright、lint、typecheck 和必要 benchmark 全部通过；上线清单明确仍需法律顾问完成服务条款与隐私政策复核。

## Comments

- 2026-09-06（agent）：已交付并验证 —— 自动化恢复演练（重启 + 备份恢复/PITR，零确认写入丢失，任务/_outbox/权限边界一致）、容量承诺的拒绝行为、既有四项基准基线、运营信号与容量 gauge、单实例部署与 Source 页约束、上线清单（法律复核为显式未完成项）。见 `docs/operations/launch-evidence.md` 与 `docs/operations/runbook.md`。
- 余项（需人工/外部条件）：生产形态目标机上的全量负载验证、生产 PostgreSQL/R2 备份与恢复演练、法律复核。状态设为 `ready-for-human`。
- 2026-09-06（agent）：补齐归档/导出基准场景，第 4 条验收项完成。新增 `scripts/benchmark-hosted-outcomes.mjs`，以真实组合的 close/export pipeline 与真实文件存储驱动两条热点：`npm run bench:archive`（32,768 items + 8,320 条账本，avg 105.6 ms）、`npm run bench:export`（默认 512 items，avg 2.36 s）。样本若未归档或未渲染成功即让整轮失败，不会给出无意义的数字。基线记入 `docs/operations/launch-evidence.md` §3。
- 2026-09-06（agent）：第 7 条验收项的 lint 门此前实际为红 —— 7 个文件有 formatter 漂移（notifications/、organizers/routes.mjs、webhooks/store.mjs 与 3 个 hosted 测试文件）外加一个未使用常量。CI 只在 main 及指向 main 的 PR 上运行，develop 从未跑过该门，因此长期未被发现。已用 `npm run format` 清扫并单独提交；launch-evidence §6 记录了这一点与"合并前先跑 lint"的要求。
- 测量中发现两个运营问题（已记入 launch-evidence §3 与 §7 第 3 条，本票不修）：满容量（32,768 items）Image Export 平均 235.4 s，且 `renderArchivePng` 的栅格化是同步调用——实测 652 ms 渲染造成 649 ms 事件循环阻塞，因此单活跃实例在整个渲染期间会停摆；`runDueExports` 又是逐个处理，多个大导出会累加。上线前需要给出取舍（异步/worker 渲染、更小边长上限，或限制可导出归档规模）。
- 2026-09-07（agent）：生产存储选型落地为自托管 PostgreSQL + 私有 Cloudflare R2。PostgreSQL 保存 JSONB 状态文档和规范化 mutation ledger，启动时持有 advisory lock 保证单活；R2 通过 S3 接口保存归档、发布画布、历史归档、Brand Asset 和 Image Export。真实 PostgreSQL 16 容器测试通过；真实 R2 凭据预检与生产备份/恢复仍是外部验收项。
