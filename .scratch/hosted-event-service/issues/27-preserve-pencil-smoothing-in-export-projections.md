# 27 — 导出投影保留 Pencil 曲线平滑

**What to build:** 让同一组已接纳的 Pencil 采样点在实时画板、Published Canvas、SVG 输出和 PNG Image Export 中呈现一致的平滑曲线，而不是在导出时退化为可见折线。

**Blocked by:** 16 — Published Canvas 与公开作者策略；17 — 异步 PNG Image Export

**Status:** ready-for-agent

- [x] 保留当前用于快照和增量追加的规范 `M/l` Pencil 存储格式，不迁移既有 SVG，也不改变 Mutation Ledger、快照恢复或 append scanner 的耐久语义。
- [x] 提供一个共享、确定性的 Pencil 展示投影：从规范存储路径恢复采样点，并使用与浏览器 `wboPencilPoint` 相同的控制点算法输出 `C` 三次贝塞尔路径。
- [x] Published Canvas 中的 Pencil 路径经过平滑投影，同时继续遵守只读、Attribution allow-list、匿名和 metadata 净化契约。
- [x] PNG Image Export 在交给 Resvg 前对 Pencil 路径执行相同投影；白底、内容留白、8192 px 上限、metadata 白名单和授权下载契约保持不变。
- [x] Legacy mode 保留的 SVG preview/download 输出与画板显示一致；Hosted mode 仍拒绝原始 SVG、preview、export 和 download 路由，不新增公开原始 SVG 能力。
- [x] 平滑曲线的真实几何边界被正确计入投影视口，贝塞尔控制点越过采样点包围盒时不得被 PNG 边缘或 SVG viewport 裁切。
- [ ] 回归测试至少覆盖一个三点转折：画板与导出投影都包含连续的 `C` 曲线，而规范存储仍为 `M/l`；PNG 像素断言能够区分平滑曲线与原始折线。
- [ ] 运行 `npm test`、`npm run typecheck`，并按 Image Export 热路径约定记录 `npm run bench -- export` 的改动前后结果。

## Comments

- 2026-09-07（user）：先记录该问题，暂不实施。
- 现象：Pencil 曲线在实时画板中平滑，但 Published Canvas／导出的 SVG 能看到折线转角，由该 SVG 生成的 PNG 也出现明显棱角；大画布缩小到最长边 8192 px 后再放大会进一步放大 PNG 的像素锯齿。
- 根因已用三点输入稳定复现。`wboPencilPoint` 生成的实时命令是 `M L C C`，而 `renderPencilPath` 对同一组点生成 `M 0 0 l 30 0 l 0 30`。平滑路径在中间点两侧的切线均为 45°，存储折线则从 0° 突变到 90°。
- `client-data/tools/pencil/index.js` 的 `normalizeServerRenderedElement` 会在浏览器启动时把规范 `M/l` 路径重新交给 `wboPencilPoint`，所以实时画板和刷新后的画板都显示平滑；`renderPencilPath`、SVG download、Published Canvas 派生和 PNG render input 没有执行同一转换。
- 已排除样式丢失：持久化 Pencil tag 明确包含 `stroke-linecap="round"` 和 `stroke-linejoin="round"`。圆角连接只能修饰折线接头，不能恢复贝塞尔中心线。
- PNG 的 Resvg 不是首要根因：`server/hosted_event/export/render.mjs` 将归档 `drawingAreaContent` 原样嵌入渲染 SVG 后再栅格化，因此它忠实呈现了已经退化的折线路径。
- 修复应位于展示／导出投影边界，不应直接把规范存储改成 `C` 命令；当前持久化扫描、增量追加和恢复路径都依赖简单的 `M/l` 格式。平滑后曲线可能越过采样点包围盒，修复时必须同时处理精确边界，不能只替换 `d` 属性。
- #24“Image Export 阻塞单活跃实例”继续独立处理。该票解决几何一致性，不负责把 Resvg 移到 worker thread／独立进程，也不以线程模型变化作为验收条件。
- 2026-09-09（implementation）：Pencil 模块新增共享平滑投影和三次贝塞尔精确边界；服务端展示投影接入 Published Canvas、PNG 渲染输入以及 legacy preview/download，并在曲线或描边越过原始 SVG 范围时扩展 viewport。按用户要求，本轮暂不新增或运行测试，测试、typecheck 和 export benchmark 验收项保持未完成，ticket 继续保留 `ready-for-agent`。
- 2026-09-09（code review）：Standards 轴发现 SVG 根属性更新重复及严格扫描参数命名不清，已分别收敛到 `updateSvgRootAttributes` 并改名；Spec 轴发现变换后的描边留白不足，展示投影现统一计算包括 scale/shear 的 painted bounds，SVG viewport 与 PNG 内容边界共用该结果。测试与 benchmark 仍按用户要求延期。
