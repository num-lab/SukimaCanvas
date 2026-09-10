# 25 — Mutation Ledger 的 append handle 从不关闭

**What to build:** 让文件账本适配器释放它打开的 append 文件句柄。当前每个接受过持久写入的 Board 都会永久占用一个文件描述符，单活跃实例长期运行会累积到进程的 fd 上限。

**Blocked by:** 11 — Board Item 创建归属与耐久 Mutation Ledger

**Status:** ready-for-agent

- [x] 账本适配器提供释放句柄的方式，且在 Board 实例被丢弃（registry 驱逐、`dispose`、关闭后不再使用）时被调用。
- [x] 关闭与进行中的 append 有序：已排队的 append 要么在关闭前完成，要么确定性失败，不得出现写入丢失或半行。
- [x] 关闭后再次 append 能重新打开句柄或确定性失败，不得静默丢弃已接受的写入。
- [ ] 长时间运行不再累积文件描述符；运行 `npm run bench:archive` 不再出现 `Closing a FileHandle object on garbage collection is deprecated` 警告。
- [ ] Node 测试覆盖：句柄释放后账本内容完整可读、重启恢复不受影响、torn tail 修复逻辑不受影响。

## Comments

- 2026-09-06（agent）：由新增的 `archive` 基准场景暴露。`server/hosted_event/ledger/store.mjs` 的 `openAppendHandle()` 用 `fs.promises.open(ledgerPath, "a")` 打开句柄并缓存在闭包里，返回的契约只有 `{appendEntries, readEntriesAfter}`，没有 close，代码库里也没有任何地方关闭它。
- 现象：跑 `npm run bench:archive` 时 Node 打印 `Warning: Closing file descriptor N on garbage collection` 与 `[DEP0137] Closing a FileHandle object on garbage collection is deprecated. ... In the future, an error will be thrown`。也就是说当前依赖 GC 回收句柄，未来 Node 版本会直接抛错。
- 生产影响：一个接受过写入的 Board 对应一个句柄，直到实例被 GC。单活跃实例连续承办活动时，fd 随已办场次累积；默认 fd 上限下，约上千场后触及上限，表现为无法打开文件——会同时打到快照保存、归档写入和账本 append。
- 注意 `deleteBoardMutationLedgerFile` 的注释已经意识到"仍持有 open append handle 的适配器实例会保留它"，但那是在讲删除的幂等性，不是句柄生命周期。
- 设计注意点：`appendEntries` 通过 `enqueue` 串行化，`ensureAppendBoundary` 的修复结果缓存在 `appendBoundary` 上。关闭必须走同一条队列，否则会和进行中的 fsync 竞争；重新打开时 append boundary 的修复语义也要重新考虑。

- 2026-09-10（agent）：已实现幂等、终止式 `close()`，通过 append 队列释放句柄；关闭后的追加明确拒绝，读取保持可用。Board dispose、registry 驱逐、归档 sealWrites 和基准脚本独立账本均接入释放。按用户要求，本次不编写或运行测试，也暂缓基准运行；长时间 fd 与 archive 警告验证、Node 回归覆盖仍待完成。
