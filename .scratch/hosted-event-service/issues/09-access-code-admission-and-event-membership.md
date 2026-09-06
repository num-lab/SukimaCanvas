# 09 — Access Code 入场与 Event Membership

**What to build:** 让已登录 Participant 在活动页提交共享 Access Code，获得可跨刷新恢复的 Event Membership，并选择其 Participant Identifier 是否可出现在未来的 Published Canvas；Hosted 模式同时关闭所有可绕过 Event 的旧 WBO 入口。

**Blocked by:** 03 — Account 恢复与 Session 安全控制；07 — Event 发现页与 Brand Asset；08 — Reservation 变更与耐久活动调度

**Status:** done

- [x] 每个 Event 使用高熵 Access Code，服务端仅保存安全摘要；正确验证创建或恢复当前 Account 的 Event Membership。
- [x] 错误代码、未知 Event、锁定 Event 和不可入场状态使用不利于枚举的响应，并按 Account 与 IP 限速。
- [x] Access Code 轮换只阻止未来通过旧代码入场，不撤销既有 Event Membership。
- [x] Owner/Admin 可以启用 Event Lock；锁定后所有新 Access Code 入场被拒绝，已有 Membership 保留。
- [x] Participant 首次加入时选择公开 Participant Identifier 或匿名，并可在 Board Session 关闭前改为匿名；关闭后选择被冻结。
- [x] Hosted 模式拒绝旧任意画板、随机画板、原始 SVG、preview、export 和 download 入口，不重定向到兼容旁路。
- [x] 公共 URL 和浏览器状态不暴露内部 Board Session 标识，直接猜测内部标识不能建立 Membership。
- [x] Node 集成测试覆盖轮换、锁定、限速、匿名偏好和旧入口拒绝；Playwright 覆盖活动页输入代码并建立 Membership。

