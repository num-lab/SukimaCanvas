# 10 — Participant Seat 与实时连接准入

**What to build:** 让有 Event Membership 的用户按活动生命周期和声明容量进入真实 WBO 画板，同时保证每个 Account 只有一个可写连接，其他标签页只读，并在短暂断线时保留 Seat。

**Blocked by:** 09 — Access Code 入场与 Event Membership

**Status:** done

- [x] SCHEDULED 的 Preparation Window 内只有 Organizer Owner/Admin 可编辑；普通 Participant 到计划开始且 Board Session OPEN 后才能获得写权限。
- [x] Participant Seat 按 Event 内的独立 Account 计数，不按标签页或 socket 数量计数，且总占用不超过获批容量。
- [x] 同一 Account 在同一 Event 最多一个可写连接；额外标签页或设备以明确只读状态连接，不重复占用 Seat。
- [x] 所有连接断开后 Seat 保留 10 分钟；期限内重连恢复资格，期限后释放并在有余量时重新竞争 Seat。
- [x] 满员、Membership 缺失、生命周期不允许、Event Lock 新入场或 Event Ban 的握手被服务端权威拒绝。
- [x] 直接连接内部 Board Session、伪造角色或复用其他 Event 凭据不能绕过 Hosted Event Module。
- [x] 画板保留 Pencil、Straight Line、Rectangle、Ellipse、Text、Eraser、Hand、Grid、Zoom 和 Cursor；Participant 看不到 Download 或原始 SVG 能力。
- [x] Socket 集成测试覆盖准入矩阵和重连宽限；Playwright 覆盖 Preparation Window、满员提示和多标签只读。

