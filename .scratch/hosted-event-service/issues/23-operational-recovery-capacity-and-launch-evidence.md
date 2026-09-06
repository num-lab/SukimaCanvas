# 23 — 运营恢复、容量与上线验收证据

**What to build:** 为 Hosted Event Service 建立可重复的运维验收：备份与恢复、容量承诺、任务失败可见性、性能基准、敏感日志脱敏和源码版本对应关系；该票产出上线前证据，但不替代中国大陆适用条款和法律复核。

**Blocked by:** 10 — Participant Seat 与实时连接准入；12 — 完整笔画审计、派生关系与崩溃恢复；13 — Event 管理、举报、封禁与锁定；15 — 归档失败恢复与幂等重试；18 — 审计查看、保留期与 Account 删除；21 — 签名 Webhook 与可靠 Outbox；22 — 受控 Legacy SVG 历史归档导入

**Status:** ready-for-human

- [ ] PostgreSQL 和对象存储具备可验证的备份、PITR 与恢复流程；月度恢复演练可以重建 Hosted Event Service 所需的最小状态。（当前适配器为文件存储：备份/PITR/恢复流程已文档化并由自动化演练验证；PostgreSQL/S3 适配器待选型后映射。）
- [x] 通过受控故障演练证明 RPO 不超过 5 秒、RTO 不超过 15 分钟，且恢复后账本、快照、任务、outbox 和权限边界一致。
- [ ] 对 20 个重叠 Board Session、1,000 个 Participant Seat 和单场 50 席的承诺执行带运维余量的负载验证，并记录不满足条件时的拒绝行为。（拒绝行为已在存储层测试证明；生产形态目标机上的全量负载验证待执行。）
- [ ] 对实时 mutation、持久化、重放、广播、归档和导出热点运行项目约定的基准，确认没有引入无法接受的回归。（既有四项基准 e2e/load/persist/broadcast 已运行并记录基线；归档/导出尚无基准场景，已记录为待办。）
- [x] 运营信号覆盖容量、连接、保存、归档、导出、邮件和 webhook 失败；告警不含密码、Session、Access Code、Credential、Entry Grant、邮箱或原始画布内容。
- [x] 单活跃应用实例部署约束被明确记录，但 PostgreSQL、对象存储和耐久任务不依赖本地进程状态；滚动部署后 Source 页面仍对应不可变源码版本。
- [x] Node、Socket.IO、Playwright、lint、typecheck 和必要 benchmark 全部通过；上线清单明确仍需法律顾问完成服务条款与隐私政策复核。

## Comments

- 2026-09-06（agent）：已交付并验证 —— 自动化恢复演练（重启 + 备份恢复/PITR，零确认写入丢失，任务/_outbox/权限边界一致）、容量承诺的拒绝行为、既有四项基准基线、运营信号与容量 gauge、单实例部署与 Source 页约束、上线清单（法律复核为显式未完成项）。见 `docs/operations/launch-evidence.md` 与 `docs/operations/runbook.md`。
- 余项（需人工/外部条件）：生产形态目标机上的全量负载验证、PostgreSQL/S3 适配器选型与流程映射、归档/导出基准场景、法律复核。状态设为 `ready-for-human`。
