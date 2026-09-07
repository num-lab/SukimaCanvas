# 18 — 审计查看、保留期与 Account 删除

**What to build:** 让授权的 Organizer 查看活动审计和成果生命周期，并以可恢复的删除窗口、到期清理和不可反推的注销身份满足数据保留边界。

**Blocked by:** 13 — Event 管理、举报、封禁与锁定；16 — Published Canvas 与公开作者策略；17 — 异步 PNG Image Export

**Status:** done

- [x] Owner/Admin 可以在 Organizer Console 查看其 Organizer scope 内的 Event、Board Item Attribution 和 Change Audit；Event Moderator 与 Participant 只能看到各自授权的最小信息。
- [x] Private Archive、Item Attribution 和 Change Audit 默认保留 90 天，保留期显示基于服务端权威时间计算。
- [x] Owner/Admin 提前删除活动成果进入 7 天可恢复期；恢复后 Archive、Published Canvas 和 Export 状态保持一致。
- [x] 删除请求进入恢复期后，Published Canvas 与全部 Image Export 下载链接立即失效。
- [x] 恢复期结束后清除 Private Archive、归属、审计及关联导出对象；重复清理幂等且不会影响其他 Event。
- [x] Account 注销后，公开归属变为不可反推的假名化身份，历史安全审计仍保留必要的责任边界。
- [x] 过期任务在重启后继续执行，失败可见且可重试；Node 集成测试覆盖时间边界、恢复、隔离和授权，Playwright 覆盖 Console 操作。

