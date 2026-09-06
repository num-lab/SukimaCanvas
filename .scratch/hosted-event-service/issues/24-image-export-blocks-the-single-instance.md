# 24 — Image Export 阻塞单活跃实例

**What to build:** 让一次 Image Export 不再占用主线程与持久写共用的 I/O 能力：渲染必须移出事件循环，且要给出满容量归档的可接受时间或明确的规模上限。当前实现下，一次满容量导出会让整台单活跃实例停摆数分钟。

**Blocked by:** 17 — 异步 PNG Image Export

**Status:** ready-for-agent

- [ ] 渲染期间事件循环不再被长时间占用：满容量归档导出时，实时 Board Session、Socket.IO 流量、HTTP 请求和生命周期扫描保持可服务。
- [ ] 渲染不与持久写争抢同一 I/O 能力，或该竞争被显式界定并记录（libuv 线程池占用、`UV_THREADPOOL_SIZE` 取值）。
- [ ] 给出满容量（32,768 items）导出的处置结论：可接受时长、可导出归档规模上限，或单次导出的硬超时与强制中止手段。
- [ ] `npm run bench -- export` 的基线在改动前后记录；`WBO_BENCH_EXPORT_ITEMS` 用于满容量测量。
- [ ] 现有导出契约不变：净化输出、metadata 白名单、确定性失败码、幂等与重启恢复、授权下载与撤销。
- [ ] `docs/operations/launch-evidence.md` §3 与 §7 第 3 条按结论更新。

## Comments

- 2026-09-06（agent）：由新增的 `export` 基准场景发现并测量，本票只记录，不在当时修复。
- 分阶段测量（同一份 8192×8192 输出，本机 Apple Silicon）：

  | 阶段 | 512 items | 4,000 items |
  | --- | --- | --- |
  | `new Resvg(svg)` 解析 | 2,422 ms | 17,192 ms |
  | `.render()` 栅格化 | 65 ms | 170 ms |
  | `.asPng()` 编码 | 506 ms | 465 ms |

  约 96% 的开销在构造函数的 SVG 解析，随 item 数近似线性增长（约 4.2 ms/item）；真正的栅格化只有 65–170 ms。满容量（32,768 items）整条导出流程平均 235.4 s，输出 8192×7844、18.6 MiB PNG。
- 阻塞已实测：652 ms 渲染造成 649 ms 事件循环延迟，50 ms 心跳漏掉一半以上 tick。票 17 的第 (2) 条评审决定把导出 pass 从请求路径上摘了下来，那解决的是请求延迟，不是事件循环饥饿——pass 仍在同一个事件循环上跑。
- `runDueExports` 逐个处理到期任务，多个大导出会串行累加。
- 候选方案与已验证的差别：
  - `renderAsync(svg, options, signal)`：改一个调用点，`renderArchivePng` 变 async。实测主线程最大延迟 17,825 ms → 448 ms，残留部分是仍然同步的 `asPng()`。**但它跑在 libuv 线程池上**（已验证：默认池下 8 个并发渲染分两波 12.1s/26.0s 完成，`UV_THREADPOOL_SIZE=8` 后合并为一波 ~24s），与 `fs` 共用——账本 fsync、各 JSON store 写入、快照保存都在那个池里，一次 4 分钟的导出会占住 4 槽中的 1 槽。其 AbortSignal 只能取消尚未开始的任务，无法打断进行中的渲染。
  - worker thread / 独立进程：同时隔离事件循环与 libuv 池，并且是唯一能对跑飞渲染硬超时强杀的手段；内存也隔离（8192×7844 的 RGBA 约 257 MB）。代价是生命周期管理与跨边界搬运（SVG 进 ~4 MiB、PNG 出 18.6 MiB）。
- 未验证但值得先测的方向：解析开销可能由文本元素的字体匹配主导（`loadSystemFonts: true` 在解析期逐元素匹配，测量用的 fixture 有三分之一是 text）。若成立，`loadSystemFonts: false` 加内置字体列表可能直接降低数量级，比换线程模型更划算。任何线程方案都只是让导出不再拖垮别人，不会让它变快。
